package agentchat

import (
	"regexp"
	"strings"

	"mini-tools/backend/i18n"
)

// Herramientas que el CLI rechazó, y la nota que se le deja a la persona.
//
// En headless un CLI no puede pedir permiso: lo que no tiene una regla que lo
// permita se rechaza solo, y el turno puede terminar con una respuesta vacía o
// con un «no pude hacerlo» del modelo que no dice POR QUÉ. Los adaptadores
// detectan esos rechazos (Claude: `permission_denials` del result; Antigravity:
// pasos en error y `denied_actions`) y el Manager, una sola vez antes de cerrar
// el turno, deja una nota accionable en el mismo chat.

// kindDenied es un evento INTERNO de los adaptadores hacia Manager.run: Text es
// el nombre de una herramienta rechazada. Nunca se emite al frontend ni se
// graba; run lo consume y lo junta para la nota del cierre.
const kindDenied EventKind = "denied"

func denied(name string) Event { return Event{Kind: kindDenied, Text: name} }

// maxDeniedName acota lo que se muestra de una acción rechazada: algunos CLIs
// describen la acción con el comando entero.
const maxDeniedName = 80

var (
	// permission check failed for mcp "mini-tools/db_get_schema": …
	reDeniedMCPQuoted = regexp.MustCompile(`mcp "([^"]+)"`)
	// … user denied permission for mcp(mini-tools/db_get_schema)
	reDeniedMCPParen = regexp.MustCompile(`mcp\(([^)]+)\)`)
)

