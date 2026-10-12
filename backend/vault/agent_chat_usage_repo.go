package vault

import (
	"mini-tools/backend/i18n"
)

// Consumo de los servidores de modelos, leído del historial de chats.
//
// Un CLI deja sus tokens en transcripts que el propio CLI escribe; un
// servidor de modelos no deja nada, pero cada turno ya guarda su uso en
// agent_chat_messages.usage (JSON de agentchat.Usage; a partir de esta
// versión con `model` y `durationMs`, ver App.usageJSON). Esto lo lee SIN
// descifrar nada: el contenido de los mensajes (content/nonce) ni se
// selecciona.

// ChatUsageRow es el uso de UN turno guardado.
type ChatUsageRow struct {
	// AgentID es el proveedor que atendió el turno (`llm:<id>`): el que quedó
	// en el usage de la fila y, en las filas anteriores a esa clave, el agente
	// que tiene el chat ahora.
	AgentID string
	ChatID  string
	// CreatedAt son segundos Unix.
	CreatedAt int64
	// Model es "" en los turnos anteriores a que se guardara el modelo.
	Model  string
	Input  int64
	Output int64
	Total  int64
	// CacheRead y CacheWrite son la parte de Input que salió de la caché del
	// prompt o se escribió en ella (Anthropic); 0 en el resto.
	CacheRead  int64
	CacheWrite int64
	// DurationMs es lo que el servidor tardó en generar; 0 = no se sabe.
	DurationMs int64
}

// ModelServerUsageRows devuelve el uso de cada turno de los chats con un
// servidor de modelos desde `since` (segundos Unix), sin acotar por servidor:
// agrupar es trabajo de quien arma el informe, que también sabe qué
// servidores siguen existiendo.
//
// El plan recorre agent_chats (una fila por conversación, tabla chica) y entra
// a los mensajes por idx_agent_chat_messages_chat; filtrar por `usage <> ”`
// deja solo la fila que cierra cada turno. El proveedor sale del propio turno
// (`$.agentId`) y solo cae al del chat si la fila no lo trae: un chat puede
// cambiar de proveedor y su consumo anterior no se mueve con él. `json_valid` protege de una fila
// con JSON dañado: sin él, un solo `json_extract` malformado haría fallar el
// informe entero.
func (s *Store) ModelServerUsageRows(since int64) ([]ChatUsageRow, error) {
	rows, err := s.db.Query(
		`SELECT COALESCE(NULLIF(json_extract(m.usage, '$.agentId'), ''), c.agent_id), m.chat_id, m.created_at,
		        COALESCE(json_extract(m.usage, '$.model'), ''),
		        COALESCE(json_extract(m.usage, '$.input'), 0),
		        COALESCE(json_extract(m.usage, '$.output'), 0),
		        COALESCE(json_extract(m.usage, '$.total'), 0),
		        COALESCE(json_extract(m.usage, '$.cacheRead'), 0),
		        COALESCE(json_extract(m.usage, '$.cacheWrite'), 0),
		        COALESCE(json_extract(m.usage, '$.durationMs'), 0)
		 FROM agent_chats c
		 JOIN agent_chat_messages m ON m.chat_id = c.id
		 WHERE c.agent_id LIKE 'llm:%' AND m.usage <> '' AND m.created_at >= ? AND json_valid(m.usage)`, since)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo el consumo de los servidores de modelos: %w", EN: "vault: reading the model servers usage: %w"}, err)
	}
	defer rows.Close()
	out := []ChatUsageRow{}
	for rows.Next() {
		var r ChatUsageRow
		if err := rows.Scan(&r.AgentID, &r.ChatID, &r.CreatedAt, &r.Model, &r.Input, &r.Output, &r.Total, &r.CacheRead, &r.CacheWrite, &r.DurationMs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
