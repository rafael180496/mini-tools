package vault

import (
	"errors"
	"sort"
	"strings"
	"testing"
)

func TestParseFolderPath(t *testing.T) {
	good := map[string][]string{
		"Cerebro":                      {"Cerebro"},
		"Cerebro/Proyectos/mini-tools": {"Cerebro", "Proyectos", "mini-tools"},
		"/Cerebro/Temas/":              {"Cerebro", "Temas"},
		"  Cerebro / Temas  ":          {"Cerebro", "Temas"},
		`Cerebro\Temas`:                {"Cerebro", "Temas"},
		"Oracle - bloqueos/ñandú":      {"Oracle - bloqueos", "ñandú"},
	}
	for in, want := range good {
		got, err := ParseFolderPath(in)
		if err != nil || strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("ParseFolderPath(%q) = %v, %v; quería %v", in, got, err, want)
		}
	}
	bad := []string{"", "   ", "/", "a//b", "../x", "a/../b", "./a", "a/./b", "a/..", "a\x00b", "a\nb",
		strings.Repeat("x", 81), "a/b/c/d/e/f/g/h/i"}
	for _, in := range bad {
		if _, err := ParseFolderPath(in); !errors.Is(err, ErrBadFolderPath) {
			t.Errorf("ParseFolderPath(%q) debía rechazarse, err = %v", in, err)
		}
	}
}

func TestEnsureNoteFolderCreatesNestedAndIsIdempotent(t *testing.T) {
	s := newChatStore(t)
	id, err := s.EnsureNoteFolder("Cerebro/Proyectos/mini-tools")
	if err != nil {
		t.Fatal(err)
	}
	// Misma ruta, otra escritura (mayúsculas): no crea carpetas nuevas.
	again, err := s.EnsureNoteFolder("cerebro/proyectos/MINI-TOOLS")
	if err != nil || again != id {
		t.Fatalf("again = %q, %v; quería %q", again, err, id)
	}
	folders, _ := s.noteFolders()
	if len(folders) != 3 {
		t.Fatalf("carpetas = %d, quería 3", len(folders))
	}
	for _, f := range folders {
		if f.Scope != "note" {
			t.Errorf("scope = %q", f.Scope)
		}
	}
	// Una hermana reutiliza el padre.
	if _, err := s.EnsureNoteFolder("Cerebro/Temas/Oracle"); err != nil {
		t.Fatal(err)
	}
	if folders, _ = s.noteFolders(); len(folders) != 5 {
		t.Errorf("carpetas = %d, quería 5", len(folders))
	}
	// Las de otro scope no cuentan: una carpeta de conexiones llamada igual no
	// se reutiliza.
	if _, err := s.CreateFolder("Raro", "", "db"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := s.FindNoteFolder("Raro"); found {
		t.Error("FindNoteFolder encontró una carpeta de otro scope")
	}
	// Una ruta inválida no crea nada.
	before, _ := s.noteFolders()
	if _, err := s.EnsureNoteFolder("Cerebro/../x"); !errors.Is(err, ErrBadFolderPath) {
		t.Errorf("err = %v", err)
	}
	if after, _ := s.noteFolders(); len(after) != len(before) {
		t.Error("una ruta inválida dejó carpetas")
	}
}

func TestNoteTagsForms(t *testing.T) {
	cases := []struct {
		content, fm string
		want        []string
	}{
		{"texto #oracle y #Prod-1\n# Encabezado\n", "", []string{"oracle", "Prod-1"}},
		{"nada", "tags: [a, b]\n", []string{"a", "b"}},
		{"nada", "tags: a, #b\n", []string{"a", "b"}},
		{"nada", "tags:\n- uno\n- dos\nclave: x\n", []string{"uno", "dos"}},
		{"x #A y #a", "tags: A\n", []string{"A"}},
		{"```sh\n#!/bin/bash\n#include\n```\ny `#inline` pero #real", "", []string{"real"}},
		{"sin etiquetas", "origen: agente-mcp\n", []string{}},
	}
	for _, c := range cases {
		got := NoteTags(c.content, c.fm)
		sort.Strings(got)
		sort.Strings(c.want)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("NoteTags(%q, %q) = %v, quería %v", c.content, c.fm, got, c.want)
		}
	}
}

// seedBrain deja tres notas visibles en dos carpetas, una privada y una nota
// suelta en la raíz.
func seedBrain(t *testing.T, s *Store) {
	t.Helper()
	mk := func(id, title, content, folder string, private bool) {
		if err := s.CreateNote(id, title, content, ""); err != nil {
			t.Fatal(err)
		}
		if folder != "" {
			fid, err := s.EnsureNoteFolder(folder)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.SetNoteFolder(id, fid); err != nil {
				t.Fatal(err)
			}
		}
		if private {
			if err := s.SetNotePrivacy(id, true); err != nil {
				t.Fatal(err)
			}
		}
	}
	mk("n1", "Bloqueos Oracle", "Diagnóstico de bloqueos #oracle #bd", "Cerebro/Proyectos/sgc", false)
	mk("n2", "Despliegue SGC", "Pasos del despliegue #ops", "Cerebro/Proyectos/sgc/deploy", false)
	mk("n3", "Idea de tema", "Notas sueltas sobre Oracle #oracle", "Cerebro/Temas", false)
	mk("n4", "Clave de producción", "la clave es hunter2 #oracle", "Cerebro/Proyectos/sgc", true)
	mk("n5", "Secreto solo", "hunter2", "Secretos", true)
	mk("n6", "Nota raíz", "oracle en la raíz", "", false)
}

