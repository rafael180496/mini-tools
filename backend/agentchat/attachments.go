package agentchat

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
)

// Adjuntos del chat: imágenes, PDF y archivos de texto o código.
//
// attach.go guarda imágenes y explica por qué van a un directorio de la app y
// no al repositorio. Este archivo generaliza eso a cualquier adjunto y agrega
// las dos mitades que faltaban:
//
//   - **Qué es el archivo** (Kind), decidido por su CONTENIDO y no por lo que
//     dice el nombre: http.DetectContentType para imágenes y PDF, y para el
//     texto una comprobación de UTF-8 sin bytes nulos, ayudada por la
//     extensión (un log con colores ANSI parece binario al sniffer y es texto).
//   - **Qué admite el destino** (AttachmentCaps) y cómo se entrega cada tipo.
//
// # Cómo llega cada tipo al modelo
//
//	imagen  API (Ollama/OpenAI/Anthropic): base64 en el request. CLIs: por ruta.
//	PDF     Anthropic: bloque `document` en base64. Claude Code: por ruta, que él
//	        sabe leer. Cualquier otro destino: se RECHAZA con un error claro —
//	        extraer el texto de un PDF sería una dependencia nueva y un resultado
//	        mediocre para cualquier cosa con tablas o escaneos.
//	texto   Para TODOS los destinos, incluidos los CLIs: pegado dentro del mensaje
//	        en un bloque con el nombre del archivo y su lenguaje. Un solo camino es
//	        más predecible que «por ruta en unos y pegado en otros», y evita que
//	        el contenido dependa de que el CLI tenga permiso de leer ese directorio.
//
// # El historial no guarda el contenido
//
// Lo que se persiste de un adjunto es su nombre, su tipo y su tamaño
// (AttachmentMeta); nunca los bytes. Y un adjunto viejo no se reenvía en los
// turnos siguientes (ver forgetAttachments): los archivos se borran al día.

// Límites. El de imagen es lo que se ACEPTA al adjuntar (una foto de teléfono):
// al modelo va una copia reducida de a lo sumo MaxModelImageBytes, el tope de la
// API de Anthropic (imagereduce.go). El de texto es lo que entra con holgura en
// el contexto de un modelo local. El de PDF queda por debajo de los 32 MB del
// request de Anthropic porque el PDF viaja en base64 (+33 %): con 32 MB de
// archivo el request se pasaría y la API contestaría 413.
const (
	MaxImageBytes  = 20 << 20
	MaxPDFBytes    = 24 << 20
	MaxTextBytes   = 512 << 10
	MaxAttachments = 10
)

// Tipos de adjunto.
const (
	AttachImage = "image"
	AttachPDF   = "pdf"
	AttachText  = "text"
	AttachOther = "other"
)

