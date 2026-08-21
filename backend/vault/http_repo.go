package vault

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Persistencia del módulo de peticiones HTTP (F1 de
// .claude/specs/http-client.md).
//
// # Qué se cifra y qué no
//
// Se cifran las columnas que pueden llevar un secreto: el cuerpo (un token
// dentro del JSON de un login es lo más común del mundo), la auth, la
// documentación —que la gente usa para pegar ejemplos reales, con datos
// reales— y el crudo de Postman preservado para el round-trip.
//
// NO se cifran url, params ni headers, y es deliberado: son las columnas por
// las que se lista, se busca y se ordena el árbol. Cifrarlas obligaría a
// descifrar la colección entera para dibujar la barra lateral. La
// contrapartida honesta es que un header con un Bearer escrito a mano queda
// en claro en el archivo del vault; la respuesta a eso son las variables
// secretas de F2, que sí se cifran y son el lugar donde va un token.

// HTTPCollection es una colección: la raíz del árbol.
type HTTPCollection struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	FolderID    string `json:"folderId,omitempty"`
	SortOrder   int    `json:"sortOrder"`
	// Variables y Auth viajan como texto JSON: este paquete no interpreta su
	// contenido, solo lo guarda cifrado. Quien los entiende es
	// backend/httpclient y las fases que los estrenan (F2 y F4).
	Variables  string `json:"variables,omitempty"`
	Auth       string `json:"auth,omitempty"`
	PreRequest string `json:"preRequest,omitempty"`
	TestScript string `json:"testScript,omitempty"`
	Computed   string `json:"computed,omitempty"`
	// DocsNoteID es la nota del vault donde se publicó la documentación de
	// esta colección, o "" si nunca se publicó. Es de solo lectura desde el
	// editor: lo escribe `SetHTTPCollectionNote`, igual que el crudo de
	// Postman, para que guardar un cambio de nombre no pueda desvincular la
	// nota sin que nadie lo pida.
	DocsNoteID string `json:"docsNoteId,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// HTTPItem es una carpeta o una petición dentro de una colección.
//
// Un solo tipo para las dos cosas, distinguidas por Kind, porque es la forma
// que tiene el formato de Postman: el import (F6) mapea uno a uno en vez de
// decidir a qué tabla va cada nodo.
type HTTPItem struct {
	ID           string `json:"id"`
	CollectionID string `json:"collectionId"`
	ParentID     string `json:"parentId,omitempty"`
	Kind         string `json:"kind"` // "folder" | "request"
	Name         string `json:"name"`
	SortOrder    int    `json:"sortOrder"`

	Method   string `json:"method,omitempty"`
	URL      string `json:"url,omitempty"`
	Params   string `json:"params,omitempty"`
	PathVars string `json:"pathVars,omitempty"`
	Headers  string `json:"headers,omitempty"`
	Settings string `json:"settings,omitempty"`
	Body     string `json:"body,omitempty"`
	Auth     string `json:"auth,omitempty"`
	Docs     string `json:"docs,omitempty"`
	// PreRequest y TestScript son JavaScript al estilo Postman. Se guardan
	// desde ya —el import los tiene que poder traer y devolver intactos—
	// aunque ejecutarlos dependa de una decisión pendiente.
	PreRequest string `json:"preRequest,omitempty"`
	TestScript string `json:"testScript,omitempty"`
	// Computed son las variables derivadas (firma declarativa), como texto
	// JSON. Reemplazan al motor JS que no entró por tamaño de binario.
	Computed string `json:"computed,omitempty"`

	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// HTTPHistoryEntry es una ejecución. La URL ya viene resuelta pero sin
// secretos: sirve para reconocer qué se corrió sin convertir el historial en
// un archivo de tokens.
type HTTPHistoryEntry struct {
	ID         string `json:"id"`
	ItemID     string `json:"itemId,omitempty"`
	Method     string `json:"method"`
	URL        string `json:"url"`
	Status     int    `json:"status"`
	DurationMs int64  `json:"durationMs"`
	SizeBytes  int64  `json:"sizeBytes"`
	Error      string `json:"error,omitempty"`
	ExecutedAt int64  `json:"executedAt"`
}

const httpHistoryPerItem = 50

// --- Colecciones -------------------------------------------------------------

// SaveHTTPCollection crea o actualiza. ID vacío = alta.
func (s *Store) SaveHTTPCollection(c HTTPCollection) (*HTTPCollection, error) {
	name := strings.TrimSpace(c.Name)
	if name == "" {
		return nil, fmt.Errorf("vault: la colección necesita un nombre")
	}
	c.Name = name
	now := time.Now().Unix()

	vars, varsNonce, err := s.encryptOptional(c.Variables)
	if err != nil {
		return nil, err
	}
	auth, authNonce, err := s.encryptOptional(c.Auth)
	if err != nil {
		return nil, err
	}
	pre, preNonce, err := s.encryptOptional(c.PreRequest)
	if err != nil {
		return nil, err
	}
	test, testNonce, err := s.encryptOptional(c.TestScript)
	if err != nil {
		return nil, err
	}
	comp, compNonce, err := s.encryptOptional(c.Computed)
	if err != nil {
		return nil, err
	}

	if c.ID == "" {
		id, err := newID()
		if err != nil {
			return nil, err
		}
		var nextOrder int
		if err := s.db.QueryRow(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM http_collections`).Scan(&nextOrder); err != nil {
			return nil, fmt.Errorf("vault: calculando orden de la colección: %w", err)
		}
		c.ID, c.SortOrder, c.CreatedAt, c.UpdatedAt = id, nextOrder, now, now
		if _, err := s.db.Exec(
			`INSERT INTO http_collections (id, name, description, folder_id, sort_order,
				variables, variables_nonce, auth, auth_nonce,
				pre_request, pre_request_nonce, test_script, test_script_nonce,
				computed, computed_nonce, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			c.ID, c.Name, c.Description, nullable(c.FolderID), c.SortOrder,
			vars, varsNonce, auth, authNonce, pre, preNonce, test, testNonce, comp, compNonce, now, now,
		); err != nil {
			return nil, fmt.Errorf("vault: creando la colección: %w", err)
		}
		return &c, nil
	}

	c.UpdatedAt = now
	if _, err := s.db.Exec(
		`UPDATE http_collections SET name = ?, description = ?, folder_id = ?,
			variables = ?, variables_nonce = ?, auth = ?, auth_nonce = ?,
			pre_request = ?, pre_request_nonce = ?, test_script = ?, test_script_nonce = ?,
			computed = ?, computed_nonce = ?, updated_at = ?
		 WHERE id = ?`,
		c.Name, c.Description, nullable(c.FolderID),
		vars, varsNonce, auth, authNonce, pre, preNonce, test, testNonce, comp, compNonce, now, c.ID,
	); err != nil {
		return nil, fmt.Errorf("vault: guardando la colección: %w", err)
	}
	return &c, nil
}

func (s *Store) ListHTTPCollections() ([]HTTPCollection, error) {
	rows, err := s.db.Query(`SELECT id, name, description, COALESCE(folder_id, ''), sort_order,
		variables, variables_nonce, auth, auth_nonce,
		pre_request, pre_request_nonce, test_script, test_script_nonce,
		computed, computed_nonce, COALESCE(docs_note_id, ''), created_at, updated_at
		FROM http_collections ORDER BY sort_order, name`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando colecciones: %w", err)
	}
	defer rows.Close()

	out := []HTTPCollection{}
	for rows.Next() {
		var c HTTPCollection
		var vars, varsNonce, auth, authNonce, pre, preNonce, test, testNonce, comp, compNonce []byte
		if err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.FolderID, &c.SortOrder,
			&vars, &varsNonce, &auth, &authNonce,
			&pre, &preNonce, &test, &testNonce, &comp, &compNonce, &c.DocsNoteID, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo colección: %w", err)
		}
		c.Variables = s.decryptOptional(vars, varsNonce)
		c.Auth = s.decryptOptional(auth, authNonce)
		c.PreRequest = s.decryptOptional(pre, preNonce)
		c.TestScript = s.decryptOptional(test, testNonce)
		c.Computed = s.decryptOptional(comp, compNonce)
		out = append(out, c)
	}
	return out, rows.Err()
}

// DeleteHTTPCollection borra la colección y todo lo que cuelga de ella.
//
// En una transacción con los ítems y el historial: media colección borrada
// es peor que ninguna, y sin claves foráneas declaradas nada lo haría por
// nosotros.
func (s *Store) DeleteHTTPCollection(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: borrando colección: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`DELETE FROM http_history WHERE item_id IN (SELECT id FROM http_items WHERE collection_id = ?)`, id,
	); err != nil {
		return fmt.Errorf("vault: borrando historial de la colección: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM http_items WHERE collection_id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando ítems de la colección: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM http_collections WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando la colección: %w", err)
	}
	return tx.Commit()
}

// --- Ítems -------------------------------------------------------------------

// SaveHTTPItem crea o actualiza una carpeta o petición. ID vacío = alta.
func (s *Store) SaveHTTPItem(it HTTPItem) (*HTTPItem, error) {
	if it.CollectionID == "" {
		return nil, fmt.Errorf("vault: el ítem necesita una colección")
	}
	if it.Kind != "folder" && it.Kind != "request" {
		return nil, fmt.Errorf("vault: tipo de ítem desconocido: %q", it.Kind)
	}
	it.Name = strings.TrimSpace(it.Name)
	if it.Name == "" {
		it.Name = "Sin nombre"
	}
	now := time.Now().Unix()

	body, bodyNonce, err := s.encryptOptional(it.Body)
	if err != nil {
		return nil, err
	}
	auth, authNonce, err := s.encryptOptional(it.Auth)
	if err != nil {
		return nil, err
	}
	docs, docsNonce, err := s.encryptOptional(it.Docs)
	if err != nil {
		return nil, err
	}
	pre, preNonce, err := s.encryptOptional(it.PreRequest)
	if err != nil {
		return nil, err
	}
	test, testNonce, err := s.encryptOptional(it.TestScript)
	if err != nil {
		return nil, err
	}
	comp, compNonce, err := s.encryptOptional(it.Computed)
	if err != nil {
		return nil, err
	}

	if it.ID == "" {
		id, err := newID()
		if err != nil {
			return nil, err
		}
		// El orden se calcula dentro del MISMO padre: dos carpetas
		// hermanas comparten numeración, una anidada arranca de cero.
		var nextOrder int
		if err := s.db.QueryRow(
			`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM http_items
			 WHERE collection_id = ? AND COALESCE(parent_id, '') = ?`,
			it.CollectionID, it.ParentID,
		).Scan(&nextOrder); err != nil {
			return nil, fmt.Errorf("vault: calculando orden del ítem: %w", err)
		}
		it.ID, it.SortOrder, it.CreatedAt, it.UpdatedAt = id, nextOrder, now, now
		if _, err := s.db.Exec(
			`INSERT INTO http_items (id, collection_id, parent_id, kind, name, sort_order,
				method, url, params, path_vars, headers, settings,
				body, body_nonce, auth, auth_nonce, docs, docs_nonce,
				pre_request, pre_request_nonce, test_script, test_script_nonce,
				computed, computed_nonce, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			it.ID, it.CollectionID, nullable(it.ParentID), it.Kind, it.Name, it.SortOrder,
			it.Method, it.URL, it.Params, it.PathVars, it.Headers, it.Settings,
			body, bodyNonce, auth, authNonce, docs, docsNonce, pre, preNonce, test, testNonce, comp, compNonce, now, now,
		); err != nil {
			return nil, fmt.Errorf("vault: creando el ítem: %w", err)
		}
		return &it, nil
	}

	it.UpdatedAt = now
	if _, err := s.db.Exec(
		`UPDATE http_items SET parent_id = ?, name = ?, method = ?, url = ?,
			params = ?, path_vars = ?, headers = ?, settings = ?,
			body = ?, body_nonce = ?, auth = ?, auth_nonce = ?, docs = ?, docs_nonce = ?,
			pre_request = ?, pre_request_nonce = ?, test_script = ?, test_script_nonce = ?,
			computed = ?, computed_nonce = ?, updated_at = ?
		 WHERE id = ?`,
		nullable(it.ParentID), it.Name, it.Method, it.URL,
		it.Params, it.PathVars, it.Headers, it.Settings,
		body, bodyNonce, auth, authNonce, docs, docsNonce, pre, preNonce, test, testNonce, comp, compNonce, now, it.ID,
	); err != nil {
		return nil, fmt.Errorf("vault: guardando el ítem: %w", err)
	}
	return &it, nil
}

