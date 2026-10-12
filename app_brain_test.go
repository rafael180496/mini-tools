package main

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/mcpserver"
	"mini-tools/backend/vault"
)

// notesApp deja una App con el MCP "encendido" (sin socket) y la escritura de
// notas habilitada, y captura los avisos de nota cambiada.
func notesApp(t *testing.T) (*App, *[]map[string]string) {
	t.Helper()
	a, _ := newChatApp(t)
	a.mcp.bridge = &mcpserver.Bridge{}
	if err := a.vault.SetMCPNotesWrite(true); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var events []map[string]string
	a.noteEmit = func(event string, data any) {
		if event != NoteChangedEvent {
			t.Errorf("evento inesperado %q", event)
		}
		mu.Lock()
		events = append(events, data.(map[string]string))
		mu.Unlock()
	}
	return a, &events
}

func call(t *testing.T, a *App, tool string, args map[string]any) string {
	t.Helper()
	out, err := a.CallTool(tool, args)
	if err != nil {
		t.Fatalf("%s %v: %v", tool, args, err)
	}
	return out
}

func callErr(t *testing.T, a *App, tool string, args map[string]any) error {
	t.Helper()
	out, err := a.CallTool(tool, args)
	if err == nil {
		t.Fatalf("%s %v debía fallar y devolvió %q", tool, args, out)
	}
	return err
}

func TestMCPCreateNoteWithFolderCreatesNestedAndRejectsTraversal(t *testing.T) {
	a, events := notesApp(t)

	out := call(t, a, "vault_create_note", map[string]any{
		"title": "Bloqueos Oracle", "content": "Causa: lock de fila #oracle", "folder": "Cerebro/Proyectos/sgc",
	})
	if !strings.Contains(out, "Cerebro/Proyectos/sgc") {
		t.Errorf("respuesta = %q", out)
	}
	if len(*events) != 1 {
		t.Errorf("avisos = %v", *events)
	}
	id, found, err := a.vault.FindNoteFolder("Cerebro/Proyectos/sgc")
	if err != nil || !found {
		t.Fatalf("la carpeta anidada no se creó: %v %v", found, err)
	}
	notes, _ := a.vault.ListNotes()
	if len(notes) != 1 || notes[0].FolderID != id || notes[0].IsPrivate {
		t.Fatalf("notas = %+v", notes)
	}
	n, _ := a.vault.GetNote(notes[0].ID)
	if !vault.AgentCanEdit(n.Frontmatter) {
		t.Errorf("la nota debe quedar marcada como del agente: %q", n.Frontmatter)
	}

	// Rutas con traversal o segmentos vacíos: error y NADA creado.
	foldersBefore, _ := a.vault.NoteFolderPaths()
	for _, bad := range []string{"../fuera", "Cerebro/../../x", "a//b", "./x", "Cerebro/..", strings.Repeat("x", 81)} {
		err := callErr(t, a, "vault_create_note", map[string]any{"title": "Mala " + bad, "content": "x", "folder": bad})
		if !errors.Is(err, vault.ErrBadFolderPath) {
			t.Errorf("folder %q: err = %v", bad, err)
		}
	}
	if after, _ := a.vault.NoteFolderPaths(); len(after) != len(foldersBefore) {
		t.Errorf("una ruta inválida dejó carpetas: %v", after)
	}
	if notes, _ = a.vault.ListNotes(); len(notes) != 1 {
		t.Errorf("una ruta inválida dejó notas: %d", len(notes))
	}

	// Un título repetido se rechaza ANTES de crear carpetas.
	callErr(t, a, "vault_create_note", map[string]any{"title": "bloqueos oracle", "content": "x", "folder": "Nueva/Carpeta"})
	if _, found, _ := a.vault.FindNoteFolder("Nueva"); found {
		t.Error("el título repetido dejó una carpeta vacía")
	}

	// Sin carpeta: raíz, como siempre.
	call(t, a, "vault_create_note", map[string]any{"title": "Suelta", "content": "x"})
	notes, _ = a.vault.ListNotes()
	for _, n := range notes {
		if n.Title == "Suelta" && n.FolderID != "" {
			t.Error("sin folder debe quedar en la raíz")
		}
	}

	// Sin el permiso, ninguna escritura.
	if err := a.vault.SetMCPNotesWrite(false); err != nil {
		t.Fatal(err)
	}
	callErr(t, a, "vault_create_note", map[string]any{"title": "Otra", "content": "x", "folder": "Z"})
	callErr(t, a, "vault_append_to_note", map[string]any{"title": "Suelta", "content": "x"})
}