// Attachment es un adjunto ya guardado en la carpeta de la app.
type Attachment struct {
	Path string `json:"path"`
	// Name es el nombre original, saneado (sin directorios ni caracteres de
	// control). Se recupera del propio nombre del archivo guardado.
	Name string `json:"name"`
	Kind string `json:"kind"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
	// ModelPath es la copia reducida de una imagen grande, la que va al modelo;
	// "" si la imagen ya cabía y se usa Path. No viaja al frontend.
	ModelPath string `json:"-"`
}

// ModelFile es el archivo que se entrega al modelo: la copia reducida si hay,
// si no el adjunto tal cual.
func (a Attachment) ModelFile() string {
	if a.ModelPath != "" {
		return a.ModelPath
	}
	return a.Path
}

// AttachmentMeta es lo único que el historial guarda de un adjunto.
type AttachmentMeta struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

// Meta resume el adjunto a lo que se persiste.
func (a Attachment) Meta() AttachmentMeta {
	return AttachmentMeta{Name: a.Name, Kind: a.Kind, Size: a.Size}
}

// AttachmentCaps es lo que admite un proveedor/modelo como adjunto.
type AttachmentCaps struct {
	Images bool `json:"images"`
	PDF    bool `json:"pdf"`
	// Text es siempre true hoy: el texto se pega en el mensaje.
	Text bool `json:"text"`
	// Known: true = lo informó el proveedor; false = se supone. Con false, un
	// «no admite imágenes» nunca bloquea el envío.
	Known         bool   `json:"known"`
	MaxImageBytes int64  `json:"maxImageBytes"`
	MaxPDFBytes   int64  `json:"maxPdfBytes"`
	MaxTextBytes  int64  `json:"maxTextBytes"`
	MaxCount      int    `json:"maxCount"`
	Note          string `json:"note"`
}

func withLimits(c AttachmentCaps) AttachmentCaps {
	c.Text = true
	c.MaxImageBytes = MaxImageBytes
	c.MaxPDFBytes = MaxPDFBytes
	c.MaxTextBytes = MaxTextBytes
	c.MaxCount = MaxAttachments
	return c
}

// CapsFromLLM traduce lo que informó un cliente de modelos.
func CapsFromLLM(c llm.AttachCaps) AttachmentCaps {
	return withLimits(AttachmentCaps{Images: c.Images, PDF: c.PDF, Known: c.Known, Note: c.Note})
}

// CLIAttachmentCaps son los adjuntos de cada CLI. Salen de cómo cada uno recibe
// los archivos (ver buildArgs), no de una consulta: un CLI no tiene un
// «capabilities».
//
//   - claude: imágenes y PDF por ruta (su herramienta de lectura abre ambos).
//   - codex: imágenes con `-i`; el PDF no tiene camino documentado.
//   - antigravity: imágenes por ruta en el prompt; con el PDF no hay nada
//     verificado, así que se trata como no soportado en vez de prometerlo.
//   - opencode: imágenes por ruta en el prompt (su herramienta de lectura las
//     abre, verificado); el PDF no se probó, así que no se promete.
func CLIAttachmentCaps(agentID string) AttachmentCaps {
	switch agentID {
	case "claude":
		return withLimits(AttachmentCaps{Images: true, PDF: true, Known: true, Note: i18n.T(i18n.Msg{
			ES: "Claude Code lee las imágenes y los PDF por su ruta; los archivos de texto van pegados en el mensaje.",
			EN: "Claude Code reads images and PDFs by path; text files are pasted into the message.",
		})})
	case "codex":
		return withLimits(AttachmentCaps{Images: true, Known: true, Note: i18n.T(i18n.Msg{
			ES: "Codex recibe las imágenes con -i y los archivos de texto pegados en el mensaje. No lee PDF.",
			EN: "Codex receives images with -i and text files pasted into the message. It does not read PDFs.",
		})})
	case "antigravity":
		return withLimits(AttachmentCaps{Images: true, Known: false, Note: i18n.T(i18n.Msg{
			ES: "Antigravity recibe las imágenes por su ruta (no está verificado que las abra) y los archivos de texto pegados en el mensaje. Los PDF no se soportan.",
			EN: "Antigravity receives images by path (it is not verified that it opens them) and text files pasted into the message. PDFs are not supported.",
		})})
	case "opencode":
		return withLimits(AttachmentCaps{Images: true, Known: true, Note: i18n.T(i18n.Msg{
			ES: "OpenCode lee las imágenes por su ruta; los archivos de texto van pegados en el mensaje. No lee PDF.",
			EN: "OpenCode reads images by path; text files are pasted into the message. It does not read PDFs.",
		})})
	}
	return withLimits(AttachmentCaps{Images: false, Known: false, Note: i18n.T(i18n.Msg{
		ES: "Este agente solo recibe archivos de texto pegados en el mensaje.",
		EN: "This agent only receives text files pasted into the message.",
	})})
}

// --- Clasificación ---------------------------------------------------------------

var imageExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

// textLang son las extensiones que se tratan como texto aunque el sniffer no
// lo vea (un log con secuencias ANSI le parece binario) y el lenguaje con el
// que se rotula el bloque. "" = texto plano.
var textLang = map[string]string{
	".go": "go", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python", ".rb": "ruby", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c",
	".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".sql": "sql", ".pls": "sql", ".pks": "sql", ".pkb": "sql",
	".md": "markdown", ".markdown": "markdown", ".json": "json", ".jsonc": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
	".xml": "xml", ".html": "html", ".htm": "html", ".svg": "xml", ".css": "css", ".scss": "scss", ".csv": "csv", ".tsv": "",
	".log": "", ".txt": "", ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".ps1": "powershell", ".bat": "bat",
	".ini": "ini", ".conf": "", ".cfg": "ini", ".properties": "properties", ".env": "", ".gradle": "groovy", ".vue": "vue",
	".proto": "protobuf", ".tf": "hcl", ".lua": "lua", ".r": "r", ".dart": "dart", ".scala": "scala", ".diff": "diff", ".patch": "diff",
}

var textNameLang = map[string]string{"dockerfile": "dockerfile", "makefile": "makefile"}

var textMime = map[string]string{
	".json": "application/json", ".md": "text/markdown", ".csv": "text/csv", ".xml": "application/xml",
	".yaml": "application/yaml", ".yml": "application/yaml", ".html": "text/html", ".htm": "text/html",
}

func isTextName(name string) bool {
	if _, ok := textLang[strings.ToLower(filepath.Ext(name))]; ok {
		return true
	}
	_, ok := textNameLang[strings.ToLower(name)]
	return ok
}

// sniffKind decide qué es el archivo mirando su comienzo (hasta 512 bytes, que
// es lo que mira http.DetectContentType). Para el texto es solo un candidato:
// validText comprueba el archivo entero.
func sniffKind(name string, head []byte) (kind, mime string, err error) {
	ct := http.DetectContentType(head)
	base, _, _ := strings.Cut(ct, ";")
	switch {
	case imageExt[base] != "":
		return AttachImage, base, nil
	case strings.HasPrefix(base, "image/"):
		return AttachOther, base, i18n.Errorf(i18n.Msg{
			ES: "%q: formato de imagen no soportado (%s); usá PNG, JPG, GIF o WebP",
			EN: "%q: unsupported image format (%s); use PNG, JPG, GIF or WebP",
		}, name, base)
	case base == "application/pdf":
		return AttachPDF, base, nil
	case isTextName(name) || strings.HasPrefix(base, "text/"):
		m := textMime[strings.ToLower(filepath.Ext(name))]
		if m == "" {
			m = "text/plain"
		}
		return AttachText, m, nil
	}
	return AttachOther, base, i18n.Errorf(i18n.Msg{
		ES: "%q no se puede adjuntar (%s): solo imágenes PNG/JPG/GIF/WebP, PDF y archivos de texto o código",
		EN: "%q cannot be attached (%s): only PNG/JPG/GIF/WebP images, PDFs and text or code files",
	}, name, base)
}

// validText comprueba que el archivo entero sea texto UTF-8 sin bytes nulos.
// Un archivo en otra codificación (UTF-16, Latin-1) se rechaza en vez de
// pegarse como basura: el modelo leería caracteres rotos sin saberlo.
func validText(name string, data []byte) error {
	if len(data) > MaxTextBytes {
		return errTooBig(name, "texto", "text", MaxTextBytes)
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return i18n.Errorf(i18n.Msg{
			ES: "%q no es texto UTF-8: solo se adjuntan archivos de texto o código en UTF-8",
			EN: "%q is not UTF-8 text: only UTF-8 text or code files can be attached",
		}, name)
	}
	return nil
}

func errTooBig(name, kindES, kindEN string, limit int64) error {
	return i18n.Errorf(i18n.Msg{
		ES: "%q supera el tamaño máximo de un adjunto de %s (%s)",
		EN: "%q exceeds the maximum size of a %s attachment (%s)",
	}, name, pick(kindES, kindEN), FormatBytes(limit))
}

// pick elige el nombre del tipo según el idioma activo.
func pick(es, en string) string { return i18n.T(i18n.Msg{ES: es, EN: en}) }

// FormatBytes escribe un tamaño para un mensaje.
func FormatBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.4g MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.4g KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func limitFor(kind string) (limit int64, es, en string) {
	switch kind {
	case AttachImage:
		return MaxImageBytes, "imagen", "image"
	case AttachPDF:
		return MaxPDFBytes, "PDF", "PDF"
	}
	return MaxTextBytes, "texto", "text"
}

// cleanName deja de un nombre solo lo que se puede mostrar y poner en un nombre
// de archivo: sin directorios (se toma lo que sigue al último separador, de
// cualquiera de los dos sistemas), sin caracteres de control, acotado.
func cleanName(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	var b strings.Builder
	for _, r := range name {
		if unicode.IsControl(r) || r == utf8.RuneError {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(strings.Trim(b.String(), ". "))
	if r := []rune(out); len(r) > 100 {
		out = string(r[:100])
	}
	if out == "" {
		return "adjunto"
	}
	return out
}

// fsName es el nombre apto para el disco: letras, números y . _ - y espacio.
func fsName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r), r == '.', r == '-', r == ' ':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

const attachPrefix = "adjunto-"

// nameFromStored recupera el nombre original de un adjunto guardado:
// «adjunto-123456_informe.pdf» → «informe.pdf». Un nombre sin guion bajo (los
// de SaveAttachment) se devuelve sin el prefijo.
func nameFromStored(path string) string {
	base := strings.TrimPrefix(filepath.Base(path), attachPrefix)
	if _, rest, ok := strings.Cut(base, "_"); ok && rest != "" {
		return rest
	}
	return base
}

// SaveFile guarda un adjunto de cualquier tipo admitido y devuelve su ficha.
//
// name solo aporta el nombre a mostrar y la extensión; el archivo lo nombra
// este código (adjunto-<aleatorio>_<nombre saneado>), así que un `../` en
// name no puede escribir fuera de dir. Un archivo que no es imagen, PDF ni
// texto, o que supera el tope de su tipo, se rechaza con un error que dice por
// qué: es mejor fallar acá, antes de que la persona escriba el mensaje, que
// después de enviarlo.
func SaveFile(dir, name, dataBase64 string) (Attachment, error) {
	display := cleanName(name)
	if i := strings.Index(dataBase64, ","); strings.HasPrefix(dataBase64, "data:") && i > 0 {
		dataBase64 = dataBase64[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		return Attachment{}, i18n.Errorf(i18n.Msg{ES: "agentchat: el archivo %q no se pudo decodificar: %w", EN: "agentchat: the file %q could not be decoded: %w"}, display, err)
	}
	if len(raw) == 0 {
		return Attachment{}, i18n.Errorf(i18n.Msg{ES: "agentchat: el archivo %q está vacío", EN: "agentchat: the file %q is empty"}, display)
	}
	if len(raw) > MaxPDFBytes {
		return Attachment{}, errTooBig(display, "adjunto", "attachment", MaxPDFBytes)
	}
	head := raw
	if len(head) > 512 {
		head = head[:512]
	}
	kind, mime, err := sniffKind(display, head)
	if err != nil {
		return Attachment{}, err
	}
	limit, kes, ken := limitFor(kind)
	if int64(len(raw)) > limit {
		return Attachment{}, errTooBig(display, kes, ken, limit)
	}
	if kind == AttachText {
		if err := validText(display, raw); err != nil {
			return Attachment{}, err
		}
	}

	stored := fsName(display)
	switch kind {
	case AttachImage:
		stored = withExt(stored, imageExt[mime])
	case AttachPDF:
		stored = withExt(stored, ".pdf")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Attachment{}, i18n.Errorf(i18n.Msg{ES: "agentchat: preparando el directorio de adjuntos: %w", EN: "agentchat: preparing the attachments directory: %w"}, err)
	}
	pruneAttachments(dir)

	f, err := os.CreateTemp(dir, attachPrefix+"*_"+stored)
	if err != nil {
		return Attachment{}, i18n.Errorf(i18n.Msg{ES: "agentchat: creando el adjunto: %w", EN: "agentchat: creating the attachment: %w"}, err)
	}
	path := f.Name()
	if _, err := f.Write(raw); err != nil {
		f.Close()
		os.Remove(path)
		return Attachment{}, i18n.Errorf(i18n.Msg{ES: "agentchat: escribiendo el adjunto: %w", EN: "agentchat: writing the attachment: %w"}, err)
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return Attachment{}, err
	}
	att := Attachment{Path: path, Name: nameFromStored(path), Kind: kind, Mime: mime, Size: int64(len(raw))}
	if kind == AttachImage {
		// La copia que va al modelo se prepara ahora: una imagen que no se puede
		// reducir (una bomba, una WebP enorme) se rechaza antes de que la persona
		// escriba el mensaje, y sin dejar nada en la carpeta.
		mp, err := ensureModelCopy(path, raw, display, mime)
		if err != nil {
			os.Remove(path)
			return Attachment{}, err
		}
		if mp != path {
			att.ModelPath = mp
		}
	}
	return att, nil
}

// withExt asegura que el nombre termine en la extensión del tipo real: una
// captura guardada como «foto.dat» tiene que poder abrirse como imagen.
func withExt(name, ext string) string {
	if strings.EqualFold(filepath.Ext(name), ext) || (ext == ".jpg" && strings.EqualFold(filepath.Ext(name), ".jpeg")) {
		return name
	}
	return name + ext
}

// ResolveAttachments vuelve a leer, desde el disco, los adjuntos que el
// frontend nombra por ruta, y los clasifica OTRA VEZ.
//
// No se confía en nada de lo que traiga el frontend por dos razones, y la
// segunda es de seguridad: el texto de un adjunto se pega en el mensaje y viaja
// al modelo —quizá a un servidor remoto—, así que aceptar rutas arbitrarias
// sería un «leé este archivo y mandalo» para cualquier cosa que el proceso
// pueda abrir. Por eso cada ruta tiene que resolver (siguiendo enlaces) DENTRO
// de dir, la carpeta de adjuntos de la app.
func ResolveAttachments(dir string, paths []string) ([]Attachment, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	if len(paths) > MaxAttachments {
		return nil, i18n.Errorf(i18n.Msg{ES: "agentchat: se pueden adjuntar hasta %d archivos por mensaje (llegaron %d)", EN: "agentchat: up to %d files can be attached per message (got %d)"}, MaxAttachments, len(paths))
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		root = filepath.Clean(dir)
	}
	out := make([]Attachment, 0, len(paths))
	for _, p := range paths {
		real, err := filepath.EvalSymlinks(filepath.Clean(p))
		if err != nil {
			return nil, i18n.Errorf(i18n.Msg{
				ES: "agentchat: el adjunto %q ya no existe (los adjuntos se borran al cabo de un día); volvé a adjuntarlo",
				EN: "agentchat: the attachment %q no longer exists (attachments are deleted after a day); attach it again",
			}, filepath.Base(p))
		}
		if rel, err := filepath.Rel(root, real); err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return nil, i18n.Errorf(i18n.Msg{
				ES: "agentchat: %q no está en la carpeta de adjuntos de la app; adjuntalo con el botón o pegándolo",
				EN: "agentchat: %q is not in the app's attachments folder; attach it with the button or by pasting it",
			}, filepath.Base(p))
		}
		a, err := classifyStored(real)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// classifyStored lee el comienzo del archivo guardado y lo clasifica; si es
// texto lo lee entero para validarlo.
func classifyStored(path string) (Attachment, error) {
	name := nameFromStored(path)
	f, err := os.Open(path)
	if err != nil {
		return Attachment{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Attachment{}, err
	}
	if !info.Mode().IsRegular() {
		return Attachment{}, i18n.Errorf(i18n.Msg{ES: "agentchat: %q no es un archivo", EN: "agentchat: %q is not a file"}, name)
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return Attachment{}, err
	}
	kind, mime, err := sniffKind(name, head[:n])
	if err != nil {
		return Attachment{}, err
	}
	limit, kes, ken := limitFor(kind)
	if info.Size() > limit {
		return Attachment{}, errTooBig(name, kes, ken, limit)
	}
	if kind == AttachText {
		data, err := os.ReadFile(path)
		if err != nil {
			return Attachment{}, err
		}
		if err := validText(name, data); err != nil {
			return Attachment{}, err
		}
	}
	att := Attachment{Path: path, Name: name, Kind: kind, Mime: mime, Size: info.Size()}
	if kind == AttachImage {
		mp, err := ensureModelCopy(path, nil, name, mime)
		if err != nil {
			return Attachment{}, err
		}
		if mp != path {
			att.ModelPath = mp
		}
	}
	return att, nil
}

// --- Preparar el envío ------------------------------------------------------------

// Prepared es el reparto de los adjuntos de un mensaje según cómo viaja cada
// tipo.
type Prepared struct {
	Images []string
	PDFs   []string
	// Text son los bloques de los archivos de texto, listos para pegar al final
	// del mensaje (vacío si no hay).
	Text string
}

// PrepareAttachments valida los adjuntos contra lo que admite el destino y los
// reparte. who nombra al destino en los errores («Ollama · llama3.2»).
//
// Las reglas, en orden de severidad:
//
//   - PDF en un destino que no lo admite: error, siempre — no hay forma de
//     entregarlo y mandarlo igual sería perder el archivo en silencio.
//   - Imagen en un destino que informó que NO tiene visión (Known): error.
//     Si el destino no informa nada, se manda y que conteste el servidor.
//   - Texto: nunca se rechaza por el destino, solo por tamaño.
func PrepareAttachments(atts []Attachment, caps AttachmentCaps, who string) (Prepared, error) {
	var p Prepared
	if len(atts) > caps.MaxCount && caps.MaxCount > 0 {
		return p, i18n.Errorf(i18n.Msg{ES: "%s: se pueden adjuntar hasta %d archivos por mensaje", EN: "%s: up to %d files can be attached per message"}, who, caps.MaxCount)
	}
	var blocks []string
	for _, a := range atts {
		switch a.Kind {
		case AttachImage:
			if !caps.Images && caps.Known {
				return p, i18n.Errorf(i18n.Msg{
					ES: "%s no acepta imágenes (%q): elegí un modelo con visión o quitá el adjunto",
					EN: "%s does not accept images (%q): choose a model with vision or remove the attachment",
				}, who, a.Name)
			}
			if caps.MaxImageBytes > 0 && a.Size > caps.MaxImageBytes {
				return p, errTooBig(a.Name, "imagen", "image", caps.MaxImageBytes)
			}
			p.Images = append(p.Images, a.ModelFile())
		case AttachPDF:
			if !caps.PDF {
				return p, i18n.Errorf(i18n.Msg{
					ES: "%s no puede leer PDF (%q): usá Claude (API o Claude Code), o pegá el texto del documento",
					EN: "%s cannot read PDFs (%q): use Claude (API or Claude Code), or paste the document's text",
				}, who, a.Name)
			}
			if caps.MaxPDFBytes > 0 && a.Size > caps.MaxPDFBytes {
				return p, errTooBig(a.Name, "PDF", "PDF", caps.MaxPDFBytes)
			}
			p.PDFs = append(p.PDFs, a.Path)
		case AttachText:
			data, err := os.ReadFile(a.Path)
			if err != nil {
				return p, err
			}
			if caps.MaxTextBytes > 0 && int64(len(data)) > caps.MaxTextBytes {
				return p, errTooBig(a.Name, "texto", "text", caps.MaxTextBytes)
			}
			if err := validText(a.Name, data); err != nil {
				return p, err
			}
			blocks = append(blocks, textBlock(a.Name, string(data)))
		default:
			return p, i18n.Errorf(i18n.Msg{ES: "%q no se puede adjuntar", EN: "%q cannot be attached"}, a.Name)
		}
	}
	p.Text = strings.Join(blocks, "\n\n")
	return p, nil
}

// textBlock arma el bloque de un archivo de texto:
//
//	--- archivo: main.go ---
//	```go
//	...
//	```
//
// La cerca tiene un acento grave más que la racha más larga del contenido: un
// README con su propio bloque de código no puede cerrar el nuestro antes de
// tiempo.
func textBlock(name, content string) string {
	lang := textLang[strings.ToLower(filepath.Ext(name))]
	if lang == "" {
		lang = textNameLang[strings.ToLower(name)]
	}
	fence := strings.Repeat("`", max(3, longestRun(content, '`')+1))
	content = strings.TrimRight(content, "\n")
	header := i18n.T(i18n.Msg{ES: "--- archivo: %s ---", EN: "--- file: %s ---"}, name)
	return header + "\n" + fence + lang + "\n" + content + "\n" + fence
}

func longestRun(s string, c byte) int {
	best, cur := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			cur++
			best = max(best, cur)
		} else {
			cur = 0
		}
	}
	return best
}

