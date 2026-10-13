package vault

import (
	"errors"
	"testing"
	"time"
)

// La migración 65 no abre ninguna conversación existente: el historial de antes
// no se vuelca de golpe en la lista de Abiertas. Es idempotente y deja intactas
// las columnas anteriores.
func TestMigration65AddsOpenColumnsClosedByDefault(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("viejo", "", "claude", "chat anterior", "git", "r1"); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`ALTER TABLE agent_chats DROP COLUMN open`,
		`ALTER TABLE agent_chats DROP COLUMN pinned`,
		`ALTER TABLE agent_chats DROP COLUMN last_status`,
		`ALTER TABLE agent_chats DROP COLUMN opened_at`,
		`DELETE FROM schema_migrations WHERE version >= 65`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := applyMigrations(s.db); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	all, err := s.ListAllAgentChats()
	if err != nil || len(all) != 1 {
		t.Fatalf("ListAll = %+v, %v", all, err)
	}
	c := all[0]
	if c.Open || c.Pinned || c.LastStatus != "" || c.Title != "chat anterior" || c.Module != "git" || c.ContextID != "r1" || c.AgentID != "claude" {
		t.Errorf("fila migrada = %+v", c)
	}
	if open, _ := s.ListOpenAgentChats(); len(open) != 0 {
		t.Errorf("ninguna conversación existente debe quedar abierta: %+v", open)
	}
	if err := applyMigrations(s.db); err != nil {
		t.Errorf("segunda pasada: %v", err)
	}
	var max int
	if err := s.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&max); err != nil || max != 65 {
		t.Errorf("versión = %d, %v", max, err)
	}
}

