package agentchat

import (
	"bytes"
	"image"
	"image/draw"
	_ "image/gif" // registra el decodificador: image.Decode lee GIF
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"mini-tools/backend/i18n"
)

// Imágenes grandes del chat: no se rechazan, se reducen al adjuntar.
//
// Una foto de un teléfono pesa 6–15 MB y mide 4000 px de lado; la API de
// Anthropic acepta 5 MB por imagen y ningún modelo necesita más de ~2000 px
// para verla. Así que:
//
//   - se acepta hasta MaxImageBytes (20 MB);
//   - al modelo —servidores LLM y CLIs— va una COPIA reducida a MaxImageSide px
//     de lado y por debajo de MaxModelImageBytes (PNG si tiene transparencia y
//     cabe, si no JPEG sobre blanco, bajando calidad y después tamaño). Si la
//     imagen ya cabe se usa tal cual, sin recomprimir;
//   - el ORIGINAL queda intacto: la copia es otro archivo, al lado, en la
//     carpeta de adjuntos de la app (nunca en el repositorio del usuario), y
//     se borra con la misma limpieza diaria.
//
// Solo stdlib: no hay golang.org/x/image, así que no hay decodificador de WebP.
// Una WebP que cabe pasa tal cual (no se puede mirar por dentro); una WebP de
// más de 5 MB se rechaza diciendo cómo arreglarlo.
const (
	// MaxModelImageBytes es lo que acepta el modelo por imagen (la API de Anthropic).
	MaxModelImageBytes = 5 << 20
	// MaxImageSide es el lado mayor de la copia que va al modelo.
	MaxImageSide = 2048
	// MaxImagePixels acota los píxeles que se decodifican. La cabecera se lee
	// con image.DecodeConfig ANTES de decodificar: un PNG de 60000×60000 pesa
	// unos pocos KB y ocuparía gigas en memoria (bomba de descompresión).
	MaxImagePixels = 50_000_000

	// modelCopyMark separa el nombre del adjunto de la marca de su copia reducida.
	modelCopyMark = "-modelo"
)

// ReduceImage devuelve la versión de la imagen que va al modelo. Si ya cabe
// (lado ≤ MaxImageSide y ≤ MaxModelImageBytes) es la misma, sin tocar
// (reduced=false). Si no, una copia reducida y recomprimida con su tipo MIME.
// name solo sirve para nombrar el archivo en los errores; mime es el del
// original (se devuelve tal cual cuando no se reduce).
func ReduceImage(name string, raw []byte, mime string) (out []byte, outMime string, reduced bool, err error) {
	cfg, format, cerr := image.DecodeConfig(bytes.NewReader(raw))
	if cerr != nil {
		// Sin decodificador (WebP) o archivo dañado: si cabe se manda y que lo
		// diga el modelo; si no, no hay forma de reducirlo.
		if len(raw) <= MaxModelImageBytes {
			return raw, mime, false, nil
		}
		return nil, "", false, i18n.Errorf(i18n.Msg{
			ES: "%q pesa más de %s y no se puede reducir (solo se reducen PNG, JPG y GIF; una WebP grande hay que convertirla a PNG o JPG, o achicarla, antes de adjuntarla)",
			EN: "%q is larger than %s and cannot be reduced (only PNG, JPG and GIF can be reduced; a large WebP has to be converted to PNG or JPG, or made smaller, before attaching it)",
		}, name, FormatBytes(MaxModelImageBytes))
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, "", false, i18n.Errorf(i18n.Msg{ES: "%q: la imagen no tiene medidas válidas", EN: "%q: the image has no valid dimensions"}, name)
	}
	if px := int64(cfg.Width) * int64(cfg.Height); px > MaxImagePixels {
		return nil, "", false, i18n.Errorf(i18n.Msg{
			ES: "%q mide %d×%d px (%d Mpx) y el máximo es %d Mpx: achicala antes de adjuntarla",
			EN: "%q is %d×%d px (%d MP) and the maximum is %d MP: make it smaller before attaching it",
		}, name, cfg.Width, cfg.Height, px/1_000_000, MaxImagePixels/1_000_000)
	}
	if len(raw) <= MaxModelImageBytes && cfg.Width <= MaxImageSide && cfg.Height <= MaxImageSide {
		return raw, mime, false, nil
	}

	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", false, i18n.Errorf(i18n.Msg{
			ES: "%q: no se pudo leer la imagen para reducirla: %w",
			EN: "%q: the image could not be read to reduce it: %w",
		}, name, err)
	}
	hasAlpha := true
	if o, ok := src.(interface{ Opaque() bool }); ok {
		hasAlpha = !o.Opaque()
	}
	orientation := 1
	if format == "jpeg" {
		orientation = exifOrientation(raw)
	}

	// Primero se reduce (más barato) y después se orienta: la copia pierde el
	// EXIF al recodificarse, así que la rotación tiene que quedar en los píxeles
	// o la foto de un teléfono llegaría al modelo de lado.
	sb := src.Bounds()
	dw, dh := fitDims(sb.Dx(), sb.Dy(), MaxImageSide)
	base := orientRGBA64(boxScale(src, dw, dh), orientation)

	if hasAlpha {
		var buf bytes.Buffer
		if err := png.Encode(&buf, straightNRGBA(base)); err == nil && buf.Len() <= MaxModelImageBytes {
			return buf.Bytes(), "image/png", true, nil
		}
	}
	// JPEG sobre blanco; si todavía pesa de más (una foto con mucho ruido), se
	// baja la calidad y después el tamaño.
	cur := base
	for side := MaxImageSide; side >= 512; side /= 2 {
		if bb := base.Bounds(); max(bb.Dx(), bb.Dy()) > side {
			w, h := fitDims(bb.Dx(), bb.Dy(), side)
			cur = boxScale(base, w, h)
		}
		flat := flattenOnWhite(cur)
		for _, q := range []int{88, 80, 70} {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, flat, &jpeg.Options{Quality: q}); err != nil {
				return nil, "", false, err
			}
			if buf.Len() <= MaxModelImageBytes {
				return buf.Bytes(), "image/jpeg", true, nil
			}
		}
	}
	return nil, "", false, i18n.Errorf(i18n.Msg{
		ES: "%q: no se pudo reducir la imagen por debajo de %s",
		EN: "%q: the image could not be reduced below %s",
	}, name, FormatBytes(MaxModelImageBytes))
}

