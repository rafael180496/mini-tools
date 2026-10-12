package vault

import "testing"

func TestModelServerUsageRows(t *testing.T) {
	s := newChatStore(t)
	for _, c := range []struct{ id, agent string }{{"a", "llm:s1"}, {"b", "llm:s2"}, {"cli", "claude"}} {
		if err := s.CreateAgentChat(c.id, "", c.agent, "t", "note", "n"); err != nil {
			t.Fatal(err)
		}
	}
	add := func(chat, role, usage string) {
		t.Helper()
		if err := s.AppendAgentChatMessage(chat, role, "secreto "+chat, "", usage); err != nil {
			t.Fatal(err)
		}
	}
	add("a", ChatRoleUser, "")
	add("a", ChatRoleAssistant, `{"input":10,"output":5,"total":15,"model":"qwen","durationMs":2500}`)
	add("a", ChatRoleAssistant, `{"input":1,"output":1,"total":2}`) // anterior a model/durationMs
	add("a", ChatRoleAssistant, `{no es json`)                      // dañada: no tira el informe
	add("b", ChatRoleAssistant, `{"input":7,"output":3,"total":10,"model":"llama"}`)
	add("cli", ChatRoleAssistant, `{"input":99,"output":99,"total":198}`) // un CLI no es un servidor de modelos

	rows, err := s.ModelServerUsageRows(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %+v", rows)
	}
	by := map[string][]ChatUsageRow{}
	for _, r := range rows {
		by[r.AgentID] = append(by[r.AgentID], r)
	}
	if len(by["claude"]) != 0 || len(by["llm:s1"]) != 2 || len(by["llm:s2"]) != 1 {
		t.Fatalf("agrupado = %+v", by)
	}
	var withModel ChatUsageRow
	for _, r := range by["llm:s1"] {
		if r.Model == "qwen" {
			withModel = r
		}
	}
	if withModel.Input != 10 || withModel.Output != 5 || withModel.Total != 15 || withModel.DurationMs != 2500 || withModel.ChatID != "a" || withModel.CreatedAt == 0 {
		t.Fatalf("fila con modelo = %+v", withModel)
	}

	// La ventana: nada anterior a `since`.
	future, err := s.ModelServerUsageRows(withModel.CreatedAt + 3600)
	if err != nil || len(future) != 0 {
		t.Fatalf("future = %+v, %v", future, err)
	}
}

// El proveedor sale del propio turno (`$.agentId`) y solo cae al del chat si la
// fila no lo trae.
func TestModelServerUsageRowsPrefersRowProvider(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("a", "", "llm:b", "t", "note", "n"); err != nil {
		t.Fatal(err)
	}
	add := func(usage string) {
		t.Helper()
		if err := s.AppendAgentChatMessage("a", ChatRoleAssistant, "x", "", usage); err != nil {
			t.Fatal(err)
		}
	}
	add(`{"input":1,"output":1,"total":2,"agentId":"llm:a"}`) // lo atendió A
	add(`{"input":2,"output":2,"total":4,"agentId":""}`)      // vacío = sin dato
	add(`{"input":3,"output":3,"total":6}`)                   // fila vieja
	add(`{"input":4,"output":4,"total":8,"agentId":"llm:b"}`)
	rows, err := s.ModelServerUsageRows(0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, r := range rows {
		got[r.AgentID] += r.Total
	}
	if len(rows) != 4 || got["llm:a"] != 2 || got["llm:b"] != 18 {
		t.Fatalf("por proveedor = %v", got)
	}
}

func TestSetAgentChatAgent(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("a", "", "llm:a", "t", "note", "n"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatSettings("a", "qwen", "high", "edit"); err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{`{"total":10}`, `{"total":5,"agentId":"llm:z"}`, `{no es json`, ""} {
		if err := s.AppendAgentChatMessage("a", ChatRoleAssistant, "x", "", u); err != nil {
			t.Fatal(err)
		}
	}
	agent, ok, err := s.AgentChatAgent("a")
	if err != nil || !ok || agent != "llm:a" {
		t.Fatalf("AgentChatAgent = %q %v %v", agent, ok, err)
	}
	if _, ok, _ := s.AgentChatAgent("no-existe"); ok {
		t.Fatal("un chat inexistente no debería tener agente")
	}

	if err := s.SetAgentChatAgent("a", "llm:otro", "llm:b"); err == nil {
		t.Fatal("un cambio desde un agente que no es el actual tiene que fallar")
	}
	if err := s.SetAgentChatAgent("a", "llm:a", "llm:b"); err != nil {
		t.Fatal(err)
	}
	chats, _ := s.ListAllAgentChats()
	if len(chats) != 1 || chats[0].AgentID != "llm:b" || chats[0].Model != "" || chats[0].Effort != "high" || chats[0].Mode != "edit" {
		t.Fatalf("chat = %+v", chats)
	}
	// El consumo anterior queda con A (lo que no traía proveedor); lo que ya
	// traía uno no se pisa.
	rows, err := s.ModelServerUsageRows(0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for _, r := range rows {
		got[r.AgentID] += r.Total
	}
	if got["llm:a"] != 10 || got["llm:z"] != 5 || got["llm:b"] != 0 {
		t.Fatalf("por proveedor = %v", got)
	}
}
