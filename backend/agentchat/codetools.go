package agentchat

import (
	"context"
	"strings"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
	"mini-tools/backend/workspace"
)

// Herramientas de código local para un servidor de modelos: este archivo
// decide QUÉ herramientas de backend/workspace se declaran según el modo del
// chat y CUÁNDO una llamada pregunta al usuario. Ejecutarlas (y confinarlas al
// directorio) es de backend/workspace; mostrar la pregunta, de App.
//
// Los permisos son los modos que el chat ya tiene, con el mismo orden y la
// misma UI:
//
//	modo      lectura   escritura        comandos
//	ask       declara   no se declara    no se declara
//	plan      declara   no se declara    no se declara
//	approve   declara   pregunta c/vez   pregunta c/vez
//	edit      declara   sin preguntar    pregunta c/vez
//	auto      declara   sin preguntar    sin preguntar, salvo los de riesgo
//
// Un comando de la lista de riesgo (workspace.Risk) pregunta en TODOS los
// modos. Y una herramienta que el modo no permite **no se declara**: igual que
// hace el MCP con la escritura de notas, una herramienta que figura y siempre
// falla invita al modelo a intentarla. Si el modelo llama igual a una no
// declarada, se rechaza acá también (defensa en profundidad: el catálogo es
// una sugerencia al modelo, no una garantía).

// ToolPermission es qué ocurre con una herramienta en un modo.
type ToolPermission int

const (
	// PermNone: no se declara y se rechaza si se la llama.
	PermNone ToolPermission = iota
	// PermAsk: se declara y cada llamada pregunta al usuario.
	PermAsk
	// PermAuto: se declara y corre sin preguntar.
	PermAuto
)

// PermissionFor es la tabla de arriba. Un modo desconocido no da permisos: ante
// la duda, solo lectura.
func PermissionFor(mode Mode, kind workspace.Kind) ToolPermission {
	switch kind {
	case workspace.KindRead:
		return PermAuto
	case workspace.KindWrite:
		switch mode {
		case ModeApprove:
			return PermAsk
		case ModeEdit, ModeAuto:
			return PermAuto
		}
	case workspace.KindCommand:
		switch mode {
		case ModeApprove, ModeEdit:
			return PermAsk
		case ModeAuto:
			return PermAuto
		}
	}
	return PermNone
}

// Approver lleva una pregunta de permiso al usuario y espera su respuesta.
// Tiene que respetar ctx (cancelar el turno es denegar) y vencer por su cuenta
// (nadie contesta es denegar): una implementación que se queda esperando para
// siempre deja colgado el turno y su goroutine.
type Approver func(ctx context.Context, req agentapprove.Request) agentapprove.Decision

// CodeTools son las herramientas de archivos y comandos de UN turno.
type CodeTools struct {
	ws      *workspace.Workspace
	mode    Mode
	approve Approver
}

// NewCodeTools arma las herramientas de un directorio de trabajo para un modo.
// approve puede ser nil: entonces toda herramienta que tendría que preguntar
// se deniega.
func NewCodeTools(ws *workspace.Workspace, mode Mode, approve Approver) *CodeTools {
	return &CodeTools{ws: ws, mode: mode, approve: approve}
}

// Defs son las herramientas que se le declaran al modelo en este modo.
func (c *CodeTools) Defs() []llm.ToolDef {
	var out []llm.ToolDef
	for _, t := range workspace.Catalog() {
		if PermissionFor(c.mode, t.Kind) == PermNone {
			continue
		}
		out = append(out, llm.ToolDef{Name: t.Name, Description: t.Description, Parameters: t.Parameters})
	}
	return out
}

// Owns dice si el nombre es de una herramienta de este conjunto (declarada o
// no en el modo): sirve para despachar entre estas y las del servidor MCP.
func (c *CodeTools) Owns(name string) bool {
	_, ok := workspace.KindOf(name)
	return ok
}

