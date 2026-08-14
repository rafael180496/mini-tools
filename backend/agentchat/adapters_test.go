package agentchat

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	evs := replay(t, "antigravity-stream.jsonl", antigravityAdapter)

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
	for _, id := range []string{"claude", "antigravity", "codex"} {
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
