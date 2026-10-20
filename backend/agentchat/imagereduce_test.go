package agentchat

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pngOf(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.NoCompression}).Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// noisy es una foto «de teléfono»: ruido que no comprime, así el archivo pasa
// de 5 MB aunque no sea enorme.
func noisy(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	rand.New(rand.NewSource(1)).Read(img.Pix)
	for i := 3; i < len(img.Pix); i += 4 {
		img.Pix[i] = 255
	}
	return img
}

func dimsOf(t *testing.T, raw []byte) (int, int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

func b64b(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// Una imagen que ya cabe llega al modelo tal cual: mismos bytes, sin copia.
func TestReduceImageLeavesSmallImagesAlone(t *testing.T) {
	raw := pngOf(t, noisy(300, 200))
	out, mime, reduced, err := ReduceImage("a.png", raw, "image/png")
	if err != nil || reduced || mime != "image/png" || !bytes.Equal(out, raw) {
		t.Fatalf("una imagen chica no se toca: reduced=%v mime=%s err=%v", reduced, mime, err)
	}

	dir := t.TempDir()
	a, err := SaveFile(dir, "chica.png", b64b(raw))
	if err != nil {
		t.Fatal(err)
	}
	if a.ModelPath != "" || a.ModelFile() != a.Path {
		t.Errorf("una imagen chica no genera copia: %+v", a)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("solo el original en la carpeta: %v", entries)
	}
}

// Una foto grande y pesada se reduce por debajo de los dos topes y el original
// queda intacto, con la copia como archivo aparte en la misma carpeta.
func TestReduceImageShrinksLargePhotosAndKeepsOriginal(t *testing.T) {
	raw := pngOf(t, noisy(2600, 1800))
	if len(raw) <= MaxModelImageBytes || len(raw) > MaxImageBytes {
		t.Fatalf("la foto de prueba tiene que pesar entre 5 y 20 MB: %d", len(raw))
	}
	out, mime, reduced, err := ReduceImage("foto.png", raw, "image/png")
	if err != nil || !reduced {
		t.Fatalf("reduced=%v err=%v", reduced, err)
	}
	if mime != "image/jpeg" || len(out) > MaxModelImageBytes {
		t.Fatalf("salida %s de %d bytes", mime, len(out))
	}
	if w, h := dimsOf(t, out); w > MaxImageSide || h > MaxImageSide || w < 512 {
		t.Errorf("medidas %dx%d", w, h)
	}

	dir := t.TempDir()
	a, err := SaveFile(dir, "foto.png", b64b(raw))
	if err != nil {
		t.Fatal(err)
	}
	if a.Size != int64(len(raw)) || a.ModelPath == "" || a.ModelPath == a.Path || filepath.Dir(a.ModelPath) != dir {
		t.Fatalf("ficha: %+v", a)
	}
	if got, _ := os.ReadFile(a.Path); !bytes.Equal(got, raw) {
		t.Error("el original tiene que quedar intacto")
	}
	cp, _ := os.ReadFile(a.ModelPath)
	if len(cp) == 0 || len(cp) > MaxModelImageBytes {
		t.Errorf("la copia pesa %d", len(cp))
	}
	if w, h := dimsOf(t, cp); w > MaxImageSide || h > MaxImageSide {
		t.Errorf("la copia mide %dx%d", w, h)
	}

	// Al enviar se vuelve a clasificar desde el disco y se reutiliza la misma copia.
	atts, err := ResolveAttachments(dir, []string{a.Path})
	if err != nil || len(atts) != 1 || filepath.Base(atts[0].ModelPath) != filepath.Base(a.ModelPath) || atts[0].Size != int64(len(raw)) {
		t.Fatalf("ResolveAttachments: %+v %v", atts, err)
	}
	p, err := PrepareAttachments(atts, CLIAttachmentCaps("claude"), "Claude Code")
	if err != nil || len(p.Images) != 1 || p.Images[0] != atts[0].ModelPath {
		t.Fatalf("al modelo tiene que ir la copia: %+v %v", p, err)
	}
	if got := attachmentNames(atts)[atts[0].ModelPath]; got != "foto.png" {
		t.Errorf("la copia lleva el nombre del original en el prompt: %q", got)
	}
	if got, _ := os.ReadFile(a.Path); !bytes.Equal(got, raw) {
		t.Error("el original sigue intacto tras enviar")
	}

	// Si la copia se perdió (o el adjunto vino de SaveAttachment), se rehace al enviar.
	if err := os.Remove(a.ModelPath); err != nil {
		t.Fatal(err)
	}
	atts, err = ResolveAttachments(dir, []string{a.Path})
	if err != nil || atts[0].ModelPath == "" {
		t.Fatalf("la copia se rehace: %+v %v", atts, err)
	}
	if _, err := os.Stat(atts[0].ModelPath); err != nil {
		t.Errorf("la copia rehecha tiene que existir: %v", err)
	}
}

// Liviana pero enorme en píxeles (un PNG plano de 4000 px): también se reduce.
func TestReduceImageShrinksByPixels(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 4000, 1000))
	for i := range img.Pix {
		img.Pix[i] = 200
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	out, _, reduced, err := ReduceImage("plana.png", buf.Bytes(), "image/png")
	if err != nil || !reduced {
		t.Fatalf("reduced=%v err=%v", reduced, err)
	}
	if w, h := dimsOf(t, out); w != 2048 || h != 512 {
		t.Errorf("medidas %dx%d", w, h)
	}
}

// Un logo con transparencia sigue siendo PNG (con su canal alfa) si cabe.
func TestReduceImageKeepsTransparency(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 3000, 3000))
	for y := 1000; y < 2000; y++ {
		for x := 1000; x < 2000; x++ {
			img.SetNRGBA(x, y, color.NRGBA{200, 30, 30, 255})
		}
	}
	var src bytes.Buffer
	if err := png.Encode(&src, img); err != nil {
		t.Fatal(err)
	}
	out, mime, reduced, err := ReduceImage("logo.png", src.Bytes(), "image/png")
	if err != nil || !reduced || mime != "image/png" {
		t.Fatalf("reduced=%v mime=%s err=%v", reduced, mime, err)
	}
	dec, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := dec.At(5, 5).RGBA(); a != 0 {
		t.Errorf("la esquina tenía que seguir transparente (alfa %d)", a)
	}
	if r, _, _, a := dec.At(1024, 1024).RGBA(); a != 0xffff || r>>8 != 200 {
		t.Errorf("el centro tenía que seguir rojo y opaco (r=%d a=%d)", r>>8, a)
	}
	if dec.Bounds().Dx() != MaxImageSide {
		t.Errorf("ancho %d", dec.Bounds().Dx())
	}
}