// mcpNameInText saca de un mensaje de rechazo el `servidor/herramienta` que
// nombra, o "" si el texto no menciona ninguno.
func mcpNameInText(s string) string {
	if m := reDeniedMCPQuoted.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	if m := reDeniedMCPParen.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// cleanDeniedName deja el nombre real de la herramienta, sin el servidor:
// `mcp__mini-tools__db_get_schema` → `db_get_schema`, `mini-tools/db_get_schema`
// → `db_get_schema`. Un nombre propio del CLI (`Bash`, `Edit`) queda igual.
func cleanDeniedName(name string) string {
	name = strings.TrimSpace(name)
	if inner := mcpNameInText(name); inner != "" {
		name = inner
	}
	if strings.HasPrefix(name, "mcp__") {
		if i := strings.LastIndex(name, "__"); i > len("mcp__")-1 {
			name = name[i+2:]
		}
	}
	if i := strings.LastIndex(name, "/"); i >= 0 && i < len(name)-1 && !strings.ContainsAny(name, " \t\n") {
		name = name[i+1:]
	}
	if r := []rune(name); len(r) > maxDeniedName {
		name = string(r[:maxDeniedName]) + "…"
	}
	return name
}

// isPermissionDenial reconoce, en el detalle de un paso que falló, un rechazo
// de permiso (y no un error de la herramienta).
func isPermissionDenial(detail string) bool {
	d := strings.ToLower(detail)
	return strings.Contains(d, "permission check failed") ||
		strings.Contains(d, "user denied permission") ||
		strings.Contains(d, "denied permission")
}

// deniedCollector junta, sin repetir, los nombres rechazados de un turno.
type deniedCollector struct {
	names []string
	seen  map[string]bool
}

func (c *deniedCollector) add(raw string) {
	name := cleanDeniedName(raw)
	if name == "" || c.seen[name] {
		return
	}
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	c.seen[name] = true
	c.names = append(c.names, name)
}

var (
	msgDeniedOne  = i18n.Msg{ES: "la herramienta `%s`", EN: "the tool `%s`"}
	msgDeniedMany = i18n.Msg{ES: "las herramientas %s", EN: "the tools %s"}

	// Claude Code y OpenCode: se destraba con un modo que apruebe cada acción.
	msgDeniedAsk = i18n.Msg{
		ES: "%s rechazó %s porque en modo no interactivo no puede pedirte permiso. Para que la use, elegí «Aprobar cada acción» o el modo que la permita y volvé a intentarlo.",
		EN: "%s denied %s because in non-interactive mode it cannot ask you for permission. To let it run, choose “Approve each action” or the mode that allows it, and try again.",
	}
	// Antigravity: su modo no interactivo rechaza las herramientas MCP que no
	// estén aprobadas en su configuración global. mini-tools las aprueba solo
	// (app_agyperm.go); si igual se rechazó una es porque las quitaste o no
	// se pudo escribir el archivo, y se puede reparar.
	msgDeniedAgy = i18n.Msg{
		ES: "Antigravity rechazó %s. Su modo no interactivo no puede pedirte permiso y rechaza las herramientas MCP que no estén aprobadas en su configuración global.",
		EN: "Antigravity denied %s. Its non-interactive mode cannot ask you for permission and rejects MCP tools that are not approved in its global configuration.",
	}
	msgDeniedAgyRepair = i18n.Msg{
		ES: "Antigravity rechazó %s. Su modo no interactivo no puede pedirte permiso y rechaza las herramientas MCP que no estén aprobadas en su configuración global; mini-tools las aprueba solo, así que probablemente las quitaste o no se pudo escribir ese archivo. Repará los permisos (botón de abajo, o Configuración → Acceso de la IA → «Reparar permisos») y volvé a pedirlo.",
		EN: "Antigravity denied %s. Its non-interactive mode cannot ask you for permission and rejects MCP tools that are not approved in its global configuration; mini-tools approves them on its own, so you probably removed them or that file could not be written. Repair the permissions (button below, or Settings → AI Access → “Repair permissions”) and ask again.",
	}
	msgTurnEmpty = i18n.Msg{ES: "%s terminó el turno sin responder nada.", EN: "%s finished the turn without replying anything."}
)

// ActionRepairAgyPerms es el Event.Action que ofrece «Reparar permisos» junto a
// la nota de un rechazo de Antigravity. El frontend lo reconoce por este código
// (ver AgentChat.tsx), no por el texto de la nota.
const ActionRepairAgyPerms = "repair-agy-perms"

// agyRepairable dice si el rechazo de este turno se arregla reparando las
// reglas de permiso de mini-tools: fue Antigravity y el turno llevaba el MCP de
// mini-tools (si estaba apagado, lo rechazado no es de mini-tools y reparar no
// cambiaría nada).
func agyRepairable(t Turn, names []string) bool {
	return len(names) > 0 && t.AgentID == "antigravity" && len(t.MCPTools) > 0
}

// WarnNote da formato de aviso de la app («_⚠ …_») a un texto de una línea. El
// frontend lo separa de la respuesta del modelo y lo dibuja como aviso
// (splitLeadingNotice en AgentChat.tsx), así que tiene que ir en UNA línea.
func WarnNote(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	return "_⚠ " + s + "_"
}

func deniedPhrase(names []string) string {
	if len(names) == 1 {
		return i18n.T(msgDeniedOne, names[0])
	}
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = "`" + n + "`"
	}
	return i18n.T(msgDeniedMany, strings.Join(quoted, ", "))
}

// agentName es cómo se nombra el CLI en una nota: su rótulo visible o, si no
// vino, el id.
func agentName(t Turn) string {
	if strings.TrimSpace(t.AgentLabel) != "" {
		return t.AgentLabel
	}
	return t.AgentID
}

// turnClosingNote es el texto que se agrega al final del turno, o "" si no hace
// falta ninguno. done = el turno cierra bien: solo entonces «no respondió nada»
// tiene sentido; la nota de denegaciones va también antes de un error.
func turnClosingNote(t Turn, names []string, sawText, done bool) string {
	var note string
	switch {
	case agyRepairable(t, names):
		note = i18n.T(msgDeniedAgyRepair, deniedPhrase(names))
	case len(names) > 0 && t.AgentID == "antigravity":
		note = i18n.T(msgDeniedAgy, deniedPhrase(names))
	case len(names) > 0:
		note = i18n.T(msgDeniedAsk, agentName(t), deniedPhrase(names))
	case done && !sawText:
		note = i18n.T(msgTurnEmpty, agentName(t))
	}
	if note == "" {
		return ""
	}
	// En cursiva y con el aviso, como las demás notas del chat
	// (msgNoToolsNotice): se distingue de lo que dijo el modelo.
	note = WarnNote(note)
	if sawText {
		return "\n\n" + note
	}
	return note
}