func TestMCPSearchAndListFilterByFolderAndTag(t *testing.T) {
	a, _ := notesApp(t)
	call(t, a, "vault_create_note", map[string]any{"title": "Bloqueos Oracle", "content": "diagnóstico #oracle", "folder": "Cerebro/Proyectos/sgc"})
	call(t, a, "vault_create_note", map[string]any{"title": "Deploy SGC", "content": "pasos #ops", "folder": "Cerebro/Proyectos/sgc/deploy"})
	call(t, a, "vault_create_note", map[string]any{"title": "Tema Oracle", "content": "sobre oracle #oracle", "folder": "Cerebro/Temas"})
	call(t, a, "vault_create_note", map[string]any{"title": "Privada Oracle", "content": "oracle clave #oracle", "folder": "Cerebro/Proyectos/sgc"})
	privID := ""
	notes, _ := a.vault.ListNotes()
	for _, n := range notes {
		if n.Title == "Privada Oracle" {
			privID = n.ID
		}
	}
	if err := a.vault.SetNotePrivacy(privID, true); err != nil {
		t.Fatal(err)
	}

	out := call(t, a, "vault_search_notes", map[string]any{"query": "oracle"})
	if strings.Contains(out, "Privada") || !strings.Contains(out, "Bloqueos Oracle") || !strings.Contains(out, "Tema Oracle") {
		t.Errorf("búsqueda = %q", out)
	}
	// Carpeta: incluye descendientes y excluye el resto.
	out = call(t, a, "vault_search_notes", map[string]any{"query": "", "folder": "Cerebro/Proyectos/sgc"})
	if !strings.Contains(out, "Bloqueos Oracle") || !strings.Contains(out, "Deploy SGC") || strings.Contains(out, "Tema Oracle") || strings.Contains(out, "Privada") {
		t.Errorf("folder = %q", out)
	}
	// Etiqueta con y sin #, combinada con carpeta.
	out = call(t, a, "vault_search_notes", map[string]any{"query": "", "tag": "#oracle", "folder": "Cerebro/Proyectos"})
	if !strings.Contains(out, "Bloqueos Oracle") || strings.Contains(out, "Deploy SGC") || strings.Contains(out, "Tema Oracle") || strings.Contains(out, "Privada") {
		t.Errorf("tag+folder = %q", out)
	}
	// Una carpeta que no existe se explica, no es un error de permiso.
	if out = call(t, a, "vault_search_notes", map[string]any{"query": "x", "folder": "No/Existe"}); !strings.Contains(out, "vault_list_folders") {
		t.Errorf("carpeta inexistente = %q", out)
	}

	// Listados.
	out = call(t, a, "vault_list_folders", nil)
	if !strings.Contains(out, "Cerebro/Proyectos/sgc/deploy") || !strings.Contains(out, "Cerebro/Temas") {
		t.Errorf("list_folders = %q", out)
	}
	if !strings.Contains(out, "Cerebro/Proyectos/sgc —") {
		t.Errorf("falta la carpeta sgc: %q", out)
	}
	// sgc tiene 1 nota propia VISIBLE (la privada no cuenta) y 2 con subcarpetas.
	if !strings.Contains(out, "Cerebro/Proyectos/sgc — 1 notes (2 including subfolders)") {
		t.Errorf("conteo de visibles: %q", out)
	}
	out = call(t, a, "vault_list_notes", map[string]any{"folder": "Cerebro/Proyectos/sgc"})
	if !strings.Contains(out, "Bloqueos Oracle") || !strings.Contains(out, "#oracle") || strings.Contains(out, "Deploy SGC") || strings.Contains(out, "Privada") {
		t.Errorf("list_notes (no recursivo) = %q", out)
	}
	out = call(t, a, "vault_list_notes", map[string]any{"folder": "Cerebro/Proyectos/sgc", "recursive": true})
	if !strings.Contains(out, "Deploy SGC") || !strings.Contains(out, "Cerebro/Proyectos/sgc/deploy") || strings.Contains(out, "Privada") {
		t.Errorf("list_notes recursivo = %q", out)
	}
	if out = call(t, a, "vault_list_notes", map[string]any{}); !strings.Contains(out, "no shared notes") && !strings.Contains(out, "No hay") {
		t.Errorf("raíz vacía = %q", out)
	}
}

