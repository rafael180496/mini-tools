package agentchat

import (
	"strings"
)

// Permisos de las herramientas MCP de mini-tools en headless.
//
// En `claude -p` y en `opencode run` no hay a quién preguntarle: una herramienta
// MCP sin regla de permiso se rechaza sola, y el cerebro y `db_get_schema`
// dejan de funcionar desde el chat en TODOS los modos. La solución es nombrar,
// una por una, las herramientas que el servidor de mini-tools declara ahora.
// Nunca un comodín (`mcp__*`, `mcp(*)`) ni una bandera que saltee los permisos:
// una herramienta que mini-tools agregue mañana, o un servidor ajeno, no queda
// habilitado por accidente.

// defaultMCPServer es el nombre con el que mini-tools se registra en cada CLI
// (app_mcp_connect.go: mcpServerName) cuando el turno no trae otro.
const defaultMCPServer = "mini-tools"

// mcpServerOf es el nombre del servidor de mini-tools para este turno.
func mcpServerOf(t Turn) string {
	if s := strings.TrimSpace(t.MCPServer); s != "" {
		return s
	}
	return defaultMCPServer
}

// mcpSafeName normaliza un nombre como lo hacen Claude Code y OpenCode al
// armar el de una herramienta: todo lo que no sea letra, dígito, `_` o `-`
// pasa a `_`.
func mcpSafeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// claudeAllowRules son las reglas `mcp__<servidor>__<herramienta>`, una por
// herramienta del catálogo.
func claudeAllowRules(t Turn) []string {
	server := mcpSafeName(mcpServerOf(t))
	rules := make([]string, 0, len(t.MCPTools))
	for _, tool := range t.MCPTools {
		if tool = strings.TrimSpace(tool); tool != "" {
			rules = append(rules, "mcp__"+server+"__"+mcpSafeName(tool))
		}
	}
	return rules
}

// claudeDisabledTools son las herramientas propias de Claude Code que se le
// quitan en «Solo consulta» y «Planificar»: las que editan archivos y la
// shell. Una regla de denegación gana a cualquier `allow` global que el
// usuario tenga en su configuración, así que la consulta deja de poder
// convertirse en edición por una regla ajena.
const claudeDisabledTools = claudeEditTools + ",Bash,PowerShell"

// claudeEditTools son solo las de edición: es lo que se le quita a un turno de
// Ask (ver Turn.oneShot), que conserva la shell que el usuario le permita.
const claudeEditTools = "Edit,Write,MultiEdit,NotebookEdit"

// claudePermissionArgs son las banderas de permisos de Claude Code que dependen
// del turno y no del modo de permisos del CLI:
//
//   - `--allowedTools` con las herramientas MCP de mini-tools, salvo en «Aprobar
//     cada acción»: ahí decide el hook, y una regla de permiso lo salteaba.
//   - `--disallowedTools` en consulta y planificación.
//
// En editar/auto la shell queda como estaba (la gobierna el modo del CLI).
func claudePermissionArgs(t Turn) []string {
	var args []string
	if t.Mode != ModeApprove {
		if rules := claudeAllowRules(t); len(rules) > 0 {
			args = append(args, "--allowedTools", strings.Join(rules, ","))
		}
	}
	if t.Mode == ModeAsk || t.Mode == ModePlan {
		disabled := claudeDisabledTools
		if t.oneShot {
			disabled = claudeEditTools
		}
		args = append(args, "--disallowedTools", disabled)
	}
	return args
}