// SystemNote es lo que se suma al mensaje de sistema cuando hay herramientas
// de archivos: dónde trabajan y qué modo rige, para que el modelo no insista
// con lo que el modo no le deja.
func (c *CodeTools) SystemNote() string {
	var rule i18n.Msg
	switch c.mode {
	case ModeApprove:
		rule = i18n.Msg{ES: "Cada escritura y cada comando le piden permiso al usuario; si lo deniega, no insistas con lo mismo.", EN: "Every write and every command asks the user for permission; if they deny it, do not insist on the same thing."}
	case ModeEdit:
		rule = i18n.Msg{ES: "Las ediciones de archivos se aplican directo; los comandos le piden permiso al usuario.", EN: "File edits are applied directly; commands ask the user for permission."}
	case ModeAuto:
		rule = i18n.Msg{ES: "Las ediciones y los comandos se aplican directo, salvo los riesgosos, que piden permiso al usuario.", EN: "Edits and commands are applied directly, except risky ones, which ask the user for permission."}
	case ModePlan:
		rule = i18n.Msg{ES: "Solo podés leer y buscar. Explorá el código y proponé un plan; no cambies nada.", EN: "You can only read and search. Explore the code and propose a plan; do not change anything."}
	default:
		rule = i18n.Msg{ES: "Solo podés leer y buscar: no modificás nada.", EN: "You can only read and search: you do not modify anything."}
	}
	return i18n.T(i18n.Msg{
		ES: "Tenés herramientas para trabajar en el repositorio abierto (rutas relativas a su raíz). Leé el código antes de editarlo; para cambiar un archivo existente usá edit_file con un fragmento exacto y único. %s",
		EN: "You have tools to work in the open repository (paths relative to its root). Read the code before editing it; to change an existing file use edit_file with an exact, unique fragment. %s",
	}, i18n.T(rule))
}

// Run ejecuta una llamada aplicando el permiso del modo. Un error vuelve al
// modelo como texto (lo arma el runner), incluida una denegación: así sabe que
// el usuario dijo que no y por qué.
func (c *CodeTools) Run(ctx context.Context, name string, args map[string]any) (string, error) {
	kind, ok := workspace.KindOf(name)
	if !ok {
		return "", i18n.Errorf(i18n.Msg{ES: "herramienta desconocida: %s", EN: "unknown tool: %s"}, name)
	}
	perm := PermissionFor(c.mode, kind)
	if perm == PermNone {
		return "", i18n.Errorf(i18n.Msg{ES: "la herramienta %s no está permitida en este modo del chat", EN: "the tool %s is not allowed in this chat mode"}, name)
	}

	raw := rawJSON(args)
	summary, detail := agentapprove.Describe(raw)
	if kind == workspace.KindCommand {
		if why := workspace.Risk(strings.TrimSpace(strArgOf(args, "command"))); why != "" {
			// Un comando de riesgo pregunta en todos los modos, también en auto.
			perm = PermAsk
			detail = i18n.T(i18n.Msg{ES: "⚠ Comando de riesgo: %s", EN: "⚠ Risky command: %s"}, why)
		}
	}
	if perm == PermAsk {
		if err := c.ask(ctx, name, raw, summary, detail); err != nil {
			return "", err
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return c.ws.Run(ctx, name, args)
}

func (c *CodeTools) ask(ctx context.Context, name, raw, summary, detail string) error {
	if c.approve == nil {
		return i18n.Errorf(i18n.Msg{ES: "esta acción necesita el permiso del usuario y no hay forma de pedírselo", EN: "this action needs the user's permission and there is no way to ask for it"})
	}
	d := c.approve(ctx, agentapprove.Request{Tool: name, Input: trim(raw), Summary: trim(summary), Detail: detail})
	if err := ctx.Err(); err != nil {
		return err
	}
	if d.Allow {
		return nil
	}
	reason := strings.TrimSpace(d.Reason)
	if reason == "" {
		return i18n.Errorf(i18n.Msg{ES: "el usuario denegó esta acción", EN: "the user denied this action"})
	}
	return i18n.Errorf(i18n.Msg{ES: "el usuario denegó esta acción: %s", EN: "the user denied this action: %s"}, reason)
}

func strArgOf(args map[string]any, key string) string {
	v, _ := args[key].(string)
	return v
}