// fitDims devuelve las medidas de w×h con el lado mayor a lo más side px y la
// misma proporción.
func fitDims(w, h, side int) (int, int) {
	if max(w, h) <= side {
		return w, h
	}
	if w >= h {
		return side, max(1, h*side/w)
	}
	return max(1, w*side/h), side
}

// boxScale lleva src a dw×dh promediando los píxeles de origen que caen en cada
// píxel de destino (un filtro de caja, de área): suficiente para reducir una
// foto y sin depender de golang.org/x/image. Promedia en color premultiplicado,
// que es el que devuelve At().RGBA(): la transparencia pondera bien.
func boxScale(src image.Image, dw, dh int) *image.RGBA64 {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	dst := image.NewRGBA64(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0, y1 := y*sh/dh, (y+1)*sh/dh
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < dw; x++ {
			x0, x1 := x*sw/dw, (x+1)*sw/dw
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, b, a, n uint64
			for sy := y0; sy < y1 && sy < sh; sy++ {
				for sx := x0; sx < x1 && sx < sw; sx++ {
					cr, cg, cb, ca := src.At(sb.Min.X+sx, sb.Min.Y+sy).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					b += uint64(cb)
					a += uint64(ca)
					n++
				}
			}
			if n == 0 {
				continue
			}
			o := dst.PixOffset(x, y)
			put16(dst.Pix[o:], uint16(r/n))
			put16(dst.Pix[o+2:], uint16(g/n))
			put16(dst.Pix[o+4:], uint16(b/n))
			put16(dst.Pix[o+6:], uint16(a/n))
		}
	}
	return dst
}

func put16(p []byte, v uint16) {
	p[0] = byte(v >> 8)
	p[1] = byte(v)
}

// straightNRGBA pasa la imagen (premultiplicada) a NRGBA de 8 bits, que es lo
// que un PNG con transparencia guarda.
func straightNRGBA(src *image.RGBA64) *image.NRGBA {
	dst := image.NewNRGBA(src.Bounds())
	draw.Draw(dst, dst.Bounds(), src, src.Bounds().Min, draw.Src)
	return dst
}

// flattenOnWhite compone la imagen sobre blanco (el JPEG no tiene canal alfa).
func flattenOnWhite(src *image.RGBA64) *image.RGBA {
	dst := image.NewRGBA(src.Bounds())
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), src, src.Bounds().Min, draw.Over)
	return dst
}

