package vault

import (
	"database/sql"
	"encoding/base64"
	"time"

	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/i18n"
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
		return i18n.Errorf(i18n.Msg{ES: "vault: la imagen está vacía", EN: "vault: the image is empty"})
	}
	if len(data) > MaxNoteAssetBytes {
		return i18n.Errorf(i18n.Msg{ES: "vault: la imagen pesa %d MB y el tope es %d MB", EN: "vault: the image is %d MB and the limit is %d MB"},
			len(data)/(1<<20), MaxNoteAssetBytes/(1<<20))
	}

	opt, err := imageopt.Prepare(data)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: %w", EN: "vault: %w"}, err)
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
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando la imagen: %w", EN: "vault: saving the image: %w"}, err)
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
		return NoteAsset{}, i18n.Errorf(i18n.Msg{ES: "vault: no existe esa imagen", EN: "vault: that image does not exist"})
	}
	if err != nil {
		return NoteAsset{}, i18n.Errorf(i18n.Msg{ES: "vault: leyendo la imagen: %w", EN: "vault: reading the image: %w"}, err)
	}

	key, err := s.gate.Key()
	if err != nil {
		return NoteAsset{}, err
	}
	plain, err := mtcrypto.Decrypt(key, enc, nonce)
	if err != nil {
		return NoteAsset{}, i18n.Errorf(i18n.Msg{ES: "vault: descifrando la imagen: %w", EN: "vault: decrypting the image: %w"}, err)
	}
	a.Data = base64.StdEncoding.EncodeToString(plain)
	return a, nil
}

// DeleteNoteAssets borra las imágenes de una nota. Se llama al borrar la nota:
// dejarlas sería basura cifrada que nadie puede ver ni borrar desde la interfaz.
func (s *Store) DeleteNoteAssets(noteID string) error {
	if _, err := s.db.Exec(`DELETE FROM vault_note_assets WHERE note_id = ?`, noteID); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: borrando las imágenes de la nota: %w", EN: "vault: deleting the note's images: %w"}, err)
	}
	return nil
}

// NoteAssetIDs devuelve los ids de las imágenes de una nota.
func (s *Store) NoteAssetIDs(noteID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT id FROM vault_note_assets WHERE note_id = ?`, noteID)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: listando las imágenes de la nota: %w", EN: "vault: listing the note's images: %w"}, err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
