package agentchat

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// El nombre que manda el frontend NO se usa como ruta: solo se le mira la
// extensión. Es lo que hace que un nombre con `../` adentro no pueda escribir
// fuera del directorio de adjuntos.
func TestSaveAttachmentIgnoresSuppliedPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "adjuntos")
	data := base64.StdEncoding.EncodeToString([]byte("no importa el contenido"))

	path, err := SaveAttachment(dir, "../../../evil.png", data)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("el adjunto se escribió fuera del directorio: %q", path)
	}
	if strings.Contains(filepath.Base(path), "evil") {
		t.Errorf("el nombre lo arma la app, no el frontend: %q", path)
	}
}

// Lista blanca, no negra: lo que llega se va a escribir en el disco y después
// se le va a nombrar a otro programa.
func TestSaveAttachmentRejectsNonImages(t *testing.T) {
	dir := t.TempDir()
	data := base64.StdEncoding.EncodeToString([]byte("x"))

	for _, name := range []string{"script.sh", "nota.txt", "sin-extension", "raro.exe"} {
		if _, err := SaveAttachment(dir, name, data); err == nil {
			t.Errorf("%q no es una imagen y debía rechazarse", name)
		}
	}
	if _, err := SaveAttachment(dir, "captura.PNG", data); err != nil {
		t.Errorf("la extensión no debería depender de mayúsculas: %v", err)
	}
}

// El pegado del navegador llega como data URL, no como base64 pelado.
func TestSaveAttachmentAcceptsDataURL(t *testing.T) {
	dir := t.TempDir()
	raw := []byte("contenido de imagen")
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)

	path, err := SaveAttachment(dir, "pegado.png", url)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(raw) {
		t.Errorf("el contenido no se decodificó bien: %q (%v)", got, err)
	}
}

// Los adjuntos se limpian solos al guardar uno nuevo: si no, la carpeta
// crecería para siempre con capturas pegadas una sola vez.
func TestSaveAttachmentPrunesOldOnes(t *testing.T) {
	dir := t.TempDir()
	data := base64.StdEncoding.EncodeToString([]byte("x"))

	viejo := filepath.Join(dir, "adjunto-viejo.png")
	if err := os.WriteFile(viejo, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(viejo, old, old); err != nil {
		t.Fatal(err)
	}
	// Un archivo ajeno al esquema de nombres no se toca: la limpieza es de lo
	// que esta app creó, no del directorio.
	ajeno := filepath.Join(dir, "otra-cosa.png")
	if err := os.WriteFile(ajeno, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(ajeno, old, old); err != nil {
		t.Fatal(err)
	}

	if _, err := SaveAttachment(dir, "nuevo.png", data); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(viejo); !os.IsNotExist(err) {
		t.Error("el adjunto vencido debería haberse borrado")
	}
	if _, err := os.Stat(ajeno); err != nil {
		t.Error("un archivo que esta app no creó no se toca")
	}
}