func titles(ns []SharedNote) string {
	var out []string
	for _, n := range ns {
		out = append(out, n.Title)
	}
	sort.Strings(out)
	return strings.Join(out, "|")
}

func TestSearchSharedNotesFolderTagAndPrivacy(t *testing.T) {
	s := newChatStore(t)
	seedBrain(t, s)

	// Sin filtros: todas las visibles, ninguna privada.
	all, err := s.SearchSharedNotes(SharedNoteFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := titles(all); got != "Bloqueos Oracle|Despliegue SGC|Idea de tema|Nota raíz" {
		t.Errorf("sin filtros = %s", got)
	}

	// Texto: una privada que contiene la palabra no aparece ni de fragmento.
	hits, _ := s.SearchSharedNotes(SharedNoteFilter{Query: "hunter2"})
	if len(hits) != 0 {
		t.Errorf("una nota privada se coló en la búsqueda: %v", titles(hits))
	}
	hits, _ = s.SearchSharedNotes(SharedNoteFilter{Query: "bloqueos oracle"})
	if len(hits) != 1 || hits[0].Title != "Bloqueos Oracle" || hits[0].Snippet == "" || strings.ContainsAny(hits[0].Snippet, "«»") {
		t.Errorf("búsqueda = %+v", hits)
	}

	// Carpeta: la propia y sus descendientes.
	ids, found, err := s.NoteFolderSubtree("Cerebro/Proyectos/sgc")
	if err != nil || !found {
		t.Fatalf("subtree: %v %v", found, err)
	}
	hits, _ = s.SearchSharedNotes(SharedNoteFilter{FolderIDs: ids})
	if got := titles(hits); got != "Bloqueos Oracle|Despliegue SGC" {
		t.Errorf("carpeta + descendientes = %s", got)
	}
	if _, found, _ := s.NoteFolderSubtree("Cerebro/Nada"); found {
		t.Error("una carpeta inexistente no debe resolverse")
	}

	// Etiqueta (con o sin #, sin distinguir mayúsculas), sola y combinada.
	for _, tag := range []string{"oracle", "#Oracle"} {
		hits, _ = s.SearchSharedNotes(SharedNoteFilter{Tag: tag})
		if got := titles(hits); got != "Bloqueos Oracle|Idea de tema" {
			t.Errorf("tag %q = %s (la privada con ese tag no debe salir)", tag, got)
		}
	}
	hits, _ = s.SearchSharedNotes(SharedNoteFilter{Tag: "oracle", FolderIDs: ids})
	if got := titles(hits); got != "Bloqueos Oracle" {
		t.Errorf("tag + carpeta = %s", got)
	}
	// `tag:` dentro del texto vale como filtro.
	hits, _ = s.SearchSharedNotes(SharedNoteFilter{Query: "tag:ops"})
	if got := titles(hits); got != "Despliegue SGC" {
		t.Errorf("tag: en el texto = %s", got)
	}
	// Orden alfabético y tope.
	hits, _ = s.SearchSharedNotes(SharedNoteFilter{SortByTitle: true, Limit: 2})
	if len(hits) != 2 || hits[0].Title != "Bloqueos Oracle" || hits[1].Title != "Despliegue SGC" {
		t.Errorf("SortByTitle/Limit = %v", titles(hits))
	}
	// El wrapper histórico mantiene su contrato.
	old, _ := s.SearchNotesForAI("hunter2", 10)
	if len(old) != 0 {
		t.Error("SearchNotesForAI devolvió una privada")
	}
}

func TestSharedFolderTreeHidesPrivateOnlyFoldersAndCountsVisible(t *testing.T) {
	s := newChatStore(t)
	seedBrain(t, s)
	// Una carpeta vacía tampoco se lista.
	if _, err := s.EnsureNoteFolder("Vacía"); err != nil {
		t.Fatal(err)
	}
	folders, root, err := s.SharedFolderTree()
	if err != nil {
		t.Fatal(err)
	}
	if root != 1 {
		t.Errorf("notas en la raíz = %d, quería 1", root)
	}
	got := map[string]FolderStat{}
	for _, f := range folders {
		got[f.Path] = f
	}
	if _, ok := got["Secretos"]; ok {
		t.Error("una carpeta con solo notas privadas apareció")
	}
	if _, ok := got["Vacía"]; ok {
		t.Error("una carpeta vacía apareció")
	}
	want := map[string][2]int{
		"Cerebro":                      {0, 3},
		"Cerebro/Proyectos":            {0, 2},
		"Cerebro/Proyectos/sgc":        {1, 2}, // n4 es privada: no cuenta
		"Cerebro/Proyectos/sgc/deploy": {1, 1},
		"Cerebro/Temas":                {1, 1},
	}
	if len(got) != len(want) {
		t.Errorf("carpetas = %v", got)
	}
	for path, w := range want {
		if g := got[path]; g.Notes != w[0] || g.Total != w[1] {
			t.Errorf("%s = %d/%d, quería %d/%d", path, g.Notes, g.Total, w[0], w[1])
		}
	}
}

func TestBrainRootAndChatFlag(t *testing.T) {
	s := newChatStore(t)
	if root, err := s.BrainRoot(); err != nil || root != "Cerebro" {
		t.Fatalf("default = %q, %v", root, err)
	}
	if err := s.SetBrainRoot(" /Notas/Mi Cerebro/ "); err != nil {
		t.Fatal(err)
	}
	if root, _ := s.BrainRoot(); root != "Notas/Mi Cerebro" {
		t.Errorf("canónica = %q", root)
	}
	for _, bad := range []string{"../x", "a//b", "a/../b"} {
		if err := s.SetBrainRoot(bad); !errors.Is(err, ErrBadFolderPath) {
			t.Errorf("SetBrainRoot(%q) = %v", bad, err)
		}
	}
	if root, _ := s.BrainRoot(); root != "Notas/Mi Cerebro" {
		t.Errorf("una raíz inválida pisó la guardada: %q", root)
	}
	if err := s.SetBrainRoot("  "); err != nil {
		t.Fatal(err)
	}
	if root, _ := s.BrainRoot(); root != "Cerebro" {
		t.Errorf("vacío debía volver al default: %q", root)
	}

	// La bandera por conversación: falla sin fila, viaja en el listado.
	if err := s.SetAgentChatBrain("nope", true); err == nil {
		t.Error("sin fila debía fallar")
	}
	if err := s.CreateAgentChat("c1", "", "claude", "t", "db", "x"); err != nil {
		t.Fatal(err)
	}
	if s.AgentChatBrain("c1") {
		t.Error("nace apagado")
	}
	if err := s.SetAgentChatBrain("c1", true); err != nil {
		t.Fatal(err)
	}
	all, _ := s.ListAllAgentChats()
	if len(all) != 1 || !all[0].Brain {
		t.Fatalf("ListAll = %+v", all)
	}
	if err := s.AppendAgentChatMessage("c1", ChatRoleUser, "brain tests", "", ""); err != nil {
		t.Fatal(err)
	}
	found, _ := s.SearchAgentChats("brain", 0)
	if len(found) != 1 || !found[0].Brain {
		t.Errorf("SearchAgentChats no trae brain: %+v", found)
	}
	if err := s.SetAgentChatBrain("c1", false); err != nil {
		t.Fatal(err)
	}
	if s.AgentChatBrain("c1") {
		t.Error("no se apagó")
	}
}

// Migración 59 sobre un vault que ya estaba en uso: agrega las dos columnas con
// sus defaults y no toca las filas existentes.
func TestMigration59AddsBrainColumns(t *testing.T) {
	s := newChatStore(t)
	if err := s.CreateAgentChat("viejo", "", "claude", "chat anterior", "git", "r1"); err != nil {
		t.Fatal(err)
	}
	// Se vuelve al estado previo a la migración. Las migraciones posteriores
	// (60: columnas de model_servers) se deshacen también: applyMigrations
	// retoma desde la versión máxima aplicada y se saltearía la 59.
	for _, q := range []string{
		`ALTER TABLE settings DROP COLUMN brain_root`,
		`ALTER TABLE agent_chats DROP COLUMN brain`,
		`ALTER TABLE model_servers DROP COLUMN encrypted_headers`,
		`ALTER TABLE model_servers DROP COLUMN headers_nonce`,
		`ALTER TABLE model_servers DROP COLUMN insecure_tls`,
		`DELETE FROM schema_migrations WHERE version >= 59`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := applyMigrations(s.db); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	var root string
	if err := s.db.QueryRow(`SELECT brain_root FROM settings WHERE id = 1`).Scan(&root); err != nil || root != "Cerebro" {
		t.Errorf("brain_root = %q, %v", root, err)
	}
	chats, err := s.ListAllAgentChats()
	if err != nil || len(chats) != 1 || chats[0].Brain || chats[0].Title != "chat anterior" {
		t.Errorf("chat existente = %+v, %v", chats, err)
	}
	// Idempotente: una segunda pasada no hace nada ni falla.
	if err := applyMigrations(s.db); err != nil {
		t.Errorf("segunda pasada: %v", err)
	}
}
