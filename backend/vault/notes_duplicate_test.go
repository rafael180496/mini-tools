package vault

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"strings"
	"testing"
)

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// La copia de una nota privada tiene que nacer privada, en su carpeta, y con
// sus propias imágenes: borrar el original no puede dejarla sin imágenes.
func TestDuplicateNoteKeepsPrivacyFolderAndImages(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("pw"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateNote("src", "Runbook", "ver ![](nota:img1) y [[Otra]]", "tags: [x]"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveNoteAsset("img1", "src", "image/png", tinyPNG(t)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetNotePrivacy("src", true); err != nil {
		t.Fatal(err)
	}
	if err := store.SetNoteFolder("src", "f1"); err != nil {
		t.Fatal(err)
	}

	n := 0
	gen := func() (string, error) { n++; return fmt.Sprintf("new%d", n), nil }
	if err := store.DuplicateNote("src", "dup", "Runbook (copia)", gen); err != nil {
		t.Fatalf("DuplicateNote: %v", err)
	}

	dup, err := store.GetNote("dup")
	if err != nil {
		t.Fatal(err)
	}
	if !dup.IsPrivate {
		t.Error("la copia de una nota privada nació visible para los agentes")
	}
	if dup.Title != "Runbook (copia)" || dup.Frontmatter != "tags: [x]" {
		t.Errorf("título/frontmatter inesperados: %q %q", dup.Title, dup.Frontmatter)
	}
	if !strings.Contains(dup.Content, "(nota:new1)") || strings.Contains(dup.Content, "nota:img1") {
		t.Errorf("el cuerpo sigue apuntando a la imagen del original: %q", dup.Content)
	}
	var folder string
	if err := store.db.QueryRow(`SELECT COALESCE(folder_id,'') FROM vault_notes WHERE id = 'dup'`).Scan(&folder); err != nil || folder != "f1" {
		t.Errorf("carpeta de la copia = %q (%v), quería f1", folder, err)
	}

	if err := store.DeleteNoteAssets("src"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNoteAsset("new1"); err != nil {
		t.Errorf("la imagen de la copia se perdió al borrar las del original: %v", err)
	}
}

// Fundir una nota privada dentro de una visible tiene que dejar el resultado
// privado; las imágenes pasan al destino y el origen desaparece.
func TestMergeNotesKeepsMostRestrictivePrivacy(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("pw"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateNote("dst", "Guía", "intro", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateNote("src", "Secreto", "clave ![](nota:img1)", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveNoteAsset("img1", "src", "image/png", tinyPNG(t)); err != nil {
		t.Fatal(err)
	}
	if err := store.SetNotePrivacy("src", true); err != nil {
		t.Fatal(err)
	}

	if err := store.MergeNotes("src", "dst"); err != nil {
		t.Fatalf("MergeNotes: %v", err)
	}
	dst, err := store.GetNote("dst")
	if err != nil {
		t.Fatal(err)
	}
	if !dst.IsPrivate {
		t.Error("el contenido de una nota privada quedó en una visible para los agentes")
	}
	if !strings.Contains(dst.Content, "intro") || !strings.Contains(dst.Content, "## Secreto") || !strings.Contains(dst.Content, "nota:img1") {
		t.Errorf("contenido fundido inesperado: %q", dst.Content)
	}
	if _, err := store.GetNote("src"); err == nil {
		t.Error("la nota de origen sigue existiendo")
	}
	if err := store.DeleteNoteAssets("src"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetNoteAsset("img1"); err != nil {
		t.Errorf("la imagen no pasó al destino: %v", err)
	}
	if err := store.MergeNotes("dst", "dst"); err == nil {
		t.Error("fundir una nota consigo misma debería fallar")
	}
}

// Fijada tiene que llegar por los dos caminos del buscador.
func TestPinnedReachesBothSearchPaths(t *testing.T) {
	store, _ := openTestStore(t)
	if err := store.Initialize("pw"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateNote("a", "Runbook", "oracle", ""); err != nil {
		t.Fatal(err)
	}
	if err := store.SetNotePinned("a", true); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"", "oracle"} {
		hits, err := store.SearchNotesSmart(q, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != 1 || !hits[0].Pinned {
			t.Errorf("búsqueda %q: pinned no llegó: %+v", q, hits)
		}
	}
}