// ListHTTPItems devuelve los ítems de una colección, planos y en orden. El
// árbol lo arma el frontend con parent_id, igual que el de conexiones y el
// de repositorios.
func (s *Store) ListHTTPItems(collectionID string) ([]HTTPItem, error) {
	rows, err := s.db.Query(`SELECT id, collection_id, COALESCE(parent_id, ''), kind, name, sort_order,
		method, url, params, path_vars, headers, settings,
		body, body_nonce, auth, auth_nonce, docs, docs_nonce,
		pre_request, pre_request_nonce, test_script, test_script_nonce,
		computed, computed_nonce, created_at, updated_at
		FROM http_items WHERE collection_id = ? ORDER BY sort_order, name`, collectionID)
	if err != nil {
		return nil, fmt.Errorf("vault: listando ítems: %w", err)
	}
	defer rows.Close()

	out := []HTTPItem{}
	for rows.Next() {
		var it HTTPItem
		var body, bodyNonce, auth, authNonce, docs, docsNonce, pre, preNonce, test, testNonce, comp, compNonce []byte
		if err := rows.Scan(&it.ID, &it.CollectionID, &it.ParentID, &it.Kind, &it.Name, &it.SortOrder,
			&it.Method, &it.URL, &it.Params, &it.PathVars, &it.Headers, &it.Settings,
			&body, &bodyNonce, &auth, &authNonce, &docs, &docsNonce,
			&pre, &preNonce, &test, &testNonce, &comp, &compNonce,
			&it.CreatedAt, &it.UpdatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo ítem: %w", err)
		}
		it.Body = s.decryptOptional(body, bodyNonce)
		it.Auth = s.decryptOptional(auth, authNonce)
		it.Docs = s.decryptOptional(docs, docsNonce)
		it.PreRequest = s.decryptOptional(pre, preNonce)
		it.TestScript = s.decryptOptional(test, testNonce)
		it.Computed = s.decryptOptional(comp, compNonce)
		out = append(out, it)
	}
	return out, rows.Err()
}

