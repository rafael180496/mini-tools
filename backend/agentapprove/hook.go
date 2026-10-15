package agentapprove

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"mini-tools/backend/i18n"
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
	// envHookSession es la sesión de chat dueña del proceso del CLI. El CLI
	// lanza el hook como hijo y le pasa su entorno entero, así que lo que se
	// pone en el entorno del turno llega solo — la misma herencia de la que ya
	// depende el socket.
	envHookSession = "MINITOOLS_HOOK_APPROVE_SESSION"
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

// HookEnvFor es HookEnv más la sesión de chat a la que pertenece el CLI que se
// lanza: así la pregunta del hook llega rotulada con su chat (Request.SessionID)
// y el diálogo global puede decir de quién es aunque la pestaña esté cerrada.
func HookEnvFor(socketPath, sessionID string) []string {
	env := HookEnv(socketPath)
	if sessionID != "" {
		env = append(env, envHookSession+"="+sessionID)
	}
	return env
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
		emitDecision(false, i18n.T(i18n.Msg{ES: "no se pudo leer la acción propuesta", EN: "couldn't read the proposed action"}))
		return
	}

	var in hookInput
	if err := json.Unmarshal(raw, &in); err != nil {
		emitDecision(false, i18n.T(i18n.Msg{ES: "no se entendió la acción propuesta", EN: "couldn't understand the proposed action"}))
		return
	}

	input := string(in.ToolInput)
	summary, detail := Describe(input)

	d := Ask(socket, Request{
		Tool:      in.ToolName,
		Input:     input,
		Summary:   summary,
		Detail:    detail,
		SessionID: os.Getenv(envHookSession),
	})

	reason := d.Reason
	if !d.Allow && reason == "" {
		reason = i18n.T(i18n.Msg{ES: "el usuario no autorizó esta acción", EN: "the user didn't authorize this action"})
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

	// Las herramientas de skills (skill, read_skill_file) nombran un skill:
	// «skill/ruta» dice más que la ruta sola, que es relativa a su carpeta.
	if sk := str("skill"); sk != "" {
		if p := str("path"); p != "" {
			return sk + "/" + p, ""
		}
		return sk, ""
	}
	// Un parche (`apply_patch`/`patch` de OpenCode, `patchText`) no trae
	// `path`: los archivos van dentro del texto. Se resume por el primero.
	if patch := str("patchText", "patch"); patch != "" {
		if files := patchFiles(patch); len(files) > 0 {
			if len(files) > 1 {
				return files[0], i18n.T(i18n.Msg{ES: "%d archivos", EN: "%d files"}, len(files))
			}
			return files[0], ""
		}
	}
	// `todowrite`: la lista de tareas del agente. Lo útil es la que está en
	// curso y cuántas van terminadas.
	if todos, ok := in["todos"].([]any); ok && len(todos) > 0 {
		return todoSummary(todos)
	}
	// Una búsqueda (`grep`/`glob`) trae el patrón Y la carpeta donde buscar. El
	// patrón es lo que la identifica; la carpeta va de detalle. Sin esto la
	// carpeta, que `path` hace pasar por «la ruta del archivo», tapaba al patrón.
	if pat := str("pattern"); pat != "" && str("content", "new_string", "newString", "new_str") == "" {
		return pat, str("glob", "include", "path", "dir")
	}
	if p := str("file_path", "filePath", "path", "notebook_path"); p != "" {
		if content := str("content", "new_string", "newString", "new_str"); content != "" {
			return p, i18n.T(i18n.Msg{ES: "%d líneas", EN: "%d lines"}, strings.Count(content, "\n")+1)
		}
		return p, ""
	}
	if c := str("command", "cmd"); c != "" {
		return c, ""
	}
	// `execute` de OpenCode: JavaScript en un sandbox. Su primera línea dice de
	// qué se trata; el resto queda en el detalle de la tarjeta.
	if code := str("code", "script"); code != "" {
		first, n := firstLine(code)
		if n > 1 {
			return first, i18n.T(i18n.Msg{ES: "%d líneas", EN: "%d lines"}, n)
		}
		return first, ""
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
	return str("name", "description", "prompt"), ""
}

// patchFiles lista los archivos que toca un parche, sin repetir y en orden: los
// encabezados `*** Add|Update|Delete File: ruta` del formato de OpenCode/Codex y
// los `+++ b/ruta` de un diff unificado.
func patchFiles(patch string) []string {
	var files []string
	seen := map[string]bool{}
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" || p == "/dev/null" || seen[p] {
			return
		}
		seen[p] = true
		files = append(files, p)
	}
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case strings.HasPrefix(line, "*** Add File:"):
			add(strings.TrimPrefix(line, "*** Add File:"))
		case strings.HasPrefix(line, "*** Update File:"):
			add(strings.TrimPrefix(line, "*** Update File:"))
		case strings.HasPrefix(line, "*** Delete File:"):
			add(strings.TrimPrefix(line, "*** Delete File:"))
		case strings.HasPrefix(line, "+++ "):
			p := strings.TrimPrefix(line, "+++ ")
			if i := strings.IndexByte(p, '\t'); i >= 0 {
				p = p[:i]
			}
			add(strings.TrimPrefix(p, "b/"))
		}
	}
	return files
}

// todoSummary resume una lista de tareas: la que está en curso (o, si ninguna
// lo está, la primera con texto) y «hechas/total».
func todoSummary(todos []any) (summary, detail string) {
	done := 0
	for _, raw := range todos {
		item, _ := raw.(map[string]any)
		status, _ := item["status"].(string)
		content, _ := item["content"].(string)
		if status == "completed" {
			done++
		}
		if content != "" && (status == "in_progress" || summary == "") {
			summary = content
		}
	}
	return summary, fmt.Sprintf("%d/%d", done, len(todos))
}

// firstLine devuelve la primera línea con texto (recortada a 120 caracteres) y
// cuántas líneas tiene el bloque.
func firstLine(s string) (string, int) {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	first := strings.TrimSpace(lines[0])
	if r := []rune(first); len(r) > 120 {
		first = string(r[:120]) + "…"
	}
	return first, len(lines)
}
