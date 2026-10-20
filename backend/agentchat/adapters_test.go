package agentchat

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mini-tools/backend/i18n"
)

// Los mensajes de error se afirman en español.
func TestMain(m *testing.M) {
	i18n.SetLang("es")
	os.Exit(m.Run())
}

// Los fixtures de testdata/ son corridas REALES capturadas de cada CLI
// (`claude -p --output-format stream-json --verbose` y `agy --print
// --output-format stream-json`), no ejemplos escritos a mano. Esa es la
// diferencia entre un adaptador verificado y uno adivinado, y el motivo por el
// que Codex todavía no tiene el suyo.

func replay(t *testing.T, file string, a adapter) []Event {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", file))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var out []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		out = append(out, a([]byte(line))...)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func kinds(evs []Event) []EventKind {
	out := make([]EventKind, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.Kind)
	}
	return out
}

func TestClaudeAdapterOnRealCapture(t *testing.T) {
	evs := replay(t, "claude-stream.jsonl", claudeAdapter)

	if len(evs) < 3 {
		t.Fatalf("se esperaban al menos start/text/done: %v", kinds(evs))
	}

	start := evs[0]
	if start.Kind != KindStart {
		t.Fatalf("el primer evento debe ser start: %v", kinds(evs))
	}
	if start.Model == "" || start.ConversationID == "" {
		t.Errorf("el start debe traer modelo y id de conversación (hace falta para encadenar el turno): %+v", start)
	}
	if len(start.Tools) == 0 {
		t.Error("el init informa las herramientas disponibles y se están perdiendo")
	}
	// La visión del CLI incluye el ESTADO de cada servidor MCP, que es lo que
	// backend/mcpconf no puede saber leyendo archivos.
	if len(start.MCPServers) == 0 || !strings.Contains(strings.Join(start.MCPServers, " "), "(") {
		t.Errorf("los servidores MCP deberían venir con su estado: %v", start.MCPServers)
	}

	var text strings.Builder
	for _, e := range evs {
		if e.Kind == KindText {
			text.WriteString(e.Text)
		}
	}
	if !strings.Contains(strings.ToLower(text.String()), "ok") {
		t.Errorf("no se recuperó el texto de la respuesta: %q", text.String())
	}

	done := evs[len(evs)-1]
	if done.Kind != KindDone || done.Usage == nil {
		t.Fatalf("el último evento debe cerrar con el uso: %+v", done)
	}
	if done.Usage.Total == 0 || done.Usage.Output == 0 {
		t.Errorf("el uso del turno vino vacío: %+v", done.Usage)
	}
	// El costo lo informa solo Claude Code; 0 significaría "no lo dice".
	if done.Usage.CostUSD <= 0 {
		t.Errorf("Claude Code informa total_cost_usd y se está perdiendo: %+v", done.Usage)
	}
}

func TestAntigravityAdapterOnRealCapture(t *testing.T) {
	agy, _ := newAntigravityTurn(Turn{})
	evs := replay(t, "antigravity-stream.jsonl", agy)

	if len(evs) < 3 {
		t.Fatalf("se esperaban al menos start/text/done: %v", kinds(evs))
	}
	if evs[0].Kind != KindStart || len(evs[0].Tools) == 0 {
		t.Errorf("el init debe abrir el turno con las herramientas: %+v", evs[0])
	}

	// El texto llega en deltas incrementales: concatenados tienen que dar la
	// respuesta. Reenviarlos tal cual es lo que hace que el chat se vea vivo.
	var text strings.Builder
	deltas := 0
	for _, e := range evs {
		if e.Kind == KindText {
			text.WriteString(e.Text)
			deltas++
		}
	}
	if deltas < 1 || !strings.Contains(strings.ToLower(text.String()), "ok") {
		t.Errorf("no se recuperó el texto de los deltas (%d): %q", deltas, text.String())
	}

	done := evs[len(evs)-1]
	if done.Kind != KindDone || done.Usage == nil {
		t.Fatalf("el último evento debe cerrar con el uso: %+v", done)
	}
	if done.Usage.Total == 0 {
		t.Errorf("Antigravity SÍ informa tokens en headless y se están perdiendo: %+v", done.Usage)
	}
	if done.ConversationID == "" {
		t.Error("sin el id de conversación no se puede encadenar el turno siguiente")
	}
	// Antigravity no informa costo: cero acá significa "no lo dice", y la UI
	// tiene que poder distinguirlo de "salió gratis".
	if done.Usage.CostUSD != 0 {
		t.Errorf("Antigravity no informa costo; inventarlo sería peor que omitirlo: %+v", done.Usage)
	}
}

