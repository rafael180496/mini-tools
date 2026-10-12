package vault

import (
	"bytes"
	"strings"
	"testing"
)

func TestModelServerLifecycle(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	saved, err := store.SaveModelServer(ModelServer{Name: " Ollama local ", Kind: ModelServerOllama, BaseURL: "http://localhost:11434/"}, "", false, nil, false)
	if err != nil {
		t.Fatalf("SaveModelServer: %v", err)
	}
	if saved.ID == "" || saved.Name != "Ollama local" || saved.BaseURL != "http://localhost:11434" || saved.HasToken {
		t.Fatalf("unexpected: %+v", saved)
	}

	// Agregar un token, conservarlo al editar sin token y borrarlo.
	upd := saved
	upd.BaseURL = "https://gpu.empresa/v1"
	upd.Kind = ModelServerOpenAI
	upd, err = store.SaveModelServer(upd, "sk-secreto", false, nil, false)
	if err != nil || !upd.HasToken || upd.Kind != ModelServerOpenAI {
		t.Fatalf("update con token: %+v, %v", upd, err)
	}
	tok, err := store.ModelServerToken(upd.ID)
	if err != nil || tok != "sk-secreto" {
		t.Fatalf("token = %q, %v", tok, err)
	}
	upd, err = store.SaveModelServer(upd, "", false, nil, false)
	if err != nil || !upd.HasToken {
		t.Fatalf("token vacío debe conservar: %+v, %v", upd, err)
	}
	upd, err = store.SaveModelServer(upd, "", true, nil, false)
	if err != nil || upd.HasToken {
		t.Fatalf("clearToken debe borrar: %+v, %v", upd, err)
	}
	if tok, _ := store.ModelServerToken(upd.ID); tok != "" {
		t.Fatalf("token tras borrar = %q", tok)
	}

	list, err := store.ListModelServers()
	if err != nil || len(list) != 1 || list[0].ID != saved.ID {
		t.Fatalf("List = %+v, %v", list, err)
	}

	if err := store.DeleteModelServer(saved.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if list, _ := store.ListModelServers(); len(list) != 0 {
		t.Fatalf("quedó %+v", list)
	}
	if _, err := store.GetModelServer(saved.ID); err == nil {
		t.Fatal("Get de un servidor borrado debería fallar")
	}
}

func TestModelServerValidation(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	cases := []ModelServer{
		{Name: "", Kind: ModelServerOllama, BaseURL: "http://x"},
		{Name: "a", Kind: "otro", BaseURL: "http://x"},
		{Name: "a", Kind: ModelServerOllama, BaseURL: "localhost:11434"},
		{Name: "a", Kind: ModelServerOllama, BaseURL: "ftp://x"},
	}
	for _, c := range cases {
		if _, err := store.SaveModelServer(c, "", false, nil, false); err == nil {
			t.Errorf("%+v debería rechazarse", c)
		}
	}

	if _, err := store.SaveModelServer(ModelServer{Name: "dup", Kind: ModelServerOllama, BaseURL: "http://x"}, "", false, nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveModelServer(ModelServer{Name: "dup", Kind: ModelServerOllama, BaseURL: "http://y"}, "", false, nil, false); err == nil || !strings.Contains(err.Error(), "dup") {
		t.Fatalf("nombre repetido: %v", err)
	}
	if _, err := store.SaveModelServer(ModelServer{ID: "no-existe", Name: "z", Kind: ModelServerOllama, BaseURL: "http://x"}, "", false, nil, false); err == nil {
		t.Fatal("actualizar un id inexistente debería fallar")
	}
}

func TestModelServerTokenIsStoredEncrypted(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	saved, err := store.SaveModelServer(ModelServer{Name: "a", Kind: ModelServerOpenAI, BaseURL: "http://x/v1"}, "sk-token-en-claro", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	var enc []byte
	if err := store.db.QueryRow(`SELECT encrypted_token FROM model_servers WHERE id = ?`, saved.ID).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	if len(enc) == 0 || bytes.Contains(enc, []byte("sk-token-en-claro")) {
		t.Fatalf("el token no está cifrado: %q", enc)
	}
}

func TestModelServerHeadersAndInsecureTLS(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	in := ModelServer{Name: "gpu", Kind: ModelServerOllama, BaseURL: "https://gpu.interna", InsecureTLS: true}
	saved, err := store.SaveModelServer(in, "", false, map[string]string{"X-Api-Key": "valor-secreto", "CF-Access-Client-Id": "id1"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.InsecureTLS {
		t.Error("InsecureTLS no se guardó")
	}
	if got := strings.Join(saved.HeaderNames, ","); got != "CF-Access-Client-Id,X-Api-Key" {
		t.Errorf("HeaderNames = %q", got)
	}
	// Los valores no están en claro en la base.
	var enc []byte
	if err := store.db.QueryRow(`SELECT encrypted_headers FROM model_servers WHERE id = ?`, saved.ID).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	if len(enc) == 0 || bytes.Contains(enc, []byte("valor-secreto")) || bytes.Contains(enc, []byte("X-Api-Key")) {
		t.Fatalf("las cabeceras no están cifradas: %q", enc)
	}
	h, err := store.ModelServerHeaders(saved.ID)
	if err != nil || h["X-Api-Key"] != "valor-secreto" || len(h) != 2 {
		t.Fatalf("ModelServerHeaders = %v, %v", h, err)
	}

	// replaceHeaders=false conserva (y InsecureTLS se apaga porque así viene).
	upd := saved
	upd.Name = "gpu2"
	upd.InsecureTLS = false
	kept, err := store.SaveModelServer(upd, "", false, map[string]string{"Otra": "x"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if kept.InsecureTLS || len(kept.HeaderNames) != 2 {
		t.Errorf("conservar: %+v", kept)
	}
	// replaceHeaders=true con mapa vacío las borra.
	cleared, err := store.SaveModelServer(kept, "", false, map[string]string{}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(cleared.HeaderNames) != 0 {
		t.Errorf("borrar: %+v", cleared)
	}
	if h, _ := store.ModelServerHeaders(saved.ID); len(h) != 0 {
		t.Errorf("quedaron cabeceras: %v", h)
	}
}

func TestModelServerHeaderValidation(t *testing.T) {
	bad := []map[string]string{
		{"Host": "x"},
		{"content-length": "1"},
		{"Mala Cabecera": "x"},
		{"X:Y": "x"},
		{"": "x"},
		{"X-A": "uno\r\nX-B: dos"},
		{"X-A": ""},
		{"X-A": "1", "x-a": "2"},
	}
	for _, h := range bad {
		if _, err := ValidateModelServerHeaders(h, false); err == nil {
			t.Errorf("%v debería rechazarse", h)
		}
	}
	if _, err := ValidateModelServerHeaders(map[string]string{"X-Api-Key": "k", "Authorization": "Basic abc"}, false); err != nil {
		t.Errorf("Authorization sin token debería admitirse: %v", err)
	}
	if _, err := ValidateModelServerHeaders(map[string]string{"authorization": "Basic abc"}, true); err == nil {
		t.Error("Authorization con token debería rechazarse")
	}

	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatal(err)
	}
	s := ModelServer{Name: "a", Kind: ModelServerOpenAI, BaseURL: "http://x/v1"}
	// Con token nuevo + Authorization en las cabeceras: choque.
	if _, err := store.SaveModelServer(s, "tok", false, map[string]string{"Authorization": "Basic abc"}, true); err == nil {
		t.Error("token + Authorization debería rechazarse al guardar")
	}
	// Guardado con Authorization sin token; poner un token después choca.
	saved, err := store.SaveModelServer(s, "", false, map[string]string{"Authorization": "Basic abc"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveModelServer(saved, "tok", false, nil, false); err == nil {
		t.Error("poner un token con Authorization guardado debería rechazarse")
	}
	// Quitando la cabecera y poniendo el token a la vez, sí.
	if _, err := store.SaveModelServer(saved, "tok", false, map[string]string{}, true); err != nil {
		t.Errorf("reemplazar las cabeceras y poner token: %v", err)
	}
}

// Migración 60 sobre un vault que ya tenía servidores guardados: las columnas
// nuevas nacen con su default (sin cabeceras, verificando el certificado) y la
// fila existente sigue intacta y con su token.
func TestMigration60AddsHeadersAndInsecureTLS(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatal(err)
	}
	saved, err := store.SaveModelServer(ModelServer{Name: "viejo", Kind: ModelServerOllama, BaseURL: "http://x"}, "tok", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`ALTER TABLE model_servers DROP COLUMN encrypted_headers`,
		`ALTER TABLE model_servers DROP COLUMN headers_nonce`,
		`ALTER TABLE model_servers DROP COLUMN insecure_tls`,
		// >= y no =: applyMigrations retoma desde la versión máxima aplicada, y las
		// migraciones posteriores (61) la dejarían saltear la 60.
		// La 62 se vuelve a aplicar con las demás: su columna tiene que faltar.
		`ALTER TABLE model_servers DROP COLUMN context_tokens`,
		`DELETE FROM schema_migrations WHERE version >= 60`,
	} {
		if _, err := store.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := applyMigrations(store.db); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	got, err := store.GetModelServer(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.InsecureTLS || len(got.HeaderNames) != 0 || !got.HasToken || got.Name != "viejo" {
		t.Errorf("después de migrar: %+v", got)
	}
	if err := applyMigrations(store.db); err != nil {
		t.Errorf("segunda pasada: %v", err)
	}
}

// context_tokens se guarda solo para Ollama, se acota y se conserva al editar.
func TestModelServerContextTokens(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatal(err)
	}
	oll, err := store.SaveModelServer(ModelServer{Name: "o", Kind: ModelServerOllama, BaseURL: "http://x", ContextTokens: 16384}, "", false, nil, false)
	if err != nil || oll.ContextTokens != 16384 {
		t.Fatalf("alta Ollama: %+v, %v", oll, err)
	}
	got, _ := store.GetModelServer(oll.ID)
	if got.ContextTokens != 16384 {
		t.Errorf("no persistió: %+v", got)
	}
	oll.ContextTokens = 32768
	if upd, err := store.SaveModelServer(oll, "", false, nil, false); err != nil || upd.ContextTokens != 32768 {
		t.Errorf("edición: %+v, %v", upd, err)
	}
	oll.ContextTokens = -5
	if upd, _ := store.SaveModelServer(oll, "", false, nil, false); upd.ContextTokens != 0 {
		t.Errorf("negativo debe quedar en 0: %d", upd.ContextTokens)
	}
	oll.ContextTokens = MaxContextTokens * 10
	if upd, _ := store.SaveModelServer(oll, "", false, nil, false); upd.ContextTokens != MaxContextTokens {
		t.Errorf("tope: %d", upd.ContextTokens)
	}

	// Un servidor OpenAI no la guarda, venga lo que venga.
	oa, err := store.SaveModelServer(ModelServer{Name: "oa", Kind: ModelServerOpenAI, BaseURL: "http://y/v1", ContextTokens: 8192}, "", false, nil, false)
	if err != nil || oa.ContextTokens != 0 {
		t.Errorf("OpenAI: %+v, %v", oa, err)
	}
}

// Migración 62 sobre un vault con servidores guardados: la columna nace en 0
// (no mandar num_ctx, como hasta ahora) y la fila queda intacta.
func TestMigration62AddsContextTokens(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatal(err)
	}
	saved, err := store.SaveModelServer(ModelServer{Name: "viejo", Kind: ModelServerOllama, BaseURL: "http://x"}, "tok", false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`ALTER TABLE model_servers DROP COLUMN context_tokens`,
		`DELETE FROM schema_migrations WHERE version >= 62`,
	} {
		if _, err := store.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := applyMigrations(store.db); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	got, err := store.GetModelServer(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ContextTokens != 0 || !got.HasToken || got.Name != "viejo" {
		t.Errorf("después de migrar: %+v", got)
	}
	if err := applyMigrations(store.db); err != nil {
		t.Errorf("segunda pasada: %v", err)
	}
	var max int
	if err := store.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&max); err != nil || max != 62 {
		t.Errorf("versión = %d, %v", max, err)
	}
}
