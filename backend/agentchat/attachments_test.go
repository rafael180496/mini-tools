package agentchat

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mini-tools/backend/llm"
)

var (
	pngHead = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
	pdfHead = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func saveOK(t *testing.T, dir, name, content string) Attachment {
	t.Helper()
	a, err := SaveFile(dir, name, b64(content))
	if err != nil {
		t.Fatalf("SaveFile(%s): %v", name, err)
	}
	return a
}

// El tipo lo decide el contenido, no el nombre.
func TestSaveFileSniffsByContent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "adjuntos")
	cases := []struct {
		name, content, kind, mime string
	}{
		{"captura.png", pngHead, AttachImage, "image/png"},
		// Una imagen con el nombre equivocado sigue siendo imagen.
		{"foto.dat", pngHead, AttachImage, "image/png"},
		{"x.jpg", "\xff\xd8\xff\xe0\x00\x10JFIF\x00", AttachImage, "image/jpeg"},
		{"informe.PDF", pdfHead, AttachPDF, "application/pdf"},
		{"main.go", "package main\n\nfunc main() {}\n", AttachText, "text/plain"},
		{"datos.json", `{"a":1}`, AttachText, "application/json"},
		{"README.md", "# Hola\n", AttachText, "text/markdown"},
		{"Dockerfile", "FROM alpine\n", AttachText, "text/plain"},
		// Un log con colores ANSI le parece binario al sniffer: la extensión lo rescata.
		{"app.log", "\x1b[31mERROR\x1b[0m algo\n", AttachText, "text/plain"},
		// Un archivo de texto con nombre de imagen es texto.
		{"nota.png", "esto es texto, no una imagen\n", AttachText, "text/plain"},
	}
	for _, c := range cases {
		a := saveOK(t, dir, c.name, c.content)
		if a.Kind != c.kind || a.Mime != c.mime {
			t.Errorf("%s: kind=%s mime=%s, quería %s %s", c.name, a.Kind, a.Mime, c.kind, c.mime)
		}
		if a.Size != int64(len(c.content)) || filepath.Dir(a.Path) != dir {
			t.Errorf("%s: ficha %+v", c.name, a)
		}
		if got, _ := os.ReadFile(a.Path); string(got) != c.content {
			t.Errorf("%s: el contenido no se guardó igual", c.name)
		}
	}
}

func TestSaveFileRejectsUnknownBinariesAndBadText(t *testing.T) {
	dir := t.TempDir()
	bad := map[string]string{
		"programa.exe": "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff",
		"firma.zip":    "PK\x03\x04\x14\x00\x00\x00",
		"icono.bmp":    "BM\x36\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00\x28\x00",
		// Texto que dice serlo pero no es UTF-8 válido o trae nulos.
		"latin.txt": "caf\xe9 con leche",
		"nulos.txt": "abc\x00def",
		"utf16.txt": "\xff\xfeh\x00o\x00l\x00a\x00",
	}
	for name, content := range bad {
		if _, err := SaveFile(dir, name, b64(content)); err == nil {
			t.Errorf("%s debía rechazarse", name)
		}
	}
	if _, err := SaveFile(dir, "vacio.txt", ""); err == nil {
		t.Error("un archivo vacío debía rechazarse")
	}
	if _, err := SaveFile(dir, "x.txt", "esto no es base64 !!!"); err == nil {
		t.Error("base64 inválido debía rechazarse")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("un rechazo no deja archivos: %v", entries)
	}
	// El error explica qué se acepta.
	_, err := SaveFile(dir, "programa.exe", b64(bad["programa.exe"]))
	if err == nil || !strings.Contains(err.Error(), "programa.exe") {
		t.Errorf("el error debe nombrar el archivo: %v", err)
	}
}

func TestSaveFileLimitsPerKind(t *testing.T) {
	dir := t.TempDir()
	// Texto: justo en el tope entra, un byte más no.
	atLimit := strings.Repeat("a", MaxTextBytes)
	if _, err := SaveFile(dir, "ok.txt", b64(atLimit)); err != nil {
		t.Errorf("512 KB entra: %v", err)
	}
	if _, err := SaveFile(dir, "grande.txt", b64(atLimit+"a")); err == nil {
		t.Error("512 KB + 1 debía rechazarse")
	}
	// Imagen: justo en el tope entra (si se puede reducir), más no. El de más de
	// 20 MB y las grandes de verdad están en imagereduce_test.go.
	if _, err := SaveFile(dir, "ok.png", b64(pngHead+strings.Repeat("\x00", MaxModelImageBytes-len(pngHead)))); err != nil {
		t.Errorf("5 MB entra: %v", err)
	}
	// PDF: un PDF de 6 MB entra (su tope es otro).
	if _, err := SaveFile(dir, "libro.pdf", b64(pdfHead+strings.Repeat("\x00", 6<<20))); err != nil {
		t.Errorf("un PDF de 6 MB entra: %v", err)
	}
}