func TestMCPReadNoteReturnsFolderTagsAndLinksWithoutPrivate(t *testing.T) {
	a, _ := notesApp(t)
	// El usuario crea estas desde la app (sin marca de agente).
	mk := func(title, content, folder string, private bool) string {
		id, err := a.createNote(title, content, "")
		if err != nil {
			t.Fatal(err)
		}
		if folder != "" {
			fid, err := a.vault.EnsureNoteFolder(folder)
			if err != nil {
				t.Fatal(err)
			}
			_ = a.vault.SetNoteFolder(id, fid)
		}
		if private {
			_ = a.vault.SetNotePrivacy(id, true)
		}
		return id
	}
	mk("Centro", "Ver [[Hija]], [[Secreta]] y [[Futura]]. #hub #bd", "Cerebro/Temas", false)
	mk("Hija", "detalle", "", false)
	mk("Secreta", "cosas", "", true)
	mk("Entrante", "apunta a [[Centro]]", "", false)
	mk("EntranteSecreta", "apunta a [[Centro]]", "", true)

	out := call(t, a, "vault_read_note", map[string]any{"title": "Centro"})
	for _, want := range []string{"Cerebro/Temas", "#hub #bd", "[[Hija]]", "[[Futura]]", "[[Entrante]]", "Ver [[Hija]]"} {
		if !strings.Contains(out, want) {
			t.Errorf("falta %q en:\n%s", want, out)
		}
	}
	for _, leak := range []string{"Secreta", "EntranteSecreta"} {
		// El cuerpo cita [[Secreta]] (es texto de la propia nota), pero ni los
		// enlaces salientes ni los entrantes la nombran.
		head := out[:strings.Index(out, "---")]
		if strings.Contains(head, leak) {
			t.Errorf("la nota privada %q apareció en las listas de enlaces:\n%s", leak, head)
		}
	}
	// El enlace roto se marca.
	if !strings.Contains(out, "[[Futura]] (") {
		t.Errorf("el enlace roto no se distingue:\n%s", out)
	}
	// Una nota del usuario se informa como no modificable.
	if !strings.Contains(out, "can't modify") && !strings.Contains(out, "no la podés modificar") {
		t.Errorf("falta la procedencia:\n%s", out)
	}
	// Y una privada sigue sin poder leerse.
	if err := callErr(t, a, "vault_read_note", map[string]any{"title": "Secreta"}); !errors.Is(err, vault.ErrNotePrivate) {
		t.Errorf("err = %v", err)
	}
}

