package main

import (
	"fmt"
	"strings"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/git"
)

// IA agéntica sobre el módulo Git: por ahora, redactar el mensaje del commit
// preparado.
//
// Es la misma forma que ya tienen el generador de consultas y el analizador de
// planes (app_dbagent.go): la app arma el contexto determinista que ya
// conoce —acá el parche preparado, los archivos y el estilo del historial—, le
// pide UNA respuesta al agente por defecto con `AgentAskWith`, y devuelve
// texto. **El agente propone; commitear sigue siendo un clic del usuario.**
// Nada de acá stagea, commitea ni escribe un archivo.

// commitDraftDiffBudget es cuánto parche se le manda al agente, en bytes.
//
// No es un límite del modelo sino de utilidad: un commit de medio megabyte de
// diff no se resume mejor por mandarlo entero —se resume por la lista de
// archivos, que va completa igual— y sí hace que la respuesta tarde minutos.
// 64 KB cubre de sobra un commit normal; arriba de eso se recorta y se le
// avisa al agente que está viendo el principio de algo más grande.
const commitDraftDiffBudget = 64 * 1024

// commitDraftRecentCount es cuántos asuntos del historial se le muestran como
// referencia de estilo. Diez alcanza para que se note una convención y es poco
// como para que un mensaje viejo raro la contamine.
const commitDraftRecentCount = 10

// CommitDraft es el mensaje propuesto más la respuesta a "¿qué le mandaste de
// mi repositorio?", que tiene que poder contestarse igual que en el asistente
// de consultas.
type CommitDraft struct {
	// Message es el mensaje ya pelado, listo para escribir en el campo.
	Message string `json:"message"`
	// Files son los archivos preparados cuyo estado se le pasó, en el formato
	// corto de git ("M  ruta").
	Files []string `json:"files"`
	// Insertions/Deletions es el churn del commit preparado.
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
	// DiffTruncated indica que el parche se recortó por tamaño. La UI lo dice:
	// un mensaje escrito sobre parte del commit es una advertencia, no un
	// detalle de implementación.
	DiffTruncated bool `json:"diffTruncated"`
	// AgentLabel es qué agente lo escribió. Con más de un CLI instalado, "lo
	// escribió Claude Code" y "lo escribió Codex" no son lo mismo a la hora de
	// decidir si el mensaje convence.
	AgentLabel string `json:"agentLabel"`
}

// AgentDraftCommit redacta el mensaje del commit a partir de lo que está EN EL
// STAGE, con el agente por defecto de la aplicación.
//
// `agentID` vacío usa el agente activo de la app —el mismo que usan el
// analizador de EXPLAIN y el generador de consultas— y solo si no hay ninguno
// elegido cae al agente por defecto de ESTE repositorio, que es lo que usaba
// esta acción antes de que existiera el agente de aplicación. Con un id
// explícito se pide la misma redacción a otro proveedor sin cambiar el activo.
//
// Trabaja sobre el stage y no sobre el working tree a propósito: el mensaje
// describe el commit que se va a hacer, y lo que no está preparado no entra en
// ese commit.
func (a *App) AgentDraftCommit(repoID, agentID string) (CommitDraft, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return CommitDraft{}, err
	}

	status, err := a.gitRunner.GetStatus(path)
	if err != nil {
		return CommitDraft{}, err
	}
	files := []string{}
	for _, f := range status.Files {
		if !f.Staged {
			continue
		}
		line := fmt.Sprintf("%s%s  %s", f.IndexStatus, f.WorkStatus, f.Path)
		if f.OrigPath != "" {
			line += " (antes " + f.OrigPath + ")"
		}
		files = append(files, line)
	}
	if len(files) == 0 {
		return CommitDraft{}, fmt.Errorf("app: no hay nada preparado — agregá archivos al stage y el mensaje se redacta sobre eso")
	}

	diff, err := a.gitRunner.GetDiff(path, git.DiffTarget{Mode: "staged"})
	if err != nil {
		return CommitDraft{}, err
	}

	patch, truncated := truncatePatch(diff.Patch, commitDraftDiffBudget)

	// El historial es opcional: un repositorio recién inicializado no tiene
	// ninguno, y eso no puede impedir escribir su primer mensaje.
	recent := []string{}
	if log, lerr := a.gitRunner.GetCommitLog(path, git.LogOptions{MaxCount: commitDraftRecentCount}); lerr == nil {
		for _, c := range log {
			if s := strings.TrimSpace(c.Subject); s != "" {
				recent = append(recent, s)
			}
		}
	}

	agentID, label, err := a.commitDraftAgent(repoID, agentID)
	if err != nil {
		return CommitDraft{}, err
	}

	answer, err := a.AgentAskWith(agentID, agentctx.CommitPrompt(agentctx.CommitDraftInput{
		Branch:        status.Branch,
		Files:         files,
		Diff:          patch,
		DiffTruncated: truncated,
		Recent:        recent,
		Insertions:    diff.Stat.Insertions,
		Deletions:     diff.Stat.Deletions,
	}), "git", repoID)
	if err != nil {
		return CommitDraft{}, err
	}

	message := agentctx.CleanCommitMessage(answer)
	if message == "" {
		return CommitDraft{}, fmt.Errorf("app: %s no devolvió ningún mensaje", label)
	}

	return CommitDraft{
		Message:       message,
		Files:         files,
		Insertions:    diff.Stat.Insertions,
		Deletions:     diff.Stat.Deletions,
		DiffTruncated: truncated,
		AgentLabel:    label,
	}, nil
}

// commitDraftAgent resuelve CON QUÉ agente se redacta y cómo se llama.
//
// El orden importa y es el que hace que el botón no mienta: lo elegido a mano
// para esta redacción, después el agente activo de la app, y recién al final el
// por defecto del repositorio. Ese último escalón existe solo para no romperle
// la acción a quien lo eligió cuando esto vivía dentro de la pestaña Git.
func (a *App) commitDraftAgent(repoID, agentID string) (string, string, error) {
	if agentID == "" {
		active, err := a.AgentActive()
		if err != nil {
			return "", "", err
		}
		if active.ID != "" {
			// El label se resuelve abajo igual que para uno explícito: el
			// guardado puede haberse desinstalado, y ahí el error tiene que
			// decir cuál falta.
			agentID = active.ID
		} else if ws, werr := a.vault.GitRepoWorkspaceFor(repoID); werr == nil && ws.DefaultAgent != "" {
			agentID = ws.DefaultAgent
		} else {
			return "", "", fmt.Errorf("app: no hay ningún agente elegido — elegí uno en la barra de agente")
		}
	}
	agent, err := a.agentByID(agentID)
	if err != nil {
		return "", "", err
	}
	return agentID, agent.Label, nil
}

// truncatePatch recorta un parche a un presupuesto de bytes, siempre en un
// límite de línea: cortar a la mitad de una línea de diff deja un parche que se
// lee como si el cambio fuera otro.
func truncatePatch(patch string, budget int) (string, bool) {
	if len(patch) <= budget {
		return patch, false
	}
	cut := patch[:budget]
	if i := strings.LastIndexByte(cut, '\n'); i > 0 {
		cut = cut[:i]
	}
	return cut, true
}
