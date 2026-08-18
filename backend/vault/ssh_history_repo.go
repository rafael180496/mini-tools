package vault

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
)

// Historial de comandos ejecutados en las terminales SSH.
//
// Hasta la migración 29 este historial existía solo en memoria, por sesión, y
// se perdía al cerrar la pestaña (ver frontend/src/lib/sshLineModel.ts): la
// razón era que una línea de comando puede llevar un secreto adentro. Guardarlo
// es una función pedida, así que lo que cambia no es esa preocupación sino cómo
// se la atiende — tres capas:
//
//  1. Las líneas que parecen traer una credencial no se guardan (secretPattern).
//  2. Lo que sí se guarda va cifrado bajo la clave maestra, como un DSN.
//  3. Se puede apagar el registro y se puede borrar lo guardado, por conexión o
//     entero, desde la propia terminal.

// SshHistoryEntry es un comando ejecutado, ya descifrado.
type SshHistoryEntry struct {
	ID      int64  `json:"id"`
	Command string `json:"command"`
	RanAt   int64  `json:"ranAt"`
}

// secretPattern reconoce las formas en que una credencial termina escrita en
// una línea de comando. Es deliberadamente amplio y de coincidencia barata: el
// costo de un falso positivo es un comando que no queda en el historial (se
// vuelve a escribir), y el de un falso negativo es una contraseña guardada en
// disco. No son comparables, así que ante la duda no se guarda.
//
// No pretende ser exhaustivo — no puede serlo, cualquier programa puede recibir
// un secreto por argumento con un nombre que nadie previó. Por eso lo de abajo
// es un filtro, no una garantía, y lo que pasa igual queda cifrado.
var secretPattern = regexp.MustCompile(`(?i)` + strings.Join([]string{
	// mysql -pSECRETO (pegado, que es el caso peligroso). La `-p` va en
	// MINÚSCULA obligatoria —de ahí el (?-i:…) contra el (?i) general— porque
	// en PowerShell casi todo parámetro empieza con mayúscula: sin esto,
	// `Get-Process`, `-Path` o `-Property` se leían como una contraseña
	// pegada y la terminal local de Windows no guardaba prácticamente nada.
	// El `(^|\s)` es lo que exige que la bandera EMPIECE un token: sin él,
	// cualquier palabra con un guion en el medio ("top-priority", "no-push")
	// se leía como una contraseña pegada.
	`(^|\s)(?-i:-p)\S`,
	`--password`,                 // --password=… / --password …
	`\bsshpass\b`,                // sshpass -p …
	`(pass|passwd|password)\s*=`, // PASSWORD=… en cualquier variante
	`(token|secret|api[_-]?key|apikey)\s*=`,
	// curl -u usuario:clave. El `\b` de antes NUNCA casaba: un límite de
	// palabra entre un espacio y un guion no existe (los dos son no-palabra),
	// así que esta regla estaba muerta desde que se escribió.
	`\bcurl\b.*(^|\s)-u\s`,
	`\bexport\s+\w*(KEY|TOKEN|SECRET|PASS)`,
	`AKIA[0-9A-Z]{16}`, // access key de AWS, reconocible por su forma
	`\bBEGIN\s+(RSA|OPENSSH|EC|DSA)?\s*PRIVATE KEY\b`,
}, "|"))

// LooksLikeSecret reporta si una línea no debería guardarse. Exportada para que
// la interfaz pueda explicar por qué un comando no aparece en el historial en
// vez de dejar al usuario pensando que se perdió.
func LooksLikeSecret(command string) bool {
	return secretPattern.MatchString(command)
}