// GetHTTPItem devuelve un ítem por id.
func (s *Store) GetHTTPItem(id string) (*HTTPItem, error) {
	var it HTTPItem
	var body, bodyNonce, auth, authNonce, docs, docsNonce, pre, preNonce, test, testNonce, comp, compNonce []byte
	err := s.db.QueryRow(`SELECT id, collection_id, COALESCE(parent_id, ''), kind, name, sort_order,
		method, url, params, path_vars, headers, settings,
		body, body_nonce, auth, auth_nonce, docs, docs_nonce,
		pre_request, pre_request_nonce, test_script, test_script_nonce,
		computed, computed_nonce, created_at, updated_at
		FROM http_items WHERE id = ?`, id).Scan(
		&it.ID, &it.CollectionID, &it.ParentID, &it.Kind, &it.Name, &it.SortOrder,
		&it.Method, &it.URL, &it.Params, &it.PathVars, &it.Headers, &it.Settings,
		&body, &bodyNonce, &auth, &authNonce, &docs, &docsNonce,
		&pre, &preNonce, &test, &testNonce, &comp, &compNonce,
		&it.CreatedAt, &it.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("vault: no existe la petición %q", id)
	}
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo la petición: %w", err)
	}
	it.Body = s.decryptOptional(body, bodyNonce)
	it.Auth = s.decryptOptional(auth, authNonce)
	it.Docs = s.decryptOptional(docs, docsNonce)
	it.PreRequest = s.decryptOptional(pre, preNonce)
	it.TestScript = s.decryptOptional(test, testNonce)
	it.Computed = s.decryptOptional(comp, compNonce)
	return &it, nil
}

