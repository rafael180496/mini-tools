package vault

import "testing"

// El idioma nace sin elegir (”), acepta en/es y rechaza cualquier otro.
func TestLanguageSetting(t *testing.T) {
	store, _ := openTestStore(t)
	st, err := store.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if st.Language != "" {
		t.Errorf("idioma inicial = %q, quería vacío (sin elegir)", st.Language)
	}
	if err := store.SetLanguage("es"); err != nil {
		t.Fatal(err)
	}
	if st, _ := store.GetSettings(); st.Language != "es" {
		t.Errorf("idioma guardado = %q, quería es", st.Language)
	}
	if err := store.SetLanguage("fr"); err == nil {
		t.Error("un idioma sin diccionario debería rechazarse")
	}
}