// El nombre del frontend no es una ruta: un `../` no escribe fuera del directorio.
func TestSaveFileSanitizesName(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "adjuntos")
	for _, name := range []string{"../../../evil.png", `..\..\evil.png`, "/etc/evil.png", "dir/evil.png"} {
		a := saveOK(t, dir, name, pngHead)
		if filepath.Dir(a.Path) != dir {
			t.Errorf("%q escribió fuera del directorio: %s", name, a.Path)
		}
		if a.Name != "evil.png" {
			t.Errorf("%q: nombre %q", name, a.Name)
		}
	}
	a := saveOK(t, dir, "informe final (v2).pdf", pdfHead)
	if a.Name == "" || strings.ContainsAny(filepath.Base(a.Path), "()/\\") {
		t.Errorf("el nombre en disco debe ser seguro: %s", a.Path)
	}
	// El nombre original se recupera del archivo guardado, sin estado aparte.
	if got := nameFromStored(a.Path); got != a.Name {
		t.Errorf("nameFromStored = %q, quería %q", got, a.Name)
	}
	// Una extensión que no corresponde al contenido se corrige: la imagen tiene que abrirse como tal.
	b := saveOK(t, dir, "foto.dat", pngHead)
	if filepath.Ext(b.Path) != ".png" {
		t.Errorf("la imagen guardada debe terminar en .png: %s", b.Path)
	}
	// Control y nombre vacío.
	if c := saveOK(t, dir, "\x00\x01", "x"); c.Name != "adjunto" {
		t.Errorf("un nombre sin nada mostrable cae a «adjunto»: %q", c.Name)
	}
}

// Los adjuntos viejos (de SaveAttachment y los nuevos) se limpian con la misma política de un día.
func TestSaveFilePrunesOldAttachments(t *testing.T) {
	dir := t.TempDir()
	viejo := filepath.Join(dir, "adjunto-1_viejo.pdf")
	if err := os.WriteFile(viejo, []byte(pdfHead), 0o600); err != nil {
		t.Fatal(err)
	}
	old := timeAgo(48)
	_ = os.Chtimes(viejo, old, old)
	saveOK(t, dir, "nuevo.txt", "x")
	if _, err := os.Stat(viejo); !os.IsNotExist(err) {
		t.Error("el adjunto vencido debía borrarse")
	}
}

