package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/agentchat"
)

const (
	testPNG = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
	testPDF = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"
)

// ollamaAttach es un Ollama de mentira: contesta el chequeo previo, /api/show
// con las capacidades que se le den y /api/chat guardando el cuerpo.
type ollamaAttach struct {
	mu   sync.Mutex
	caps string
	chat []map[string]any
}

func (o *ollamaAttach) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/version":
		fmt.Fprint(w, `{"version":"0.9.1"}`)
	case "/api/tags":
		fmt.Fprint(w, `{"models":[{"name":"llava"}]}`)
	case "/api/show":
		fmt.Fprintf(w, `{"capabilities":%s}`, o.caps)
	case "/api/chat":
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		o.mu.Lock()
		o.chat = append(o.chat, body)
		o.mu.Unlock()
		fmt.Fprint(w, `{"model":"llava","message":{"role":"assistant","content":"visto"},"done":false}`+"\n"+`{"model":"llava","message":{"content":""},"done":true}`+"\n")
	default:
		http.NotFound(w, r)
	}
}

func (o *ollamaAttach) lastUser(t *testing.T) map[string]any {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.chat) == 0 {
		t.Fatal("el servidor no recibió ningún chat")
	}
	msgs, _ := o.chat[len(o.chat)-1]["messages"].([]any)
	for i := len(msgs) - 1; i >= 0; i-- {
		if m, _ := msgs[i].(map[string]any); m["role"] == "user" {
			return m
		}
	}
	t.Fatal("sin mensaje de usuario")
	return nil
}

func attachApp(t *testing.T, caps string) (*App, chan agentchat.Event, *ollamaAttach, string, string) {
	t.Helper()
	spanish(t)
	a, events := newChatApp(t)
	repoID, _ := addRepo(t, a)
	o := &ollamaAttach{caps: caps}
	ts := httptest.NewServer(o)
	t.Cleanup(ts.Close)
	srv := saveServer(t, a, "Ollama taller", ts.URL)
	return a, events, o, repoID, agentchat.LLMPrefix + srv.ID
}

func saveChatFile(t *testing.T, a *App, name, content string) agentchat.Attachment {
	t.Helper()
	att, err := a.SaveChatFile(name, base64.StdEncoding.EncodeToString([]byte(content)))
	if err != nil {
		t.Fatalf("SaveChatFile(%s): %v", name, err)
	}
	return att
}

func TestSaveChatFileReturnsTheCard(t *testing.T) {
	a, _ := newChatApp(t)
	att := saveChatFile(t, a, "informe.pdf", testPDF)
	if att.Kind != "pdf" || att.Mime != "application/pdf" || att.Name != "informe.pdf" || att.Size != int64(len(testPDF)) {
		t.Fatalf("ficha: %+v", att)
	}
	if dir, _ := chatAttachmentsDir(); filepath.Dir(att.Path) != dir {
		t.Errorf("va a la carpeta de adjuntos de la app: %s", att.Path)
	}
	// El binding viejo sigue andando.
	p, err := a.SaveChatAttachment("c.png", base64.StdEncoding.EncodeToString([]byte(testPNG)))
	if err != nil || p == "" {
		t.Errorf("SaveChatAttachment: %q %v", p, err)
	}
	// La ficha viaja con estas claves.
	b, _ := json.Marshal(att)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"path", "name", "kind", "mime", "size"} {
		if _, ok := m[k]; !ok {
			t.Errorf("falta %q en %s", k, b)
		}
	}
	if _, err := a.SaveChatFile("x.exe", base64.StdEncoding.EncodeToString([]byte("MZ\x90\x00\x03\x00"))); err == nil {
		t.Error("un binario desconocido debía rechazarse")
	}
}

func TestAgentAttachmentCapabilities(t *testing.T) {
	a, _, _, _, ollama := attachApp(t, `["completion","vision"]`)

	cli := func(id string) agentchat.AttachmentCaps {
		c, err := a.AgentAttachmentCapabilities(id, "")
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		return c
	}
	if c := cli("claude"); !c.Images || !c.PDF || !c.Text || !c.Known {
		t.Errorf("claude: %+v", c)
	}
	if c := cli("codex"); !c.Images || c.PDF || !c.Text {
		t.Errorf("codex: %+v", c)
	}
	if c := cli("antigravity"); !c.Images || c.PDF || c.Known {
		t.Errorf("antigravity: %+v", c)
	}
	c, err := a.AgentAttachmentCapabilities(ollama, "llava")
	if err != nil || !c.Images || !c.Known || c.PDF || !c.Text || c.MaxImageBytes != 20<<20 || c.MaxCount != 10 {
		t.Errorf("ollama con visión: %+v %v", c, err)
	}
	// Sin modelo elegido se resuelve el del proveedor (el primero que liste).
	if c, err := a.AgentAttachmentCapabilities(ollama, ""); err != nil || !c.Images || !c.Known {
		t.Errorf("modelo por defecto: %+v %v", c, err)
	}
	if _, err := a.AgentAttachmentCapabilities("no-existe", ""); err == nil {
		t.Error("un agente desconocido debía fallar")
	}
}