// orientRGBA64 aplica la orientación EXIF (1–8) y devuelve la imagen resultante
// (la misma si no hay nada que girar).
func orientRGBA64(src *image.RGBA64, o int) *image.RGBA64 {
	if o < 2 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	nw, nh := w, h
	if o >= 5 {
		nw, nh = h, w
	}
	dst := image.NewRGBA64(image.Rect(0, 0, nw, nh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2: // espejo horizontal
				dx, dy = w-1-x, y
			case 3: // 180°
				dx, dy = w-1-x, h-1-y
			case 4: // espejo vertical
				dx, dy = x, h-1-y
			case 5: // transpuesta
				dx, dy = y, x
			case 6: // 90° horario
				dx, dy = h-1-y, x
			case 7: // transversa
				dx, dy = h-1-y, w-1-x
			case 8: // 90° antihorario
				dx, dy = y, w-1-x
			}
			copy(dst.Pix[dst.PixOffset(dx, dy):dst.PixOffset(dx, dy)+8], src.Pix[src.PixOffset(x, y):src.PixOffset(x, y)+8])
		}
	}
	return dst
}

// exifOrientation lee la etiqueta de orientación EXIF de un JPEG (1 si no hay).
// Un teléfono guarda las fotos «de lado» y anota ahí cómo girarlas: la copia
// reducida se recodifica sin EXIF, así que ignorarlo la mandaría acostada.
func exifOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		if marker == 0xD9 || marker == 0xDA { // fin o datos de imagen
			return 1
		}
		if marker == 0xFF {
			i++
			continue
		}
		n := int(data[i+2])<<8 | int(data[i+3])
		if n < 2 || i+2+n > len(data) {
			return 1
		}
		seg := data[i+4 : i+2+n]
		if marker == 0xE1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		i += 2 + n
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var u16, u32 func([]byte) int
	switch string(t[:2]) {
	case "II":
		u16 = func(b []byte) int { return int(b[0]) | int(b[1])<<8 }
		u32 = func(b []byte) int { return int(b[0]) | int(b[1])<<8 | int(b[2])<<16 | int(b[3])<<24 }
	case "MM":
		u16 = func(b []byte) int { return int(b[0])<<8 | int(b[1]) }
		u32 = func(b []byte) int { return int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3]) }
	default:
		return 1
	}
	off := u32(t[4:8])
	if off < 8 || off+2 > len(t) {
		return 1
	}
	n := u16(t[off : off+2])
	for k := 0; k < n; k++ {
		e := off + 2 + 12*k
		if e+12 > len(t) {
			return 1
		}
		if u16(t[e:e+2]) == 0x0112 { // Orientation
			if v := u16(t[e+8 : e+10]); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// --- La copia en disco -------------------------------------------------------------

// modelCopyPath es la ruta de la copia reducida de un adjunto: al lado del
// original, con la marca «-modelo» y la extensión del formato que salió. Lleva
// el prefijo «adjunto-» del original, así que la limpieza diaria la borra sola.
func modelCopyPath(path, outMime string) string {
	ext := ".jpg"
	if outMime == "image/png" {
		ext = ".png"
	}
	return strings.TrimSuffix(path, filepath.Ext(path)) + modelCopyMark + ext
}

// existingModelCopy devuelve la copia reducida ya escrita de un adjunto, o "".
func existingModelCopy(path string) string {
	for _, mime := range []string{"image/jpeg", "image/png"} {
		p := modelCopyPath(path, mime)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			return p
		}
	}
	return ""
}

// ensureModelCopy devuelve el archivo que va al modelo para la imagen guardada
// en path: ella misma si ya cabe, o su copia reducida (escribiéndola si no
// existe). raw es el contenido, si ya está leído; nil = leerlo del disco. El
// original no se toca nunca.
//
// Se llama al guardar (para fallar antes de que la persona escriba el mensaje)
// y al enviar (cubre los adjuntos que no pasaron por SaveFile y la copia que se
// haya perdido).
func ensureModelCopy(path string, raw []byte, name, mime string) (string, error) {
	if p := existingModelCopy(path); p != "" {
		return p, nil
	}
	if raw == nil {
		var err error
		if raw, err = os.ReadFile(path); err != nil {
			return "", err
		}
	}
	out, outMime, reduced, err := ReduceImage(name, raw, mime)
	if err != nil {
		return "", err
	}
	if !reduced {
		return path, nil
	}
	copyPath := modelCopyPath(path, outMime)
	if err := os.WriteFile(copyPath, out, 0o600); err != nil {
		_ = os.Remove(copyPath)
		return "", i18n.Errorf(i18n.Msg{ES: "agentchat: escribiendo la copia reducida de la imagen: %w", EN: "agentchat: writing the reduced copy of the image: %w"}, err)
	}
	return copyPath, nil
}
