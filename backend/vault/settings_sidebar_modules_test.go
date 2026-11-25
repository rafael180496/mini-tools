package vault

import (
	"reflect"
	"testing"
)

// latestMigrationVersion es la última versión declarada en `migrations`. Los
// tests de migraciones comparan contra ella y no contra un número fijo: así
// siguen siendo exactos (detectan una migración que no corrió) sin tener que
// tocarlos cada vez que se agrega una nueva.
func latestMigrationVersion() int {
	return migrations[len(migrations)-1].version
}

func assertSchemaAtLatest(t *testing.T, s *Store) {
	t.Helper()
	var max int
	if err := s.db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&max); err != nil || max != latestMigrationVersion() {
		t.Errorf("versión = %d (esperada %d), %v", max, latestMigrationVersion(), err)
	}
}

// La migración 66 agrega settings.hidden_sidebar_modules vacía (se ven los seis
// módulos), es idempotente y no toca el resto de la fila de settings.
func TestMigration66AddsHiddenSidebarModules(t *testing.T) {
	s := newChatStore(t)
	if err := s.SetTheme("light"); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`ALTER TABLE settings DROP COLUMN hidden_sidebar_modules`,
		`DELETE FROM schema_migrations WHERE version >= 66`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if err := applyMigrations(s.db); err != nil {
		t.Fatalf("applyMigrations: %v", err)
	}
	got, err := s.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.HiddenSidebarModules) != 0 || got.HiddenSidebarModules == nil {
		t.Errorf("HiddenSidebarModules = %#v, se esperaba []", got.HiddenSidebarModules)
	}
	if got.Theme != "light" {
		t.Errorf("la migración tocó otras columnas: theme = %q", got.Theme)
	}
	// Segunda pasada: la columna ya existe y no debe fallar.
	if _, err := s.db.Exec(`DELETE FROM schema_migrations WHERE version >= 66`); err != nil {
		t.Fatal(err)
	}
	if err := applyMigrations(s.db); err != nil {
		t.Errorf("segunda pasada: %v", err)
	}
	assertSchemaAtLatest(t, s)
}

// SetHiddenSidebarModules descarta ids desconocidos y repetidos, y nunca guarda
// los seis ocultos: la barra lateral tiene que quedar con al menos un módulo.
func TestSetHiddenSidebarModules(t *testing.T) {
	s := newChatStore(t)
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"vacío", nil, []string{}},
		{"válidos", []string{"ssh", "http"}, []string{"ssh", "http"}},
		{"desconocidos y repetidos", []string{"ssh", "nope", "ssh", "notes"}, []string{"ssh", "notes"}},
		{"los seis ocultos vuelve a mostrar todos", []string{"connections", "ssh", "git", "notes", "http", "utilities"}, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := s.SetHiddenSidebarModules(c.in); err != nil {
				t.Fatal(err)
			}
			got, err := s.GetSettings()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.HiddenSidebarModules, c.want) {
				t.Errorf("HiddenSidebarModules = %#v, want %#v", got.HiddenSidebarModules, c.want)
			}
		})
	}
	// Un valor corrupto en la base se lee como "sin módulos ocultos", no rompe GetSettings.
	if _, err := s.db.Exec(`UPDATE settings SET hidden_sidebar_modules = '{roto' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetSettings()
	if err != nil || len(got.HiddenSidebarModules) != 0 {
		t.Errorf("valor corrupto: %#v, %v", got.HiddenSidebarModules, err)
	}
}