func TestResolveAttachments(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "adjuntos")
	img := saveOK(t, dir, "captura.png", pngHead)
	pdf := saveOK(t, dir, "doc.pdf", pdfHead)
	txt := saveOK(t, dir, "main.go", "package main\n")

	got, err := ResolveAttachments(dir, []string{img.Path, pdf.Path, txt.Path})
	if err != nil || len(got) != 3 {
		t.Fatalf("Resolve: %+v, %v", got, err)
	}
	if got[0].Kind != AttachImage || got[0].Name != "captura.png" || got[1].Kind != AttachPDF || got[2].Kind != AttachText || got[2].Name != "main.go" {
		t.Errorf("fichas: %+v", got)
	}

	// Un archivo fuera de la carpeta de adjuntos NO se lee (es un «mandá este archivo» al modelo).
	outside := filepath.Join(root, "secreto.txt")
	_ = os.WriteFile(outside, []byte("clave=1234"), 0o600)
	if _, err := ResolveAttachments(dir, []string{outside}); err == nil || !strings.Contains(err.Error(), "carpeta de adjuntos") && !strings.Contains(err.Error(), "attachments folder") {
		t.Errorf("una ruta fuera de la carpeta debía rechazarse: %v", err)
	}
	if _, err := ResolveAttachments(dir, []string{filepath.Join(dir, "..", "secreto.txt")}); err == nil {
		t.Error("el .. no debe escapar de la carpeta")
	}
	// Ni siguiendo un enlace simbólico que apunta afuera.
	link := filepath.Join(dir, "adjunto-9_link.txt")
	if err := os.Symlink(outside, link); err == nil {
		if _, err := ResolveAttachments(dir, []string{link}); err == nil {
			t.Error("un symlink hacia afuera debía rechazarse")
		}
	}
	// Desapareció (se limpió al día): error que dice qué hacer.
	if _, err := ResolveAttachments(dir, []string{filepath.Join(dir, "adjunto-5_no.png")}); err == nil || !strings.Contains(err.Error(), "no-existe") && !strings.Contains(err.Error(), "adjunto-5_no.png") {
		t.Errorf("adjunto inexistente: %v", err)
	}
	// El tope se vuelve a comprobar al enviar: un archivo de más de 20 MB no pasa.
	big := filepath.Join(dir, "adjunto-7_big.png")
	f, _ := os.Create(big)
	_, _ = f.WriteString(pngHead)
	_ = f.Truncate(MaxImageBytes + 1)
	f.Close()
	if _, err := ResolveAttachments(dir, []string{big}); err == nil {
		t.Error("una imagen de más de 20 MB debía rechazarse al enviar")
	}
	bigPDF := filepath.Join(dir, "adjunto-8_big.pdf")
	f, _ = os.Create(bigPDF)
	_, _ = f.WriteString(pdfHead)
	_ = f.Truncate(MaxPDFBytes + 1)
	f.Close()
	if _, err := ResolveAttachments(dir, []string{bigPDF}); err == nil {
		t.Error("un PDF de más de 24 MB debía rechazarse al enviar")
	}
	// Tope de cantidad.
	many := make([]string, MaxAttachments+1)
	for i := range many {
		many[i] = img.Path
	}
	if _, err := ResolveAttachments(dir, many); err == nil {
		t.Error("más de 10 adjuntos debía rechazarse")
	}
	if got, err := ResolveAttachments(dir, nil); err != nil || got != nil {
		t.Errorf("sin adjuntos: %v %v", got, err)
	}
}

func TestPrepareAttachmentsPerProvider(t *testing.T) {
	dir := t.TempDir()
	img := saveOK(t, dir, "captura.png", pngHead)
	pdf := saveOK(t, dir, "doc.pdf", pdfHead)
	txt := saveOK(t, dir, "main.go", "package main\n\nfunc main() {}\n")
	all := []Attachment{img, pdf, txt}

	ollamaNoVision := CapsFromLLM(llm.AttachCaps{Known: true, Note: "sin visión"})
	// Imagen en un modelo que el proveedor dijo que no ve: error claro.
	_, err := PrepareAttachments([]Attachment{img}, ollamaNoVision, "Ollama · llama3.2")
	if err == nil || !strings.Contains(err.Error(), "Ollama · llama3.2") {
		t.Errorf("imagen sin visión (Known): %v", err)
	}
	// PDF para Ollama: se rechaza nombrando proveedor/modelo y el archivo.
	_, err = PrepareAttachments([]Attachment{pdf}, ollamaNoVision, "Ollama · llama3.2")
	if err == nil || !strings.Contains(err.Error(), "Ollama · llama3.2") || !strings.Contains(err.Error(), "doc.pdf") {
		t.Errorf("PDF a Ollama: %v", err)
	}
	// Sin información del proveedor (Known=false) la imagen se manda igual.
	assumed := CapsFromLLM(llm.AttachCaps{Images: true})
	p, err := PrepareAttachments([]Attachment{img}, assumed, "srv")
	if err != nil || len(p.Images) != 1 {
		t.Errorf("imagen supuesta: %+v %v", p, err)
	}
	// Aunque el «no» no sea conocido, el PDF no se manda a quien no lo lee.
	if _, err := PrepareAttachments([]Attachment{pdf}, assumed, "srv"); err == nil {
		t.Error("PDF sin soporte debía rechazarse aun con Known=false")
	}
	// Anthropic: todo.
	anth := CapsFromLLM(llm.AttachCaps{Images: true, PDF: true, Known: true})
	p, err = PrepareAttachments(all, anth, "Claude")
	if err != nil || len(p.Images) != 1 || len(p.PDFs) != 1 || !strings.Contains(p.Text, "main.go") {
		t.Errorf("anthropic: %+v %v", p, err)
	}
	// CLIs.
	if c := CLIAttachmentCaps("codex"); !c.Images || c.PDF || !c.Text {
		t.Errorf("codex: %+v", c)
	}
	if c := CLIAttachmentCaps("claude"); !c.Images || !c.PDF || !c.Text || !c.Known {
		t.Errorf("claude: %+v", c)
	}
	if c := CLIAttachmentCaps("antigravity"); !c.Images || c.PDF || c.Known {
		t.Errorf("antigravity: %+v", c)
	}
	if _, err := PrepareAttachments([]Attachment{pdf}, CLIAttachmentCaps("codex"), "Codex"); err == nil {
		t.Error("Codex no lee PDF")
	}
	// Los límites viajan en las capacidades para que la UI los muestre.
	c := CLIAttachmentCaps("claude")
	if c.MaxImageBytes != 20<<20 || c.MaxPDFBytes != 24<<20 || c.MaxTextBytes != 512<<10 || c.MaxCount != 10 {
		t.Errorf("límites: %+v", c)
	}
}

