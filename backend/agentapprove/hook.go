package agentapprove

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// Hook PreToolUse: el mecanismo por el que el agente pregunta antes de CADA
// acción.
//
// # Por qué un hook y no el servidor MCP de mcpserver.go
//
// El plan original era `--permission-prompt-tool` apuntando a una herramienta
// MCP nuestra. Al verificarlo contra el CLI instalado (Claude Code 2.1.231)
// **esa bandera ya no existe**: el `--help` de esa versión no la lista. Los
// hooks sí, están documentados en el propio `--help` (`--settings`,
// `--include-hook-events`) y hay uno andando en esta máquina.
//
// El cambio de mecanismo no invalidó nada de lo construido: el canal por
// socket de channel.go —con su timeout, su "si no se puede preguntar, se
// deniega" y sus pruebas— es el mismo. Lo único distinto es la forma de la
// conversación con el CLI: en vez de JSON-RPC, un objeto JSON por stdin y una
// decisión por stdout, que es más simple.
//
// mcpserver.go se conserva porque el mecanismo MCP sigue existiendo en otros
// CLIs y volver a escribirlo costaría lo mismo que dejarlo.

const (
	envHookActive = "MINITOOLS_HOOK_APPROVE"
	envHookSocket = "MINITOOLS_HOOK_APPROVE_SOCKET"
)

// IsHookInvocation informa si este proceso fue re-ejecutado como hook de
// permisos. main() lo comprueba antes de abrir ninguna ventana.
func IsHookInvocation() bool {
	return os.Getenv(envHookActive) == "1"
}

// HookEnv son las variables con las que se lanza el re-exec como hook.
func HookEnv(socketPath string) []string {
	return []string{envHookActive + "=1", envHookSocket + "=" + socketPath}
}

// hookInput es lo que el CLI manda por stdin. Se leen solo los campos que
// hacen falta; el resto se ignora, que es lo que permite que el CLI agregue
// campos sin romper esto.
type hookInput struct {
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
}

// HookMain lee la acción propuesta, pregunta y responde.
//
// **Siempre sale con código 0 y una decisión explícita.** Un hook que falla
// con código distinto de cero deja que el CLI decida por su cuenta qué hacer,
// y eso es justo lo que no queremos: si algo salió mal acá, la respuesta tiene
// que ser "no", dicha en voz alta.
func HookMain() {
	socket := os.Getenv(envHookSocket)

	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 16<<20))
	if err != nil {
		emitDecision(false, "no se pudo leer la acción propuesta")
		return
	}

	var in hookInput
	if err := json.Unmarshal(raw, &in); err != nil {
		emitDecision(false, "no se entendió la acción propuesta")
		return
	}

	input := string(in.ToolInput)
	summary, detail := Describe(input)

	d := Ask(socket, Request{
		Tool:    in.ToolName,
		Input:   input,
		Summary: summary,
		Detail:  detail,
	})

	reason := d.Reason
	if !d.Allow && reason == "" {
		reason = "el usuario no autorizó esta acción"
	}
	emitDecision(d.Allow, reason)
}

// emitDecision escribe la respuesta en el formato del hook PreToolUse.
//
// Se emiten las DOS formas a la vez —`hookSpecificOutput.permissionDecision` y
// el `decision`/`reason` de la forma anterior— porque los CLIs cambian su
// contrato entre versiones y un campo que sobra se ignora, mientras que uno
// que falta convierte la denegación en un "no dijo nada". Ante la duda, decir
// que no por partida doble.
func emitDecision(allow bool, reason string) {
	decision := "deny"
	if allow {
		decision = "allow"
	}

	out := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       decision,
			"permissionDecisionReason": reason,
		},
	}
	if !allow {
		out["decision"] = "block"
		out["reason"] = reason
	}

	b, err := json.Marshal(out)
	if err != nil {
		// Último recurso: una denegación escrita a mano. Nunca callarse.
		fmt.Println(`{"decision":"block","reason":"error interno de mini-tools"}`)
		return
	}
	fmt.Println(string(b))
}

// Describe arma la línea legible de lo que una herramienta está por hacer.
//
// La usan los DOS lados: el diálogo que pide autorización y la lista de
// acciones del chat (backend/agentchat). Es a propósito una sola: si el chat
// describiera la acción de una forma y el permiso de otra, el usuario estaría
// autorizando algo que no se parece a lo que después ve.
//
// Se mira el CONTENIDO del argumento y no el nombre de la herramienta, porque
// los CLIs cambian esos nombres entre versiones (`Edit`/`edit_file`/`replace`)
// pero todos terminan pasando un `file_path`, un `command` o un `pattern`.
func Describe(raw string) (summary, detail string) {
	if strings.TrimSpace(raw) == "" {
		return "", ""
	}
	var in map[string]any
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		return "", ""
	}

	str := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := in[k].(string); ok && v != "" {
				return v
			}
		}
		return ""
	}

	if p := str("file_path", "filePath", "path", "notebook_path"); p != "" {
		if content := str("content", "new_string", "newString", "new_str"); content != "" {
			return p, fmt.Sprintf("%d líneas", strings.Count(content, "\n")+1)
		}
		return p, ""
	}
	if c := str("command", "cmd"); c != "" {
		return c, ""
	}
	if p := str("pattern", "query", "q"); p != "" {
		if where := str("glob", "include", "dir"); where != "" {
			return p, where
		}
		return p, ""
	}
	if u := str("url", "uri"); u != "" {
		return u, ""
	}
	return str("description", "prompt"), ""
}
