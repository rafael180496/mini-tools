package vault

import (
	"os"
	"testing"

	"mini-tools/backend/i18n"
)

// Los tests del vault verifican mensajes en español (el idioma en el que se
// escribieron). El idioma por defecto del proceso es inglés, así que se fija
// acá para todo el paquete. Ver backend/i18n.
func TestMain(m *testing.M) {
	i18n.SetLang("es")
	os.Exit(m.Run())
}