// Una línea que no se entiende se descarta, nunca corta el turno: un evento
// nuevo en la próxima versión del CLI no puede romper la conversación.
func TestAdaptersIgnoreUnknownLines(t *testing.T) {
	for name, a := range adapters {
		for _, line := range []string{
			`{"type":"algo_que_no_existe_todavia","payload":{"x":1}}`,
			`{"event":"futuro","futuro":{}}`,
			`no es json`,
			``,
		} {
			if evs := a([]byte(line)); len(evs) != 0 {
				t.Errorf("%s: la línea %q debería ignorarse, dio %v", name, line, kinds(evs))
			}
		}
	}
}

// Solo se ofrecen los agentes con adaptador verificado contra una corrida
// real, guardada en testdata/. Gemini CLI queda afuera hasta poder capturarlo:
// la regla es la captura, no la reputación del CLI.
func TestSupportsOnlyVerifiedAgents(t *testing.T) {
	for _, id := range []string{"claude", "antigravity", "codex", "opencode"} {
		if !Supports(id) {
			t.Errorf("%s tiene adaptador verificado contra una captura real", id)
		}
	}
	// Un id que no está en el catálogo: la lista de adaptadores no puede
	// afirmar que funciona algo que nunca se capturó.
	if Supports("un-cli-que-no-existe") {
		t.Error("sin una captura real no se puede afirmar que el chat funcione")
	}
}

// Los argumentos del modo headless son lo que decide si el turno arranca y si
// encadena con el anterior.
func TestBuildArgs(t *testing.T) {
	args, err := buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "hola"}, "")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-p hola") || !strings.Contains(joined, "stream-json") {
		t.Errorf("faltan las banderas del modo headless: %v", args)
	}
	if strings.Contains(joined, "--resume") {
		t.Error("sin conversación previa no hay que encadenar")
	}

	args, _ = buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "hola"}, "abc-123")
	if !strings.Contains(strings.Join(args, " "), "--resume abc-123") {
		t.Errorf("el turno siguiente debe encadenar con la conversación: %v", args)
	}

	// El comando del catálogo puede traer argumentos fijos del usuario y hay
	// que conservarlos.
	args, _ = buildArgs(Turn{AgentID: "antigravity", Command: "agy --effort high", Prompt: "hola"}, "conv-9")
	joined = strings.Join(args, " ")
	if args[0] != "agy" || !strings.Contains(joined, "--effort high") || !strings.Contains(joined, "--conversation conv-9") {
		t.Errorf("no se respetaron los argumentos fijos: %v", args)
	}

	// **Ni siquiera en ModeEdit se saltean TODOS los permisos.** Esa bandera
	// cubre también la ejecución de comandos, no solo la edición de archivos:
	// "que modifique el repositorio, que se ve en el diff" puede ser una
	// elección informada; "que haga cualquier cosa en la máquina" no es algo
	// que una lista desplegable pueda representar honestamente.
	for _, id := range []string{"claude", "antigravity"} {
		a, _ := buildArgs(Turn{AgentID: id, Command: id, Prompt: "x", Mode: ModeEdit}, "")
		for _, flag := range []string{"--dangerously-skip-permissions", "bypassPermissions", "--yolo", "--auto-approve"} {
			if strings.Contains(strings.Join(a, " "), flag) {
				t.Errorf("%s: nunca se debe pasar %s", id, flag)
			}
		}
	}

	// Un agente sin modo headless verificado falla claro en vez de correr algo
	// cuya salida no se sabe leer.
	if _, err := buildArgs(Turn{AgentID: "un-cli-que-no-existe", Command: "x", Prompt: "hola"}, ""); err == nil {
		t.Error("un agente sin modo headless verificado debe fallar claro")
	}
}