// AppendSshHistory guarda un comando ejecutado. Devuelve (false, nil) cuando la
// línea se descartó por parecer traer un secreto: no es un error — el comando se
// ejecutó igual, solo no se registra.
func (s *Store) AppendSshHistory(connID, command string) (bool, error) {
	command = strings.TrimSpace(command)
	if connID == "" || command == "" {
		return false, nil
	}
	if LooksLikeSecret(command) {
		return false, nil
	}
	// Una línea larguísima es casi siempre un pegado accidental (un archivo
	// entero, una clave), no un comando que alguien vaya a querer repetir.
	if len(command) > 4000 {
		return false, nil
	}

	key, err := s.gate.Key()
	if err != nil {
		return false, err
	}
	ciphertext, nonce, err := mtcrypto.Encrypt(key, []byte(command))
	if err != nil {
		return false, fmt.Errorf("vault: cifrando el comando: %w", err)
	}

	if _, err := s.db.Exec(
		`INSERT INTO ssh_command_history (conn_id, encrypted_cmd, nonce, ran_at) VALUES (?, ?, ?, ?)`,
		connID, ciphertext, nonce, time.Now().Unix(),
	); err != nil {
		return false, fmt.Errorf("vault: guardando el comando: %w", err)
	}
	return true, nil
}

// ListSshHistory devuelve los últimos comandos de una conexión, del más
// reciente al más viejo. limit <= 0 usa un tope por defecto en vez de traer
// todo: el panel muestra una lista, no un archivo histórico completo.
func (s *Store) ListSshHistory(connID string, limit int) ([]SshHistoryEntry, error) {
	if limit <= 0 {
		limit = 500
	}
	key, err := s.gate.Key()
	if err != nil {
		return nil, err
	}

	rows, err := s.db.Query(
		`SELECT id, encrypted_cmd, nonce, ran_at FROM ssh_command_history
		 WHERE conn_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?`,
		connID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo el historial: %w", err)
	}
	defer rows.Close()

	out := []SshHistoryEntry{}
	for rows.Next() {
		var e SshHistoryEntry
		var ciphertext, nonce []byte
		if err := rows.Scan(&e.ID, &ciphertext, &nonce, &e.RanAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo una fila del historial: %w", err)
		}
		plaintext, err := mtcrypto.Decrypt(key, ciphertext, nonce)
		if err != nil {
			// Una fila que no descifra (vault restaurado de un backup con otra
			// clave maestra) se saltea en vez de tumbar la lista entera: el
			// resto del historial sigue siendo legible y útil.
			continue
		}
		e.Command = string(plaintext)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ClearSshHistory borra el historial de una conexión. Devuelve cuántas filas se
// borraron, para poder confirmárselo al usuario con un número en vez de con un
// "listo" que no dice si había algo.
func (s *Store) ClearSshHistory(connID string) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM ssh_command_history WHERE conn_id = ?`, connID)
	if err != nil {
		return 0, fmt.Errorf("vault: limpiando el historial: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ClearAllSshHistory borra el historial de TODAS las conexiones.
func (s *Store) ClearAllSshHistory() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM ssh_command_history`)
	if err != nil {
		return 0, fmt.Errorf("vault: limpiando todo el historial: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// SshHistoryEnabled reporta si se está registrando el historial.
func (s *Store) SshHistoryEnabled() (bool, error) {
	var enabled int
	if err := s.db.QueryRow(`SELECT ssh_history_enabled FROM settings WHERE id = 1`).Scan(&enabled); err != nil {
		return false, fmt.Errorf("vault: leyendo ssh_history_enabled: %w", err)
	}
	return enabled != 0, nil
}

// SetSshHistoryEnabled prende o apaga el registro. Apagarlo NO borra lo que ya
// hay — son dos decisiones distintas y juntarlas haría que quien solo quiere
// dejar de grabar pierda lo que ya tenía sin haberlo pedido.
func (s *Store) SetSshHistoryEnabled(enabled bool) error {
	v := 0
	if enabled {
		v = 1
	}
	if _, err := s.db.Exec(`UPDATE settings SET ssh_history_enabled = ? WHERE id = 1`, v); err != nil {
		return fmt.Errorf("vault: guardando ssh_history_enabled: %w", err)
	}
	return nil
}