// Una «bomba» (la cabecera declara 60000×60000) se rechaza sin decodificarla,
// y no deja nada en la carpeta de adjuntos.
func TestReduceImageRejectsPixelBombs(t *testing.T) {
	raw := pngOf(t, image.NewNRGBA(image.Rect(0, 0, 2, 2)))
	// IHDR empieza en el byte 8: largo(4) "IHDR"(4) ancho(4) alto(4)… y su CRC.
	binary.BigEndian.PutUint32(raw[16:], 60000)
	binary.BigEndian.PutUint32(raw[20:], 60000)
	binary.BigEndian.PutUint32(raw[29:], crc32.ChecksumIEEE(raw[12:29]))
	if _, _, _, err := ReduceImage("bomba.png", raw, "image/png"); err == nil || !strings.Contains(err.Error(), "bomba.png") {
		t.Fatalf("una imagen de 3600 Mpx tenía que rechazarse nombrándola: %v", err)
	}
	dir := t.TempDir()
	if _, err := SaveFile(dir, "bomba.png", b64b(raw)); err == nil {
		t.Fatal("SaveFile tenía que rechazar la bomba")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("un rechazo no deja archivos: %v", entries)
	}
}

// Sin decodificador de WebP en la stdlib: una que cabe pasa tal cual; una de
// más de 5 MB se rechaza diciendo cómo arreglarlo.
func TestWebPLargerThanModelLimitIsRejected(t *testing.T) {
	head := "RIFF\x00\x00\x00\x00WEBPVP8 "
	dir := t.TempDir()
	if a, err := SaveFile(dir, "chica.webp", b64(head+strings.Repeat("\x00", 1<<10))); err != nil || a.ModelPath != "" || a.Mime != "image/webp" {
		t.Fatalf("una WebP chica pasa tal cual: %+v %v", a, err)
	}
	_, err := SaveFile(dir, "grande.webp", b64(head+strings.Repeat("\x00", 6<<20)))
	if err == nil || !strings.Contains(err.Error(), "grande.webp") || !strings.Contains(err.Error(), "WebP") || !strings.Contains(err.Error(), "5 MB") {
		t.Fatalf("una WebP de 6 MB tenía que rechazarse con un mensaje claro: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("el rechazo no deja archivos: %v", entries)
	}
}

// El tope de lo que se acepta es 20 MB.
func TestImageInputLimitIs20MB(t *testing.T) {
	dir := t.TempDir()
	_, err := SaveFile(dir, "enorme.png", b64(pngHead+strings.Repeat("\x00", MaxImageBytes)))
	if err == nil || !strings.Contains(err.Error(), "enorme.png") || !strings.Contains(err.Error(), "20 MB") {
		t.Errorf("más de 20 MB tenía que rechazarse diciendo el tope: %v", err)
	}
	if MaxImageBytes != 20<<20 || CLIAttachmentCaps("claude").MaxImageBytes != 20<<20 {
		t.Error("el tope que ve el frontend es 20 MB")
	}
}

// La copia recodificada pierde el EXIF, así que la rotación tiene que quedar en
// los píxeles: una foto vertical de teléfono no puede llegar acostada.
func TestReduceImageAppliesExifOrientation(t *testing.T) {
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, noisy(3000, 1000), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	// Orientación 6 (girar 90° en sentido horario), little-endian.
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
	seg := append([]byte("Exif\x00\x00"), tiff...)
	exif := append([]byte{0xFF, 0xE1, byte((len(seg) + 2) >> 8), byte(len(seg) + 2)}, seg...)
	raw := append(append(append([]byte{}, jpg.Bytes()[:2]...), exif...), jpg.Bytes()[2:]...)
	if exifOrientation(raw) != 6 {
		t.Fatalf("el EXIF de prueba no se lee: %d", exifOrientation(raw))
	}
	if len(raw) > MaxModelImageBytes {
		t.Skipf("la foto de prueba pesa %d: ya no entra en el caso «solo por lado»", len(raw))
	}
	out, _, reduced, err := ReduceImage("vertical.jpg", raw, "image/jpeg")
	if err != nil || !reduced {
		t.Fatalf("reduced=%v err=%v", reduced, err)
	}
	if w, h := dimsOf(t, out); w >= h || h != MaxImageSide {
		t.Errorf("medidas %dx%d: tenía que quedar vertical de 2048 de alto", w, h)
	}
}
