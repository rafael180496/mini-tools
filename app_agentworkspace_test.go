package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
)

// fakeHome apunta la validación de carpetas a un home temporal.
func fakeHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	prev := userHomeDir
	userHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHomeDir = prev })
	return home
}

func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func addFolder(t *testing.T, a *App) (ctxID, dir string) {
	t.Helper()
	fakeHome(t)
	dir = t.TempDir()
	w, err := a.AddAgentWorkspace(dir, "carpeta")
	if err != nil {
		t.Fatal(err)
	}
	return "ws:" + w.ID, dir
}

func TestParseWorkspaceContext(t *testing.T) {
	for in, want := range map[string]string{"ws:abc": "abc", "ws:": "", "": "", "abc": "", "WS:abc": "", " ws:abc": ""} {
		id, ok := parseWorkspaceContext(in)
		if id != want || ok != (want != "") {
			t.Errorf("parseWorkspaceContext(%q) = %q, %v", in, id, ok)
		}
	}
}

func TestAgentWorkspaceCRUDAndValidation(t *testing.T) {
	a, _ := newChatApp(t)
	home := fakeHome(t)

	// Alta: el nombre por defecto es el de la carpeta; existe, no es git.
	dir := t.TempDir()
	w, err := a.AddAgentWorkspace(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if w.ID == "" || w.Name != filepath.Base(dir) || w.Path != dir || !w.Exists || w.IsGit {
		t.Fatalf("alta = %+v", w)
	}
	// Con git adentro, IsGit.
	gitDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(gitDir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	g, err := a.AddAgentWorkspace(gitDir, "  con git  ")
	if err != nil || g.Name != "con git" || !g.IsGit {
		t.Fatalf("git = %+v, %v", g, err)
	}

	// Duplicado: devuelve la existente, también con barra final, con un
	// segmento redundante y por un enlace simbólico.
	for _, p := range []string{dir, dir + string(filepath.Separator), filepath.Join(dir, ".")} {
		again, err := a.AddAgentWorkspace(p, "otro nombre")
		if err != nil || again.ID != w.ID || again.Name != w.Name {
			t.Errorf("duplicado %q = %+v, %v", p, again, err)
		}
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "enlace")
		if err := os.Symlink(dir, link); err == nil {
			again, err := a.AddAgentWorkspace(link, "")
			if err != nil || again.ID != w.ID {
				t.Errorf("duplicado por enlace = %+v, %v", again, err)
			}
		}
	}
	list, err := a.ListAgentWorkspaces()
	if err != nil || len(list) != 2 {
		t.Fatalf("lista = %+v, %v", list, err)
	}

	// Rechazos, cada uno con su motivo.
	file := filepath.Join(dir, "archivo.txt")
	put(t, file, "x")
	root := string(filepath.Separator)
	if v := filepath.VolumeName(dir); v != "" {
		root = v + root
	}
	sub := filepath.Join(home, "proyectos", "x")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct{ path, why string }{
		"vacía":       {"", "falta"},
		"relativa":    {"relativa/x", "absoluta"},
		"inexistente": {filepath.Join(dir, "no-existe"), "no existe"},
		"archivo":     {file, "no es una carpeta"},
		"raíz":        {root, "demasiado amplia"},
		"home":        {home, "demasiado amplia"},
		"padre home":  {filepath.Dir(home), "demasiado amplia"},
	} {
		_, err := a.AddAgentWorkspace(c.path, "")
		if err == nil {
			t.Errorf("%s (%q) debía rechazarse", name, c.path)
		} else if !strings.Contains(strings.ToLower(err.Error()), c.why) && !strings.Contains(strings.ToLower(err.Error()), "too broad") &&
			!strings.Contains(strings.ToLower(err.Error()), "absolute") && !strings.Contains(strings.ToLower(err.Error()), "missing") &&
			!strings.Contains(strings.ToLower(err.Error()), "not a folder") && !strings.Contains(strings.ToLower(err.Error()), "does not exist") {
			t.Errorf("%s: motivo poco claro: %v", name, err)
		}
	}
	// Un enlace al home tampoco esquiva la comprobación.
	if runtime.GOOS != "windows" {
		link := filepath.Join(t.TempDir(), "casa")
		if err := os.Symlink(home, link); err == nil {
			if _, err := a.AddAgentWorkspace(link, ""); err == nil {
				t.Error("un enlace al home debía rechazarse")
			}
		}
	}
	// Una subcarpeta del home sí.
	if _, err := a.AddAgentWorkspace(sub, ""); err != nil {
		t.Errorf("una subcarpeta del home es aceptable: %v", err)
	}

	// Una carpeta que desaparece se sigue listando, marcada.
	if err := os.RemoveAll(gitDir); err != nil {
		t.Fatal(err)
	}
	list, _ = a.ListAgentWorkspaces()
	var gone bool
	for _, it := range list {
		if it.ID == g.ID {
			gone = !it.Exists && !it.IsGit
		}
	}
	if !gone {
		t.Errorf("la carpeta borrada debía listarse con exists=false: %+v", list)
	}

	// Quitar no toca el disco.
	if err := a.RemoveAgentWorkspace(w.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Error("quitar de la lista no debe borrar la carpeta")
	}
	if err := a.RemoveAgentWorkspace(w.ID); err == nil {
		t.Error("quitar dos veces")
	}
}

func TestAgentWorkspaceBindingsRequireUnlock(t *testing.T) {
	a, _ := newChatApp(t)
	a.gate.Lock()
	if _, err := a.ListAgentWorkspaces(); err == nil {
		t.Error("ListAgentWorkspaces con el vault bloqueado")
	}
	if _, err := a.AddAgentWorkspace(t.TempDir(), ""); err == nil {
		t.Error("AddAgentWorkspace con el vault bloqueado")
	}
	if err := a.RemoveAgentWorkspace("x"); err == nil {
		t.Error("RemoveAgentWorkspace con el vault bloqueado")
	}
	if _, err := a.AgentWorkspaceContext("utilities", "ws:x"); err == nil {
		t.Error("AgentWorkspaceContext con el vault bloqueado")
	}
	if _, err := a.PickAgentWorkspaceFolder(); err == nil {
		t.Error("PickAgentWorkspaceFolder con el vault bloqueado")
	}
}

func TestWorkspaceRootAndAgentCwdWithFolders(t *testing.T) {
	a, _ := newChatApp(t)
	ctxID, dir := addFolder(t, a)
	repoID, repoDir := addRepo(t, a)

	for _, c := range []struct{ module, ctx, want string }{
		{"utilities", ctxID, dir},
		{"git", ctxID, dir},
		{"db", ctxID, dir}, // `ws:` vale en cualquier módulo
		{"utilities", repoID, repoDir},
		{"db", repoID, ""}, // un id de repo sigue siendo solo de git/utilities
		{"utilities", "ws:desconocido", ""},
		{"utilities", "ws:", ""},
	} {
		if got := a.workspaceRoot(c.module, c.ctx); got != c.want {
			t.Errorf("workspaceRoot(%q,%q) = %q, quería %q", c.module, c.ctx, got, c.want)
		}
	}
	for _, module := range []string{"utilities", "git", "db"} {
		if cwd, err := a.agentCwd(module, ctxID); err != nil || cwd != dir {
			t.Errorf("agentCwd(%s, ws) = %q, %v", module, cwd, err)
		}
	}
	if cwd, err := a.agentCwd("git", repoID); err != nil || cwd != repoDir {
		t.Errorf("el repositorio git sigue igual: %q, %v", cwd, err)
	}
	// Una carpeta desconocida o borrada cae al directorio de consultas, como un
	// id de repositorio desconocido en Utilidades.
	if cwd, err := a.agentCwd("utilities", "ws:desconocido"); err != nil || !strings.HasSuffix(cwd, "consultas") {
		t.Errorf("ws desconocido = %q, %v", cwd, err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if got := a.workspaceRoot("utilities", ctxID); got != "" {
		t.Errorf("carpeta borrada = %q", got)
	}
	if cwd, _ := a.agentCwd("utilities", ctxID); !strings.HasSuffix(cwd, "consultas") {
		t.Errorf("carpeta borrada: cwd = %q", cwd)
	}
}

func TestBuildLLMToolsFolderModesAndSystemPrompt(t *testing.T) {
	a, _ := newChatApp(t)
	ctxID, dir := addFolder(t, a)
	put(t, filepath.Join(dir, "AGENTS.md"), "Siempre respondé en voseo.\n")

	const reads = "glob,list_dir,read_file,search"
	const all = "edit_file,glob,list_dir,read_file,run_command,search,write_file"
	for mode, want := range map[agentchat.Mode]string{
		agentchat.ModeAsk: reads, agentchat.ModePlan: reads,
		agentchat.ModeApprove: all, agentchat.ModeEdit: all, agentchat.ModeAuto: all,
	} {
		set := a.buildLLMTools("utilities", ctxID, mode)
		if got := toolNames(set); got != want {
			t.Errorf("%s = %s", mode, got)
		}
		if !strings.Contains(set.System, "Siempre respondé en voseo.") || !strings.Contains(set.System, dir) {
			t.Errorf("%s: el system no lleva el proyecto:\n%s", mode, set.System)
		}
	}
	// Solo lectura: el modelo se entera de que debe proponer, no editar.
	ro := a.buildLLMTools("utilities", ctxID, agentchat.ModePlan).System
	if strings.Contains(ro, "write_file") {
		t.Errorf("en plan no se nombra write_file:\n%s", ro)
	}

	// Con un skill (del proyecto), las herramientas de skills aparecen en todos
	// los modos, también en ask.
	put(t, filepath.Join(dir, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Cómo desplegar\n---\npaso 1\n")
	for _, mode := range []agentchat.Mode{agentchat.ModeAsk, agentchat.ModeAuto} {
		set := a.buildLLMTools("utilities", ctxID, mode)
		if got := toolNames(set); !strings.Contains(got, "read_skill_file") || !strings.Contains(got, ",skill") {
			t.Errorf("%s con skills = %s", mode, got)
		}
		if !strings.Contains(set.System, "deploy: Cómo desplegar") {
			t.Errorf("falta el índice de skills:\n%s", set.System)
		}
	}
}

func TestAgentWorkspaceContextBinding(t *testing.T) {
	a, _ := newChatApp(t)
	home := t.TempDir()
	llmProjectHome = home
	ctxID, dir := addFolder(t, a)

	// Sin proyecto: vacío, no error.
	empty, err := a.AgentWorkspaceContext("utilities", "")
	if err != nil || empty.Root != "" || empty.Instructions == nil || empty.Skills == nil || len(empty.Instructions) != 0 {
		t.Fatalf("sin raíz = %+v, %v", empty, err)
	}
	if got, _ := a.AgentWorkspaceContext("db", "algo"); got.Root != "" {
		t.Errorf("un módulo sin proyecto = %+v", got)
	}

	put(t, filepath.Join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
	put(t, filepath.Join(dir, "AGENTS.md"), "reglas")
	put(t, filepath.Join(dir, ".claude", "skills", "uno", "SKILL.md"), "---\nname: uno\ndescription: Primero\n---\n")
	put(t, filepath.Join(home, ".claude", "CLAUDE.md"), "global")
	put(t, filepath.Join(home, ".agents", "skills", "glob", "SKILL.md"), "---\nname: glob\ndescription: Global\n---\n")

	info, err := a.AgentWorkspaceContext("utilities", ctxID)
	if err != nil {
		t.Fatal(err)
	}
	realDir, _ := filepath.EvalSymlinks(dir)
	if info.Root != realDir || !info.IsGit || info.Branch != "main" || info.TotalChars != len("reglas")+len("global") {
		t.Errorf("info = %+v", info)
	}
	if len(info.Instructions) != 2 || info.Instructions[0].Path != "AGENTS.md" || info.Instructions[0].Scope != "project" ||
		info.Instructions[1].Path != "~/.claude/CLAUDE.md" || info.Instructions[1].Scope != "global" || info.Instructions[0].Truncated {
		t.Errorf("instrucciones = %+v", info.Instructions)
	}
	var names []string
	for _, s := range info.Skills {
		names = append(names, s.Name+"/"+s.Scope)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "glob/global,uno/project" {
		t.Errorf("skills = %v", names)
	}
}

func TestAgentChatModesForModelServersAreAllFive(t *testing.T) {
	a, _ := newChatApp(t)
	agentID, _ := setupOllama(t, a)
	// Los modos son del agente y no dependen de si el chat tiene proyecto: el
	// modo ask es la cadena vacía. Sin proyecto, el runner solo declara las
	// herramientas del MCP; con uno (repo o carpeta), las de archivos.
	modes, err := a.AgentChatModes(agentID)
	if err != nil || strings.Join(modes, ",") != ",plan,approve,edit,auto" {
		t.Errorf("modos = %v, %v", modes, err)
	}
}

// Extremo a extremo: un chat con una CARPETA (no git) en modo auto. El modelo
// recibe el proyecto en el mensaje de sistema, carga un skill global, escribe y
// corre un comando sin que nadie le pregunte, y lo riesgoso (git push) sí
// pregunta.
func TestSendAgentChatLLMAutoModeWithFolderEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("comandos POSIX")
	}
	a, events := newChatApp(t)
	home := t.TempDir()
	llmProjectHome = home
	ctxID, dir := addFolder(t, a)
	put(t, filepath.Join(dir, "AGENTS.md"), "REGLA-DEL-PROYECTO: usá tabs.\n")
	put(t, filepath.Join(home, ".claude", "CLAUDE.md"), "REGLA-GLOBAL: sé breve.\n")
	put(t, filepath.Join(home, ".claude", "skills", "mi-guia", "SKILL.md"), "---\nname: mi-guia\ndescription: Guía de ejemplo\n---\nCuerpo de la guía\n")
	put(t, filepath.Join(home, ".claude", "skills", "mi-guia", "references", "api.md"), "DOC-DE-LA-API\n")

	agentID, srv := setupOllama(t, a,
		toolCallStep("read_skill_file", `{"skill":"mi-guia","path":"references/api.md"}`),
		toolCallStep("write_file", `{"path":"src/nuevo.txt","content":"hola\n"}`),
		toolCallStep("run_command", `{"command":"touch listo.txt"}`),
		toolCallStep("run_command", `{"command":"git push origin main"}`),
		textStep("Hecho."))

	var mu sync.Mutex
	var asked []agentapprove.Request
	a.approvalEmit = func(event string, data any) {
		if event != "agent-approval" {
			return
		}
		req := data.(agentapprove.Request)
		mu.Lock()
		asked = append(asked, req)
		mu.Unlock()
		go func() { _ = a.RespondAgentApproval(req.ID, false, "no pushees") }()
	}

	if err := a.SendAgentChat("auto-1", "utilities", ctxID, agentID, "hacé lo tuyo", "auto", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "auto-1")

	// Escribió y corrió sin preguntar.
	if b, err := os.ReadFile(filepath.Join(dir, "src", "nuevo.txt")); err != nil || string(b) != "hola\n" {
		t.Fatalf("write_file no se aplicó: %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "listo.txt")); err != nil {
		t.Fatal("run_command no corrió")
	}
	// Lo único que preguntó fue el comando de riesgo.
	mu.Lock()
	defer mu.Unlock()
	if len(asked) != 1 || asked[0].Tool != "run_command" || asked[0].Summary != "git push origin main" {
		t.Fatalf("preguntas = %+v", asked)
	}

	// El mensaje de sistema del primer request lleva el proyecto, las
	// instrucciones (de proyecto y globales), el índice de skills y la guía.
	msgs := srv.reqs[0]["messages"].([]any)
	sys := msgs[0].(map[string]any)["content"].(string)
	for _, want := range []string{
		dir[len(dir)-10:], "REGLA-DEL-PROYECTO", "REGLA-GLOBAL", "mi-guia (global): Guía de ejemplo",
		"skill(name)", "edit_file", "run_command", "AGENTS.md", "~/.claude/CLAUDE.md",
	} {
		if !strings.Contains(sys, want) {
			t.Errorf("el system prompt no contiene %q:\n%s", want, sys)
		}
	}
	if strings.Index(sys, "REGLA-DEL-PROYECTO") > strings.Index(sys, "REGLA-GLOBAL") {
		t.Error("las instrucciones del proyecto van antes que las globales")
	}
	var declared []string
	for _, tl := range srv.reqs[0]["tools"].([]any) {
		declared = append(declared, tl.(map[string]any)["function"].(map[string]any)["name"].(string))
	}
	sort.Strings(declared)
	if strings.Join(declared, ",") != "edit_file,glob,list_dir,read_file,read_skill_file,run_command,search,skill,write_file" {
		t.Errorf("herramientas = %v", declared)
	}
	// La skill global se leyó por read_skill_file (está fuera de la carpeta).
	second := srv.reqs[1]["messages"].([]any)
	if got := second[len(second)-1].(map[string]any)["content"].(string); !strings.Contains(got, "DOC-DE-LA-API") {
		t.Errorf("read_skill_file = %q", got)
	}
	// Y el rechazo del push volvió al modelo.
	last := srv.reqs[4]["messages"].([]any)
	if got := last[len(last)-1].(map[string]any)["content"].(string); !strings.Contains(got, "no pushees") {
		t.Errorf("el modelo debía enterarse de la denegación: %q", got)
	}
}

// Una carpeta de trabajo en modo ask: solo lectura, y el proyecto igual viaja.
func TestSendAgentChatLLMAskModeFolderReadOnly(t *testing.T) {
	a, events := newChatApp(t)
	ctxID, dir := addFolder(t, a)
	put(t, filepath.Join(dir, "CLAUDE.md"), "REGLA-CLAUDE\n")
	agentID, srv := setupOllama(t, a, textStep("ok"))
	if err := a.SendAgentChat("ask-1", "utilities", ctxID, agentID, "mirá", "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "ask-1")
	var names []string
	for _, tl := range srv.reqs[0]["tools"].([]any) {
		names = append(names, tl.(map[string]any)["function"].(map[string]any)["name"].(string))
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "glob,list_dir,read_file,search" {
		t.Errorf("ask declara %v", names)
	}
	sys := srv.reqs[0]["messages"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(sys, "REGLA-CLAUDE") || strings.Contains(sys, "write_file") {
		t.Errorf("system en ask:\n%s", sys)
	}
}
