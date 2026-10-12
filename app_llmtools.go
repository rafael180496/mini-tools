package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
	"mini-tools/backend/workspace"
)

// Herramientas de un chat con un servidor de modelos (fases 4 y 5 del spec
// ia-ollama-chat-utilidades): las del servidor MCP de la app y las de archivos
// y comandos del repositorio abierto.
//
// El runner (backend/agentchat) no conoce el vault ni los permisos: recibe por
// el Turn la lista de herramientas y cómo ejecutarlas. Este archivo es donde
// se arma esa lista, con tres reglas:
//
//   - **MCP con las mismas reglas que hoy.** Mismo catálogo (`mcpTools`, que ya
//     oculta la escritura de notas si `mcpNotesWrite` está apagado), mismo
//     registro de accesos y mismo cortafuegos (`CallTool` es EXACTAMENTE lo que
//     llama el puente MCP), y solo si el servidor MCP está encendido. Sin
//     aprobación por llamada: el permiso de MCP es el interruptor.
//   - **Archivos y comandos solo con un repositorio.** El directorio de trabajo
//     es el repositorio del chat; sin él no se declaran. Los modos deciden qué
//     se declara y cuándo se pregunta (agentchat.PermissionFor).
//   - **Ask no usa herramientas.** Los botones de un solo turno (generar SQL,
//     analizar un plan, redactar un commit) son rápidos y de solo texto a
//     propósito: un botón que de pronto lee archivos o consulta una base
//     tardaría y haría cosas que nadie le pidió. Quien quiera herramientas
//     abre el chat.

// llmApprovalSeq numera las preguntas de permiso de este proceso. El prefijo
// las distingue de las del canal de los CLIs (`approve-N`): las dos comparten
// el mapa de pendientes y el evento, y un id repetido cruzaría las respuestas.
var llmApprovalSeq atomic.Uint64

// askApprovalCtx lleva una pregunta de permiso a la ventana y espera la
// respuesta, la cancelación del turno o el plazo — lo primero que ocurra. Las
// dos últimas DENIEGAN: el silencio no es un sí, y la goroutine del turno no
// puede quedar esperando un clic que ya no va a llegar.
func (a *App) askApprovalCtx(ctx context.Context, req agentapprove.Request) agentapprove.Decision {
	emit := a.approvalEmit
	if emit == nil {
		emit = func(event string, data any) { runtime.EventsEmit(a.ctx, event, data) }
	}
	return a.askApprovalWith(ctx, req, agentapprove.Timeout, emit)
}

// askApprovalWith es la lógica con el emisor y el plazo inyectados: separado
// para probarlo sin el contexto de Wails (ver runCollection).
func (a *App) askApprovalWith(ctx context.Context, req agentapprove.Request, timeout time.Duration, emit func(event string, data any)) agentapprove.Decision {
	req.ID = fmt.Sprintf("llm-approve-%d", llmApprovalSeq.Add(1))
	reply := make(chan agentapprove.Decision, 1)

	a.approveMu.Lock()
	if a.approvePending == nil {
		a.approvePending = map[string]chan agentapprove.Decision{}
	}
	a.approvePending[req.ID] = reply
	a.approveMu.Unlock()
	defer func() {
		a.approveMu.Lock()
		delete(a.approvePending, req.ID)
		a.approveMu.Unlock()
	}()

	emit("agent-approval", req)

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case d := <-reply:
		return d
	case <-ctx.Done():
		emit("agent-approval-dismiss", req.ID)
		return agentapprove.Decision{Reason: i18n.T(i18n.Msg{ES: "turno cancelado", EN: "turn cancelled"})}
	case <-timer.C:
		emit("agent-approval-dismiss", req.ID)
		return agentapprove.Decision{Reason: i18n.T(i18n.Msg{ES: "nadie respondió a tiempo", EN: "nobody answered in time"})}
	}
}

// mcpEnabled dice si el servidor MCP está encendido. Las herramientas del MCP
// se le ofrecen a un modelo solo en ese caso: apagado significa apagado.
func (a *App) mcpEnabled() bool {
	a.mcp.mu.Lock()
	defer a.mcp.mu.Unlock()
	return a.mcp.bridge != nil
}

