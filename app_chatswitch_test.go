package main

import (
	"testing"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/vault"
	"mini-tools/backend/vaultgate"
)

func chatAgentOf(t *testing.T, a *App, id string) vault.AgentChat {
	t.Helper()
	chats, err := a.vault.ListAllAgentChats()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range chats {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no está el chat %s", id)
	return vault.AgentChat{}
}

func TestSetAgentChatAgent(t *testing.T) {
	spanish(t)
	a, _ := newChatApp(t)
	srvA, _ := a.vault.SaveModelServer(vault.ModelServer{Name: "Uno", Kind: "ollama", BaseURL: "http://localhost:11434"}, "", false, nil, false)
	srvB, _ := a.vault.SaveModelServer(vault.ModelServer{Name: "Dos", Kind: "openai", BaseURL: "https://api.example.com/v1"}, "", false, nil, false)
	srvOff, _ := a.vault.SaveModelServer(vault.ModelServer{Name: "Apagado", Kind: "anthropic", BaseURL: "https://api.anthropic.com"}, "", false, nil, false)
	if err := a.vault.SetModelServerEnabled(srvOff.ID, false); err != nil {
		t.Fatal(err)
	}
	idA, idB, idOff := agentchat.LLMPrefix+srvA.ID, agentchat.LLMPrefix+srvB.ID, agentchat.LLMPrefix+srvOff.ID

	if err := a.vault.CreateAgentChat("c1", "", idA, "t", "note", "n"); err != nil {
		t.Fatal(err)
	}
	if err := a.vault.CreateAgentChat("cli", "", "claude", "t", "note", "n"); err != nil {
		t.Fatal(err)
	}
	if err := a.vault.SetAgentChatSettings("c1", "qwen", "high", "edit"); err != nil {
		t.Fatal(err)
	}

	// Rechazos: nada cambia.
	for name, c := range map[string][2]string{
		"chat inexistente":         {"nope", idB},
		"chat de un CLI":           {"cli", idB},
		"destino que es un CLI":    {"c1", "claude"},
		"destino inexistente":      {"c1", agentchat.LLMPrefix + "no-existe"},
		"destino desactivado":      {"c1", idOff},
		"destino vacío":            {"c1", ""},
		"destino con solo prefijo": {"c1", agentchat.LLMPrefix},
	} {
		if err := a.SetAgentChatAgent(c[0], c[1]); err == nil {
			t.Errorf("%s: tendría que fallar", name)
		}
	}
	if c := chatAgentOf(t, a, "c1"); c.AgentID != idA || c.Model != "qwen" {
		t.Fatalf("un rechazo cambió el chat: %+v", c)
	}
	if c := chatAgentOf(t, a, "cli"); c.AgentID != "claude" {
		t.Fatalf("el chat del CLI cambió: %+v", c)
	}

	// Mismo proveedor: éxito sin tocar nada (ni el modelo).
	if err := a.SetAgentChatAgent("c1", idA); err != nil {
		t.Fatal(err)
	}
	if c := chatAgentOf(t, a, "c1"); c.Model != "qwen" {
		t.Fatalf("el mismo proveedor no debería vaciar el modelo: %+v", c)
	}

	if err := a.SetAgentChatAgent("c1", idB); err != nil {
		t.Fatal(err)
	}
	c := chatAgentOf(t, a, "c1")
	if c.AgentID != idB || c.Model != "" || c.Effort != "high" || c.Mode != "edit" {
		t.Fatalf("chat = %+v", c)
	}
}

func TestSetAgentChatAgentRequiresUnlock(t *testing.T) {
	a := &App{gate: vaultgate.New()}
	if err := a.SetAgentChatAgent("c", agentchat.LLMPrefix+"x"); err == nil {
		t.Fatal("con el vault bloqueado tendría que fallar")
	}
}
