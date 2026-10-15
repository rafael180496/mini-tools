package main

import (
	"fmt"
	"strings"

	"mini-tools/backend/git"
	"mini-tools/backend/i18n"
)

// «Validar con otro agente»: el contexto que se le entrega al revisor.
//
// Un CLI en modo consulta muchas veces no puede ni correr `git diff`, así que
// pedirle «revisá el diff» sin dárselo era pedirle que adivinara. Esto arma lo
// que el revisor necesita ver —los archivos con su estado y el parche— y la UI
// lo adjunta al mensaje como una ficha desplegable: el contexto tiene que
// VERSE, no viajar a escondidas. Es solo lectura: no stagea ni escribe nada.

// reviewDiffBudget es cuánto parche se adjunta, en bytes, sumando lo preparado
// y lo sin preparar.
//
// Es menos que el del borrador de commit (64 KB) porque acá el parche va a un
// chat que alguien lee y a un agente que tiene que contestar con referencias a
// archivo y línea: 48 KB alcanzan para una tanda de cambios normal, y arriba de
// eso una revisión útil sale de leer los archivos, no de un diff gigante. Al
// pasarse se recorta en un límite de línea y `Truncated` lo declara.
const reviewDiffBudget = 48 * 1024

// ReviewContext es lo que se le muestra y se le manda al agente revisor.
type ReviewContext struct {
	// Files son todos los archivos con cambios en formato corto de git
	// ("M  ruta", " M ruta", "?? ruta"), incluidos los sin seguimiento: esos no
	// salen en ningún diff, así que van por nombre.
	Files []string `json:"files"`
	// Diff es el parche: primero lo preparado y después lo sin preparar, cada
	// parte con su rótulo. Vacío si solo hay archivos sin seguimiento.
	Diff string `json:"diff"`
	// Truncated indica que el parche se recortó por tamaño. La UI lo avisa: un
	// revisor que cree haber visto todo y vio la mitad da una revisión falsa.
	Truncated bool `json:"truncated"`
	// Insertions/Deletions es el churn de lo preparado más lo sin preparar.
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
}

// GitReviewContext arma el diff del árbol de trabajo —preparado y sin
// preparar— más la lista de archivos, para adjuntárselo al agente que valida el
// trabajo de otro. Sin cambios devuelve un error claro: no hay nada que revisar
// y la UI manda entonces solo el resumen de lo que hizo el primer agente.
func (a *App) GitReviewContext(repoID string) (ReviewContext, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return ReviewContext{}, err
	}
	status, err := a.gitRunner.GetStatus(path)
	if err != nil {
		return ReviewContext{}, err
	}
	if len(status.Files) == 0 {
		return ReviewContext{}, i18n.Errorf(i18n.Msg{ES: "app: no hay cambios sin commitear para revisar", EN: "app: there are no uncommitted changes to review"})
	}

	rc := ReviewContext{Files: make([]string, 0, len(status.Files))}
	var staged, worktree []string
	for _, f := range status.Files {
		line := fmt.Sprintf("%s%s %s", f.IndexStatus, f.WorkStatus, f.Path)
		if f.OrigPath != "" {
			line += " " + i18n.T(i18n.Msg{ES: "(antes %s)", EN: "(was %s)"}, f.OrigPath)
		}
		rc.Files = append(rc.Files, line)
		if f.Staged {
			staged = append(staged, f.Path)
		}
		if !f.Untracked && f.WorkStatus != " " {
			worktree = append(worktree, f.Path)
		}
	}

	stagedPatch, ins, del := a.reviewPatch(path, "staged", staged)
	rc.Insertions, rc.Deletions = ins, del
	worktreePatch, ins, del := a.reviewPatch(path, "worktree", worktree)
	rc.Insertions += ins
	rc.Deletions += del

	var sections []string
	if strings.TrimSpace(stagedPatch) != "" {
		sections = append(sections, i18n.T(i18n.Msg{ES: "# Preparado (staged)", EN: "# Staged"})+"\n"+strings.TrimRight(stagedPatch, "\n"))
	}
	if strings.TrimSpace(worktreePatch) != "" {
		sections = append(sections, i18n.T(i18n.Msg{ES: "# Sin preparar (árbol de trabajo)", EN: "# Unstaged (working tree)"})+"\n"+strings.TrimRight(worktreePatch, "\n"))
	}
	rc.Diff, rc.Truncated = truncatePatch(strings.Join(sections, "\n\n"), reviewDiffBudget)
	return rc, nil
}

// reviewPatch devuelve el parche de un modo (preparado o sin preparar) y su
// churn. Un error de git no tumba el resto: se devuelve vacío, porque un
// revisor con la lista de archivos y la mitad del diff sirve más que ninguno.
//
// Si git declara el parche entero ilegible (`GetDiff` lo vacía apenas UN
// archivo es binario), se repite archivo por archivo para no perder los de
// texto por culpa de una imagen.
func (a *App) reviewPatch(repoPath, mode string, files []string) (string, int, int) {
	if len(files) == 0 {
		return "", 0, 0
	}
	whole, err := a.gitRunner.GetDiff(repoPath, git.DiffTarget{Mode: mode})
	if err != nil {
		return "", 0, 0
	}
	if !whole.IsBinary {
		return whole.Patch, whole.Stat.Insertions, whole.Stat.Deletions
	}
	var b strings.Builder
	ins, del := whole.Stat.Insertions, whole.Stat.Deletions
	for _, p := range files {
		one, oerr := a.gitRunner.GetDiff(repoPath, git.DiffTarget{Mode: mode, Path: p})
		if oerr != nil {
			continue
		}
		if one.IsBinary || strings.TrimSpace(one.Patch) == "" {
			b.WriteString(i18n.T(i18n.Msg{ES: "(sin parche de texto: %s)", EN: "(no text patch: %s)"}, p))
			b.WriteString("\n")
			continue
		}
		b.WriteString(strings.TrimRight(one.Patch, "\n"))
		b.WriteString("\n")
	}
	return b.String(), ins, del
}
