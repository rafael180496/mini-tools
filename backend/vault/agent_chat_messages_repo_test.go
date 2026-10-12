package vault

import (
	"bytes"
	"testing"
)

func newChatStore(t *testing.T) *Store {
	t.Helper()
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return store
}

func TestAgentChatMessagesOrderAndEncryptionAtRest(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("c1", "", "llm:x", "Mi chat", "note", "n1"); err != nil {
		t.Fatal(err)
	}
	secret := "mi contraseña es hunter2"
	if err := s.AppendAgentChatMessages("c1", []NewChatMessage{
		{Role: ChatRoleUser, Content: secret},
		{Role: ChatRoleTool, Content: "src/a.go\n+3 líneas", ToolName: "Edit"},
		{Role: ChatRoleAssistant, Content: "Listo", Usage: `{"input":1}`},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendAgentChatMessage("c1", ChatRoleUser, "otra", "", ""); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListAgentChatMessages("c1")
	if err != nil || len(got) != 4 {
		t.Fatalf("List = %+v, %v", got, err)
	}
	for i, m := range got {
		if m.Seq != i+1 {
			t.Fatalf("seq[%d] = %d", i, m.Seq)
		}
	}
	if got[0].Content != secret || got[1].ToolName != "Edit" || got[1].Content != "src/a.go\n+3 líneas" ||
		got[2].Usage != `{"input":1}` || got[3].Content != "otra" || got[0].CreatedAt == 0 {
		t.Fatalf("contenido inesperado: %+v", got)
	}

	// En el archivo no hay texto plano: ni en content, ni en ninguna columna.
	rows, err := s.db.Query(`SELECT content, nonce FROM agent_chat_messages`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var enc, nonce []byte
		if err := rows.Scan(&enc, &nonce); err != nil {
			t.Fatal(err)
		}
		if len(nonce) == 0 || bytes.Contains(enc, []byte("hunter2")) || bytes.Contains(enc, []byte("Listo")) {
			t.Fatalf("contenido sin cifrar: %q nonce=%d", enc, len(nonce))
		}
	}

	recent, err := s.RecentAgentChatMessages("c1", 2)
	if err != nil || len(recent) != 2 || recent[0].Seq != 3 || recent[1].Seq != 4 {
		t.Fatalf("Recent = %+v, %v", recent, err)
	}
	if none, _ := s.RecentAgentChatMessages("c1", 0); len(none) != 0 {
		t.Fatalf("Recent(0) = %+v", none)
	}
	if empty, err := s.ListAgentChatMessages("nope"); err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("chat sin mensajes: %+v, %v (no debe ser nil)", empty, err)
	}

	// Un rol inventado se rechaza antes de escribir nada.
	if err := s.AppendAgentChatMessage("c1", "system", "x", "", ""); err == nil {
		t.Fatal("rol desconocido debería fallar")
	}
	if all, _ := s.ListAgentChatMessages("c1"); len(all) != 4 {
		t.Fatalf("quedó basura: %d", len(all))
	}
}

func TestAgentChatMessagesTouchChatActivity(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("c1", "", "claude", "t", "git", "r"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE agent_chats SET updated_at = 1 WHERE id = 'c1'`); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendAgentChatMessage("c1", ChatRoleUser, "hola", "", ""); err != nil {
		t.Fatal(err)
	}
	chats, _ := s.ListAllAgentChats()
	if len(chats) != 1 || chats[0].UpdatedAt <= 1 {
		t.Fatalf("updated_at no se movió: %+v", chats)
	}
}

func TestDeleteAgentChatRemovesItsMessages(t *testing.T) {
	s := newChatStore(t)
	for _, id := range []string{"c1", "c2"} {
		if err := s.CreateAgentChat(id, "", "claude", id, "db", ""); err != nil {
			t.Fatal(err)
		}
		if err := s.AppendAgentChatMessage(id, ChatRoleUser, "hola "+id, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	// Sin PRAGMA foreign_keys el CASCADE no corre: el borrado es explícito.
	if err := s.DeleteAgentChat("c1"); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.ListAgentChatMessages("c1"); len(m) != 0 {
		t.Fatalf("los mensajes de c1 sobrevivieron: %+v", m)
	}
	if m, _ := s.ListAgentChatMessages("c2"); len(m) != 1 {
		t.Fatalf("c2 perdió mensajes: %+v", m)
	}

	if err := s.DeleteAgentChatMessages("c2"); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.ListAgentChatMessages("c2"); len(m) != 0 {
		t.Fatal("DeleteAgentChatMessages no borró")
	}
	if ok, _ := s.AgentChatExists("c2"); !ok {
		t.Fatal("DeleteAgentChatMessages no debe borrar el chat")
	}
}

func TestCreateAgentChatIsIdempotent(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("c1", "", "claude", "Primero", "db", "x"); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateAgentChat("c1", "", "claude", "Segundo", "db", "x"); err != nil {
		t.Fatalf("la segunda alta no debe fallar: %v", err)
	}
	chats, _ := s.ListAllAgentChats()
	if len(chats) != 1 || chats[0].Title != "Primero" {
		t.Fatalf("chats = %+v", chats)
	}
}

func TestAgentChatIDByConversation(t *testing.T) {
	s := newChatStore(t)
	_ = s.CreateAgentChat("c1", "", "claude", "t", "db", "")
	_ = s.TouchAgentChat("c1", "conv-9")
	if id, err := s.AgentChatIDByConversation("claude", "conv-9"); err != nil || id != "c1" {
		t.Fatalf("id=%q err=%v", id, err)
	}
	if id, _ := s.AgentChatIDByConversation("codex", "conv-9"); id != "" {
		t.Fatalf("otro agente no debe coincidir: %q", id)
	}
	if id, _ := s.AgentChatIDByConversation("claude", ""); id != "" {
		t.Fatalf("conversación vacía: %q", id)
	}
}

func TestSearchAgentChats(t *testing.T) {
	s := newChatStore(t)
	mk := func(id, title string, msgs ...string) {
		t.Helper()
		if err := s.CreateAgentChat(id, "", "llm:x", title, "note", ""); err != nil {
			t.Fatal(err)
		}
		for _, m := range msgs {
			if err := s.AppendAgentChatMessage(id, ChatRoleAssistant, m, "", ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	mk("viejo", "Migración", "El diagnóstico del tablespace USERS")
	mk("medio", "Redis", "configurar el maxmemory", "y la política de evicción")
	mk("nuevo", "Diagnóstico de red", "nada que ver")
	mk("vacio", "Sin mensajes")
	for id, ts := range map[string]int64{"viejo": 100, "medio": 200, "nuevo": 300, "vacio": 50} {
		if _, err := s.db.Exec(`UPDATE agent_chats SET updated_at = ? WHERE id = ?`, ts, id); err != nil {
			t.Fatal(err)
		}
	}
	ids := func(q string, limit int) []string {
		t.Helper()
		got, err := s.SearchAgentChats(q, limit)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, c := range got {
			out = append(out, c.ID)
		}
		return out
	}
	eq := func(got []string, want ...string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	}

	// Sin acentos ni mayúsculas, en título y en contenido, más reciente primero.
	eq(ids("DIAGNOSTICO", 0), "nuevo", "viejo")
	// Todas las palabras, aunque estén en mensajes distintos o en el título.
	eq(ids("politica maxmemory", 0), "medio")
	eq(ids("redis evicción", 0), "medio")
	eq(ids("diagnostico redis", 0))
	// Frase literal.
	eq(ids(`"tablespace users"`, 0), "viejo")
	eq(ids(`"users tablespace"`, 0))
	// Tope.
	eq(ids("diagnostico", 1), "nuevo")
	// Vacía: nada.
	eq(ids("   ", 0))
	eq(ids("", 0))
	// El título solo también acierta.
	eq(ids("mensajes", 0), "vacio")

	// Un chat borrado deja de aparecer.
	_ = s.DeleteAgentChat("viejo")
	eq(ids("tablespace", 0))
}

func TestRemoveGitRepoRemovesChatMessages(t *testing.T) {
	s := newChatStore(t)
	repo, err := s.AddGitRepo("r", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_ = s.CreateAgentChat("c1", repo.ID, "claude", "t", "git", repo.ID)
	_ = s.CreateAgentChat("c2", "", "claude", "t", "db", "")
	_ = s.AppendAgentChatMessage("c1", ChatRoleUser, "hola", "", "")
	_ = s.AppendAgentChatMessage("c2", ChatRoleUser, "hola", "", "")
	if err := s.RemoveGitRepo(repo.ID); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.ListAgentChatMessages("c1"); len(m) != 0 {
		t.Fatalf("los mensajes del chat del repositorio sobrevivieron: %+v", m)
	}
	if m, _ := s.ListAgentChatMessages("c2"); len(m) != 1 {
		t.Fatalf("c2 no debía tocarse: %+v", m)
	}
}
