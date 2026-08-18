package agentlimits

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// claudeLimits lee el caché de utilización que deja Claude Code en
// `~/.claude.json`, bloque `cachedUsageUtilization`.
//
// Es exactamente lo que dibuja su propio `/usage`: el porcentaje de la ventana
// de 5 horas, el de la semana con todos los modelos y el de las semanas por
// modelo, cada uno con su reinicio. El número lo calculó el servidor de
// Anthropic; acá solo se lee, con la fecha en que se lo preguntó.
//
// **Se prefiere la lista `limits` sobre los campos sueltos.** `five_hour` y
// `seven_day` siguen ahí, pero la lista es la que trae también las ventanas por
// modelo y el estado de cada una, y es la que va creciendo cuando el proveedor
// agrega un límite nuevo. Los campos sueltos quedan como respaldo para una
// versión del CLI que todavía no escriba la lista.
func claudeLimits(home string) AgentLimits {
	path := filepath.Join(home, ".claude.json")
	l := AgentLimits{Agent: "claude", Source: path}

	raw, err := os.ReadFile(path)
	if err != nil {
		l.Note = "No hay una sesión de Claude Code iniciada en esta máquina."
		return l
	}

	var doc struct {
		Cached struct {
			FetchedAtMs int64 `json:"fetchedAtMs"`
			Utilization struct {
				FiveHour *claudeBucket      `json:"five_hour"`
				SevenDay *claudeBucket      `json:"seven_day"`
				Limits   []claudeLimitEntry `json:"limits"`
			} `json:"utilization"`
		} `json:"cachedUsageUtilization"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		l.Note = "No se pudo leer la configuración de Claude Code."
		return l
	}

	if doc.Cached.FetchedAtMs == 0 {
		l.Note = "Claude Code todavía no guardó tu uso: se llena la primera vez que abrís una sesión con esta versión del CLI."
		return l
	}
	l.MeasuredAt = time.UnixMilli(doc.Cached.FetchedAtMs).Format(time.RFC3339)

	u := doc.Cached.Utilization
	for _, w := range u.Limits {
		if w.Percent == nil {
			// Un límite sin porcentaje es uno que la cuenta no tiene (un modelo
			// al que no se accede). Mostrarlo en 0% diría que existe y no se
			// usó, que es otra cosa.
			continue
		}
		win := Window{
			Percent:  *w.Percent,
			Severity: w.Severity,
			Active:   w.IsActive,
			Kind:     claudeKind(w.Kind, w.Group),
			Label:    claudeLabel(w),
		}
		if w.ResetsAt != nil {
			win.ResetsAt = *w.ResetsAt
		}
		l.Windows = append(l.Windows, win)
	}

	// Respaldo para un CLI que todavía no escribe `limits`.
	if len(l.Windows) == 0 {
		if b := u.FiveHour; b != nil && b.Utilization != nil {
			l.Windows = append(l.Windows, Window{Kind: "session", Label: "Sesión · 5 h", Percent: *b.Utilization, ResetsAt: strOrEmpty(b.ResetsAt)})
		}
		if b := u.SevenDay; b != nil && b.Utilization != nil {
			l.Windows = append(l.Windows, Window{Kind: "weekly", Label: "Semana · todos los modelos", Percent: *b.Utilization, ResetsAt: strOrEmpty(b.ResetsAt)})
		}
	}

	if len(l.Windows) == 0 {
		l.Note = "El caché de uso de Claude Code está vacío."
		return l
	}
	l.Known = true
	return l
}

// claudeLimitEntry es una fila de `utilization.limits`: la forma genérica en
// la que el proveedor publica cada límite, y la que sigue funcionando cuando
// agrega uno nuevo.
type claudeLimitEntry struct {
	Kind     string   `json:"kind"`
	Group    string   `json:"group"`
	Percent  *float64 `json:"percent"`
	Severity string   `json:"severity"`
	ResetsAt *string  `json:"resets_at"`
	IsActive bool     `json:"is_active"`
	Scope    *struct {
		Model *struct {
			DisplayName string `json:"display_name"`
		} `json:"model"`
	} `json:"scope"`
}

type claudeBucket struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    *string  `json:"resets_at"`
}

// claudeKind traduce el nombre interno del límite a las tres clases que
// entiende la UI, cayendo al grupo del proveedor cuando aparece uno nuevo —
// mostrar un nombre desconocido tal cual es lo que permite buscarlo.
func claudeKind(kind, group string) string {
	switch kind {
	case "session":
		return "session"
	case "weekly_all", "weekly_scoped":
		return "weekly"
	}
	if group != "" {
		return group
	}
	return "unknown"
}

// claudeLabel nombra la ventana como la nombra el propio /usage.
func claudeLabel(w claudeLimitEntry) string {
	model := ""
	if w.Scope != nil && w.Scope.Model != nil {
		model = w.Scope.Model.DisplayName
	}
	switch w.Kind {
	case "session":
		return "Sesión · 5 h"
	case "weekly_all":
		return "Semana · todos los modelos"
	case "weekly_scoped":
		if model != "" {
			return "Semana · " + model
		}
		return "Semana · un modelo"
	}
	if model != "" {
		return w.Kind + " · " + model
	}
	return w.Kind
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
