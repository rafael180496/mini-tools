package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/i18n"
	"mini-tools/backend/vault"
)

// Proyectos de un chat con un servidor de modelos: repositorios git o carpetas.
//
// Un repositorio de git ya existía como destino de las herramientas de archivos
// y comandos (workspaceRoot). Esto suma las CARPETAS: cualquier directorio del
// disco, con o sin git. Se guardan en agent_workspaces (migración 61) y el
// contexto de un chat las nombra como `ws:<id>`; un id sin prefijo sigue siendo
// el de un repositorio git.
//
// El confinamiento no cambia: la raíz de las herramientas es esa carpeta y
// nada de lo que pida el modelo sale de ella (backend/workspace).

// AgentWorkspace es una carpeta registrada, ya resuelta para la UI. Los
// repositorios git NO salen de acá: siguen viniendo de GitListRepos.
type AgentWorkspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
	// IsGit: la carpeta tiene un `.git` (por ejemplo, un proyecto al que se
	// le hizo `git init` después de agregarlo).
	IsGit bool `json:"isGit"`
	// Exists: la carpeta sigue en el disco. Una que se movió o se borró se
	// sigue listando —para poder quitarla— pero el chat que la usa trabaja sin
	// herramientas de archivos.
	Exists bool `json:"exists"`
}

// WorkspaceContextInfo es lo que se le está pasando al modelo del proyecto de
// un chat, sin el texto: para que la pantalla muestre qué se cargó.
type WorkspaceContextInfo struct {
	Root         string                     `json:"root"`
	IsGit        bool                       `json:"isGit"`
	Branch       string                     `json:"branch"`
	Instructions []agentctx.InstructionInfo `json:"instructions"`
	Skills       []agentctx.SkillInfo       `json:"skills"`
	// TotalChars son los caracteres de instrucciones que entraron al prompt
	// (el tope es agentctx.MaxInstructionChars).
	TotalChars int `json:"totalChars"`
}

// userHomeDir se inyecta en las pruebas de la validación de carpetas.
var userHomeDir = os.UserHomeDir

// llmProjectHome es el home desde el que se cargan las instrucciones y los
// skills GLOBALES de un chat. Vacío = el del usuario. Existe para que las
// pruebas no lean el ~/.claude real de quien las corre.
var llmProjectHome = ""

// parseWorkspaceContext reconoce el contexto `ws:<id>` y devuelve el id.
func parseWorkspaceContext(contextID string) (id string, ok bool) {
	id, ok = strings.CutPrefix(contextID, vault.AgentWorkspaceContextPrefix)
	if !ok || id == "" {
		return "", false
	}
	return id, true
}

// agentWorkspacePath resuelve el id de una carpeta a su ruta, tras comprobar
// que el vault está desbloqueado. Es el único lugar donde un id de carpeta se
// vuelve una ruta, igual que gitRepo para los repositorios.
func (a *App) agentWorkspacePath(id string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	w, err := a.vault.GetAgentWorkspace(id)
	if err != nil {
		return "", err
	}
	return w.Path, nil
}

// ListAgentWorkspaces devuelve las carpetas de trabajo registradas (solo
// carpetas: los repositorios git vienen de GitListRepos).
func (a *App) ListAgentWorkspaces() ([]AgentWorkspace, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	rows, err := a.vault.ListAgentWorkspaces()
	if err != nil {
		return nil, err
	}
	out := make([]AgentWorkspace, 0, len(rows))
	for _, w := range rows {
		out = append(out, toAgentWorkspace(w))
	}
	return out, nil
}

func toAgentWorkspace(w vault.AgentWorkspace) AgentWorkspace {
	out := AgentWorkspace{ID: w.ID, Name: w.Name, Path: w.Path}
	if fi, err := os.Stat(w.Path); err == nil && fi.IsDir() {
		out.Exists = true
		_, gitErr := os.Stat(filepath.Join(w.Path, ".git"))
		out.IsGit = gitErr == nil
	}
	return out
}

// PickAgentWorkspaceFolder abre el selector nativo de carpetas y devuelve la
// elegida, o "" si se canceló. No valida ni guarda nada: eso lo hace
// AddAgentWorkspace.
func (a *App) PickAgentWorkspaceFolder() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: i18n.T(i18n.Msg{ES: "Elegir la carpeta del proyecto", EN: "Choose the project folder"}),
	})
}