// Los modos se traducen a la bandera REAL de cada CLI — verificadas contra
// `claude --help` y `agy --help`, no supuestas.
func TestBuildArgsModes(t *testing.T) {
	cases := []struct {
		agent, command string
		mode           Mode
		want           string
	}{
		{"claude", "claude", ModePlan, "--permission-mode plan"},
		{"claude", "claude", ModeEdit, "--permission-mode acceptEdits"},
		{"antigravity", "agy", ModePlan, "--mode plan"},
		{"antigravity", "agy", ModeEdit, "--mode accept-edits"},
	}
	for _, c := range cases {
		args, err := buildArgs(Turn{AgentID: c.agent, Command: c.command, Prompt: "x", Mode: c.mode}, "")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(args, " "), c.want) {
			t.Errorf("%s/%s: falta %q en %v", c.agent, c.mode, c.want, args)
		}
	}

	// El modo por defecto no pasa ninguna bandera de permisos: sin modo
	// explícito, una edición que necesita confirmación no se puede aprobar
	// desde acá y el agente la salta.
	for _, agent := range []string{"claude", "antigravity"} {
		args, _ := buildArgs(Turn{AgentID: agent, Command: agent, Prompt: "x", Mode: ModeAsk}, "")
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "permission-mode") || strings.Contains(joined, "--mode") {
			t.Errorf("%s: el modo por defecto no debe fijar permisos: %v", agent, args)
		}
	}

	args, _ := buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "x", Effort: "high"}, "")
	if !strings.Contains(strings.Join(args, " "), "--effort high") {
		t.Errorf("el esfuerzo no se está pasando: %v", args)
	}
}

func TestCodexAdapterOnRealCapture(t *testing.T) {
	evs := replay(t, "codex-stream.jsonl", codexAdapter)

	if len(evs) < 3 {
		t.Fatalf("se esperaban al menos start/tool/text/done: %v", kinds(evs))
	}
	if evs[0].Kind != KindStart || evs[0].ConversationID == "" {
		t.Errorf("el thread_id es lo que permite retomar la conversación: %+v", evs[0])
	}

	// La acción se muestra al EMPEZAR, no al terminar: es lo que hace que se
	// vea trabajando. Y una sola vez, no dos (started + completed).
	tools := 0
	for _, e := range evs {
		if e.Kind == KindTool {
			tools++
			if e.Tool.Summary == "" {
				t.Errorf("una acción sin descripción no dice nada: %+v", e.Tool)
			}
		}
	}
	if tools != 1 {
		t.Errorf("se esperaba UNA llamada a herramienta, hubo %d: %v", tools, kinds(evs))
	}

	var text strings.Builder
	for _, e := range evs {
		if e.Kind == KindText {
			text.WriteString(e.Text)
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		t.Error("no se recuperó el texto de la respuesta")
	}

	done := evs[len(evs)-1]
	if done.Kind != KindDone || done.Usage == nil || done.Usage.Total == 0 {
		t.Fatalf("el turno debe cerrar con el uso: %+v", done)
	}
	// `input_tokens` de Codex YA incluye los cacheados: si no se restaran, la
	// entrada se contaría dos veces y el total quedaría inflado.
	if done.Usage.Input+done.Usage.CacheRead != 26654+0 {
		t.Errorf("los tokens cacheados se están contando dos veces: %+v", done.Usage)
	}
	// Codex no informa costo: cero significa "no lo dice".
	if done.Usage.CostUSD != 0 {
		t.Errorf("Codex no informa costo; inventarlo sería peor que omitirlo: %+v", done.Usage)
	}
}

// Los argumentos de Codex son distintos de los otros dos: subcomando `exec`,
// el prompt posicional al final, y `resume <id>` para encadenar.
func TestBuildArgsCodex(t *testing.T) {
	args, err := buildArgs(Turn{AgentID: "codex", Command: "codex", Prompt: "hola"}, "")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "exec --json") || !strings.HasSuffix(joined, "hola") {
		t.Errorf("el prompt va último y sin bandera: %v", args)
	}

	args, _ = buildArgs(Turn{AgentID: "codex", Command: "codex", Prompt: "x"}, "thread-9")
	if !strings.Contains(strings.Join(args, " "), "resume thread-9") {
		t.Errorf("el turno siguiente debe encadenar con el thread: %v", args)
	}

	args, _ = buildArgs(Turn{AgentID: "codex", Command: "codex", Prompt: "x", Mode: ModeEdit}, "")
	if !strings.Contains(strings.Join(args, " "), "--sandbox workspace-write") {
		t.Errorf("editar es su sandbox de escritura acotada: %v", args)
	}
	// Nunca la que apaga el sandbox entero.
	if strings.Contains(strings.Join(args, " "), "dangerously-bypass") {
		t.Error("jamás se pasa --dangerously-bypass-approvals-and-sandbox")
	}
}

