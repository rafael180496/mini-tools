package agentchat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testdata/opencode-stream.jsonl es una corrida real de `opencode run --format
// json --thinking` (v2.0.22): escribe un archivo, corre `ls` y contesta. No
// trae un evento final: el turno lo cierra el finisher.
func TestOpencodeAdapterOnRealCapture(t *testing.T) {
	a, _ := newOpencodeTurn()
	evs := replay(t, "opencode-stream.jsonl", a)

	if len(evs) == 0 || evs[0].Kind != KindStart || evs[0].ConversationID == "" {
		t.Fatalf("el turno abre con el id de sesión, que es lo que permite retomarlo: %v", kinds(evs))
	}
	starts, tools := 0, 0
	var text, thinking strings.Builder
	for _, e := range evs {
		switch e.Kind {
		case KindStart:
			starts++
		case KindTool:
			tools++
			if e.Tool.Summary == "" {
				t.Errorf("una acción sin descripción no dice nada: %+v", e.Tool)
			}
		case KindText:
			text.WriteString(e.Text)
		case KindThinking:
			thinking.WriteString(e.Text)
		case KindDone, KindError:
			t.Errorf("el stream no trae cierre propio; no hay que inventarlo: %+v", e)
		}
	}
	// Hay un step_start por vuelta del modelo; el start del chat es uno solo.
	if starts != 1 {
		t.Errorf("se esperaba UN start, hubo %d", starts)
	}
	if tools != 2 {
		t.Errorf("se esperaban dos herramientas (write y shell), hubo %d", tools)
	}
	if !strings.Contains(text.String(), "b.txt") || thinking.Len() == 0 {
		t.Errorf("falta texto o razonamiento: %q / %q", text.String(), thinking.String())
	}
}

func TestOpencodeErrorEndsTurnOnce(t *testing.T) {
	a, finish := newOpencodeTurn()
	evs := replay(t, "opencode-error.jsonl", a)
	if len(evs) != 1 || evs[0].Kind != KindError || !strings.Contains(evs[0].Error, "nope/nada") {
		t.Fatalf("el error del CLI es el mensaje del turno: %+v", evs)
	}
	// Después de un error no hay cierre: sería un "listo" encima del fallo.
	if out := finish(Turn{}); out != nil {
		t.Errorf("tras un error no se emite done: %+v", out)
	}
}

// El uso sale de la sesión exportada (testdata/opencode-export.json, real):
// el stream no trae el del último paso.
func TestOpencodeUsageFromExport(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "opencode-export.json"))
	if err != nil {
		t.Fatal(err)
	}
	u := opencodeUsageFromExport(raw)
	if u == nil {
		t.Fatal("la sesión trae los tokens de cada mensaje")
	}
	// Los dos mensajes del asistente del turno, el último incluido.
	if u.Input != 4160+4532 || u.Output != 198+110 || u.CacheRead != 4336*2 || u.Thinking != 89+17 {
		t.Errorf("uso mal sumado: %+v", u)
	}
	if u.Total != u.Input+u.Output+u.CacheRead {
		t.Errorf("total inconsistente: %+v", u)
	}
	if u.Model != "opencode/nemotron-3.5-super-vl-free" {
		t.Errorf("el modelo va como proveedor/modelo, que es como se elige: %q", u.Model)
	}
	if opencodeUsageFromExport([]byte("no es json")) != nil {
		t.Error("sin datos legibles el uso es desconocido, no cero")
	}
}

func TestBuildArgsOpencode(t *testing.T) {
	args, err := buildArgs(Turn{AgentID: "opencode", Command: "opencode", Prompt: "-hola"}, "")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"run --format json --standalone", "--agent plan"} {
		if !strings.Contains(joined, want) {
			t.Errorf("falta %q: %v", want, args)
		}
	}
	// El prompt va último, después de `--`: uno que empieza con guion no es
	// una bandera.
	if args[len(args)-2] != "--" || args[len(args)-1] != "-hola" {
		t.Errorf("el prompt va después de --: %v", args)
	}
	if strings.Contains(joined, "--session") {
		t.Error("sin conversación previa no hay que encadenar")
	}

	args, _ = buildArgs(Turn{AgentID: "opencode", Command: "opencode", Prompt: "x", Mode: ModeEdit, Model: "opencode-go/glm-5.3", Effort: "high"}, "ses_1")
	joined = strings.Join(args, " ")
	// Editar nombra `build` aunque sea el de por defecto: una sesión retomada
	// conserva el agente anterior si no se le dice otro.
	if !strings.Contains(joined, "--agent build") {
		t.Errorf("editar nombra su agente: %v", args)
	}
	if !strings.Contains(joined, "--session ses_1") || !strings.Contains(joined, "--model opencode-go/glm-5.3") {
		t.Errorf("encadena y respeta el modelo: %v", args)
	}
	if strings.Contains(joined, "high") {
		t.Errorf("el esfuerzo no se pasa: es una variante de cada modelo: %v", args)
	}
	// `--auto` aprueba todo lo que no esté denegado: nunca.
	if strings.Contains(joined, "--auto") {
		t.Error("jamás se pasa --auto")
	}

	// En todos los modos va la configuración que le quita los comandos.
	for _, m := range []Mode{ModeAsk, ModeEdit} {
		env := strings.Join(turnEnv(Turn{AgentID: "opencode", Mode: m, Cwd: "/repo"}), " ")
		if !strings.Contains(env, `OPENCODE_CONFIG_CONTENT=`) || !strings.Contains(env, `"bash":"deny"`) {
			t.Errorf("modo %q sin la denegación de comandos: %q", m, env)
		}
		// OpenCode toma el directorio de PWD, no del proceso.
		if !strings.Contains(env, "PWD=/repo") {
			t.Errorf("falta PWD: %q", env)
		}
	}
	if turnEnv(Turn{AgentID: "claude"}) != nil {
		t.Error("los otros agentes no reciben esa variable")
	}
}

func TestParseOpencodeSessions(t *testing.T) {
	got := parseOpencodeSessions([]byte(`[
  {"id": "ses_b", "title": "Segunda", "updated": 1792088177232},
  {"id": "ses_sin", "updated": 1792088179000},
  {"id": "ses_a", "title": "Primera", "updated": 1792088159409}
]`))
	if len(got) != 2 || got[0].ID != "ses_b" || got[1].ID != "ses_a" {
		t.Fatalf("de la más reciente a la más vieja, sin las que no tienen título: %+v", got)
	}
	if got[0].UpdatedAt != 1792088177 || got[0].Agent != "opencode" {
		t.Errorf("updated viene en milisegundos: %+v", got[0])
	}
}