// HTTPAuthLevel es un eslabón de la cadena de herencia, con SU IDENTIDAD.
//
// Se devuelve el id y no solo el JSON porque hay un caso que necesita
// escribir de vuelta: cuando OAuth 2.0 renueva un token vencido, el token
// nuevo tiene que guardarse en el mismo nivel donde estaba configurada la
// autenticación. Sin saber cuál fue, la única alternativa sería adivinar.
type HTTPAuthLevel struct {
	// ItemID vacío significa que este eslabón es la colección.
	ItemID       string
	CollectionID string
	Auth         string
}

// HTTPAuthChain devuelve la cadena de autenticación de un ítem, de la más
// específica a la más general: la petición, sus carpetas de adentro hacia
// afuera, y por último la colección.
//
// Se arma acá y no en la capa de arriba porque es una consulta de árbol: la
// alternativa era que el binding pidiera el ítem, después su padre, después
// el padre del padre… una llamada por nivel para algo que sale de una sola
// lectura de la colección.
func (s *Store) HTTPAuthChain(itemID string) ([]HTTPAuthLevel, error) {
	it, err := s.GetHTTPItem(itemID)
	if err != nil {
		return nil, err
	}

	items, err := s.ListHTTPItems(it.CollectionID)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]HTTPItem, len(items))
	for _, i := range items {
		byID[i.ID] = i
	}

	chain := []HTTPAuthLevel{{ItemID: it.ID, CollectionID: it.CollectionID, Auth: it.Auth}}
	// Tope de profundidad: un parent_id corrupto que apunte a un ancestro
	// haría un ciclo, y un bucle infinito acá cuelga la aplicación entera.
	parent := it.ParentID
	for depth := 0; parent != "" && depth < 64; depth++ {
		p, ok := byID[parent]
		if !ok {
			break
		}
		chain = append(chain, HTTPAuthLevel{ItemID: p.ID, CollectionID: p.CollectionID, Auth: p.Auth})
		parent = p.ParentID
	}

	cols, err := s.ListHTTPCollections()
	if err == nil {
		for _, c := range cols {
			if c.ID == it.CollectionID {
				chain = append(chain, HTTPAuthLevel{CollectionID: c.ID, Auth: c.Auth})
				break
			}
		}
	}
	return chain, nil
}

