package agentchat

import (
	"strings"
	"testing"
)

// Turn.Notice sale una sola vez, justo después del primer start y antes del
// resto de la respuesta, y no cuenta como respuesta del modelo.
func TestTurnNoticeGoesRightAfterTheFirstStart(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	notice := WarnNote("mini-tools aprobó sus herramientas")
	err := m.Send(Turn{
		SessionID: "s1", AgentID: "antigravity", Command: "agy", Prompt: "hola",
		Exec:   []string{"sh", "-c", "cat testdata/antigravity-stream.jsonl"},
		Notice: notice,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	evs := col.wait(t)
	if evs[0].Kind != KindStart || evs[1].Kind != KindText || evs[1].Text != notice+"\n\n" {
		t.Fatalf("el aviso va después del start: %v / %+v", kinds(evs), evs[:2])
	}
	n := 0
	for _, e := range evs {
		if strings.Contains(e.Text, "aprobó sus herramientas") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("el aviso sale una sola vez, salió %d", n)
	}
}

// Un turno sin respuesta sigue diciendo que no respondió aunque haya aviso.
func TestTurnNoticeDoesNotCountAsAReply(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	err := m.Send(Turn{
		SessionID: "s1", AgentID: "antigravity", Command: "agy", AgentLabel: "Antigravity", Prompt: "hola",
		Exec:   []string{"sh", "-c", "cat testdata/antigravity-text-empty.jsonl"},
		Notice: WarnNote("aviso"),
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	var b strings.Builder
	for _, e := range eventsOfKind(col.wait(t), KindText) {
		b.WriteString(e.Text)
	}
	if !strings.Contains(b.String(), "terminó el turno sin responder nada") {
		t.Errorf("falta la nota de turno vacío: %q", b.String())
	}
}

// El rechazo de Antigravity ofrece «Reparar permisos» (Action) solo si el
// turno llevaba el MCP de mini-tools; sin él la nota es la de siempre.
func TestAgyDenialOffersRepairOnlyWithMCP(t *testing.T) {
	run := func(tools []string) []Event {
		col := newCollector()
		m := NewManager(col.emit)
		err := m.Send(Turn{
			SessionID: "s1", AgentID: "antigravity", Command: "agy", AgentLabel: "Antigravity", Prompt: "hola",
			Exec:     []string{"sh", "-c", "cat testdata/antigravity-denied.jsonl"},
			MCPTools: tools, MCPServer: "mini-tools",
		})
		if err != nil {
			t.Fatalf("Send: %v", err)
		}
		return col.wait(t)
	}
	actions := func(evs []Event) (n int) {
		for _, e := range evs {
			if e.Action == ActionRepairAgyPerms {
				if e.Kind != KindText {
					t.Errorf("la acción va en la nota (texto): %+v", e)
				}
				n++
			}
		}
		return
	}

	evs := run([]string{"db_get_schema"})
	if actions(evs) != 1 {
		t.Errorf("con MCP debe haber exactamente una acción de reparar: %v", kinds(evs))
	}
	var note string
	for _, e := range evs {
		if e.Action != "" {
			note = e.Text
		}
	}
	if !strings.Contains(note, "Reparar permisos") && !strings.Contains(note, "Repará los permisos") {
		t.Errorf("la nota debe ofrecer la reparación: %q", note)
	}

	if n := actions(run(nil)); n != 0 {
		t.Errorf("sin MCP no hay nada que reparar, hubo %d acciones", n)
	}
}

func TestEventActionIsOmittedFromJSONWhenEmpty(t *testing.T) {
	if b, _ := jsonString(Event{Kind: KindText}); strings.Contains(b, "action") {
		t.Errorf("action vacío no debe serializarse: %s", b)
	}
	if b, _ := jsonString(Event{Kind: KindText, Action: ActionRepairAgyPerms}); !strings.Contains(b, `"action":"repair-agy-perms"`) {
		t.Errorf("action = %s", b)
	}
}
