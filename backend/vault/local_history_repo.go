package vault

import (
	"fmt"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
)

// Historial de comandos de las terminales LOCALES (la shell del sistema
// operativo abierta dentro de la app).
//
// Es el hermano de ssh_history_repo.go y comparte con él las tres capas que
// hacen aceptable guardar líneas de comando: se descartan las que parecen traer
// una credencial (`LooksLikeSecret`, definido allá y reusado acá — un solo
// filtro, para que las dos terminales tengan exactamente el mismo criterio), lo
// que se guarda va cifrado bajo la clave maestra, y se puede apagar y borrar.
//
// Lo único que cambia es POR QUÉ SE AGRUPA. El historial de una terminal SSH es
// de un servidor; el de una terminal local es del INTÉRPRETE que se está
// usando, porque los comandos de PowerShell no significan nada en zsh y
// mezclarlos convertiría las sugerencias en ruido.

// AppendLocalHistory guarda un comando ejecutado en una terminal local.
// Devuelve (false, nil) cuando la línea se descartó por parecer traer un
// secreto: no es un error — el comando se ejecutó igual, solo no se registra.
func (s *Store) AppendLocalHistory(shellID, command string) (bool, error) {
	command = strings.TrimSpace(command)
	if shellID == "" || command == "" {
		return false, nil
	}
	if LooksLikeSecret(command) {
		return false, nil
	}
	// Mismo tope que el historial SSH: una línea larguísima es casi siempre un
	// pegado accidental, no un comando que alguien vaya a querer repetir.
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
		`INSERT INTO local_command_history (shell_id, encrypted_cmd, nonce, ran_at) VALUES (?, ?, ?, ?)`,
		shellID, ciphertext, nonce, time.Now().Unix(),
	); err != nil {
		return false, fmt.Errorf("vault: guardando el comando: %w", err)
	}
	return true, nil
}

// ListLocalHistory devuelve los últimos comandos de un intérprete, del más
// reciente al más viejo. Se reusa SshHistoryEntry a propósito: es la misma
// forma y el panel que los muestra es el mismo, así que un tipo espejo solo
// obligaría a convertir de uno a otro en el medio.
func (s *Store) ListLocalHistory(shellID string, limit int) ([]SshHistoryEntry, error) {
	if limit <= 0 {
		limit = 500
	}
	key, err := s.gate.Key()
	if err != nil {
		return nil, err
	}

	rows, err := s.db.Query(
		`SELECT id, encrypted_cmd, nonce, ran_at FROM local_command_history
		 WHERE shell_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?`,
		shellID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo el historial local: %w", err)
	}
	defer rows.Close()

	out := []SshHistoryEntry{}
	for rows.Next() {
		var e SshHistoryEntry
		var ciphertext, nonce []byte
		if err := rows.Scan(&e.ID, &ciphertext, &nonce, &e.RanAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo una fila del historial local: %w", err)
		}
		plaintext, err := mtcrypto.Decrypt(key, ciphertext, nonce)
		if err != nil {
			// Una fila que no descifra (vault restaurado con otra clave
			// maestra) se saltea, igual que en el historial SSH: el resto de la
			// lista sigue siendo legible.
			continue
		}
		e.Command = string(plaintext)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ClearLocalHistory borra el historial de un intérprete y devuelve cuántas
// filas se borraron, para poder confirmarlo con un número.
func (s *Store) ClearLocalHistory(shellID string) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM local_command_history WHERE shell_id = ?`, shellID)
	if err != nil {
		return 0, fmt.Errorf("vault: limpiando el historial local: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