// WithText pega los bloques de texto al final del mensaje.
func WithText(prompt, blocks string) string {
	if blocks == "" {
		return prompt
	}
	if strings.TrimSpace(prompt) == "" {
		return blocks
	}
	return prompt + "\n\n" + blocks
}

// DefaultAttachmentPrompt es el mensaje cuando la persona adjuntó archivos y no
// escribió nada: un turno no puede ir vacío, y «mirá esto» es lo que quiso decir.
func DefaultAttachmentPrompt() string {
	return i18n.T(i18n.Msg{ES: "Revisá los archivos adjuntos.", EN: "Take a look at the attached files."})
}

// --- Historial ---------------------------------------------------------------------

// Metas resume una lista de adjuntos a lo que se persiste.
func Metas(atts []Attachment) []AttachmentMeta {
	if len(atts) == 0 {
		return nil
	}
	out := make([]AttachmentMeta, len(atts))
	for i, a := range atts {
		out[i] = a.Meta()
	}
	return out
}

// AttachmentNote es la línea que reemplaza a los adjuntos cuando ya no se
// reenvían: solo los nombres, para que el modelo sepa que existieron.
func AttachmentNote(metas []AttachmentMeta) string {
	if len(metas) == 0 {
		return ""
	}
	names := make([]string, len(metas))
	for i, m := range metas {
		names[i] = m.Name
	}
	return i18n.T(i18n.Msg{
		ES: "[Adjuntos de este mensaje, que ya no se reenvían: %s]",
		EN: "[Attachments of this message, which are no longer resent: %s]",
	}, strings.Join(names, ", "))
}