// AddAgentWorkspace registra una carpeta como proyecto de trabajo.
//
// Rechaza lo que no es una carpeta absoluta y existente, y las demasiado
// amplias: la raíz del disco, el home del usuario y cualquier carpeta que
// CONTENGA al home (/Users, C:\Users). Las herramientas del chat leen y
// escriben dentro de esa carpeta, y darle a un modelo todo el home —claves
// SSH, el vault, los dotfiles— es el error que esta comprobación existe para
// evitar. Una subcarpeta del home (~/proyectos/x) sí se acepta.
//
// Es idempotente: la misma carpeta (por ruta limpia o por ruta real, así un
// enlace simbólico no duplica la entrada) devuelve la ya registrada. name
// vacío = el nombre de la carpeta.
func (a *App) AddAgentWorkspace(path, name string) (AgentWorkspace, error) {
	if err := a.requireUnlocked(); err != nil {
		return AgentWorkspace{}, err
	}
	clean, err := validateWorkspaceFolder(path)
	if err != nil {
		return AgentWorkspace{}, err
	}

	existing, err := a.vault.ListAgentWorkspaces()
	if err != nil {
		return AgentWorkspace{}, err
	}
	real := realPath(clean)
	for _, w := range existing {
		if samePath(w.Path, clean) || samePath(realPath(w.Path), real) {
			return toAgentWorkspace(w), nil
		}
	}

	name = strings.TrimSpace(name)
	if name == "" {
		name = filepath.Base(clean)
	}
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	w, err := a.vault.AddAgentWorkspace(name, clean)
	if err != nil {
		return AgentWorkspace{}, err
	}
	return toAgentWorkspace(*w), nil
}

// RemoveAgentWorkspace quita la carpeta de la lista (y los chats que la
// usaban). No toca nada en el disco.
func (a *App) RemoveAgentWorkspace(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.RemoveAgentWorkspace(id)
}

// AgentWorkspaceContext dice qué instrucciones y skills se le están pasando al
// modelo del proyecto de un chat. Sin proyecto (o con uno que ya no existe)
// devuelve un resultado vacío, no un error: la pantalla solo no muestra nada.
func (a *App) AgentWorkspaceContext(module, contextID string) (WorkspaceContextInfo, error) {
	if err := a.requireUnlocked(); err != nil {
		return WorkspaceContextInfo{}, err
	}
	out := WorkspaceContextInfo{Instructions: []agentctx.InstructionInfo{}, Skills: []agentctx.SkillInfo{}}
	root := a.workspaceRoot(module, contextID)
	if root == "" {
		return out, nil
	}
	pc := a.projectContext(root)
	out.Root, out.IsGit, out.Branch = pc.Root, pc.IsGit, pc.Branch
	out.Instructions, out.Skills = pc.Info()
	out.TotalChars = pc.TotalChars
	return out, nil
}

// projectContext descubre las instrucciones y los skills de una raíz.
func (a *App) projectContext(root string) agentctx.ProjectContext {
	return agentctx.LoadProject(agentctx.ProjectOptions{Root: root, Home: llmProjectHome})
}

// validateWorkspaceFolder comprueba que path sea una carpeta aceptable y
// devuelve su ruta limpia.
func validateWorkspaceFolder(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "falta la ruta de la carpeta", EN: "the folder path is missing"})
	}
	if !filepath.IsAbs(path) {
		return "", i18n.Errorf(i18n.Msg{ES: "la ruta tiene que ser absoluta: %q", EN: "the path must be absolute: %q"}, path)
	}
	clean := filepath.Clean(path)
	fi, err := os.Stat(clean)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "la carpeta %q no existe o no se puede leer: %w", EN: "the folder %q does not exist or cannot be read: %w"}, clean, err)
	}
	if !fi.IsDir() {
		return "", i18n.Errorf(i18n.Msg{ES: "%q no es una carpeta", EN: "%q is not a folder"}, clean)
	}
	if isTooBroad(clean) {
		return "", i18n.Errorf(i18n.Msg{
			ES: "la carpeta %q es demasiado amplia (es la raíz del disco, tu carpeta personal o una que la contiene): elegí la carpeta de un proyecto",
			EN: "the folder %q is too broad (it is the disk root, your home folder or one that contains it): choose a project folder",
		}, clean)
	}
	return clean, nil
}

// isTooBroad dice si p es la raíz del sistema de archivos, el home del usuario
// o un ancestro del home. Se comprueba con la ruta tal cual y con la real
// (symlinks resueltos): un enlace al home no es una forma de esquivarlo.
func isTooBroad(p string) bool {
	for _, cand := range []string{p, realPath(p)} {
		if filepath.Dir(cand) == cand {
			return true
		}
		home, err := userHomeDir()
		if err != nil || home == "" {
			continue
		}
		for _, h := range []string{filepath.Clean(home), realPath(home)} {
			// p contiene a h (o es h) si h, relativo a p, no sube.
			if rel, err := filepath.Rel(cand, h); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}

func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

func samePath(a, b string) bool {
	rel, err := filepath.Rel(filepath.Clean(a), filepath.Clean(b))
	return err == nil && rel == "."
}