func TestTextBlockAndInlining(t *testing.T) {
	got := textBlock("main.go", "package main\n\n")
	want := "--- archivo: main.go ---\n```go\npackage main\n```"
	if got != want {
		t.Errorf("bloque:\n%s\nquería:\n%s", got, want)
	}
	// Un README con su propio bloque de código no cierra el nuestro antes de tiempo.
	nested := textBlock("README.md", "uso:\n```bash\nls\n```\n")
	if !strings.HasPrefix(nested, "--- archivo: README.md ---\n````markdown\n") || !strings.HasSuffix(nested, "\n````") {
		t.Errorf("la cerca debe ser más larga que la del contenido:\n%s", nested)
	}
	if !strings.Contains(textBlock("sin-ext", "x"), "```\nx\n```") {
		t.Error("sin lenguaje conocido, la cerca va sin etiqueta")
	}

	if WithText("hola", "") != "hola" || WithText("", "B") != "B" || WithText("hola", "B") != "hola\n\nB" {
		t.Error("WithText")
	}

	dir := t.TempDir()
	a := saveOK(t, dir, "a.sql", "select 1 from dual;\n")
	b := saveOK(t, dir, "b.yaml", "k: v\n")
	p, err := PrepareAttachments([]Attachment{a, b}, CLIAttachmentCaps("codex"), "Codex")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(p.Text, "--- archivo: a.sql ---\n```sql\nselect 1 from dual;\n```\n\n--- archivo: b.yaml ---\n```yaml\nk: v\n```") {
		t.Errorf("dos archivos:\n%s", p.Text)
	}
	if len(p.Images) != 0 || len(p.PDFs) != 0 {
		t.Errorf("el texto no viaja como imagen ni PDF: %+v", p)
	}
	// Un texto que creció después de guardarse (o un tope menor) se rechaza.
	small := CLIAttachmentCaps("codex")
	small.MaxTextBytes = 4
	if _, err := PrepareAttachments([]Attachment{a}, small, "Codex"); err == nil {
		t.Error("texto sobre el tope debía rechazarse")
	}
}

func TestCLIPromptNamesPathsAndCodexUsesFlag(t *testing.T) {
	atts := []Attachment{
		{Path: "/data/adjuntos/adjunto-1_captura.png", Name: "captura.png", Kind: AttachImage},
		{Path: "/data/adjuntos/adjunto-2_informe.pdf", Name: "informe.pdf", Kind: AttachPDF},
	}
	turn := Turn{
		Prompt: "revisá", Images: []string{atts[0].Path}, PDFs: []string{atts[1].Path}, Attachments: atts,
	}

	turn.AgentID, turn.Command = "claude", "claude"
	args, err := buildArgs(turn, "")
	if err != nil {
		t.Fatal(err)
	}
	prompt := args[argAfter(args, "-p")]
	for _, want := range []string{"revisá", atts[0].Path, "(captura.png)", atts[1].Path, "(informe.pdf)"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("claude: el prompt no menciona %q:\n%s", want, prompt)
		}
	}

	// Codex: las imágenes con -i y el prompt intacto (no lee PDF; PrepareAttachments ya lo rechazó antes).
	turn.AgentID, turn.Command, turn.PDFs = "codex", "codex", nil
	args, err = buildArgs(turn, "")
	if err != nil {
		t.Fatal(err)
	}
	if i := argAfter(args, "-i"); i < 0 || args[i] != atts[0].Path || args[len(args)-1] != "revisá" {
		t.Errorf("codex: %v", args)
	}

	// Antigravity: las imágenes nombradas en el prompt, el PDF jamás.
	turn.AgentID, turn.Command = "antigravity", "agy"
	turn.PDFs = []string{atts[1].Path}
	args, err = buildArgs(turn, "")
	if err != nil {
		t.Fatal(err)
	}
	p := args[argAfter(args, "--print")]
	if !strings.Contains(p, atts[0].Path) || strings.Contains(p, atts[1].Path) {
		t.Errorf("antigravity: %s", p)
	}
}