// SaveHTTPAuthAt escribe la autenticación en el nivel indicado, sin tocar
// nada más de esa fila.
//
// Un UPDATE de una sola columna y no un guardado completo: el nivel puede
// ser una petición que el usuario está editando en otra pestaña, y
// reescribirla entera con lo que había en disco le borraría los cambios.
func (s *Store) SaveHTTPAuthAt(level HTTPAuthLevel, authJSON string) error {
	enc, nonce, err := s.encryptOptional(authJSON)
	if err != nil {
		return err
	}
	now := time.Now().Unix()

	if level.ItemID != "" {
		_, err = s.db.Exec(`UPDATE http_items SET auth = ?, auth_nonce = ?, updated_at = ? WHERE id = ?`,
			enc, nonce, now, level.ItemID)
	} else {
		_, err = s.db.Exec(`UPDATE http_collections SET auth = ?, auth_nonce = ?, updated_at = ? WHERE id = ?`,
			enc, nonce, now, level.CollectionID)
	}
	if err != nil {
		return fmt.Errorf("vault: guardando la autenticación: %w", err)
	}
	return nil
}

// DeleteHTTPItem borra un ítem y, si es carpeta, todo su subárbol.
//
// El descenso se hace en Go y no con un CTE recursivo de SQLite por una
// razón de legibilidad más que de capacidad: son árboles de decenas de
// nodos, y una consulta recursiva acá sería más difícil de auditar que un
// bucle explícito.
func (s *Store) DeleteHTTPItem(id string) error {
	all, err := s.itemParents(id)
	if err != nil {
		return err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: borrando ítem: %w", err)
	}
	defer tx.Rollback()

	for _, victim := range all {
		if _, err := tx.Exec(`DELETE FROM http_history WHERE item_id = ?`, victim); err != nil {
			return fmt.Errorf("vault: borrando historial del ítem: %w", err)
		}
		if _, err := tx.Exec(`DELETE FROM http_items WHERE id = ?`, victim); err != nil {
			return fmt.Errorf("vault: borrando ítem: %w", err)
		}
	}
	return tx.Commit()
}

// itemParents devuelve el id dado más el de todos sus descendientes.
func (s *Store) itemParents(id string) ([]string, error) {
	var collectionID string
	if err := s.db.QueryRow(`SELECT collection_id FROM http_items WHERE id = ?`, id).Scan(&collectionID); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("vault: no existe el ítem %q", id)
		}
		return nil, fmt.Errorf("vault: leyendo el ítem: %w", err)
	}

	rows, err := s.db.Query(`SELECT id, COALESCE(parent_id, '') FROM http_items WHERE collection_id = ?`, collectionID)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo el árbol: %w", err)
	}
	defer rows.Close()

	children := map[string][]string{}
	for rows.Next() {
		var kid, parent string
		if err := rows.Scan(&kid, &parent); err != nil {
			return nil, err
		}
		children[parent] = append(children[parent], kid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []string{}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		out = append(out, cur)
		stack = append(stack, children[cur]...)
	}
	return out, nil
}

