package vault

import "testing"

func TestAgentWorkspaceLifecycle(t *testing.T) {
	s := newChatStore(t)

	w, err := s.AddAgentWorkspace("docs", "/tmp/docs")
	if err != nil || w.ID == "" || w.Name != "docs" || w.Path != "/tmp/docs" || w.CreatedAt == 0 {
		t.Fatalf("Add = %+v, %v", w, err)
	}
	if _, err := s.AddAgentWorkspace("otra vez", "/tmp/docs"); err == nil {
		t.Error("path UNIQUE: la misma carpeta no se agrega dos veces")
	}
	if _, err := s.AddAgentWorkspace("api", "/tmp/api"); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListAgentWorkspaces()
	if err != nil || len(list) != 2 {
		t.Fatalf("List = %+v, %v", list, err)
	}
	got, err := s.GetAgentWorkspace(w.ID)
	if err != nil || got.Path != "/tmp/docs" {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	if _, err := s.GetAgentWorkspace("nada"); err == nil {
		t.Error("id desconocido")
	}

	// Quitar borra los chats y mensajes de esa carpeta, y solo de esa.
	if err := s.CreateAgentChat("c-ws", "", "llm:1", "t", "utilities", AgentWorkspaceContextPrefix+w.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateAgentChat("c-otro", "", "llm:1", "t", "utilities", AgentWorkspaceContextPrefix+"otro"); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveAgentWorkspace(w.ID); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.AgentChatExists("c-ws"); ok {
		t.Error("el chat de la carpeta quitada debía borrarse")
	}
	if ok, _ := s.AgentChatExists("c-otro"); !ok {
		t.Error("el chat de otra carpeta no se toca")
	}
	if err := s.RemoveAgentWorkspace(w.ID); err == nil {
		t.Error("quitar dos veces es un error")
	}
	if list, _ = s.ListAgentWorkspaces(); len(list) != 1 {
		t.Errorf("quedó %+v", list)
	}
}

// Migración 61 sobre un vault que ya estaba en uso: crea la tabla sin tocar lo
// existente, y es idempotente.
func TestMigration61CreatesAgentWorkspaces(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("viejo", "", "claude", "chat anterior", "git", "r1"); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE agent_workspaces`,
		// La 62 se vuelve a aplicar con las demás: su columna tiene que faltar.
		`ALTER TABLE model_servers DROP COLUMN context_tokens`,
		// Y la 63 también: sus tres columnas tienen que faltar para reaplicarla.
		`ALTER TABLE model_servers DROP COLUMN enabled`,
		`ALTER TABLE model_servers DROP COLUMN default_model`,
		`ALTER TABLE model_servers DROP COLUMN sort_order`,
		// Y la 64: sus dos columnas de agent_chat_messages tienen que faltar para reaplicarla.
		`ALTER TABLE agent_chat_messages DROP COLUMN meta`,
		`ALTER TABLE agent_chat_messages DROP COLUMN meta_nonce`,
		// Y la 65: sus cuatro columnas de agent_chats tienen que faltar para reaplicarla.
		`ALTER TABLE agent_chats DROP COLUMN open`,
		`ALTER TABLE agent_chats DROP COLUMN pinned`,
		`ALTER TABLE agent_chats DROP COLUMN last_status`,
		`ALTER TABLE agent_chats DROP COLUMN opened_at`,
		`DELETE FROM schema_migrations WHERE version >= 61`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := applyMigrations(s.db); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	if _, err := s.AddAgentWorkspace("x", "/tmp/x"); err != nil {
		t.Errorf("la tabla debía existir: %v", err)
	}
	if ok, _ := s.AgentChatExists("viejo"); !ok {
		t.Error("la migración no debe tocar los chats existentes")
	}
	if err := applyMigrations(s.db); err != nil {
		t.Errorf("segunda pasada: %v", err)
	}
	var max int
	if err := s.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&max); err != nil || max != 65 {
		t.Errorf("versión = %d, %v", max, err)
	}
}