func TestMCPAppendToNoteOwnershipRules(t *testing.T) {
	a, events := notesApp(t)
	call(t, a, "vault_create_note", map[string]any{"title": "Mía", "content": "Primera parte", "folder": "Cerebro/Temas"})
	call(t, a, "vault_create_note", map[string]any{"title": "Enlazada", "content": "x"})

	call(t, a, "vault_append_to_note", map[string]any{"title": "Mía", "heading": "## Segunda", "content": "Más datos con [[Enlazada]] #nuevo"})
	n, err := a.vault.NoteForAI("Mía")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(n.Content, "Primera parte\n\n## Segunda\n\nMás datos con [[Enlazada]] #nuevo") {
		t.Errorf("contenido = %q", n.Content)
	}
	if !strings.Contains(n.Frontmatter, "actualizada:") || !vault.AgentCanEdit(n.Frontmatter) {
		t.Errorf("frontmatter = %q", n.Frontmatter)
	}
	// Los enlaces se reindexan: "Enlazada" tiene ahora un backlink.
	enl, _ := a.vault.NoteForAI("Enlazada")
	if bl, _ := a.vault.NoteBacklinks(enl.ID); len(bl) != 1 || bl[0].Title != "Mía" {
		t.Errorf("backlinks = %+v", bl)
	}
	// La carpeta se conserva.
	if fid, _ := a.vault.NoteFolderID(n.ID); fid == "" {
		t.Error("el append sacó la nota de su carpeta")
	}
	if len(*events) < 3 {
		t.Errorf("avisos = %d", len(*events))
	}
	// Sin heading: solo el contenido, separado por una línea en blanco.
	call(t, a, "vault_append_to_note", map[string]any{"title": "Mía", "content": "Cola"})
	n, _ = a.vault.NoteForAI("Mía")
	if !strings.HasSuffix(n.Content, "#nuevo\n\nCola\n") {
		t.Errorf("contenido = %q", n.Content)
	}

	// Una nota del usuario (sin la marca) no se toca.
	userID, _ := a.createNote("Del usuario", "texto", "")
	callErr(t, a, "vault_append_to_note", map[string]any{"title": "Del usuario", "content": "intruso"})
	// Una del agente que el usuario editó después tampoco.
	mine, _ := a.vault.NoteForAI("Mía")
	if err := a.UpdateNote(mine.ID, mine.Title, mine.Content+"\nmi aporte", mine.Frontmatter); err != nil {
		t.Fatal(err)
	}
	callErr(t, a, "vault_append_to_note", map[string]any{"title": "Mía", "content": "otra"})
	after, _ := a.vault.NoteForAI("Mía")
	if strings.Contains(after.Content, "otra") {
		t.Error("se pisó una nota editada por el usuario")
	}
	// Una privada ni se lee ni se amplía.
	call(t, a, "vault_create_note", map[string]any{"title": "Oculta", "content": "x"})
	hid, _ := a.vault.NoteForAI("Oculta")
	_ = a.vault.SetNotePrivacy(hid.ID, true)
	if err := callErr(t, a, "vault_append_to_note", map[string]any{"title": "Oculta", "content": "y"}); !errors.Is(err, vault.ErrNotePrivate) {
		t.Errorf("err = %v", err)
	}
	if u, _ := a.vault.GetNote(userID); u.Content != "texto" {
		t.Errorf("la nota del usuario cambió: %q", u.Content)
	}
	// Inexistente, vacío y tope de tamaño.
	callErr(t, a, "vault_append_to_note", map[string]any{"title": "No existe", "content": "x"})
	callErr(t, a, "vault_append_to_note", map[string]any{"title": "Enlazada", "content": "   "})
	call(t, a, "vault_create_note", map[string]any{"title": "Grande", "content": strings.Repeat("a", maxMCPNoteBytes-100)})
	callErr(t, a, "vault_append_to_note", map[string]any{"title": "Grande", "content": strings.Repeat("b", 200)})
}

func TestMCPNoteToolsAreDeclaredByPermission(t *testing.T) {
	a, _ := newChatApp(t)
	names := func() string {
		var out []string
		for _, tl := range a.ListTools() {
			out = append(out, tl.Name)
		}
		return strings.Join(out, ",")
	}
	got := names()
	for _, w := range []string{"vault_search_notes", "vault_read_note", "vault_list_folders", "vault_list_notes"} {
		if !strings.Contains(got, w) {
			t.Errorf("falta %s", w)
		}
	}
	for _, w := range []string{"vault_create_note", "vault_update_note", "vault_append_to_note"} {
		if strings.Contains(got, w) {
			t.Errorf("%s no debe declararse sin mcpNotesWrite", w)
		}
	}
	if err := a.vault.SetMCPNotesWrite(true); err != nil {
		t.Fatal(err)
	}
	if got = names(); !strings.Contains(got, "vault_append_to_note") {
		t.Errorf("con el permiso debe declararse: %s", got)
	}
}

