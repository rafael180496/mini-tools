package vault

import (
	"strings"

	"mini-tools/backend/i18n"
)

// Cerebro (migración 59): la carpeta raíz bajo la que un agente deja notas por
// su cuenta y la bandera por conversación que lo habilita.

// DefaultBrainRoot es la carpeta raíz del cerebro mientras nadie elija otra.
const DefaultBrainRoot = "Cerebro"

// BrainRoot devuelve la carpeta raíz del cerebro (una ruta de carpetas de
// notas, p. ej. "Cerebro" o "Notas/Cerebro").
func (s *Store) BrainRoot() (string, error) {
	var root string
	if err := s.db.QueryRow(`SELECT brain_root FROM settings WHERE id = 1`).Scan(&root); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: leyendo brain_root: %w", EN: "vault: reading brain_root: %w"}, err)
	}
	if strings.TrimSpace(root) == "" {
		return DefaultBrainRoot, nil
	}
	return root, nil
}

// SetBrainRoot guarda la carpeta raíz del cerebro. Vacío vuelve al default.
//
// Se valida como ruta de carpeta (sin segmentos vacíos ni «..», ver
// ParseFolderPath) y se guarda canónica —segmentos recortados, separados por
// «/»—: el agente la usa tal cual para armar rutas, y una barra de más o un
// espacio al final se convertiría en una carpeta distinta.
func (s *Store) SetBrainRoot(root string) error {
	canonical := DefaultBrainRoot
	if strings.TrimSpace(root) != "" {
		segs, err := ParseFolderPath(root)
		if err != nil {
			return err
		}
		canonical = strings.Join(segs, "/")
	}
	if _, err := s.db.Exec(`UPDATE settings SET brain_root = ? WHERE id = 1`, canonical); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando brain_root: %w", EN: "vault: saving brain_root: %w"}, err)
	}
	return nil
}

// SetAgentChatBrain enciende o apaga el cerebro de una conversación. Falla si
// la fila no existe: encender algo en un chat que no está guardado no se
// recordaría, y devolver éxito mentiría.
//
// No toca updated_at: encender el control no es actividad de la conversación y
// la subiría en el historial sin que se haya dicho nada.
func (s *Store) SetAgentChatBrain(id string, enabled bool) error {
	v := 0
	if enabled {
		v = 1
	}
	res, err := s.db.Exec(`UPDATE agent_chats SET brain = ? WHERE id = ?`, v, id)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando el cerebro del chat: %w", EN: "vault: saving the chat's brain flag: %w"}, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return i18n.Errorf(i18n.Msg{ES: "vault: no existe el chat %q", EN: "vault: chat %q does not exist"}, id)
	}
	return nil
}

// AgentChatBrain dice si esa conversación tiene el cerebro encendido. Una
// conversación inexistente es false: sin fila no hay nada que habilitar.
func (s *Store) AgentChatBrain(id string) bool {
	var v int
	if err := s.db.QueryRow(`SELECT brain FROM agent_chats WHERE id = ?`, id).Scan(&v); err != nil {
		return false
	}
	return v != 0
}
