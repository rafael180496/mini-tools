// Package agentlimits lee cuánto llevás usado DE TU LÍMITE en cada CLI
// agéntico, a partir de lo que el propio CLI dejó cacheado en el disco.
//
// # Por qué esto no contradice a agentusage
//
// `backend/agentusage` mide consumo REAL (tokens contados de los transcripts) y
// dice explícitamente que sus porcentajes son proporciones de lo gastado, nunca
// fracciones de un tope, porque el tope no vive en ningún archivo local.
//
// Eso sigue siendo cierto para el CÁLCULO: nadie puede dividir tokens por un
// límite que no conoce. Lo que sí existe —y es lo que lee este paquete— es el
// porcentaje **ya calculado por el servidor del proveedor** y guardado por el
// CLI en su propio caché. No se inventa una división: se lee el número que el
// proveedor contestó, con la marca de tiempo de cuándo lo contestó.
//
// La diferencia importa al mostrarlo: es un dato *fechado*, no en vivo. Si el
// CLI no se usa hace dos días, el porcentaje es el de hace dos días, y decirlo
// es parte del dato. Por eso `MeasuredAt` no es opcional.
//
// # De dónde sale, verificado en instalaciones reales
//
//   - **Claude Code**: `~/.claude.json`, bloque `cachedUsageUtilization` — lo
//     mismo que dibuja su `/usage`: la ventana de 5 horas, la semanal de todos
//     los modelos y las semanales por modelo, cada una con su porcentaje y
//     cuándo se reinicia.
//   - **Codex**: sus sesiones (`~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl`)
//     traen un evento `token_count` con `rate_limits`, que es lo que el
//     servidor devuelve en cada respuesta: `used_percent`, el tamaño de la
//     ventana en minutos y cuándo se reinicia. Se lee el ÚLTIMO, que es el más
//     reciente.
//   - **Antigravity**: no publica nada de esto en el disco. Su cuota la
//     contesta el servidor y solo se ve con `/usage` dentro de la sesión — se
//     dice eso en vez de mostrar un cero que se leería como "no consumiste
//     nada".
package agentlimits

import (
	"fmt"
	"os"
)

// Window es una ventana de límite: cuánto se lleva usado de ella y cuándo
// vuelve a cero.
type Window struct {
	// Kind normaliza la ventana para poder ordenarla y colorearla:
	// "session", "weekly", "monthly" o el nombre crudo del proveedor cuando no
	// encaja en ninguna. No se inventa una equivalencia entre proveedores más
	// allá de eso: la ventana de 5 horas de uno y la de 30 días de otro no son
	// lo mismo y no deben verse igual.
	Kind string `json:"kind"`
	// Label es cómo se muestra ("Sesión · 5 h", "Semana · todos los modelos").
	Label string `json:"label"`
	// Detail es qué cubre exactamente esa ventana, cuando el proveedor lo dice
	// (Antigravity manda qué modelos entran en cada grupo). Va al tooltip: sin
	// eso, "Claude y GPT" adentro de la tarjeta de Antigravity se lee como si
	// fuera consumo de otro proveedor, y no lo es.
	Detail string `json:"detail"`
	// Percent es cuánto se lleva usado del límite, 0..100. Este SÍ es un
	// porcentaje de un tope — calculado por el proveedor, no por esta app.
	Percent float64 `json:"percent"`
	// ResetsAt es cuándo se reinicia la ventana (RFC 3339). Vacío cuando el
	// proveedor no lo informa, que pasa en las ventanas todavía sin consumo.
	ResetsAt string `json:"resetsAt"`
	// Severity es el estado que informó el proveedor ("normal", "warning"…).
	// Vacío cuando no manda ninguno; la UI colorea por porcentaje en ese caso.
	Severity string `json:"severity"`
	// Active marca la ventana que el proveedor considera la que manda ahora
	// mismo — con varias corriendo a la vez, es la que conviene mirar.
	Active bool `json:"active"`
}

// AgentLimits es lo que se sabe de los límites de un agente.
type AgentLimits struct {
	Agent string `json:"agent"`
	// Known es false cuando el CLI no deja este dato en el disco. Se distingue
	// de "0% usado" a propósito: no saber y saber que no consumiste son cosas
	// distintas, y mostrarlas igual sería inventar.
	Known bool `json:"known"`
	// Note explica por qué no se sabe.
	Note string `json:"note"`
	// Source es de qué archivo salió, para poder verificarlo a mano.
	Source string `json:"source"`
	// Plan es el plan que viene junto con los límites, cuando el propio dato lo
	// trae (Codex manda `plan_type`). Vacío si no.
	Plan string `json:"plan"`
	// Queryable es si a este agente se le puede PREGUNTAR el límite corriendo
	// su propio CLI, para los que no lo dejan escrito en ningún archivo. La UI
	// lo usa para ofrecer el botón de consultar solo donde hace algo. Ver
	// query.go.
	Queryable bool `json:"queryable"`
	// MeasuredAt es cuándo el CLI le preguntó esto al servidor (RFC 3339).
	// **No es "ahora"**: es la edad del dato, y sin ella un 17% viejo se lee
	// como si fuera de este minuto.
	MeasuredAt string `json:"measuredAt"`

	Windows []Window `json:"windows"`
}

// All devuelve los límites de los tres agentes. Siempre los tres: uno ausente
// del listado y uno sin dato se verían igual, y solo el segundo es información.
func All() []AgentLimits {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	out := []AgentLimits{claudeLimits(home), codexLimits(home), antigravityLimits(home)}
	// Lo que ya contestó un CLI en esta sesión de la app pisa al lector de
	// disco: para Antigravity el disco no tiene nada que decir, y volver a
	// mostrar "no publica su cuota" después de haberla consultado sería perder
	// un dato que la app ya tiene.
	for i, l := range out {
		if l.Known {
			continue
		}
		if c, ok := cachedFor(l.Agent); ok {
			out[i] = c
		}
	}
	return out
}

// windowLabel nombra una ventana por su duración en minutos. Es lo único que
// manda Codex para identificarla, y "5 h" o "semana" se entienden sin traducir
// mentalmente 10080 minutos.
func windowLabel(minutes int) string {
	switch {
	case minutes <= 0:
		return "ventana desconocida"
	case minutes%1440 == 0 && minutes/1440 == 7:
		return "semana"
	case minutes%1440 == 0:
		return fmt.Sprintf("%d días", minutes/1440)
	case minutes%60 == 0:
		return fmt.Sprintf("%d h", minutes/60)
	default:
		return fmt.Sprintf("%d min", minutes)
	}
}

// windowKind clasifica una ventana por duración, para que la UI pueda ordenar
// "la corta primero" sin conocer a cada proveedor.
func windowKind(minutes int) string {
	switch {
	case minutes <= 0:
		return "unknown"
	case minutes <= 24*60:
		return "session"
	case minutes <= 7*24*60:
		return "weekly"
	default:
		return "monthly"
	}
}