// Las imágenes NO llegan igual a los tres, y por eso esto se prueba: Codex
// tiene bandera propia (`-i`, verificada en su --help) y los otros dos no,
// así que ahí van nombradas en el prompt para que las abran con su
// herramienta de lectura.
func TestBuildArgsImages(t *testing.T) {
	imgs := []string{"/tmp/a.png", "/tmp/b.png"}

	args, _ := buildArgs(Turn{AgentID: "codex", Command: "codex", Prompt: "mirá", Images: imgs}, "")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-i /tmp/a.png") || !strings.Contains(joined, "-i /tmp/b.png") {
		t.Errorf("Codex recibe las imágenes por bandera: %v", args)
	}
	// Y NO nombradas en el texto: se contarían dos veces.
	if strings.Contains(args[len(args)-1], "/tmp/a.png") {
		t.Errorf("el prompt de Codex no debe repetir las rutas: %q", args[len(args)-1])
	}

	for _, agent := range []string{"claude", "antigravity"} {
		args, _ := buildArgs(Turn{AgentID: agent, Command: agent, Prompt: "mirá", Images: imgs}, "")
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "/tmp/a.png") {
			t.Errorf("%s: sin bandera, las rutas van en el prompt: %v", agent, args)
		}
		if strings.Contains(joined, " -i ") {
			t.Errorf("%s no tiene bandera de imagen y no hay que inventarla: %v", agent, args)
		}
	}

	// Sin adjuntos, el prompt queda intacto: nada de encabezados vacíos.
	args, _ = buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "hola"}, "")
	if !strings.Contains(strings.Join(args, " "), "-p hola --output-format") {
		t.Errorf("sin imágenes el prompt no se toca: %v", args)
	}
}

// Dos sesiones del MISMO repositorio corren a la vez: es lo que permite tener
// un agente trabajando y otro revisando lo que hizo.
//
// Lo que sí se bloquea es mandar dos mensajes a la MISMA sesión mientras
// contesta — ahí no hay concurrencia posible: el CLI encadena por conversación
// y dos turnos simultáneos sobre la misma se pisarían.
func TestSessionsAreIndependent(t *testing.T) {
	m := NewManager(func(string, Event) {})

	// Se ocupa una sesión a mano, sin lanzar proceso: lo que se prueba es el
	// candado por sesión, no el CLI.
	m.mu.Lock()
	m.cancels["ocupada"] = func() {}
	m.mu.Unlock()

	if err := m.Send(Turn{SessionID: "ocupada", AgentID: "claude", Command: "claude", Prompt: "x"}); err == nil {
		t.Error("una sesión que ya está contestando no debe aceptar otro turno")
	}

	// Otra sesión, en cambio, no está bloqueada por la primera. Se comprueba
	// que el rechazo NO sea por concurrencia: un agente sin adaptador falla
	// por otro motivo, y ese es el error que tiene que aparecer.
	err := m.Send(Turn{SessionID: "otra", AgentID: "sin-adaptador", Command: "x", Prompt: "y"})
	if err == nil || !strings.Contains(err.Error(), "verificado") {
		t.Errorf("otra sesión no debería estar bloqueada por la primera: %v", err)
	}
}

