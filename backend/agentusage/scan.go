package agentusage

import (
	"os"
	"time"
)

// DefaultDays es la ventana que se lee. Treinta días es lo que hace
// comparable un total —"esto es un mes de trabajo"— sin tener que recorrer
// historiales de años en cada apertura del panel.
const DefaultDays = 30

// Scan devuelve el consumo de cada agente del catálogo.
//
// No falla: un agente sin datos vuelve con Available=false y una nota que
// explica por qué, que es más útil que un cero sin contexto o que un error.
func Scan(repoRoot string, days int) Usage {
	if days <= 0 {
		days = DefaultDays
	}
	since := time.Now().AddDate(0, 0, -days)

	u := Usage{Days: days, Agents: []AgentUsage{}}

	home, err := os.UserHomeDir()
	if err != nil {
		return u
	}

	u.Agents = append(u.Agents, readClaude(home, claudeSlug(repoRoot), since))
	// Codex tiene lector propio desde que se pudo instalar y mirar su base
	// real: informa un total por conversación en state_*.sqlite, ya agregado
	// por él mismo — ver el encabezado de codex.go.
	u.Agents = append(u.Agents, readCodex(home, repoRoot, since))
	// Antigravity tiene lector propio: no deja tokens en el disco, pero sí
	// actividad — ver el encabezado de antigravity.go para lo que se comprobó.
	u.Agents = append(u.Agents, readAntigravity(home, repoRoot))
	return u
}