func argAfter(args []string, flag string) int {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return i + 1
		}
	}
	return -1
}

func TestAttachmentNoteAndSeedHistory(t *testing.T) {
	metas := []AttachmentMeta{{Name: "informe.pdf", Kind: AttachPDF, Size: 10}, {Name: "captura.png", Kind: AttachImage, Size: 5}}
	note := AttachmentNote(metas)
	if !strings.Contains(note, "informe.pdf, captura.png") || AttachmentNote(nil) != "" {
		t.Errorf("nota = %q", note)
	}

	got := SeedHistory([]HistoryMessage{
		{Role: "user", Content: "resumí esto", Attachments: metas},
		{Role: "assistant", Content: "listo"},
	}, 10, 0)
	if len(got) != 2 || !strings.Contains(got[0].Content, "resumí esto") || !strings.Contains(got[0].Content, "informe.pdf") {
		t.Fatalf("la siembra debe dejar los nombres: %+v", got)
	}
	// Solo nombres: nada que se pueda reenviar como archivo.
	if len(got[0].Images) != 0 || len(got[0].PDFs) != 0 {
		t.Errorf("los adjuntos del historial no se reenvían: %+v", got[0])
	}

	past := PastTurnsFromStored([]HistoryMessage{
		{Role: "user", Content: "hola", Attachments: metas},
		{Role: "assistant", Content: "ok"},
	})
	if len(past) != 2 || len(past[0].Attachments) != 2 || past[0].Attachments[0].Name != "informe.pdf" || len(past[1].Attachments) != 0 {
		t.Errorf("PastTurn: %+v", past)
	}
}

// Los adjuntos de un turno que terminó no se reenvían en el siguiente: ni sus
// bytes (imágenes y PDF) ni su ruta (que a las 24 h ya no existe). El texto
// pegado sí queda: es parte de lo que dijo la persona.
func TestRunnerDoesNotResendPastAttachments(t *testing.T) {
	dir := t.TempDir()
	img := saveOK(t, dir, "captura.png", pngHead)
	pdf := saveOK(t, dir, "doc.pdf", pdfHead)

	f := &fakeLLM{models: []string{"m"}, reply: "visto"}
	col := newCollector()
	m := NewManager(col.emit)
	t1 := Turn{
		SessionID: "s", AgentID: "llm:a", LLM: f,
		Prompt: "mirá\n\n--- archivo: a.go ---\n```go\nx\n```",
		Images: []string{img.Path}, PDFs: []string{pdf.Path}, Attachments: []Attachment{img, pdf},
	}
	if err := m.Send(t1); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	waitIdle(t, m, "s")

	// El primer request SÍ lleva los archivos.
	first := f.requests[0].Messages
	last := first[len(first)-1]
	if len(last.Images) != 1 || len(last.PDFs) != 1 {
		t.Fatalf("el primer turno debe llevar imagen y PDF: %+v", last)
	}

	if err := m.Send(Turn{SessionID: "s", AgentID: "llm:a", LLM: f, Prompt: "¿y ahora?"}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	waitIdle(t, m, "s")
	second := f.requests[1].Messages
	for i, msg := range second {
		if len(msg.Images) != 0 || len(msg.PDFs) != 0 {
			t.Errorf("mensaje %d reenvía archivos del turno anterior: %+v", i, msg)
		}
	}
	u := second[1]
	if !strings.Contains(u.Content, "captura.png, doc.pdf") || !strings.Contains(u.Content, "--- archivo: a.go ---") {
		t.Errorf("queda el nombre de los adjuntos y el texto pegado:\n%s", u.Content)
	}
}

func timeAgo(hours int) time.Time { return time.Now().Add(-time.Duration(hours) * time.Hour) }
