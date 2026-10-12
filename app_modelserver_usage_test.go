package main

import (
	"fmt"
	"testing"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/vault"
)

func TestBuildModelServerUsage(t *testing.T) {
	spanish(t)
	now := time.Date(2026, 10, 12, 15, 0, 0, 0, time.Local)
	at := func(daysAgo int, hour int) int64 {
		return time.Date(2026, 10, 12-daysAgo, hour, 30, 0, 0, time.Local).Unix()
	}
	servers := []vault.ModelServer{
		{ID: "loc", Name: "Mi Ollama", Kind: vault.ModelServerOllama, BaseURL: "http://localhost:11434"},
		{ID: "rem", Name: "GPU remota", Kind: vault.ModelServerOpenAI, BaseURL: "https://gpu.empresa:8000/v1"},
		{ID: "idle", Name: "Sin uso", Kind: vault.ModelServerOllama, BaseURL: "http://127.0.0.1:11434"},
	}
	rows := []vault.ChatUsageRow{
		{AgentID: "llm:loc", ChatID: "c1", CreatedAt: at(0, 9), Model: "qwen", Input: 100, Output: 50, Total: 150, DurationMs: 5000}, // 10 tok/s
		{AgentID: "llm:loc", ChatID: "c1", CreatedAt: at(0, 10), Model: "qwen", Input: 100, Output: 150, Total: 250, DurationMs: 5000},
		{AgentID: "llm:loc", ChatID: "c2", CreatedAt: at(3, 23), Model: "llama", Input: 40, Output: 10},    // sin duración
		{AgentID: "llm:loc", ChatID: "c3", CreatedAt: at(29, 8), Model: "", Input: 5, Output: 5},           // fila vieja: sin total ni modelo
		{AgentID: "llm:loc", ChatID: "c4", CreatedAt: at(30, 8), Model: "qwen", Input: 1000, Output: 1000}, // fuera de la ventana de 30 días
		{AgentID: "llm:rem", ChatID: "c5", CreatedAt: at(1, 12), Model: "gpt", Input: 10, Output: 20, Total: 30, DurationMs: 1000},
		{AgentID: "llm:gone", ChatID: "c6", CreatedAt: at(2, 12), Model: "x", Input: 1, Output: 1, Total: 2},
	}
	rep := buildModelServerUsage(servers, rows, now, 30)

	if rep.Days != 30 || rep.FirstDay != "2026-09-13" || rep.LastDay != "2026-10-12" {
		t.Fatalf("ventana = %+v", rep)
	}
	if len(rep.Servers) != 4 {
		t.Fatalf("servers = %d: %+v", len(rep.Servers), rep.Servers)
	}
	// Orden: más consumo primero, los sin turnos al final.
	names := []string{rep.Servers[0].Name, rep.Servers[1].Name, rep.Servers[2].Name, rep.Servers[3].Name}
	if names[0] != "Mi Ollama" || names[1] != "GPU remota" || names[3] != "Sin uso" || !rep.Servers[2].Deleted {
		t.Fatalf("orden = %v", names)
	}

	loc := rep.Servers[0]
	if !loc.IsLocal || loc.AgentID != "llm:loc" || loc.Kind != "ollama" {
		t.Fatalf("loc meta = %+v", loc)
	}
	// 150+250+50+10 = 460; la fila vieja suma input+output; la de afuera no cuenta.
	if loc.Totals.Input != 245 || loc.Totals.Output != 215 || loc.Totals.Total != 460 || loc.Totals.Turns == 0 || loc.Totals.Turns != 4 || loc.Totals.Conversations != 3 {
		t.Fatalf("loc totals = %+v", loc.Totals)
	}
	// Velocidad: solo los dos turnos con duración: 200 tokens en 10 s.
	if loc.TokensPerSec != 20 {
		t.Fatalf("tokens/s = %v", loc.TokensPerSec)
	}
	if loc.LastUsedAt != at(0, 10) {
		t.Fatalf("lastUsedAt = %d", loc.LastUsedAt)
	}
	if len(loc.ByModel) != 3 || loc.ByModel[0].Model != "qwen" || loc.ByModel[0].Totals.Total != 400 || loc.ByModel[0].Percent != 87 ||
		loc.ByModel[0].TokensPerSec != 20 || loc.ByModel[1].Model != "llama" || loc.ByModel[1].TokensPerSec != 0 || loc.ByModel[2].Model != "" {
		t.Fatalf("byModel = %+v", loc.ByModel)
	}
	// La serie trae todos los días, con ceros.
	if len(loc.ByDay) != 30 || loc.ByDay[0].Day != "2026-09-13" || loc.ByDay[29].Day != "2026-10-12" ||
		loc.ByDay[29].Total != 400 || loc.ByDay[29].Turns != 2 || loc.ByDay[26].Total != 50 || loc.ByDay[0].Total != 10 || loc.ByDay[10].Total != 0 {
		t.Fatalf("byDay = %+v", loc.ByDay)
	}

	if rem := rep.Servers[1]; rem.IsLocal || rem.Kind != "openai" || rem.Totals.Total != 30 || rem.TokensPerSec != 20 {
		t.Fatalf("rem = %+v", rem)
	}
	gone := rep.Servers[2]
	if gone.AgentID != "llm:gone" || gone.Kind != "" || gone.Totals.Turns != 1 || gone.Name == "" {
		t.Fatalf("gone = %+v", gone)
	}
	idle := rep.Servers[3]
	if idle.Totals.Turns != 0 || idle.LastUsedAt != 0 || len(idle.ByDay) != 30 || len(idle.ByModel) != 0 || !idle.IsLocal {
		t.Fatalf("idle = %+v", idle)
	}
}