func TestSendAgentChatRejectsUnsupportedAttachments(t *testing.T) {
	a, _, o, repoID, agent := attachApp(t, `["completion"]`)
	img := saveChatFile(t, a, "captura.png", testPNG)
	pdf := saveChatFile(t, a, "doc.pdf", testPDF)

	// Imagen en un modelo que Ollama dijo que no ve.
	err := a.SendAgentChat("c1", "git", repoID, agent, "mirá", "", "", "llama3", []string{img.Path})
	if err == nil || !strings.Contains(err.Error(), "Ollama taller · llama3") || !strings.Contains(err.Error(), "imágenes") {
		t.Errorf("imagen sin visión: %v", err)
	}
	// PDF: nadie en esta app lo lee salvo Anthropic y Claude Code.
	err = a.SendAgentChat("c1", "git", repoID, agent, "resumí", "", "", "llama3", []string{pdf.Path})
	if err == nil || !strings.Contains(err.Error(), "Ollama taller · llama3") || !strings.Contains(err.Error(), "PDF") {
		t.Errorf("PDF a Ollama: %v", err)
	}
	// Una ruta que no es de la carpeta de adjuntos nunca se lee.
	outside := filepath.Join(t.TempDir(), "secreto.txt")
	_ = os.WriteFile(outside, []byte("clave=1234"), 0o600)
	err = a.SendAgentChat("c1", "git", repoID, agent, "leé", "", "", "llama3", []string{outside})
	if err == nil || !strings.Contains(err.Error(), "carpeta de adjuntos") {
		t.Errorf("ruta ajena: %v", err)
	}
	// Nada de eso llegó a Ollama ni dejó un chat a medias.
	if len(o.chat) != 0 {
		t.Errorf("el servidor recibió %d chats", len(o.chat))
	}
	if chats, _ := a.vault.ListAllAgentChats(); len(chats) != 0 {
		t.Errorf("un rechazo no crea chats: %+v", chats)
	}
	// PDF a Codex: también.
	if err := a.SendAgentChat("c2", "git", repoID, "codex", "resumí", "", "", "", []string{pdf.Path}); err == nil || !strings.Contains(err.Error(), "PDF") {
		t.Errorf("PDF a Codex: %v", err)
	}
}

// De punta a punta con Ollama con visión: la imagen viaja en base64, el texto
// va pegado en el mensaje, y el historial guarda solo la ficha.
func TestSendAgentChatWithAttachmentsAndHistory(t *testing.T) {
	a, events, o, repoID, agent := attachApp(t, `["completion","vision"]`)
	img := saveChatFile(t, a, "captura.png", testPNG)
	code := saveChatFile(t, a, "main.go", "package main\n\nfunc secreto() {}\n")

	if err := a.SendAgentChat("chat-a", "git", repoID, agent, "¿qué ves?", "", "", "llava", []string{img.Path, code.Path}); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "chat-a")

	u := o.lastUser(t)
	imgs, _ := u["images"].([]any)
	if len(imgs) != 1 || imgs[0] != base64.StdEncoding.EncodeToString([]byte(testPNG)) {
		t.Errorf("la imagen viaja en base64: %v", u["images"])
	}
	content, _ := u["content"].(string)
	if !strings.HasPrefix(content, "¿qué ves?") || !strings.Contains(content, "--- archivo: main.go ---\n```go\npackage main") {
		t.Errorf("el texto va pegado en el mensaje:\n%s", content)
	}

	msgs, err := a.AgentChatMessages("chat-a")
	if err != nil || len(msgs) != 2 {
		t.Fatalf("msgs = %+v, %v", msgs, err)
	}
	user := msgs[0]
	// El historial guarda lo escrito: ni el contenido del archivo ni su ruta.
	if user.Content != "¿qué ves?" || strings.Contains(user.Content, "secreto") {
		t.Errorf("contenido del usuario: %q", user.Content)
	}
	if len(user.Attachments) != 2 || user.Attachments[0].Name != "captura.png" || user.Attachments[0].Kind != "image" ||
		user.Attachments[1].Name != "main.go" || user.Attachments[1].Kind != "text" || user.Attachments[1].Size != code.Size {
		t.Errorf("attachments = %+v", user.Attachments)
	}
	if msgs[1].Attachments == nil || len(msgs[1].Attachments) != 0 {
		t.Errorf("las filas sin adjuntos traen lista vacía: %+v", msgs[1].Attachments)
	}
	// El JSON del binding.
	b, _ := json.Marshal(user)
	if !strings.Contains(string(b), `"attachments":[{"name":"captura.png","kind":"image","size":`) {
		t.Errorf("json: %s", b)
	}
	// Retomar el chat: los chips vuelven por AgentChatHistory también.
	past, err := a.AgentChatHistory(agent, "chat-a")
	if err != nil || len(past) != 2 || len(past[0].Attachments) != 2 {
		t.Errorf("past = %+v, %v", past, err)
	}
}

// Solo adjuntos, sin texto: el turno no va vacío y el chat se titula con el archivo.
func TestSendAgentChatAttachmentOnly(t *testing.T) {
	a, events, o, repoID, agent := attachApp(t, `["completion"]`)
	txt := saveChatFile(t, a, "error.log", "boom\n")

	if err := a.SendAgentChat("chat-b", "git", repoID, agent, "  ", "", "", "llama3", []string{txt.Path}); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "chat-b")
	content, _ := o.lastUser(t)["content"].(string)
	if !strings.HasPrefix(content, agentchat.DefaultAttachmentPrompt()) || !strings.Contains(content, "--- archivo: error.log ---") {
		t.Errorf("mensaje:\n%s", content)
	}
	chats, _ := a.vault.ListAllAgentChats()
	if len(chats) != 1 || chats[0].Title != "error.log" {
		t.Errorf("título del chat: %+v", chats)
	}
	msgs, _ := a.AgentChatMessages("chat-b")
	if len(msgs) == 0 || msgs[0].Content != "" || len(msgs[0].Attachments) != 1 {
		t.Errorf("la fila del usuario guarda lo escrito (nada) y la ficha: %+v", msgs)
	}
}