// MoveHTTPItem reubica un ítem: nuevo padre y nuevo orden entre hermanos.
//
// order es la posición deseada; los hermanos se renumeran de cero para que
// no queden huecos ni empates después de varios movimientos.
func (s *Store) MoveHTTPItem(id, newParentID string, order int) error {
	var collectionID, kind string
	if err := s.db.QueryRow(`SELECT collection_id, kind FROM http_items WHERE id = ?`, id).Scan(&collectionID, &kind); err != nil {
		return fmt.Errorf("vault: moviendo ítem: %w", err)
	}

	// Una carpeta no puede caer adentro de sí misma ni de su propio
	// subárbol: eso desconecta la rama del árbol y la vuelve inalcanzable
	// desde la barra lateral, sin ningún error visible.
	if newParentID != "" {
		descendants, err := s.itemParents(id)
		if err != nil {
			return err
		}
		for _, d := range descendants {
			if d == newParentID {
				return fmt.Errorf("vault: no se puede mover una carpeta adentro de sí misma")
			}
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: moviendo ítem: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE http_items SET parent_id = ?, updated_at = ? WHERE id = ?`,
		nullable(newParentID), time.Now().Unix(), id); err != nil {
		return fmt.Errorf("vault: moviendo ítem: %w", err)
	}

	rows, err := tx.Query(
		`SELECT id FROM http_items WHERE collection_id = ? AND COALESCE(parent_id, '') = ? AND id <> ?
		 ORDER BY sort_order, name`, collectionID, newParentID, id)
	if err != nil {
		return fmt.Errorf("vault: reordenando hermanos: %w", err)
	}
	siblings := []string{}
	for rows.Next() {
		var sib string
		if err := rows.Scan(&sib); err != nil {
			rows.Close()
			return err
		}
		siblings = append(siblings, sib)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	if order < 0 {
		order = 0
	}
	if order > len(siblings) {
		order = len(siblings)
	}
	ordered := append(append(append([]string{}, siblings[:order]...), id), siblings[order:]...)
	for i, sib := range ordered {
		if _, err := tx.Exec(`UPDATE http_items SET sort_order = ? WHERE id = ?`, i, sib); err != nil {
			return fmt.Errorf("vault: reordenando hermanos: %w", err)
		}
	}
	return tx.Commit()
}

// --- Historial ---------------------------------------------------------------

// AddHTTPHistory registra una ejecución y poda las viejas de esa petición.
//
// El tope es por ítem y no global: quien depura una petición la corre veinte
// veces seguidas, y un tope global le borraría el historial de todas las
// demás.
//
// Las peticiones rápidas —las que se mandan sin guardarlas en ninguna
// colección— comparten un único cajón (`item_id` NULL) y se podan igual. Antes
// se salteaban la poda, y como nada las borra, era la única forma de que esta
// tabla creciera sin techo.
func (s *Store) AddHTTPHistory(e HTTPHistoryEntry) error {
	id, err := newID()
	if err != nil {
		return err
	}
	if e.ExecutedAt == 0 {
		e.ExecutedAt = time.Now().Unix()
	}
	if _, err := s.db.Exec(
		`INSERT INTO http_history (id, item_id, method, url, status, duration_ms, size_bytes, error, executed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, nullable(e.ItemID), e.Method, e.URL, e.Status, e.DurationMs, e.SizeBytes, e.Error, e.ExecutedAt,
	); err != nil {
		return fmt.Errorf("vault: guardando el historial: %w", err)
	}

	// El desempate por rowid NO es adorno: `executed_at` está en segundos, y
	// quien depura una petición la manda cinco veces en el mismo segundo. Con
	// el orden ambiguo, la poda se quedaba con las cincuenta MÁS VIEJAS y
	// borraba justo la que se acababa de mandar.
	if _, err := s.db.Exec(
		`DELETE FROM http_history WHERE COALESCE(item_id, '') = ? AND id NOT IN (
			SELECT id FROM http_history WHERE COALESCE(item_id, '') = ?
			ORDER BY executed_at DESC, rowid DESC LIMIT ?
		)`, e.ItemID, e.ItemID, httpHistoryPerItem,
	); err != nil {
		return fmt.Errorf("vault: podando el historial: %w", err)
	}
	return nil
}

func (s *Store) ListHTTPHistory(itemID string) ([]HTTPHistoryEntry, error) {
	rows, err := s.db.Query(
		`SELECT id, COALESCE(item_id, ''), method, url, status, duration_ms, size_bytes, error, executed_at
		 FROM http_history WHERE COALESCE(item_id, '') = ?
		 ORDER BY executed_at DESC, rowid DESC LIMIT ?`,
		itemID, httpHistoryPerItem)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo el historial: %w", err)
	}
	defer rows.Close()

	out := []HTTPHistoryEntry{}
	for rows.Next() {
		var e HTTPHistoryEntry
		if err := rows.Scan(&e.ID, &e.ItemID, &e.Method, &e.URL, &e.Status,
			&e.DurationMs, &e.SizeBytes, &e.Error, &e.ExecutedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo el historial: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) ClearHTTPHistory(itemID string) error {
	if _, err := s.db.Exec(`DELETE FROM http_history WHERE COALESCE(item_id, '') = ?`, itemID); err != nil {
		return fmt.Errorf("vault: limpiando el historial: %w", err)
	}
	return nil
}

// nullable convierte "" en NULL. El resto del paquete usa "" para "sin
// valor" en Go, pero la columna tiene que quedar NULL para que los índices y
// los COALESCE de arriba se comporten.
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// --- Entornos ----------------------------------------------------------------

// HTTPEnvironment es un conjunto de variables transversal a las colecciones:
// el mismo "prod" se usa desde varias, que es lo que lo distingue de las
// variables de una colección.
type HTTPEnvironment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Variables viaja como texto JSON, cifrado: adentro van las marcadas
	// como secretas. Este paquete no lo interpreta — quien lo entiende es
	// backend/httpclient.
	Variables string `json:"variables,omitempty"`
	// PinnedCollectionID hace que abrir una petición de esa colección
	// seleccione este entorno solo ("Pin an environment to automatically
	// switch to it when working with this collection").
	PinnedCollectionID string `json:"pinnedCollectionId,omitempty"`
	SortOrder          int    `json:"sortOrder"`
	CreatedAt          int64  `json:"createdAt"`
	UpdatedAt          int64  `json:"updatedAt"`
}

// SaveHTTPEnvironment crea o actualiza. ID vacío = alta.
func (s *Store) SaveHTTPEnvironment(e HTTPEnvironment) (*HTTPEnvironment, error) {
	name := strings.TrimSpace(e.Name)
	if name == "" {
		return nil, fmt.Errorf("vault: el entorno necesita un nombre")
	}
	e.Name = name
	now := time.Now().Unix()

	vars, varsNonce, err := s.encryptOptional(e.Variables)
	if err != nil {
		return nil, err
	}

	// Un solo entorno puede estar anclado a una colección: dos anclados a la
	// misma harían que "cambiar solo" dependiera del orden de lectura, o sea
	// que a veces elegiría uno y a veces el otro.
	clearPin := func(exec func(string, ...any) (sql.Result, error)) error {
		if e.PinnedCollectionID == "" {
			return nil
		}
		_, err := exec(`UPDATE http_environments SET pinned_collection_id = NULL WHERE pinned_collection_id = ? AND id <> ?`,
			e.PinnedCollectionID, e.ID)
		return err
	}

	if e.ID == "" {
		id, err := newID()
		if err != nil {
			return nil, err
		}
		var nextOrder int
		if err := s.db.QueryRow(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM http_environments`).Scan(&nextOrder); err != nil {
			return nil, fmt.Errorf("vault: calculando orden del entorno: %w", err)
		}
		e.ID, e.SortOrder, e.CreatedAt, e.UpdatedAt = id, nextOrder, now, now
		if err := clearPin(s.db.Exec); err != nil {
			return nil, fmt.Errorf("vault: liberando el anclaje anterior: %w", err)
		}
		if _, err := s.db.Exec(
			`INSERT INTO http_environments (id, name, variables, variables_nonce, pinned_collection_id, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			e.ID, e.Name, vars, varsNonce, nullable(e.PinnedCollectionID), e.SortOrder, now, now,
		); err != nil {
			return nil, fmt.Errorf("vault: creando el entorno: %w", err)
		}
		return &e, nil
	}

	e.UpdatedAt = now
	if err := clearPin(s.db.Exec); err != nil {
		return nil, fmt.Errorf("vault: liberando el anclaje anterior: %w", err)
	}
	if _, err := s.db.Exec(
		`UPDATE http_environments SET name = ?, variables = ?, variables_nonce = ?,
			pinned_collection_id = ?, updated_at = ? WHERE id = ?`,
		e.Name, vars, varsNonce, nullable(e.PinnedCollectionID), now, e.ID,
	); err != nil {
		return nil, fmt.Errorf("vault: guardando el entorno: %w", err)
	}
	return &e, nil
}

func (s *Store) ListHTTPEnvironments() ([]HTTPEnvironment, error) {
	rows, err := s.db.Query(`SELECT id, name, variables, variables_nonce,
		COALESCE(pinned_collection_id, ''), sort_order, created_at, updated_at
		FROM http_environments ORDER BY sort_order, name`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando entornos: %w", err)
	}
	defer rows.Close()

	out := []HTTPEnvironment{}
	for rows.Next() {
		var e HTTPEnvironment
		var vars, varsNonce []byte
		if err := rows.Scan(&e.ID, &e.Name, &vars, &varsNonce,
			&e.PinnedCollectionID, &e.SortOrder, &e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo entorno: %w", err)
		}
		e.Variables = s.decryptOptional(vars, varsNonce)
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeleteHTTPEnvironment borra un entorno y, si era el activo, deja la
// selección vacía — un id activo apuntando a algo que ya no existe haría que
// las peticiones se envíen sin variables sin decir por qué.
func (s *Store) DeleteHTTPEnvironment(id string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: borrando entorno: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM http_environments WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando entorno: %w", err)
	}
	if _, err := tx.Exec(`UPDATE settings SET http_active_env = '' WHERE id = 1 AND http_active_env = ?`, id); err != nil {
		return fmt.Errorf("vault: limpiando el entorno activo: %w", err)
	}
	return tx.Commit()
}

// ActiveHTTPEnvironment devuelve el id del entorno activo, o "" si no hay.
func (s *Store) ActiveHTTPEnvironment() (string, error) {
	var id string
	if err := s.db.QueryRow(`SELECT http_active_env FROM settings WHERE id = 1`).Scan(&id); err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("vault: leyendo el entorno activo: %w", err)
	}
	return id, nil
}

func (s *Store) SetActiveHTTPEnvironment(id string) error {
	if _, err := s.db.Exec(`UPDATE settings SET http_active_env = ? WHERE id = 1`, id); err != nil {
		return fmt.Errorf("vault: guardando el entorno activo: %w", err)
	}
	return nil
}

// --- Crudo de Postman (preservación para el round-trip) ----------------------

// Las columnas postman_raw guardan el JSON original de cada ítem y de la
// colección, para poder devolverlo intacto al exportar.
//
// Se leen y escriben aparte del CRUD normal a propósito: solo las tocan el
// import y el export, y meterlas en SaveHTTPItem obligaría a que cada
// guardado desde el editor arrastre —y pueda pisar— un dato que no está
// editando.

func (s *Store) SaveHTTPItemRaw(id, raw string) error {
	enc, nonce, err := s.encryptOptional(raw)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`UPDATE http_items SET postman_raw = ?, postman_raw_nonce = ? WHERE id = ?`, enc, nonce, id); err != nil {
		return fmt.Errorf("vault: guardando el original de la petición: %w", err)
	}
	return nil
}

func (s *Store) HTTPItemRaw(id string) (string, error) {
	var enc, nonce []byte
	if err := s.db.QueryRow(`SELECT postman_raw, postman_raw_nonce FROM http_items WHERE id = ?`, id).Scan(&enc, &nonce); err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("vault: leyendo el original de la petición: %w", err)
	}
	return s.decryptOptional(enc, nonce), nil
}

// SetHTTPCollectionNote vincula (o desvincula, con noteID vacío) la nota donde
// vive la documentación de la colección.
//
// Aparte del guardado normal a propósito: el editor de la colección no manda
// este campo, y si formara parte del UPDATE de `SaveHTTPCollection` cualquier
// guardado hecho con una colección leída antes de publicar la documentación la
// desvincularía en silencio.
func (s *Store) SetHTTPCollectionNote(id, noteID string) error {
	if _, err := s.db.Exec(`UPDATE http_collections SET docs_note_id = ? WHERE id = ?`, noteID, id); err != nil {
		return fmt.Errorf("vault: vinculando la nota de documentación: %w", err)
	}
	return nil
}

func (s *Store) SaveHTTPCollectionRaw(id, raw string) error {
	enc, nonce, err := s.encryptOptional(raw)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`UPDATE http_collections SET postman_raw = ?, postman_raw_nonce = ? WHERE id = ?`, enc, nonce, id); err != nil {
		return fmt.Errorf("vault: guardando el original de la colección: %w", err)
	}
	return nil
}

func (s *Store) HTTPCollectionRaw(id string) (string, error) {
	var enc, nonce []byte
	if err := s.db.QueryRow(`SELECT postman_raw, postman_raw_nonce FROM http_collections WHERE id = ?`, id).Scan(&enc, &nonce); err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", fmt.Errorf("vault: leyendo el original de la colección: %w", err)
	}
	return s.decryptOptional(enc, nonce), nil
}
