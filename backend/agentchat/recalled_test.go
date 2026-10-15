package agentchat

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"mini-tools/backend/llm"
)

// Las notas recordadas del cerebro viajan en el PRIMER KindStart del turno (y
// en ningún otro evento): es lo que la conversación muestra como «Recordó N
// notas». Vale para los CLIs (run) y para los servidores de modelos (runLLM).

func TestRecalledGoesOnTheFirstStartOfACLITurn(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	want := []string{"_Índice proyecto", "Bloqueos Oracle"}

	// Un CLI de mentira: reproduce la corrida real capturada de Antigravity.
	err := m.Send(Turn{
		SessionID: "s1", AgentID: "antigravity", Command: "agy", Prompt: "hola",
		Exec:     []string{"sh", "-c", "cat testdata/antigravity-stream.jsonl"},
		Recalled: want,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	evs := col.wait(t)

	starts := 0
	for _, e := range evs {
		if e.Kind == KindStart {
			starts++
			if starts == 1 && !reflect.DeepEqual(e.Recalled, want) {
				t.Errorf("el primer start debe llevar %v, lleva %v", want, e.Recalled)
			}
			continue
		}
		if e.Recalled != nil {
			t.Errorf("solo el start lleva Recalled: %+v", e)
		}
	}
	if starts == 0 {
		t.Fatalf("la corrida no emitió ningún start: %+v", evs)
	}
	if starts > 1 {
		t.Logf("la corrida trae %d starts; solo el primero lleva el recuerdo", starts)
	}
}

func TestNoRecalledMeansNoField(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	err := m.Send(Turn{
		SessionID: "s1", AgentID: "antigravity", Command: "agy", Prompt: "hola",
		Exec: []string{"sh", "-c", "cat testdata/antigravity-stream.jsonl"},
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	for _, e := range col.wait(t) {
		if e.Recalled != nil {
			t.Errorf("sin recuerdo no debe haber campo: %+v", e)
		}
	}
}

func TestRecalledGoesOnTheStartOfAnLLMTurn(t *testing.T) {
	f := &fakeLLM{models: []string{"qwen2.5:3b"}, reply: "ok", usage: llm.Usage{Input: 1, Output: 1}}
	col := newCollector()
	m := NewManager(col.emit)
	want := []string{"Deploy SGC"}

	if err := m.Send(Turn{SessionID: "s1", AgentID: "llm:abc", Prompt: "hola", LLM: f, Recalled: want}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	evs := col.wait(t)
	if evs[0].Kind != KindStart || !reflect.DeepEqual(evs[0].Recalled, want) {
		t.Fatalf("start = %+v", evs[0])
	}
	for _, e := range evs[1:] {
		if e.Recalled != nil {
			t.Errorf("solo el start lleva Recalled: %+v", e)
		}
	}
	waitIdle(t, m, "s1")

	// El turno siguiente, sin recuerdo, no hereda el del anterior.
	if err := m.Send(Turn{SessionID: "s1", AgentID: "llm:abc", Prompt: "otra", LLM: f}); err != nil {
		t.Fatalf("Send 2: %v", err)
	}
	evs = col.wait(t)
	if evs[0].Kind != KindStart || evs[0].Recalled != nil {
		t.Errorf("el start del segundo turno no debe traer recuerdo: %+v", evs[0])
	}
}

func TestRecalledIsOmittedFromJSONWhenEmpty(t *testing.T) {
	// Es el contrato con el frontend: `recalled` solo existe cuando hay algo.
	if b, _ := jsonString(Event{Kind: KindStart}); strings.Contains(b, "recalled") {
		t.Errorf("recalled vacío no debe serializarse: %s", b)
	}
	if b, _ := jsonString(Event{Kind: KindStart, Recalled: []string{"A"}}); !strings.Contains(b, `"recalled":["A"]`) {
		t.Errorf("recalled = %s", b)
	}
}

func jsonString(e Event) (string, error) {
	b, err := json.Marshal(e)
	return string(b), err
}
