package vault

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
)

// Configuración por agente de código (backend/agents): con qué comando se
// abre y, opcionalmente, una API key.
//
// La vía normal de Claude Code, Codex y Gemini CLI es su PROPIO login, que
// guarda sus credenciales donde cada uno decida — esta app no las toca. La
// key de acá existe solo para quien prefiere autenticarse por variable de
// entorno, y se guarda con el mismo cifrado que un DSN o una llave SSH.

// AgentConfig es lo que el frontend puede ver de la configuración de un
// agente. La key NUNCA forma parte: igual que SSHKeySummary con el material
// de la llave, solo viaja el hecho de que exista.
type AgentConfig struct {
	AgentID string `json:"agentId"`
	Command string `json:"command"`
	HasKey  bool   `json:"hasKey"`
}

// ListAgentConfigs devuelve las filas guardadas, indexadas por agente. Un
// agente sin fila simplemente no aparece: el catálogo aporta los defaults.
func (s *Store) ListAgentConfigs() (map[string]AgentConfig, error) {
	rows, err := s.db.Query(`SELECT agent_id, command, encrypted_key IS NOT NULL FROM agent_configs`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando configuración de agentes: %w", err)
	}
	defer rows.Close()

	out := map[string]AgentConfig{}
	for rows.Next() {
		var c AgentConfig
		if err := rows.Scan(&c.AgentID, &c.Command, &c.HasKey); err != nil {
			return nil, fmt.Errorf("vault: leyendo configuración de agente: %w", err)
		}
		out[c.AgentID] = c
	}
	return out, rows.Err()
}

// SetAgentCommand guarda con qué comando se abre un agente. Un comando vacío
// borra el override y devuelve el default del catálogo, en vez de guardar la
// cadena vacía como si fuera una elección.
func (s *Store) SetAgentCommand(agentID, command string) error {
	if strings.TrimSpace(agentID) == "" {
		return fmt.Errorf("vault: falta el id del agente")
	}
	command = strings.TrimSpace(command)
	if _, err := s.db.Exec(`
		INSERT INTO agent_configs (agent_id, command, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET command = excluded.command, updated_at = excluded.updated_at
	`, agentID, command, time.Now().Unix()); err != nil {
		return fmt.Errorf("vault: guardando el comando del agente: %w", err)
	}
	return nil
}

// SetAgentKey cifra y guarda la API key de un agente bajo la clave maestra.
func (s *Store) SetAgentKey(agentID, apiKey string) error {
	if strings.TrimSpace(agentID) == "" {
		return fmt.Errorf("vault: falta el id del agente")
	}
	if strings.TrimSpace(apiKey) == "" {
		return fmt.Errorf("vault: la API key está vacía")
	}

	key, err := s.gate.Key()
	if err != nil {
		return err
	}
	ciphertext, nonce, err := mtcrypto.Encrypt(key, []byte(apiKey))
	if err != nil {
		return fmt.Errorf("vault: cifrando la API key: %w", err)
	}

	if _, err := s.db.Exec(`
		INSERT INTO agent_configs (agent_id, command, encrypted_key, key_nonce, updated_at) VALUES (?, '', ?, ?, ?)
		ON CONFLICT(agent_id) DO UPDATE SET encrypted_key = excluded.encrypted_key, key_nonce = excluded.key_nonce, updated_at = excluded.updated_at
	`, agentID, ciphertext, nonce, time.Now().Unix()); err != nil {
		return fmt.Errorf("vault: guardando la API key del agente: %w", err)
	}
	return nil
}

// ClearAgentKey borra la key guardada, dejando el resto de la configuración
// (el comando) intacto — son dos ajustes independientes y borrar uno no debe
// arrastrar al otro.
func (s *Store) ClearAgentKey(agentID string) error {
	if _, err := s.db.Exec(
		`UPDATE agent_configs SET encrypted_key = NULL, key_nonce = NULL, updated_at = ? WHERE agent_id = ?`,
		time.Now().Unix(), agentID,
	); err != nil {
		return fmt.Errorf("vault: borrando la API key del agente: %w", err)
	}
	return nil
}

// AgentKey descifra la API key guardada. Devuelve "" sin error cuando no hay
// ninguna: no tenerla es el caso NORMAL (el agente usa su propio login), no
// una condición de error.
//
// Sin binding: lo llama únicamente app.go para armar el entorno de la sesión.
// La key nunca cruza hacia el frontend, misma regla que el DSN.
func (s *Store) AgentKey(agentID string) (string, error) {
	var ciphertext, nonce []byte
	err := s.db.QueryRow(
		`SELECT encrypted_key, key_nonce FROM agent_configs WHERE agent_id = ?`, agentID,
	).Scan(&ciphertext, &nonce)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("vault: leyendo la API key del agente: %w", err)
	}
	if len(ciphertext) == 0 || len(nonce) == 0 {
		return "", nil
	}

	key, err := s.gate.Key()
	if err != nil {
		return "", err
	}
	plaintext, err := mtcrypto.Decrypt(key, ciphertext, nonce)
	if err != nil {
		return "", fmt.Errorf("vault: descifrando la API key del agente: %w", err)
	}
	return string(plaintext), nil
}
