package vault

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"time"

	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/imageopt"
)

// Imágenes de las notas (migración 39).
//
// **Cifradas y adentro del vault**, con la misma clave maestra que el texto.
// Una captura de un tablero de producción o de una consola con datos de un
// cliente es igual de sensible que el párrafo que la acompaña — y más
// delatora, porque se entiende de un vistazo mientras que un texto hay que
// leerlo. Guardar la nota cifrada y la imagen en una carpeta al lado sería
// proteger la mitad.
//
// En el Markdown quedan como `![alt](nota:ID)`. El esquema `nota:` es propio y
// eso tiene una consecuencia que hay que decir: una nota **exportada** con
// imágenes se abre en Obsidian con el texto intacto pero sin ver las imágenes,
// porque el archivo no las tiene. Es el precio de que estén cifradas; la
// alternativa era dejarlas en claro en el disco.

// MaxNoteAssetBytes acota lo que se puede pegar. 8 MB es una captura de
// pantalla generosa; un video o un PDF entero no son "una imagen en una nota"
// y harían crecer el vault sin techo.
const MaxNoteAssetBytes = 8 << 20

// NoteAsset es una imagen ya descifrada, lista para mostrarse.
type NoteAsset struct {
	ID   string `json:"id"`
	Mime string `json:"mime"`
	// Data es el contenido en base64, para que el frontend lo use como
	// `data:` URI. Nunca se escribe a disco en claro.
	Data string `json:"data"`
	Size int64  `json:"size"`
}

// SaveNoteAsset valida, comprime y guarda una imagen.
//
// **Solo PNG y JPG**, validados por los bytes y no por lo que declare quien la
// manda. Y la compresión no pierde calidad: el PNG se recomprime (el formato es
// sin pérdida, así que los píxeles son idénticos) y el JPEG se guarda tal cual
// —volver a codificarlo pierde calidad siempre—. Ver backend/imageopt.
func (s *Store) SaveNoteAsset(id, noteID, _ string, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("vault: la imagen está vacía")
	}
	if len(data) > MaxNoteAssetBytes {
		return fmt.Errorf("vault: la imagen pesa %d MB y el tope es %d MB",
			len(data)/(1<<20), MaxNoteAssetBytes/(1<<20))
	}

	opt, err := imageopt.Prepare(data)
	if err != nil {
		return fmt.Errorf("vault: %w", err)
	}
	data = opt.Data
	mime := opt.Mime

	key, err := s.gate.Key()
	if err != nil {
		return err
	}
	enc, nonce, err := mtcrypto.Encrypt(key, data)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(
		`INSERT INTO vault_note_assets (id, note_id, mime, encrypted_data, data_nonce, size_bytes, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, noteID, mime, enc, nonce, int64(len(data)), time.Now().Unix(),
	); err != nil {
		return fmt.Errorf("vault: guardando la imagen: %w", err)
	}
	return nil
}

// GetNoteAsset descifra una imagen.
func (s *Store) GetNoteAsset(id string) (NoteAsset, error) {
	var a NoteAsset
	var enc, nonce []byte
	err := s.db.QueryRow(
		`SELECT id, mime, encrypted_data, data_nonce, size_bytes FROM vault_note_assets WHERE id = ?`, id,
	).Scan(&a.ID, &a.Mime, &enc, &nonce, &a.Size)
	if err == sql.ErrNoRows {
		return NoteAsset{}, fmt.Errorf("vault: no existe esa imagen")
	}
	if err != nil {
		return NoteAsset{}, fmt.Errorf("vault: leyendo la imagen: %w", err)
	}

	key, err := s.gate.Key()
	if err != nil {
		return NoteAsset{}, err
	}
	plain, err := mtcrypto.Decrypt(key, enc, nonce)
	if err != nil {
		return NoteAsset{}, fmt.Errorf("vault: descifrando la imagen: %w", err)
	}
	a.Data = base64.StdEncoding.EncodeToString(plain)
	return a, nil
}

// DeleteNoteAssets borra las imágenes de una nota. Se llama al borrar la nota:
// dejarlas sería basura cifrada que nadie puede ver ni borrar desde la interfaz.
func (s *Store) DeleteNoteAssets(noteID string) error {
	if _, err := s.db.Exec(`DELETE FROM vault_note_assets WHERE note_id = ?`, noteID); err != nil {
		return fmt.Errorf("vault: borrando las imágenes de la nota: %w", err)
	}
	return nil
}
