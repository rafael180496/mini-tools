package agentchat

import (
	"os"
	"path/filepath"
	"testing"
)

// El transcript de Codex mezcla mensajes INYECTADOS con rol `user` junto al
// que escribió la persona, sin ningún campo que los distinga — se comprobó
// contra archivos reales. Filtrarlos es lo que separa un historial legible de
// uno lleno del prompt de sistema.
func TestCodexHistoryFiltersInjectedMessages(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".codex", "sessions", "2026", "08", "14")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	const id = "hilo-123"
	lines := `{"type":"session_meta","payload":{}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are the primary agent"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>\nlista de plugins\n"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"cuántas líneas tiene VERSION"}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":[]}}
{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"{\"command\":\"wc -l VERSION\"}"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"1"}]}}
esto no es json
`
	if err := os.WriteFile(filepath.Join(dir, "rollout-2026-08-14T15-00-00-"+id+".jsonl"), []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	turns, err := codexHistory(home, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 {
		t.Fatalf("se esperaban 2 turnos (el del usuario y el del agente), hubo %d: %+v", len(turns), turns)
	}
	if turns[0].Role != "user" || turns[0].Text != "cuántas líneas tiene VERSION" {
		t.Errorf("el mensaje real del usuario se perdió o se coló uno inyectado: %+v", turns[0])
	}
	// La herramienta y el texto del agente son UN turno, no dos burbujas: el
	// transcript los parte y dibujarlos separados mostraría una conversación
	// que no se parece a la que pasó.
	if turns[1].Role != "agent" || turns[1].Text != "1" || len(turns[1].Tools) != 1 {
		t.Errorf("el turno del agente debería venir unido: %+v", turns[1])
	}
	if turns[1].Tools[0].Summary != "wc -l VERSION" {
		t.Errorf("la herramienta debería venir descrita: %+v", turns[1].Tools[0])
	}
}

// El modo de fallo de la heurística, dicho en un test para que no sorprenda.
func TestInjectedMessageHeuristic(t *testing.T) {
	for _, s := range []string{"<recommended_plugins>\nx", "<skills_instructions>y"} {
		if !injectedMessage(s) {
			t.Errorf("debería reconocerse como inyectado: %q", s)
		}
	}
	for _, s := range []string{"hola", "usá <div> en el html", "¿por qué <b> no anda?"} {
		if injectedMessage(s) {
			t.Errorf("un mensaje real no debería filtrarse: %q", s)
		}
	}
	// Documentado: un mensaje que EMPIEZA con una etiqueta se pierde del
	// historial. Es raro, no pierde datos —sigue en el transcript del CLI— y
	// la alternativa es llenar el panel con el prompt de sistema.
	if !injectedMessage("<div>hola</div>") {
		t.Error("este es el falso positivo conocido; si cambia, actualizá el comentario de injectedMessage")
	}
}

// Una conversación que no está NO es un error: puede haberse borrado desde el
// propio CLI, y el chat tiene que abrir igual.
func TestHistoryMissingIsNotAnError(t *testing.T) {
	turns, err := History("codex", "no-existe")
	if err != nil || len(turns) != 0 {
		t.Errorf("debería devolver vacío sin error: %+v (%v)", turns, err)
	}
	// Antigravity tampoco: sin su carpeta en `brain/` no hay transcript.
	turns, err = History("antigravity", "cualquiera")
	if err != nil || len(turns) != 0 {
		t.Errorf("una conversación de Antigravity que no está debe devolver vacío: %+v (%v)", turns, err)
	}
	// Y un agente sin lector sigue siendo vacío sin error, no un fallo.
	turns, err = History("inventado", "cualquiera")
	if err != nil || len(turns) != 0 {
		t.Errorf("un agente sin lector debe devolver vacío: %+v (%v)", turns, err)
	}
}

// El transcript de Antigravity envuelve el mensaje del usuario y le agrega
// bloques propios detrás; los pasos de SYSTEM son checkpoints y avisos del
// servidor que la conversación nunca tuvo. Este test fija las dos cosas: el
// recorte del envoltorio y qué se descarta.
//
// Las líneas son la forma real de
// `brain/<id>/.system_generated/logs/transcript_full.jsonl`.
func TestAntigravityHistoryLeeElTranscript(t *testing.T) {
	home := t.TempDir()
	const id = "a43da416-948e-444a-be0b-6db656233ed8"
	dir := filepath.Join(home, ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	lines := `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\ncorregí este insert\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-24T20:43:11-06:00.\n</ADDITIONAL_METADATA>"}
{"step_index":1,"source":"SYSTEM","type":"CHECKPOINT","content":"{{ CHECKPOINT 0 }} resumen del contexto truncado"}
{"step_index":2,"source":"MODEL","type":"VIEW_FILE","content":"Created At: 2026-08-16T04:00:18Z\nFile Path: ` + "`file:///tmp/consulta.sql`" + `\nTotal Lines: 55\n1: select 1"}
{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","content":"Sobra la palabra values."}
{"step_index":4,"source":"SYSTEM","type":"SYSTEM_MESSAGE","content":"[Notice] All your subagents have been stopped."}
esto no es json
`
	if err := os.WriteFile(filepath.Join(dir, "transcript_full.jsonl"), []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	turns, err := antigravityHistory(home, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(turns) != 2 {
		t.Fatalf("se esperaban 2 turnos (el del usuario y el del agente), hubo %d: %+v", len(turns), turns)
	}
	if turns[0].Role != "user" || turns[0].Text != "corregí este insert" {
		t.Errorf("el envoltorio y los bloques del CLI deberían quedar afuera: %+v", turns[0])
	}
	// La herramienta y el texto son UN turno: el transcript los parte y
	// dibujarlos separados mostraría una conversación que no pasó.
	if turns[1].Role != "agent" || turns[1].Text != "Sobra la palabra values." || len(turns[1].Tools) != 1 {
		t.Errorf("el turno del agente debería venir unido: %+v", turns[1])
	}
	if got := turns[1].Tools[0]; got.Name != "view_file" || got.Summary != "/tmp/consulta.sql" {
		t.Errorf("la herramienta debería decir sobre qué actuó: %+v", got)
	}
}

// El id de conversación termina en un filepath.Join. Uno con separadores
// sacaría la lectura de la carpeta de conversaciones.
func TestAntigravityHistoryRechazaIdConRuta(t *testing.T) {
	home := t.TempDir()
	for _, id := range []string{"../../../etc", "a/b", `a\b`, ".."} {
		turns, err := antigravityHistory(home, id)
		if err != nil || len(turns) != 0 {
			t.Errorf("un id con ruta adentro no debería leer nada: %q → %+v (%v)", id, turns, err)
		}
	}
}