// Cada sesión encadena su PROPIA conversación: si compartieran el id, dos
// agentes trabajando en paralelo se mezclarían las charlas.
func TestConversationsArePerSession(t *testing.T) {
	m := NewManager(func(string, Event) {})
	m.Resume("a", "conv-a")
	m.Resume("b", "conv-b")

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.convos["a"] != "conv-a" || m.convos["b"] != "conv-b" {
		t.Errorf("las conversaciones se cruzaron: %+v", m.convos)
	}
}

// TestAntigravitySplitRune: un carácter partido entre dos trozos.
//
// Es el bug de `borrado l<?><?>gico`: la "ó" ocupa dos bytes y el CLI cortó
// entre uno y otro. Cada línea, por separado, es texto inválido; juntas son la
// palabra. Sin este arreglo, `encoding/json` reemplazaba cada mitad por U+FFFD
// al decodificar y la palabra quedaba rota para siempre.
func TestAntigravitySplitRune(t *testing.T) {
	lines := [][]byte{
		[]byte("{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"agent_response\",\"text_delta\":\"borrado l\xc3\"}}"),
		[]byte("{\"event\":\"step_update\",\"step_update\":{\"step_type\":\"agent_response\",\"text_delta\":\"\xb3gico\"}}"),
	}

	agy, _ := newAntigravityTurn(Turn{})
	var fix utf8Stitcher
	var got string
	for _, line := range lines {
		for _, ev := range agy(line) {
			if ev.Kind == KindText {
				got += fix.Feed(ev.Text)
			}
		}
	}
	got += fix.Flush()

	if want := "borrado lógico"; got != want {
		t.Fatalf("texto cosido = %q, quería %q", got, want)
	}
}

// TestStitcherKeepsWholeText: el caso normal —ningún carácter partido— tiene
// que pasar tal cual y trozo por trozo, o el chat dejaría de verse escribir.
func TestStitcherKeepsWholeText(t *testing.T) {
	var fix utf8Stitcher
	for _, chunk := range []string{"Añadí ", "una restricción ", "🚀"} {
		if out := fix.Feed(chunk); out != chunk {
			t.Fatalf("Feed(%q) = %q, quería el trozo entero", chunk, out)
		}
	}
	if rest := fix.Flush(); rest != "" {
		t.Fatalf("quedó %q colgando y no tendría que haber nada", rest)
	}
}

// TestJSONRawStringUnescapes: los escapes normales se siguen entendiendo, con
// par de sustitutos incluido (un emoji viaja como DOS escapes).
func TestJSONRawStringUnescapes(t *testing.T) {
	cases := map[string]string{
		`"lógico"`:      "lógico",
		`"a\nb\t\"c\""`: "a\nb\t\"c\"",
		`"🚀 ok"`:        "🚀 ok",
	}
	for in, want := range cases {
		if got := jsonRawString([]byte(in)); got != want {
			t.Fatalf("jsonRawString(%s) = %q, quería %q", in, got, want)
		}
	}
}

// Turn.System llega a Claude Code detrás del idioma, en UN solo valor de
// --append-system-prompt (repetir la bandera pisaría la anterior). Codex y
// Antigravity no lo usan: quien llama antepone el texto al prompt.
func TestBuildArgsClaudeAppendsSystemInOneFlag(t *testing.T) {
	flagValues := func(args []string) []string {
		var out []string
		for i, a := range args {
			if a == "--append-system-prompt" && i+1 < len(args) {
				out = append(out, args[i+1])
			}
		}
		return out
	}

	args, _ := buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "hola"}, "")
	vals := flagValues(args)
	if len(vals) != 1 || vals[0] != i18n.T(replyLanguage) {
		t.Fatalf("sin System, solo el idioma: %q", vals)
	}

	args, _ = buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "hola", System: "INSTRUCCIONES DEL CEREBRO"}, "")
	vals = flagValues(args)
	if len(vals) != 1 || !strings.HasPrefix(vals[0], i18n.T(replyLanguage)) || !strings.HasSuffix(vals[0], "INSTRUCCIONES DEL CEREBRO") {
		t.Fatalf("idioma + System en un solo valor: %q", vals)
	}

	for _, id := range []string{"codex", "antigravity"} {
		a, _ := buildArgs(Turn{AgentID: id, Command: id, Prompt: "hola", System: "INSTRUCCIONES DEL CEREBRO"}, "")
		if strings.Contains(strings.Join(a, " "), "INSTRUCCIONES") {
			t.Errorf("%s no debe recibir System por argumentos: %v", id, a)
		}
	}
}