func TestSetAgentChatBrainGating(t *testing.T) {
	a, _ := newChatApp(t)
	if err := a.vault.CreateAgentChat("c1", "", "claude", "t", "git", "r"); err != nil {
		t.Fatal(err)
	}
	// MCP apagado: no se puede encender; apagar siempre se puede.
	if err := a.SetAgentChatBrain("c1", true); err == nil {
		t.Fatal("con el MCP apagado debía fallar")
	}
	a.mcp.bridge = &mcpserver.Bridge{}
	if err := a.SetAgentChatBrain("c1", true); err == nil {
		t.Fatal("sin mcpNotesWrite debía fallar")
	}
	if a.vault.AgentChatBrain("c1") {
		t.Fatal("un intento fallido dejó la bandera encendida")
	}
	if st, _ := a.BrainStatus(); !st.MCPEnabled || st.NotesWrite || st.Root != "Cerebro" {
		t.Errorf("BrainStatus = %+v", st)
	}
	if err := a.vault.SetMCPNotesWrite(true); err != nil {
		t.Fatal(err)
	}
	if err := a.SetAgentChatBrain("c1", true); err != nil {
		t.Fatal(err)
	}
	if !a.vault.AgentChatBrain("c1") || !a.chatBrainOn("c1") {
		t.Error("no quedó encendido")
	}
	all, _ := a.vault.ListAllAgentChats()
	if len(all) != 1 || !all[0].Brain {
		t.Errorf("AgentChat.Brain = %+v", all)
	}
	// Revocar el permiso apaga el cerebro de hecho, sin tocar la bandera.
	if err := a.vault.SetMCPNotesWrite(false); err != nil {
		t.Fatal(err)
	}
	if a.chatBrainOn("c1") || a.brainInstructions("c1", "git", "r") != "" {
		t.Error("sin mcpNotesWrite no deben enviarse las instrucciones")
	}
	_ = a.vault.SetMCPNotesWrite(true)
	if err := a.SetAgentChatBrain("c1", false); err != nil {
		t.Fatal(err)
	}
	if a.chatBrainOn("c1") {
		t.Error("no se apagó")
	}
	if st, _ := a.BrainStatus(); !st.NotesWrite {
		t.Errorf("BrainStatus = %+v", st)
	}

	// Raíz.
	if root, _ := a.GetBrainRoot(); root != "Cerebro" {
		t.Errorf("root = %q", root)
	}
	if err := a.SetBrainRoot("../x"); err == nil {
		t.Error("una raíz con traversal debía rechazarse")
	}
	if err := a.SetBrainRoot("Mi Cerebro"); err != nil {
		t.Fatal(err)
	}
	if root, _ := a.GetBrainRoot(); root != "Mi Cerebro" {
		t.Errorf("root = %q", root)
	}
	if err := a.SetAgentChatBrain("", true); err == nil {
		t.Error("sin id debía fallar")
	}
}