// Un turno de verdad deja el modelo y el tiempo de generación en el uso
// guardado, y el informe los toma de ahí.
func TestModelServerUsageEndToEnd(t *testing.T) {
	a, events := newChatApp(t)
	f := &fakeChatLLM{reply: "Hola"}
	srvA, _ := a.vault.SaveModelServer(vault.ModelServer{Name: "Mi Ollama", Kind: "ollama", BaseURL: "http://localhost:11434"}, "", false, nil, false)
	agentID := agentchat.LLMPrefix + srvA.ID
	for i := 0; i < 2; i++ {
		session := fmt.Sprintf("chat-%d", i)
		err := a.sendRecorded("note", "n1", "hola", agentchat.Turn{SessionID: session, AgentID: agentID, Prompt: "hola", LLM: f})
		if err != nil {
			t.Fatal(err)
		}
		waitTurnEnd(t, a, events, session)
	}

	rep, err := a.ModelServerUsage(0)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Days != 30 || len(rep.Servers) != 1 {
		t.Fatalf("rep = %+v", rep)
	}
	s := rep.Servers[0]
	// fakeChatLLM: 7 in + 3 out por turno, modelo "m".
	if s.Name != "Mi Ollama" || s.Totals.Turns != 2 || s.Totals.Conversations != 2 || s.Totals.Input != 14 || s.Totals.Output != 6 || s.Totals.Total != 20 {
		t.Fatalf("totales = %+v", s)
	}
	if len(s.ByModel) != 1 || s.ByModel[0].Model != "m" || s.ByModel[0].Percent != 100 {
		t.Fatalf("byModel = %+v", s.ByModel)
	}
	if s.LastUsedAt == 0 || s.ByDay[len(s.ByDay)-1].Turns != 2 {
		t.Fatalf("hoy = %+v", s.ByDay[len(s.ByDay)-1])
	}

	// El servidor se elimina: sus chats quedan como «eliminado», no desaparecen.
	if err := a.vault.DeleteModelServer(srvA.ID); err != nil {
		t.Fatal(err)
	}
	rep, _ = a.ModelServerUsage(7)
	if rep.Days != 7 || len(rep.Servers) != 1 || !rep.Servers[0].Deleted || rep.Servers[0].Totals.Turns != 2 || len(rep.Servers[0].ByDay) != 7 {
		t.Fatalf("tras borrar = %+v", rep)
	}
}

// Un chat que cambia de proveedor no arrastra su consumo anterior: cada turno
// queda con el proveedor que lo atendió, y los turnos viejos (sin proveedor
// en el usage) se quedan con el que tenía el chat al momento del cambio.
func TestModelServerUsageFollowsProviderSwitch(t *testing.T) {
	a, events := newChatApp(t)
	f := &fakeChatLLM{reply: "Hola"}
	srvA, _ := a.vault.SaveModelServer(vault.ModelServer{Name: "Uno", Kind: "ollama", BaseURL: "http://localhost:11434"}, "", false, nil, false)
	srvB, _ := a.vault.SaveModelServer(vault.ModelServer{Name: "Dos", Kind: "openai", BaseURL: "https://api.example.com/v1"}, "", false, nil, false)
	idA, idB := agentchat.LLMPrefix+srvA.ID, agentchat.LLMPrefix+srvB.ID
	run := func(agent string) {
		t.Helper()
		if err := a.sendRecorded("note", "n1", "hola", agentchat.Turn{SessionID: "chat", AgentID: agent, Prompt: "hola", LLM: f}); err != nil {
			t.Fatal(err)
		}
		waitTurnEnd(t, a, events, "chat")
	}
	run(idA)
	run(idA)
	// Un turno viejo, de antes de que se guardara el proveedor.
	if err := a.vault.AppendAgentChatMessage("chat", vault.ChatRoleAssistant, "viejo", "", `{"input":100,"output":0,"total":100}`); err != nil {
		t.Fatal(err)
	}
	if err := a.SetAgentChatAgent("chat", idB); err != nil {
		t.Fatal(err)
	}
	run(idB)

	rep, err := a.ModelServerUsage(0)
	if err != nil {
		t.Fatal(err)
	}
	turns := map[string]int{}
	totals := map[string]int64{}
	for _, s := range rep.Servers {
		turns[s.AgentID] = s.Totals.Turns
		totals[s.AgentID] = s.Totals.Total
	}
	// A: dos turnos de 10 y el viejo de 100. B: uno solo, de 10.
	if turns[idA] != 3 || totals[idA] != 120 || turns[idB] != 1 || totals[idB] != 10 {
		t.Fatalf("A=%d/%d B=%d/%d, quería A=3/120 B=1/10", turns[idA], totals[idA], turns[idB], totals[idB])
	}
}
