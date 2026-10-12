package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/mcpserver"
	"mini-tools/backend/vault"
)

func addRepo(t *testing.T, a *App) (id, path string) {
	t.Helper()
	dir := t.TempDir()
	r, err := a.vault.AddGitRepo("proyecto", dir)
	if err != nil {
		t.Fatal(err)
	}
	return r.ID, dir
}

func toolNames(set llmToolSet) string {
	var out []string
	for _, d := range set.Tools {
		out = append(out, d.Name)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

func TestAskApprovalWithAnswerCancelAndTimeout(t *testing.T) {
	a, _ := newChatApp(t)
	var mu sync.Mutex
	var events []string
	var lastReq agentapprove.Request
	arrived := make(chan struct{}, 4)
	emit := func(event string, data any) {
		mu.Lock()
		events = append(events, event)
		if r, ok := data.(agentapprove.Request); ok {
			lastReq = r
		}
		mu.Unlock()
		if event == "agent-approval" {
			arrived <- struct{}{}
		}
	}
	pending := func() int {
		a.approveMu.Lock()
		defer a.approveMu.Unlock()
		return len(a.approvePending)
	}
	req := agentapprove.Request{Tool: "write_file", Summary: "a.txt"}

	// 1. El usuario contesta que sí.
	done := make(chan agentapprove.Decision, 1)
	go func() { done <- a.askApprovalWith(context.Background(), req, time.Minute, emit) }()
	<-arrived
	mu.Lock()
	id1 := lastReq.ID
	mu.Unlock()
	if !strings.HasPrefix(id1, "llm-approve-") || lastReq.Tool != "write_file" {
		t.Fatalf("pregunta = %+v", lastReq)
	}
	if err := a.RespondAgentApproval(id1, true, ""); err != nil {
		t.Fatal(err)
	}
	if d := <-done; !d.Allow {
		t.Fatalf("decisión = %+v", d)
	}
	// Una segunda respuesta (doble clic) no bloquea ni rompe nada.
	if err := a.RespondAgentApproval(id1, false, "tarde"); err != nil {
		t.Fatal(err)
	}
	if pending() != 0 {
		t.Fatal("quedó una pregunta pendiente")
	}

	// 2. Se cancela el turno mientras se espera: deniega y avisa a la ventana.
	ctx, cancel := context.WithCancel(context.Background())
	go func() { done <- a.askApprovalWith(ctx, req, time.Minute, emit) }()
	<-arrived
	cancel()
	select {
	case d := <-done:
		if d.Allow || d.Reason == "" {
			t.Fatalf("cancelar debe denegar: %+v", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("la goroutine quedó esperando tras cancelar")
	}

	// 3. Nadie contesta: deniega solo.
	start := time.Now()
	d := a.askApprovalWith(context.Background(), req, 50*time.Millisecond, emit)
	if d.Allow || d.Reason == "" || time.Since(start) > 2*time.Second {
		t.Fatalf("el plazo debe denegar: %+v", d)
	}
	if pending() != 0 {
		t.Fatal("quedó una pregunta pendiente tras el plazo")
	}
	mu.Lock()
	defer mu.Unlock()
	dismisses := 0
	for _, e := range events {
		if e == "agent-approval-dismiss" {
			dismisses++
		}
	}
	if dismisses != 2 {
		t.Errorf("la ventana debe poder cerrar el diálogo (cancelación y plazo): %v", events)
	}
}

func TestWorkspaceRootAndAgentCwd(t *testing.T) {
	a, _ := newChatApp(t)
	id, dir := addRepo(t, a)

	for _, c := range []struct{ module, ctx, want string }{
		{"git", id, dir},
		{"utilities", id, dir},
		{"utilities", "no-es-un-repo", ""},
		{"utilities", "", ""},
		{"db", id, ""}, // otros módulos no trabajan en un repositorio
		{"git", "", ""},
	} {
		if got := a.workspaceRoot(c.module, c.ctx); got != c.want {
			t.Errorf("workspaceRoot(%q,%q) = %q, quería %q", c.module, c.ctx, got, c.want)
		}
	}

	if cwd, err := a.agentCwd("utilities", id); err != nil || cwd != dir {
		t.Errorf("agentCwd utilities+repo = %q, %v", cwd, err)
	}
	cwd, err := a.agentCwd("utilities", "no-es-un-repo")
	if err != nil || !strings.HasSuffix(cwd, "consultas") {
		t.Errorf("sin repo cae al directorio de consultas: %q, %v", cwd, err)
	}
	if cwd, _ = a.agentCwd("db", id); !strings.HasSuffix(cwd, "consultas") {
		t.Errorf("db no usa el repositorio: %q", cwd)
	}

	// Un repositorio cuyo directorio desapareció no es una raíz.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if got := a.workspaceRoot("git", id); got != "" {
		t.Errorf("directorio borrado = %q", got)
	}
}

func TestBuildLLMToolsGating(t *testing.T) {
	a, _ := newChatApp(t)
	id, _ := addRepo(t, a)
	const reads = "glob,list_dir,read_file,search"

	// Sin repositorio y con MCP apagado: sin herramientas, el chat es el de siempre.
	if set := a.buildLLMTools("utilities", "", agentchat.ModeAuto); len(set.Tools) != 0 {
		t.Fatalf("sin repo ni MCP = %s", toolNames(set))
	}
	// Con repositorio, según el modo.
	if got := toolNames(a.buildLLMTools("git", id, agentchat.ModeAsk)); got != reads {
		t.Errorf("ask = %s", got)
	}
	if got := toolNames(a.buildLLMTools("utilities", id, agentchat.ModeEdit)); got != "edit_file,glob,list_dir,read_file,run_command,search,write_file" {
		t.Errorf("edit = %s", got)
	}

	// MCP encendido: mismo catálogo que hoy, y la escritura de notas sigue
	// dependiendo de mcpNotesWrite.
	a.mcp.bridge = &mcpserver.Bridge{}
	base := "db_explain_query,db_get_schema,db_list_connections,git_status,ssh_get_recent_logs,vault_list_folders,vault_list_notes,vault_read_note,vault_search_notes"
	if got := toolNames(a.buildLLMTools("db", "x", agentchat.ModeAuto)); got != base {
		t.Errorf("MCP sin repo = %s", got)
	}
	both := strings.Split(base+","+reads, ",")
	sort.Strings(both)
	if got := toolNames(a.buildLLMTools("git", id, agentchat.ModeAsk)); got != strings.Join(both, ",") {
		t.Errorf("MCP + repo (ask) = %s", got)
	}
	if err := a.vault.SetMCPNotesWrite(true); err != nil {
		t.Fatal(err)
	}
	if got := toolNames(a.buildLLMTools("db", "x", agentchat.ModeAsk)); !strings.Contains(got, "vault_create_note") || !strings.Contains(got, "vault_update_note") || !strings.Contains(got, "vault_append_to_note") {
		t.Errorf("con mcpNotesWrite se declaran las de escritura: %s", got)
	}
	// Y el catálogo es el MISMO que el del puente.
	if len(a.mcpToolDefs()) != len(a.ListTools()) {
		t.Errorf("el catálogo del chat difiere del del puente")
	}
}

func TestLLMToolRunDispatchAuditsMCP(t *testing.T) {
	a, _ := newChatApp(t)
	id, dir := addRepo(t, a)
	a.mcp.bridge = &mcpserver.Bridge{}
	set := a.buildLLMTools("git", id, agentchat.ModeEdit)
	ctx := context.Background()

	if out, err := set.Run(ctx, "db_list_connections", nil); err != nil || out == "" {
		t.Fatalf("MCP: %q, %v", out, err)
	}
	if _, err := set.Run(ctx, "vault_read_note", map[string]any{"title": "no existe"}); err == nil {
		t.Fatal("una nota inexistente es un error de la herramienta")
	}
	a.mcp.mu.Lock()
	audit := append([]mcpAudit(nil), a.mcp.audit...)
	a.mcp.mu.Unlock()
	if len(audit) != 2 || audit[0].Tool != "db_list_connections" || audit[0].Denied || audit[1].Tool != "vault_read_note" || !audit[1].Denied {
		t.Fatalf("auditoría = %+v (cada llamada del chat queda en el registro de accesos)", audit)
	}

	if _, err := set.Run(ctx, "write_file", map[string]any{"path": "x.txt", "content": "hola"}); err != nil {
		t.Fatalf("write_file: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "x.txt")); string(b) != "hola" {
		t.Errorf("x.txt = %q", b)
	}
	if _, err := set.Run(ctx, "nada", nil); err == nil {
		t.Error("herramienta desconocida")
	}
	// Apagar el MCP a mitad de la charla se respeta en la próxima llamada.
	a.mcp.bridge = nil
	if _, err := set.Run(ctx, "db_list_connections", nil); err == nil {
		t.Error("con el MCP apagado la llamada se rechaza")
	}
}

// ollamaScript responde a /api/chat con un guion y guarda los cuerpos.
type ollamaScript struct {
	mu    sync.Mutex
	steps []string // líneas NDJSON de cada respuesta
	reqs  []map[string]any
}

func (o *ollamaScript) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/tags" {
		fmt.Fprint(w, `{"models":[{"name":"m"}]}`)
		return
	}
	// El chequeo previo del servidor pregunta la versión antes de cada turno.
	if r.URL.Path == "/api/version" {
		fmt.Fprint(w, `{"version":"0.9.1"}`)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var req map[string]any
	_ = json.Unmarshal(body, &req)
	o.mu.Lock()
	idx := len(o.reqs)
	o.reqs = append(o.reqs, req)
	o.mu.Unlock()
	if idx >= len(o.steps) {
		http.Error(w, `{"error":"sin guion"}`, http.StatusInternalServerError)
		return
	}
	fmt.Fprint(w, o.steps[idx])
}

func toolCallStep(name, argsJSON string) string {
	return `{"model":"m","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"` + name + `","arguments":` + argsJSON + `}}]},"done":false}` + "\n" +
		`{"model":"m","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":2}` + "\n"
}

func textStep(text string) string {
	return `{"model":"m","message":{"role":"assistant","content":"` + text + `"},"done":false}` + "\n" +
		`{"model":"m","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":20,"eval_count":4}` + "\n"
}

var serverSeq int

func setupOllama(t *testing.T, a *App, steps ...string) (agentID string, srv *ollamaScript) {
	t.Helper()
	srv = &ollamaScript{steps: steps}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	serverSeq++
	saved, err := a.vault.SaveModelServer(vault.ModelServer{Name: fmt.Sprintf("Local %d", serverSeq), Kind: "ollama", BaseURL: ts.URL}, "", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return agentchat.LLMPrefix + saved.ID, srv
}

func TestSendAgentChatLLMEditModeWritesFileEndToEnd(t *testing.T) {
	a, events := newChatApp(t)
	id, dir := addRepo(t, a)
	agentID, srv := setupOllama(t, a,
		toolCallStep("write_file", `{"path":"docs/hola.txt","content":"hola\nmundo\n"}`),
		textStep("Listo, creé el archivo."))

	if err := a.SendAgentChat("chat-1", "git", id, agentID, "creá docs/hola.txt", "edit", "", "", nil); err != nil {
		t.Fatal(err)
	}
	var evs []agentchat.Event
	deadline := time.After(10 * time.Second)
loop:
	for {
		select {
		case ev := <-events:
			evs = append(evs, ev)
			if ev.Kind == agentchat.KindDone || ev.Kind == agentchat.KindError {
				break loop
			}
		case <-deadline:
			t.Fatal("el turno no terminó")
		}
	}
	if last := evs[len(evs)-1]; last.Kind != agentchat.KindDone || last.Usage.Total != 36 {
		t.Fatalf("eventos = %+v", evs)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "docs", "hola.txt")); err != nil || string(b) != "hola\nmundo\n" {
		t.Fatalf("archivo = %q, %v", b, err)
	}

	// El modelo recibió las herramientas del modo edit (sin MCP, que está apagado)
	// y la respuesta tool correlacionada por nombre.
	first := srv.reqs[0]["tools"].([]any)
	if len(first) != 7 {
		t.Errorf("herramientas declaradas = %d", len(first))
	}
	msgs := srv.reqs[1]["messages"].([]any)
	lastMsg := msgs[len(msgs)-1].(map[string]any)
	if lastMsg["role"] != "tool" || lastMsg["tool_name"] != "write_file" || !strings.Contains(lastMsg["content"].(string), "docs/hola.txt") {
		t.Errorf("mensaje tool = %v", lastMsg)
	}
	sys := msgs[0].(map[string]any)["content"].(string)
	if !strings.Contains(sys, "edit_file") {
		t.Errorf("falta la nota de sistema de las herramientas: %q", sys)
	}

	// Historial: usuario, la herramienta con su resumen y la respuesta.
	rows, err := a.AgentChatMessages("chat-1")
	if err != nil || len(rows) != 3 {
		t.Fatalf("filas = %+v, %v", rows, err)
	}
	if rows[1].Role != "tool" || rows[1].ToolName != "write_file" || !strings.HasPrefix(rows[1].Content, "docs/hola.txt") || rows[2].Content != "Listo, creé el archivo." {
		t.Fatalf("filas = %+v", rows)
	}
}

func TestSendAgentChatLLMApproveModeAsksAndHonorsDenial(t *testing.T) {
	a, events := newChatApp(t)
	id, dir := addRepo(t, a)
	agentID, srv := setupOllama(t, a,
		toolCallStep("run_command", `{"command":"touch creado.txt"}`),
		textStep("Entendido, no lo hago."))

	var asked []agentapprove.Request
	var mu sync.Mutex
	a.approvalEmit = func(event string, data any) {
		if event != "agent-approval" {
			return
		}
		req := data.(agentapprove.Request)
		mu.Lock()
		asked = append(asked, req)
		mu.Unlock()
		go func() { _ = a.RespondAgentApproval(req.ID, false, "no corras comandos") }()
	}

	if err := a.SendAgentChat("chat-2", "utilities", id, agentID, "creá un archivo", "approve", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "chat-2")

	mu.Lock()
	defer mu.Unlock()
	if len(asked) != 1 || asked[0].Tool != "run_command" || asked[0].Summary != "touch creado.txt" || !strings.HasPrefix(asked[0].ID, "llm-approve-") {
		t.Fatalf("preguntas = %+v", asked)
	}
	if _, err := os.Stat(filepath.Join(dir, "creado.txt")); err == nil {
		t.Fatal("el comando corrió pese a la denegación")
	}
	msgs := srv.reqs[1]["messages"].([]any)
	got := msgs[len(msgs)-1].(map[string]any)["content"].(string)
	if !strings.HasPrefix(got, "error:") || !strings.Contains(got, "no corras comandos") {
		t.Errorf("el modelo debía enterarse de la denegación: %q", got)
	}
}

func TestSendAgentChatLLMNoRepoOnlyOffersMCPAndAskModeIsReadOnly(t *testing.T) {
	a, events := newChatApp(t)
	// Sin repositorio ni MCP: ninguna herramienta, aunque el modo sea auto.
	agentID, srv := setupOllama(t, a, textStep("hola"))
	if err := a.SendAgentChat("c3", "utilities", "", agentID, "hola", "auto", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "c3")
	if _, has := srv.reqs[0]["tools"]; has {
		t.Errorf("sin repositorio ni MCP no se declara nada: %v", srv.reqs[0]["tools"])
	}

	// Modo desconocido se rechaza también para un servidor de modelos.
	if err := a.SendAgentChat("c4", "utilities", "", agentID, "hola", "root", "", "", nil); err == nil {
		t.Error("un modo desconocido debe rechazarse")
	}

	// Ask (el modo por defecto) con repositorio: solo lectura.
	id, _ := addRepo(t, a)
	agentID2, srv2 := setupOllama(t, a, textStep("ok"))
	if err := a.SendAgentChat("c5", "git", id, agentID2, "mirá", "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "c5")
	var names []string
	for _, tl := range srv2.reqs[0]["tools"].([]any) {
		names = append(names, tl.(map[string]any)["function"].(map[string]any)["name"].(string))
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "glob,list_dir,read_file,search" {
		t.Errorf("ask declara %v", names)
	}
}

func TestAgentAskNeverUsesTools(t *testing.T) {
	a, _ := newChatApp(t)
	id, _ := addRepo(t, a)
	a.mcp.bridge = &mcpserver.Bridge{}
	agentID, srv := setupOllama(t, a, textStep("SELECT 1"))
	got, err := a.AgentAskWith(agentID, "dame sql", "git", id)
	if err != nil || got != "SELECT 1" {
		t.Fatalf("AgentAskWith = %q, %v", got, err)
	}
	if _, has := srv.reqs[0]["tools"]; has {
		t.Errorf("los botones de un turno no declaran herramientas: %v", srv.reqs[0]["tools"])
	}
}

func TestParseChatModeAndLoopback(t *testing.T) {
	for in, want := range map[string]agentchat.Mode{"": agentchat.ModeAsk, "plan": agentchat.ModePlan, "approve": agentchat.ModeApprove, "edit": agentchat.ModeEdit, "auto": agentchat.ModeAuto} {
		if got, err := parseChatMode(in); err != nil || got != want {
			t.Errorf("parseChatMode(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := parseChatMode("yolo"); err == nil {
		t.Error("modo desconocido")
	}

	for u, want := range map[string]bool{
		"http://localhost:11434": true, "http://127.0.0.1:1234/v1": true, "http://[::1]:11434": true,
		"http://127.1.2.3": true, "http://0.0.0.0:11434": true, "http://miapp.localhost:80": true,
		"http://192.168.1.10:11434": false, "https://gpu.empresa.com/v1": false, "http://10.0.0.5": false,
		"http://localhost.evil.com": false, "http://[2001:db8::1]:11434": false, "": false, "::::": false,
	} {
		if got := isLoopbackURL(u); got != want {
			t.Errorf("isLoopbackURL(%q) = %v, quería %v", u, got, want)
		}
	}
	remote := modelServerAgent(vault.ModelServer{ID: "1", Name: "GPU", Kind: "ollama", BaseURL: "https://gpu.empresa.com"})
	local := modelServerAgent(vault.ModelServer{ID: "2", Name: "Mi PC", Kind: "ollama", BaseURL: "http://localhost:11434"})
	if !strings.Contains(strings.ToLower(remote.Note), "remot") || strings.Contains(strings.ToLower(local.Note), "remot") {
		t.Errorf("notas: %q / %q", remote.Note, local.Note)
	}
	if !toModelServer(vault.ModelServer{BaseURL: "http://localhost:11434"}).IsLocal || toModelServer(vault.ModelServer{BaseURL: "https://x.com"}).IsLocal {
		t.Error("ModelServer.IsLocal")
	}
}