// Permisos de las herramientas MCP de mini-tools en Claude Code: una regla
// `--allowedTools` por herramienta (nunca un comodín), salvo en «Aprobar cada
// acción», donde decide el hook; y la shell y las ediciones fuera en consulta y
// planificación.
func TestBuildArgsClaudePermissions(t *testing.T) {
	flag := func(args []string, name string) string {
		for i, a := range args {
			if a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return "<ausente>"
	}
	tools := []string{"vault_search_notes", "db_get_schema"}
	const shell = "Edit,Write,MultiEdit,NotebookEdit,Bash,PowerShell"
	const allowed = "mcp__mini-tools__vault_search_notes,mcp__mini-tools__db_get_schema"

	cases := []struct {
		mode            Mode
		allow, disallow string
	}{
		{ModeAsk, allowed, shell},
		{ModePlan, allowed, shell},
		{ModeEdit, allowed, "<ausente>"},
		{ModeAuto, allowed, "<ausente>"},
		{ModeApprove, "<ausente>", "<ausente>"},
	}
	for _, c := range cases {
		args, err := buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "x", Mode: c.mode, MCPTools: tools, ApproveSettings: "/tmp/s.json"}, "")
		if err != nil {
			t.Fatal(err)
		}
		if got := flag(args, "--allowedTools"); got != c.allow {
			t.Errorf("modo %q: --allowedTools = %q, quería %q", c.mode, got, c.allow)
		}
		if got := flag(args, "--disallowedTools"); got != c.disallow {
			t.Errorf("modo %q: --disallowedTools = %q, quería %q", c.mode, got, c.disallow)
		}
		if j := strings.Join(args, " "); strings.Contains(j, "mcp__*") || strings.Contains(j, "dangerously") || strings.Contains(j, "bypassPermissions") {
			t.Errorf("modo %q: nunca comodines ni saltear permisos: %v", c.mode, args)
		}
	}

	// Sin servidor MCP declarado no hay reglas allow; el nombre registrado en
	// el CLI manda sobre el default.
	args, _ := buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "x"}, "")
	if flag(args, "--allowedTools") != "<ausente>" {
		t.Errorf("sin herramientas declaradas no se permite nada: %v", args)
	}
	args, _ = buildArgs(Turn{AgentID: "claude", Command: "claude", Prompt: "x", MCPTools: []string{"db_get_schema"}, MCPServer: "mi tools"}, "")
	if got := flag(args, "--allowedTools"); got != "mcp__mi_tools__db_get_schema" {
		t.Errorf("el nombre del servidor se normaliza como lo hace el CLI: %q", got)
	}
}

// Codex en «Solo consulta» fija el sandbox de solo lectura (el config.toml del
// usuario puede traer otro), antes del prompt y detrás de `resume`.
func TestBuildArgsCodexAskIsReadOnly(t *testing.T) {
	args, _ := buildArgs(Turn{AgentID: "codex", Command: "codex", Prompt: "hola"}, "thread-9")
	if j := strings.Join(args, " "); !strings.Contains(j, "resume thread-9 --sandbox read-only") || !strings.HasSuffix(j, "hola") {
		t.Errorf("read-only explícito, tras resume y antes del prompt: %v", args)
	}
}

func eventsOfKind(evs []Event, k EventKind) []Event {
	var out []Event
	for _, e := range evs {
		if e.Kind == k {
			out = append(out, e)
		}
	}
	return out
}