// mcpToolDefs convierte el catálogo MCP al formato de herramientas de un
// servidor de modelos (`{type:"function", function:{name, description,
// parameters}}` en Ollama y en OpenAI; el cliente arma el sobre).
func (a *App) mcpToolDefs() []llm.ToolDef {
	infos := a.mcpTools()
	defs := make([]llm.ToolDef, 0, len(infos))
	for _, t := range infos {
		defs = append(defs, llm.ToolDef{Name: t.Name, Description: t.Description, Parameters: t.InputSchema})
	}
	return defs
}

// workspaceRoot es el directorio de trabajo de las herramientas de archivos y
// comandos: el repositorio del chat, o "" si el chat no tiene uno.
//
//   - módulo `git`: contextId es el id del repositorio.
//   - módulo `utilities`: contextId es el id del repositorio que el chat de
//     Utilidades eligió como de trabajo (si no eligió ninguno, o el id no es
//     un repositorio conocido, no hay raíz).
//
// Cualquier otro módulo (un editor SQL, una terminal SSH) trabaja en el
// directorio vacío de consultas (agentCwd): ahí no hay nada que leer ni
// escribir, y darle herramientas de archivos a esa carpeta sería ofrecer algo
// que no sirve.
func (a *App) workspaceRoot(module, contextID string) string {
	if contextID == "" || (module != "git" && module != "utilities") {
		return ""
	}
	path, err := a.gitRepo(contextID)
	if err != nil || path == "" {
		return ""
	}
	if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
		return ""
	}
	return path
}

// llmToolSet es lo que se le pasa al Turn.
type llmToolSet struct {
	Tools   []llm.ToolDef
	Run     func(ctx context.Context, name string, args map[string]any) (string, error)
	System  string
	HasCode bool
}

// buildLLMTools arma las herramientas de un turno de chat. Si no hay ninguna
// (MCP apagado y sin repositorio) devuelve un conjunto vacío y el chat se
// comporta como siempre.
func (a *App) buildLLMTools(module, contextID string, mode agentchat.Mode) llmToolSet {
	var set llmToolSet
	var code *agentchat.CodeTools
	mcpNames := map[string]bool{}

	if root := a.workspaceRoot(module, contextID); root != "" {
		shellID := ""
		if s, err := a.vault.GetSettings(); err == nil {
			shellID = s.LocalShell
		}
		ws, err := workspace.New(root, workspace.Options{ShellID: shellID})
		if err != nil {
			// El chat sigue sin herramientas de archivos en vez de fallar: el
			// directorio pudo borrarse entre que se eligió y ahora.
			log.Printf("herramientas de archivos del chat: %v", err)
		} else {
			code = agentchat.NewCodeTools(ws, mode, a.askApprovalCtx)
			set.Tools = append(set.Tools, code.Defs()...)
			set.System = code.SystemNote()
			set.HasCode = true
		}
	}
	if a.mcpEnabled() {
		for _, d := range a.mcpToolDefs() {
			mcpNames[d.Name] = true
			set.Tools = append(set.Tools, d)
		}
	}

	set.Run = func(ctx context.Context, name string, args map[string]any) (string, error) {
		switch {
		case code != nil && code.Owns(name):
			return code.Run(ctx, name, args)
		case mcpNames[name]:
			if !a.mcpEnabled() {
				return "", i18n.Errorf(i18n.Msg{ES: "el servidor MCP está apagado", EN: "the MCP server is off"})
			}
			// CallTool es lo que llama el puente MCP: comprueba el vault,
			// ejecuta y deja el acceso en el registro (recordMCPAccess).
			return a.CallTool(name, args)
		}
		return "", i18n.Errorf(i18n.Msg{ES: "herramienta desconocida: %s", EN: "unknown tool: %s"}, name)
	}
	return set
}

// attachLLMTools completa el Turno de un chat con las herramientas que le
// correspondan.
func (a *App) attachLLMTools(t *agentchat.Turn, module, contextID string) {
	set := a.buildLLMTools(module, contextID, t.Mode)
	if len(set.Tools) == 0 {
		return
	}
	t.Tools, t.RunTool, t.System = set.Tools, set.Run, set.System
}
