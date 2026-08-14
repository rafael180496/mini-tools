package agentusage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// El slug es lo que permite atribuir consumo AL repositorio abierto. Los casos
// están tomados de directorios reales de ~/.claude/projects.
func TestClaudeSlug(t *testing.T) {
	got := claudeSlug("/Users/developer/Documents/project/github_project/golang/support-lab")
	want := "-Users-developer-Documents-project-github-project-golang-support-lab"
	if got != want {
		t.Errorf("slug incorrecto:\n got %q\nwant %q", got, want)
	}
	if claudeSlug("") != "" {
		t.Error("una ruta vacía no tiene slug")
	}
}

func TestReadClaudeAggregates(t *testing.T) {
	home := t.TempDir()
	repo := "/proyectos/mi-repo"
	slug := claudeSlug(repo)
	now := time.Now().UTC()

	line := func(id, model string, ts time.Time, in, out, cw, cr int64) string {
		return fmt.Sprintf(
			`{"type":"assistant","timestamp":%q,"message":{"id":%q,"model":%q,"usage":{"input_tokens":%d,"output_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d}}}`,
			ts.Format(time.RFC3339), id, model, in, out, cw, cr) + "\n"
	}

	// Sesión del repositorio abierto. La tercera línea REPITE el id de la
	// primera: el transcript real duplica mensajes y sumarlos dos veces
	// inflaría el total sin que se note.
	repoDir := filepath.Join(home, ".claude", "projects", slug)
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := line("msg1", "claude-opus-5", now, 100, 50, 200, 700) +
		`{"type":"user","message":{"content":"hola"}}` + "\n" +
		line("msg2", "claude-sonnet-5", now, 10, 5, 0, 85) +
		line("msg1", "claude-opus-5", now, 100, 50, 200, 700) +
		"esto no es json\n"
	if err := os.WriteFile(filepath.Join(repoDir, "s1.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	// Otro proyecto: suma al total pero NO al del repositorio.
	otherDir := filepath.Join(home, ".claude", "projects", "-otro-proyecto")
	if err := os.MkdirAll(otherDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(otherDir, "s2.jsonl"), []byte(line("msg3", "claude-opus-5", now, 1000, 0, 0, 0)), 0o644); err != nil {
		t.Fatal(err)
	}

	u := readClaude(home, slug, now.AddDate(0, 0, -30))

	if !u.Available {
		t.Fatalf("debería haber datos: %+v", u)
	}
	// msg1 (1050) + msg2 (100) + msg3 (1000) = 2150, con msg1 contado UNA vez.
	if u.All.Total != 2150 || u.All.Messages != 3 {
		t.Errorf("total mal agregado (¿se contó el duplicado?): %+v", u.All)
	}
	if u.Repo.Total != 1150 || u.Repo.Messages != 2 {
		t.Errorf("el total del repositorio no debería incluir otros proyectos: %+v", u.Repo)
	}

	// Porcentajes por modelo sobre el total del agente.
	if len(u.ByModel) != 2 || u.ByModel[0].Key != "claude-opus-5" || u.ByModel[0].Total != 2050 {
		t.Errorf("desglose por modelo incorrecto: %+v", u.ByModel)
	}
	if p := u.ByModel[0].Percent; p < 95.3 || p > 95.4 {
		t.Errorf("porcentaje por modelo incorrecto: %v", p)
	}

	// Caché sobre los tokens de ENTRADA (input + cacheRead + cacheWrite),
	// no sobre el total: la salida no se cachea.
	// (700+85) / (1110+200+785) = 785/2095 = 37.5%
	if u.CacheHitPercent < 37.4 || u.CacheHitPercent > 37.5 {
		t.Errorf("porcentaje de caché incorrecto: %v", u.CacheHitPercent)
	}

	if u.FirstDay == "" || u.LastDay == "" {
		t.Error("sin rango de fechas un total no significa nada")
	}
}

// Una sesión más vieja que la ventana no entra: sin esto, "los últimos 30
// días" incluiría todo el historial.
func TestReadClaudeRespectsWindow(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-viejo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := time.Now().UTC().AddDate(0, 0, -90)
	content := fmt.Sprintf(
		`{"type":"assistant","timestamp":%q,"message":{"id":"x","model":"m","usage":{"input_tokens":999,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}`+"\n",
		old.Format(time.RFC3339))

	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	// El mtime también se mueve al pasado: es el filtro barato que evita abrir
	// el archivo, y hay que probar que descarta de verdad.
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	u := readClaude(home, "", time.Now().AddDate(0, 0, -30))

	if u.Available || u.All.Total != 0 {
		t.Errorf("una sesión de hace 90 días no entra en una ventana de 30: %+v", u.All)
	}
	if u.Note == "" {
		t.Error("sin datos hay que explicar por qué, no devolver un cero pelado")
	}
}

// Cada agente informa lo que de verdad tiene, y dice de dónde salió.
//
// El reporte siempre trae los tres, estén instalados o no: un agente ausente
// del listado y uno sin consumo se verían igual, y solo el segundo es
// información.
func TestEveryAgentReportsItsSource(t *testing.T) {
	u := Scan("", 30)

	byAgent := map[string]AgentUsage{}
	for _, a := range u.Agents {
		byAgent[a.Agent] = a
	}
	for _, id := range []string{"claude", "codex", "antigravity"} {
		a, ok := byAgent[id]
		if !ok {
			t.Fatalf("falta %s en el reporte", id)
		}
		if a.Source == "" {
			t.Errorf("%s debe decir dónde buscó: %+v", id, a)
		}
		// Sin datos hay que explicar por qué; con datos, la nota es opcional.
		if !a.Available && a.Note == "" {
			t.Errorf("%s no tiene datos y no dice por qué: %+v", id, a)
		}
	}

	// Antigravity NO guarda tokens en el disco (su cuota la contesta el
	// servidor), así que nunca puede reportarlos por más que esté instalado.
	if ag := byAgent["antigravity"]; ag.All.Total != 0 {
		t.Errorf("Antigravity no guarda tokens y no puede reportarlos: %+v", ag)
	}
}

// La actividad de Antigravity sale de su base de resúmenes, que se abre en
// solo lectura porque es la base viva de otro programa.
func TestAntigravityReportsActivityNotTokens(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	repo := "/proyectos/mi-repo"
	db, err := sql.Open("sqlite", filepath.Join(dir, "conversation_summaries.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE conversation_summaries (
		conversation_id text, step_count integer, workspace_uris text, last_modified_time datetime)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversation_summaries VALUES
		('a', 12, 'file://`+repo+`', '2026-08-14T10:00:00Z'),
		('b', 3, 'file:///otro/lado', '2026-08-10T10:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	u := readAntigravity(home, repo)

	if u.Available || u.All.Total != 0 {
		t.Errorf("Antigravity no guarda tokens: no puede reportarlos: %+v", u)
	}
	if u.Note == "" || !strings.Contains(u.Note, "/usage") {
		t.Errorf("la nota debe decir dónde se ve la cuota de verdad: %q", u.Note)
	}
	if u.Activity == nil {
		t.Fatal("debería haber actividad leída de la base")
	}
	if u.Activity.Conversations != 2 || u.Activity.Steps != 15 {
		t.Errorf("actividad total incorrecta: %+v", u.Activity)
	}
	if u.Activity.RepoConversations != 1 || u.Activity.RepoSteps != 12 {
		t.Errorf("la actividad de este repositorio no debería incluir otros workspaces: %+v", u.Activity)
	}
	if u.Activity.LastUsed != "2026-08-14" && u.Activity.LastUsed != "2026-08-13" {
		t.Errorf("último uso incorrecto (se admite el corrimiento de zona horaria): %q", u.Activity.LastUsed)
	}
}

// Sin Antigravity instalado no hay actividad ni nota engañosa.
func TestAntigravityAbsent(t *testing.T) {
	u := readAntigravity(t.TempDir(), "")
	if u.Activity != nil || u.Available {
		t.Errorf("sin instalar no debería reportar nada: %+v", u)
	}
	if u.Note == "" {
		t.Error("hay que decir que no se encontró")
	}
}