// forgetAttachments saca de la memoria de la sesión los bytes de los adjuntos
// del turno que terminó (imágenes y PDF), dejando solo sus nombres. Se reenviaban
// enteros en cada mensaje siguiente: caro en tokens y, a las 24 horas, un error,
// porque el archivo ya no está. El texto pegado SÍ se conserva: es parte de lo
// que dijo la persona, y «¿y la línea 40 de ese archivo?» tiene que poder
// contestarse.
func forgetAttachments(msgs []llm.Message, t Turn) []llm.Message {
	if len(t.Images) == 0 && len(t.PDFs) == 0 {
		return msgs
	}
	var metas []AttachmentMeta
	for _, a := range t.Attachments {
		if a.Kind == AttachImage || a.Kind == AttachPDF {
			metas = append(metas, a.Meta())
		}
	}
	out := make([]llm.Message, len(msgs))
	copy(out, msgs)
	for i, m := range out {
		if m.Role != llm.RoleUser || (len(m.Images) == 0 && len(m.PDFs) == 0) {
			continue
		}
		m.Images, m.PDFs = nil, nil
		if note := AttachmentNote(metas); note != "" {
			m.Content = WithText(m.Content, note)
		}
		out[i] = m
	}
	return out
}

// withAttachmentPaths nombra los archivos adjuntos dentro del prompt, para los
// CLIs que los abren con su propia herramienta de lectura. names pone el nombre
// original entre paréntesis (la ruta lleva un id aleatorio).
func withAttachmentPaths(prompt string, images, pdfs []string, names map[string]string) string {
	if len(images) == 0 && len(pdfs) == 0 {
		return prompt
	}
	var b strings.Builder
	b.WriteString(prompt)
	list := func(title i18n.Msg, paths []string) {
		if len(paths) == 0 {
			return
		}
		b.WriteString("\n\n" + i18n.T(title))
		for _, p := range paths {
			b.WriteString("\n- ")
			b.WriteString(p)
			if n := names[p]; n != "" {
				b.WriteString(" (" + n + ")")
			}
		}
	}
	list(i18n.Msg{ES: "Imágenes adjuntas (abrilas para verlas):", EN: "Attached images (open them to see them):"}, images)
	list(i18n.Msg{ES: "PDF adjuntos (abrilos para leerlos):", EN: "Attached PDFs (open them to read them):"}, pdfs)
	return b.String()
}

// attachmentNames indexa el nombre original de cada adjunto por su ruta (y por
// la de su copia reducida, que es la que viaja en Images).
func attachmentNames(atts []Attachment) map[string]string {
	if len(atts) == 0 {
		return nil
	}
	m := make(map[string]string, len(atts))
	for _, a := range atts {
		m[a.Path] = a.Name
		if a.ModelPath != "" {
			m[a.ModelPath] = a.Name
		}
	}
	return m
}
