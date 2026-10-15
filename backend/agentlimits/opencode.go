package agentlimits

import (
	"os"
	"path/filepath"

	"mini-tools/backend/i18n"
)

// opencodeDataDir es dónde OpenCode guarda su estado (sesiones, credenciales).
// Sigue la convención XDG, que OpenCode respeta también fuera de Linux.
func opencodeDataDir(home string) string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "opencode")
}

// opencodeLimits declara que OpenCode no tiene un límite que leer.
//
// # Qué se buscó antes de decir que no
//
// En OpenCode 2.0.22 se revisó lo que podría contener una cuota o un saldo:
//
//   - `opencode stats --json` (la fuente del panel de consumo) trae tokens y
//     COSTO medidos, pero ningún tope ni porcentaje.
//   - `opencode auth list` lista las credenciales, sin saldo.
//   - La API local (`opencode api GET /openapi.json`, 116 rutas) no tiene
//     ninguna operación de uso, cuota, límite, saldo ni plan.
//   - `auth.json` y la base de sesiones guardan credenciales y conversaciones,
//     no el estado de la cuenta.
//
// OpenCode es un cliente que habla con varios proveedores (OpenCode Go, Zen,
// Anthropic, OpenAI…) y cada uno lleva su propia cuenta: si hay un tope, lo
// sabe el servidor de ese proveedor y no pasa por el CLI. Por eso no se
// inventa nada: se declara no disponible, con la razón y a dónde mirar, que es
// lo mismo que ya hace Antigravity y distinto de "0% usado" — el número más
// engañoso que podría mostrar esta pantalla.
//
// No es Queryable: no hay un comando al que preguntarle.
func opencodeLimits(home string) AgentLimits {
	l := AgentLimits{Agent: "opencode", Source: opencodeDataDir(home)}
	if _, err := os.Stat(l.Source); err != nil {
		l.Note = i18n.T(i18n.Msg{ES: "No se encontró OpenCode CLI en esta máquina.", EN: "OpenCode CLI wasn't found on this machine."})
		return l
	}
	l.Note = i18n.T(i18n.Msg{ES: "OpenCode no expone una cuota ni un saldo, ni en el disco ni por línea de comandos: el límite, si existe, lo lleva cada proveedor (se mira en su consola). Lo medido —tokens y costo— está en el consumo.", EN: "OpenCode does not expose a quota or a balance, neither on disk nor from the command line: the limit, if any, is kept by each provider (check its console). What is measured —tokens and cost— is in the usage."})
	return l
}