// Claude Code: `permission_denials` del result se vuelven rechazos (sin
// repetir al limpiar el nombre) y van ANTES del cierre.
func TestClaudePermissionDenials(t *testing.T) {
	evs := replay(t, "claude-denied.jsonl", claudeAdapter)
	var c deniedCollector
	for _, e := range eventsOfKind(evs, kindDenied) {
		c.add(e.Text)
	}
	if want := []string{"db_get_schema", "Edit"}; strings.Join(c.names, ",") != strings.Join(want, ",") {
		t.Errorf("rechazos = %v, quería %v", c.names, want)
	}
	if last := evs[len(evs)-1]; last.Kind != KindDone {
		t.Errorf("los rechazos van antes del done: %v", kinds(evs))
	}
	for _, e := range eventsOfKind(evs, KindTool) {
		if e.Tool.Name == "mcp__mini-tools__db_get_schema" {
			return
		}
	}
	t.Error("la tarjeta de la herramienta MCP de Claude conserva su nombre completo (el frontend lo limpia)")
}

// Antigravity: `call_mcp_tool` de mini-tools se muestra como la herramienta real
// con sus argumentos; las de otros servidores no se tocan.
func TestAntigravityUnwrapsMiniToolsMCP(t *testing.T) {
	agy, _ := newAntigravityTurn(Turn{})
	evs := replay(t, "antigravity-mcp.jsonl", agy)
	var names []string
	var firstInput string
	for _, e := range eventsOfKind(evs, KindTool) {
		names = append(names, e.Tool.Name)
		if e.Tool.Name == "vault_create_note" {
			firstInput = e.Tool.Input
		}
	}
	if want := "db_list_connections,vault_create_note,call_mcp_tool"; strings.Join(names, ",") != want {
		t.Errorf("herramientas = %v, quería %s (la de otro servidor queda como llega)", names, want)
	}
	if !strings.Contains(firstInput, `"title":"Caja"`) || strings.Contains(firstInput, "ServerName") {
		t.Errorf("la entrada son los Arguments, no el sobre: %q", firstInput)
	}
	if n := len(eventsOfKind(evs, kindDenied)); n != 0 {
		t.Errorf("sin rechazos no debe haber nada que anotar: %d", n)
	}

	// Con el servidor registrado con otro nombre en el CLI también se desenvuelve.
	line := `{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"call_mcp_tool","tool_name":"call_mcp_tool","tool_input":{"ServerName":"minitools-dev","ToolName":"git_status","Arguments":{}}}}`
	other, _ := newAntigravityTurn(Turn{MCPServer: "minitools-dev"})
	if got := other([]byte(line)); len(got) != 1 || got[0].Tool.Name != "git_status" {
		t.Errorf("el servidor detectado también se desenvuelve: %+v", got)
	}
	plain, _ := newAntigravityTurn(Turn{})
	if got := plain([]byte(line)); len(got) != 1 || got[0].Tool.Name != "call_mcp_tool" {
		t.Errorf("sin ese nombre en el turno es un servidor ajeno: %+v", got)
	}
}

// Antigravity: un paso en ERROR por permiso es un rechazo con el nombre real; el
// turno sin deltas ni respuesta termina igual.
func TestAntigravityPermissionDeniedStep(t *testing.T) {
	agy, _ := newAntigravityTurn(Turn{})
	evs := replay(t, "antigravity-denied.jsonl", agy)
	rej := eventsOfKind(evs, kindDenied)
	if len(rej) != 1 || cleanDeniedName(rej[0].Text) != "db_get_schema" {
		t.Fatalf("rechazos = %+v", rej)
	}
	if evs[len(evs)-1].Kind != KindDone || len(eventsOfKind(evs, KindText)) != 0 {
		t.Errorf("sin respuesta: solo el done al final: %v", kinds(evs))
	}
}

// `denied_actions` no está documentado: textos y objetos de cualquier forma
// dan algo legible, y un paso cancelado sin motivo de permiso no es rechazo.
func TestAntigravityDeniedActionsAnyShape(t *testing.T) {
	agy, _ := newAntigravityTurn(Turn{})
	evs := replay(t, "antigravity-denied-actions.jsonl", agy)
	var got []string
	for _, e := range eventsOfKind(evs, kindDenied) {
		got = append(got, cleanDeniedName(e.Text))
	}
	if want := "vault_search_notes,run_command," + `{"x":1}`; strings.Join(got, ",") != want {
		t.Errorf("rechazos = %q, quería %q", got, want)
	}
}