// Una conversación nueva existe desde el primer instante: abierta, sin título,
// con el proveedor, el modelo y el proyecto elegidos. Es idempotente.
func TestCreateOpenAgentChatPersistsTheDraft(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateOpenAgentChat("d1", "llm:x", "qwen3", "utilities", "ws:7"); err != nil {
		t.Fatal(err)
	}
	// Repetirlo no pisa nada.
	if err := s.CreateOpenAgentChat("d1", "claude", "otro", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	open, err := s.ListOpenAgentChats()
	if err != nil || len(open) != 1 {
		t.Fatalf("open = %+v, %v", open, err)
	}
	c := open[0]
	if c.ID != "d1" || !c.Open || c.Pinned || c.Title != "" || c.AgentID != "llm:x" || c.Model != "qwen3" ||
		c.Module != "utilities" || c.ContextID != "ws:7" || c.LastStatus != "" || c.ConversationID != "" || c.RepoID != "" {
		t.Errorf("borrador = %+v", c)
	}
}

func TestOpenListPutsPinnedFirstThenMostRecent(t *testing.T) {
	s := newChatStore(t)
	for _, id := range []string{"a", "b", "c", "d"} {
		if err := s.CreateOpenAgentChat(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	// Una cerrada con mensajes no figura.
	if err := s.CreateAgentChat("hist", "", "llm:x", "viejo", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	for id, ts := range map[string]int64{"a": 100, "b": 400, "c": 300, "d": 200} {
		if _, err := s.db.Exec(`UPDATE agent_chats SET updated_at = ? WHERE id = ?`, ts, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetAgentChatPinned("a", true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatPinned("d", true); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListOpenAgentChats()
	if err != nil {
		t.Fatal(err)
	}
	ids := ""
	for _, c := range got {
		ids += c.ID
	}
	// Fijadas (d reciente, a vieja) y después b y c por fecha.
	if ids != "dabc" {
		t.Fatalf("orden = %q, quería dabc", ids)
	}
	if err := s.SetAgentChatPinned("a", false); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatPinned("nope", true); !errors.Is(err, ErrAgentChatNotFound) {
		t.Errorf("fijar una inexistente = %v", err)
	}
}

// Abrir una conversación del historial la suma a la lista y le da un estado
// (si no, un chat con mensajes se vería como borrador). No cuenta como
// actividad. Abrir una inexistente es un error.
func TestOpeningAnOldChatAddsItToTheList(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("viejo", "", "llm:x", "algo", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendAgentChatMessage("viejo", ChatRoleUser, "hola", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE agent_chats SET updated_at = 123 WHERE id = 'viejo'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetAgentChatOpen("viejo", true); err != nil {
		t.Fatal(err)
	}
	open, _ := s.ListOpenAgentChats()
	if len(open) != 1 || !open[0].Open || open[0].LastStatus != ChatStatusIdle || open[0].UpdatedAt != 123 {
		t.Fatalf("open = %+v", open)
	}
	if _, err := s.SetAgentChatOpen("fantasma", true); !errors.Is(err, ErrAgentChatNotFound) {
		t.Errorf("abrir una inexistente = %v", err)
	}
}

// Cerrar saca la conversación de la lista y la desfija, pero conserva sus
// mensajes. Un borrador sin uso ni nombre se descarta al cerrarlo; uno con
// nombre no.
func TestClosingKeepsHistoryAndDiscardsEmptyDrafts(t *testing.T) {
	s := newChatStore(t)
	for _, id := range []string{"usado", "vacio", "nombrado"} {
		if err := s.CreateOpenAgentChat(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AppendAgentChatMessage("usado", ChatRoleUser, "hola", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatLastStatus("usado", ChatStatusIdle); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatPinned("usado", true); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameAgentChat("nombrado", "Mi borrador"); err != nil {
		t.Fatal(err)
	}

	for id, wantDeleted := range map[string]bool{"usado": false, "vacio": true, "nombrado": false} {
		deleted, err := s.SetAgentChatOpen(id, false)
		if err != nil || deleted != wantDeleted {
			t.Fatalf("cerrar %s: deleted=%v err=%v", id, deleted, err)
		}
	}
	// Cerrar de nuevo, o una inexistente, no es error.
	if _, err := s.SetAgentChatOpen("usado", false); err != nil {
		t.Errorf("cerrar es idempotente: %v", err)
	}
	if _, err := s.SetAgentChatOpen("fantasma", false); err != nil {
		t.Errorf("cerrar una inexistente: %v", err)
	}

	if open, _ := s.ListOpenAgentChats(); len(open) != 0 {
		t.Errorf("no debe quedar nada abierto: %+v", open)
	}
	all, _ := s.ListAllAgentChats()
	got := map[string]AgentChat{}
	for _, c := range all {
		got[c.ID] = c
	}
	if _, ok := got["vacio"]; ok {
		t.Error("el borrador vacío debía descartarse")
	}
	if u := got["usado"]; u.Open || u.Pinned {
		t.Errorf("usado = %+v", u)
	}
	if msgs, _ := s.ListAgentChatMessages("usado"); len(msgs) != 1 {
		t.Errorf("cerrar no borra los mensajes: %+v", msgs)
	}
	if _, ok := got["nombrado"]; !ok {
		t.Error("un borrador con nombre se conserva")
	}
}

func TestDeleteRemovesEverythingOfAnOpenChat(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateOpenAgentChat("x", "llm:x", "", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendAgentChatMessage("x", ChatRoleUser, "hola", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatPinned("x", true); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAgentChat("x"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.AgentChatExists("x"); ok {
		t.Error("la fila debía borrarse")
	}
	if msgs, _ := s.ListAgentChatMessages("x"); len(msgs) != 0 {
		t.Errorf("mensajes huérfanos: %+v", msgs)
	}
	if open, _ := s.ListOpenAgentChats(); len(open) != 0 {
		t.Errorf("open = %+v", open)
	}
}

func TestLastStatusAndInterruptedMarking(t *testing.T) {
	s := newChatStore(t)
	for _, id := range []string{"a", "b"} {
		if err := s.CreateOpenAgentChat(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(`UPDATE agent_chats SET updated_at = 50`); err != nil {
		t.Fatal(err)
	}
	// Un cambio de estado cuenta como actividad...
	if err := s.SetAgentChatLastStatus("a", ChatStatusIdle); err != nil {
		t.Fatal(err)
	}
	// ...marcar la interrupción por el cierre de la app, no.
	if err := s.MarkAgentChatsInterrupted([]string{"b", "fantasma"}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkAgentChatsInterrupted(nil); err != nil {
		t.Fatal(err)
	}
	// Un id sin fila no es un error.
	if err := s.SetAgentChatLastStatus("fantasma", ChatStatusError); err != nil {
		t.Fatal(err)
	}
	all, _ := s.ListAllAgentChats()
	got := map[string]AgentChat{}
	for _, c := range all {
		got[c.ID] = c
	}
	if got["a"].LastStatus != ChatStatusIdle || got["a"].UpdatedAt <= 50 || time.Now().Unix()-got["a"].UpdatedAt > 5 {
		t.Errorf("a = %+v", got["a"])
	}
	if got["b"].LastStatus != ChatStatusInterrupted || got["b"].UpdatedAt != 50 || !got["b"].Open {
		t.Errorf("b = %+v", got["b"])
	}
}

func TestDraftProviderCanChangeToAnyProviderOnlyWhileEmpty(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateOpenAgentChat("d", "claude", "opus", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatDraftAgent("d", "llm:x"); err != nil {
		t.Fatal(err)
	}
	all, _ := s.ListAllAgentChats()
	if all[0].AgentID != "llm:x" || all[0].Model != "" {
		t.Errorf("después del cambio: %+v", all[0])
	}
	if err := s.AppendAgentChatMessage("d", ChatRoleUser, "hola", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentChatDraftAgent("d", "claude"); err == nil {
		t.Error("con mensajes ya no es un borrador: no debe cambiar de proveedor")
	}
}