func TestBrainRequestedBeforeTheChatRowExistsIsPersistedOnSend(t *testing.T) {
	a, events := newChatApp(t)
	a.mcp.bridge = &mcpserver.Bridge{}
	_ = a.vault.SetMCPNotesWrite(true)
	agentID, srv := setupOllama(t, a, textStep("ok"))

	// El chat todavía no existe: la bandera queda pendiente y ya cuenta.
	if err := a.SetAgentChatBrain("nuevo", true); err != nil {
		t.Fatal(err)
	}
	if a.vault.AgentChatBrain("nuevo") || !a.chatBrainOn("nuevo") {
		t.Fatal("debía quedar pendiente en memoria")
	}
	if err := a.SendAgentChat("nuevo", "utilities", "", agentID, "hola", "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "nuevo")
	if !a.vault.AgentChatBrain("nuevo") {
		t.Error("al crearse la fila, la bandera debía persistirse")
	}

	// Entrega a un servidor de modelos: va en el mensaje de sistema, y el
	// historial guarda solo lo que escribió el usuario.
	sys := srv.reqs[0]["messages"].([]any)[0].(map[string]any)
	if sys["role"] != "system" || !strings.Contains(sys["content"].(string), "vault_append_to_note") ||
		!strings.Contains(sys["content"].(string), "Cerebro/Temas") {
		t.Errorf("mensaje de sistema = %v", sys)
	}
	rows, _ := a.AgentChatMessages("nuevo")
	if len(rows) == 0 || rows[0].Content != "hola" {
		t.Errorf("el historial no debe llevar las instrucciones: %+v", rows)
	}
	// Con el cerebro apagado, el siguiente turno no las lleva.
	if err := a.SetAgentChatBrain("nuevo", false); err != nil {
		t.Fatal(err)
	}
	agentID2, srv2 := setupOllama(t, a, textStep("ok"))
	if err := a.SendAgentChat("nuevo", "utilities", "", agentID2, "otra", "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	waitTurnEnd(t, a, events, "nuevo")
	sys2 := srv2.reqs[0]["messages"].([]any)[0].(map[string]any)
	if s, _ := sys2["content"].(string); strings.Contains(s, "vault_append_to_note") {
		t.Errorf("apagado, el turno no debe llevar el cerebro: %q", s)
	}
}

func TestBrainInstructionsProjectOrTopic(t *testing.T) {
	a, _ := newChatApp(t)
	a.mcp.bridge = &mcpserver.Bridge{}
	_ = a.vault.SetMCPNotesWrite(true)
	repoID, _ := addRepo(t, a) // el repositorio se llama "proyecto"
	conn, err := a.vault.AddGitRepo("a/b", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_ = a.vault.CreateAgentChat("c", "", "claude", "t", "git", repoID)
	_ = a.vault.SetAgentChatBrain("c", true)

	cases := []struct{ module, ctx, want string }{
		{"git", repoID, "Cerebro/Proyectos/proyecto"},
		{"utilities", repoID, "Cerebro/Proyectos/proyecto"},
		{"git", conn.ID, "Cerebro/Proyectos/a-b"}, // una barra del nombre no parte la ruta
		{"utilities", "", "Cerebro/Temas"},
		{"utilities", "no-existe", "Cerebro/Temas"},
		{"note", "id-de-nota", "Cerebro/Temas"},
	}
	for _, c := range cases {
		if got := a.brainInstructions("c", c.module, c.ctx); !strings.Contains(got, c.want) {
			t.Errorf("%s/%s: no menciona %q:\n%s", c.module, c.ctx, c.want, got)
		}
	}
	if got := a.brainInstructions("c", "utilities", ""); strings.Contains(got, "Proyectos/") {
		t.Errorf("sin proyecto no debe nombrar uno:\n%s", got)
	}
	// Con otra raíz.
	_ = a.vault.SetBrainRoot("Notas/IA")
	if got := a.brainInstructions("c", "git", repoID); !strings.Contains(got, "Notas/IA/Proyectos/proyecto") {
		t.Errorf("raíz configurable: %s", got)
	}
	// Un chat sin la bandera no recibe nada.
	_ = a.vault.CreateAgentChat("c2", "", "claude", "t", "git", repoID)
	if a.brainInstructions("c2", "git", repoID) != "" {
		t.Error("sin bandera no hay instrucciones")
	}
}

func TestBrainDeliveryPerAgentKind(t *testing.T) {
	const brain = "INSTRUCCIONES"
	if sys, p := brainDelivery("claude", brain, "hola"); sys != brain || p != "hola" {
		t.Errorf("claude: system=%q prompt=%q", sys, p)
	}
	for _, id := range []string{"codex", "antigravity"} {
		sys, p := brainDelivery(id, brain, "hola")
		if sys != "" || !strings.HasPrefix(p, brain) || !strings.HasSuffix(p, "hola") {
			t.Errorf("%s: system=%q prompt=%q", id, sys, p)
		}
	}
	if sys, p := brainDelivery("claude", "", "hola"); sys != "" || p != "hola" {
		t.Errorf("apagado: %q %q", sys, p)
	}
	if got := withBrain("base", brain); got != "base\n\n"+brain {
		t.Errorf("withBrain = %q", got)
	}
	if got := withBrain("", brain); got != brain {
		t.Errorf("withBrain vacío = %q", got)
	}
	if got := withBrain("base", ""); got != "base" {
		t.Errorf("withBrain sin cerebro = %q", got)
	}
}