// Si el CLI cierra con `result.response` y nunca mandó deltas, esa respuesta es
// el texto del turno; si mandó deltas, no se duplica.
func TestAntigravityResponseFallback(t *testing.T) {
	agy, _ := newAntigravityTurn(Turn{})
	evs := replay(t, "antigravity-response-only.jsonl", agy)
	txt := eventsOfKind(evs, KindText)
	if len(txt) != 1 || txt[0].Text != "Listo, sin deltas." || evs[len(evs)-1].Kind != KindDone {
		t.Errorf("la respuesta del result sale como texto antes del done: %+v", evs)
	}

	agy, _ = newAntigravityTurn(Turn{})
	evs = replay(t, "antigravity-mcp.jsonl", agy)
	if n := len(eventsOfKind(evs, KindText)); n != 1 {
		t.Errorf("con deltas la respuesta no se repite: %d textos", n)
	}

	agy, _ = newAntigravityTurn(Turn{})
	got := agy([]byte(`{"event":"result","result":{"status":"FAILED","error":{"message":"cuota agotada"}}}`))
	if len(got) != 1 || got[0].Kind != KindError || !strings.Contains(got[0].Error, "FAILED") || !strings.Contains(got[0].Error, "cuota agotada") {
		t.Errorf("el motivo del estado viaja en el error: %+v", got)
	}
}

// La nota del cierre: una sola vez, antes del done, con el nombre real de la
// herramienta y lo que hay que hacer según el CLI; y un turno vacío lo dice.
func TestTurnClosingNoteEndToEnd(t *testing.T) {
	run := func(agent, label, fixture string) []Event {
		col := newCollector()
		m := NewManager(col.emit)
		err := m.Send(Turn{
			SessionID: "s1", AgentID: agent, Command: agent, AgentLabel: label, Prompt: "hola",
			Exec: []string{"sh", "-c", "cat testdata/" + fixture},
		})
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
		return col.wait(t)
	}
	textOf := func(evs []Event) string {
		var b strings.Builder
		for _, e := range eventsOfKind(evs, KindText) {
			b.WriteString(e.Text)
		}
		return b.String()
	}

	evs := run("claude", "Claude Code", "claude-denied.jsonl")
	txt := textOf(evs)
	if strings.Count(txt, "_⚠ ") != 1 || !strings.Contains(txt, "`db_get_schema`, `Edit`") || strings.Contains(txt, "mcp__") ||
		!strings.Contains(txt, "Aprobar cada acción") || !strings.Contains(txt, "Claude Code") {
		t.Errorf("nota de Claude: %q", txt)
	}
	if evs[len(evs)-1].Kind != KindDone || evs[len(evs)-2].Kind != KindText {
		t.Errorf("la nota va justo antes del done: %v", kinds(evs))
	}
	if len(eventsOfKind(evs, kindDenied)) != 0 {
		t.Error("kindDenied es interno: no se emite")
	}

	txt = textOf(run("antigravity", "Antigravity", "antigravity-denied.jsonl"))
	if !strings.Contains(txt, "`db_get_schema`") || !strings.Contains(txt, "configuración global") || strings.Contains(txt, "Aprobar cada acción") {
		t.Errorf("nota de Antigravity: %q", txt)
	}

	// Sin texto y sin rechazos: el turno dice que no respondió nada.
	txt = textOf(run("antigravity", "Antigravity", "antigravity-text-empty.jsonl"))
	if txt != "_⚠ Antigravity terminó el turno sin responder nada._" {
		t.Errorf("turno vacío: %q", txt)
	}

	// Con respuesta y sin rechazos: no se agrega nada.
	if txt = textOf(run("antigravity", "Antigravity", "antigravity-stream.jsonl")); strings.Contains(txt, "Nota:") || strings.Contains(txt, "sin responder") {
		t.Errorf("un turno normal no lleva nota: %q", txt)
	}
}
