package main

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/appdata"
	"mini-tools/backend/i18n"
	"mini-tools/backend/mcpconf"
)

// Reglas de permiso de Antigravity para las herramientas MCP de mini-tools
// (`permissions.allow` de ~/.gemini/antigravity-cli/settings.json). El porqué
// y lo medido con el `agy` real están en backend/mcpconf/agyperm.go y en la
// sección «Antigravity» de .claude/specs/chat-cli-permisos.md.
//
// En corto: en `agy -p` toda herramienta MCP sin una regla `mcp(<servidor>/
// <herramienta>)` se auto-deniega y el turno termina sin respuesta. mini-tools
// agrega esas reglas —una por herramienta de su catálogo, sin comodines— y:
//
//   - las sincroniza al preparar cada turno de Antigravity (con el MCP
//     encendido) y al **Conectar** Antigravity;
//   - respeta **Quitar**: un marcador en la carpeta de datos de la app hace que
//     no se repongan solas hasta «Volver a sincronizar» o «Reparar permisos»;
//   - nunca toca nada que no sea una regla `mcp(mini-tools/…)`: el
//     ~/.gemini es del usuario.
//
// A diferencia de ScadLab no hay marca de modo por turno: el servidor MCP de
// mini-tools no tiene herramientas que dependan del modo del chat. La
// consecuencia aceptada de que la regla sea global es que la terminal
// interactiva de Antigravity tampoco pregunta antes de usarlas; se dice en el
// aviso y en la pantalla, y **Quitar** lo revierte.

// agyPermsOffFile es la marca, en la carpeta de datos de la app, de que el
// usuario quitó las reglas desde Acceso de la IA. Mientras exista, no se
// reponen solas.
const agyPermsOffFile = "antigravity-permissions-off"

// agySettingsPath es el settings.json que se gestiona. Variable para que los
// tests no dependan de la forma en que cada sistema resuelve el home.
var agySettingsPath = mcpconf.AgySettingsPath

// agyPermSyncMu serializa las escrituras al archivo: dos turnos seguidos, o un
// turno y el botón Reparar, no deben leer-modificar-escribir a la vez.
var agyPermSyncMu sync.Mutex

func agyMarkerPath() string {
	dir, err := appdata.Dir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, agyPermsOffFile)
}

// agyPermsManaged es si la app mantiene las reglas al día (el usuario no las
// quitó a propósito). Sin carpeta de datos se asume que sí.
func agyPermsManaged() bool {
	path := agyMarkerPath()
	if path == "" {
		return true
	}
	_, err := os.Stat(path)
	return errors.Is(err, fs.ErrNotExist)
}

func setAgyPermsManaged(managed bool) error {
	path := agyMarkerPath()
	if path == "" {
		return nil
	}
	if managed {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	return os.WriteFile(path, []byte("El usuario quitó los permisos de mini-tools de Antigravity desde Acceso de la IA.\n"), 0o600)
}

// agyServer es el nombre con el que Antigravity tiene registrado a mini-tools
// (el que escribió Conectar, o el que le puso quien lo agregó a mano).
func agyServer() string { return miniToolsServerName("antigravity") }

// agyPermTools son los nombres del catálogo MCP, uno por regla.
func (a *App) agyPermTools() []string {
	infos := a.mcpTools()
	names := make([]string, 0, len(infos))
	for _, t := range infos {
		names = append(names, t.Name)
	}
	return names
}

// agySyncResult es lo que pasó al sincronizar.
type agySyncResult struct {
	Path    string
	Added   int
	Removed int
	// Skipped: no se tocó nada porque no se sabe dónde está el archivo o porque
	// el usuario quitó las reglas y no se pidió forzar.
	Skipped bool
	Err     error
}

// Changed es si se escribió el archivo.
func (r agySyncResult) Changed() bool { return r.Added+r.Removed > 0 }

// syncAgyPermissionsAt deja en el archivo exactamente una regla por
// herramienta de tools para ese servidor. Con force=false respeta que el
// usuario las haya quitado. Un archivo que no es JSON válido no se pisa: es un
// error, no un archivo que reparar a la fuerza.
func syncAgyPermissionsAt(path, server string, tools []string, force bool) agySyncResult {
	agyPermSyncMu.Lock()
	defer agyPermSyncMu.Unlock()
	res := agySyncResult{Path: path}
	if path == "" || (!force && !agyPermsManaged()) {
		res.Skipped = true
		return res
	}
	st, err := mcpconf.AgyPermStatus(path, server, tools)
	if err != nil {
		res.Err = err
		return res
	}
	if !st.Valid {
		res.Err = errors.New(st.Problem)
		return res
	}
	if st.Synced {
		return res
	}
	if _, err := mcpconf.SyncAgyPermissions(path, server, tools); err != nil {
		res.Err = err
		return res
	}
	res.Added, res.Removed = len(st.Missing), len(st.Extra)
	return res
}

func (a *App) syncAgyPermissions(force bool) agySyncResult {
	res := syncAgyPermissionsAt(agySettingsPath(), agyServer(), a.agyPermTools(), force)
	switch {
	case res.Err != nil:
		log.Printf("permisos de Antigravity en %s: %v", res.Path, res.Err)
	case res.Changed():
		log.Printf("permisos de Antigravity en %s: %d reglas agregadas, %d quitadas", res.Path, res.Added, res.Removed)
	}
	return res
}

// removeAgyPermissions quita solo las reglas `mcp(mini-tools/…)`. Devuelve si
// escribió.
func removeAgyPermissions() (bool, error) {
	agyPermSyncMu.Lock()
	defer agyPermSyncMu.Unlock()
	return mcpconf.RemoveAgyPermissions(agySettingsPath(), agyServer())
}

var (
	msgAgySynced = i18n.Msg{
		ES: "mini-tools actualizó los permisos de Antigravity en %s (reglas `mcp(%s/…)` agregadas: %d, quitadas: %d): sin ellas Antigravity bloquea las herramientas en modo no interactivo. Valen para todo Antigravity, así que su terminal tampoco pedirá confirmación para las herramientas de mini-tools. Se quitan en Configuración → Acceso de la IA.",
		EN: "mini-tools updated Antigravity's permissions in %s (`mcp(%s/…)` rules added: %d, removed: %d): without them Antigravity blocks the tools in non-interactive mode. They apply to all of Antigravity, so its terminal will not ask for confirmation for mini-tools' tools either. You can remove them in Settings → AI Access.",
	}
	msgAgySyncFailed = i18n.Msg{
		ES: "mini-tools no pudo aprobar sus herramientas en Antigravity (%s): sin esa aprobación las bloquea en modo no interactivo y este turno puede terminar sin respuesta. Arreglá el archivo y usá «Reparar permisos» en Configuración → Acceso de la IA.",
		EN: "mini-tools could not approve its tools in Antigravity (%s): without that approval Antigravity blocks them in non-interactive mode and this turn may end without a reply. Fix the file and use “Repair permissions” in Settings → AI Access.",
	}
	msgAgyNoSettings = i18n.Msg{
		ES: "app: no se pudo ubicar el settings.json de Antigravity en este equipo",
		EN: "app: couldn't locate Antigravity's settings.json on this computer",
	}
	msgAgyPermsFailed = i18n.Msg{
		ES: "app: no se pudieron actualizar los permisos de Antigravity (%s): %w",
		EN: "app: couldn't update Antigravity's permissions (%s): %w",
	}
)

// agyNoticeFor traduce el resultado de una sincronización al aviso que se deja
// en el chat, o "" si no hay nada que decir: ya estaba todo, o el usuario las
// quitó a propósito. Un fallo SÍ se avisa, pero no rompe el turno.
func agyNoticeFor(res agySyncResult, server string) string {
	switch {
	case res.Skipped:
		return ""
	case res.Err != nil:
		// Los errores de mcpconf ya nombran el archivo; los demás, no.
		detail := res.Err.Error()
		if !strings.Contains(detail, res.Path) {
			detail = res.Path + ": " + detail
		}
		return agentchat.WarnNote(i18n.T(msgAgySyncFailed, detail))
	case res.Changed():
		return agentchat.WarnNote(i18n.T(msgAgySynced, res.Path, server, res.Added, res.Removed))
	}
	return ""
}

// agyTurnNotice prepara los permisos de Antigravity para un turno del chat y
// devuelve el aviso que el chat debe mostrar. Solo actúa con Antigravity y con
// el servidor MCP encendido; con cualquier otro agente es un no-op.
func (a *App) agyTurnNotice(agentID string) string {
	if agentID != "antigravity" || !a.mcpEnabled() {
		return ""
	}
	return agyNoticeFor(a.syncAgyPermissions(false), agyServer())
}

// AntigravityPermissions es el estado de las reglas de mini-tools en el
// settings.json de Antigravity, para Configuración → Acceso de la IA.
type AntigravityPermissions struct {
	// Installed es si el CLI está en esta máquina.
	Installed bool `json:"installed"`
	// MCPEnabled es si el servidor MCP de mini-tools está encendido: apagado,
	// los turnos no sincronizan nada.
	MCPEnabled bool `json:"mcpEnabled"`
	// Path es el archivo ("" si no se pudo ubicar el home).
	Path   string `json:"path"`
	Server string `json:"server"`
	Exists bool   `json:"exists"`
	// Valid es si el archivo se pudo leer como JSON con la forma esperada;
	// Problem dice por qué no, cuando no.
	Valid   bool   `json:"valid"`
	Problem string `json:"problem"`
	// Expected son las herramientas del catálogo; Approved cuántas ya tienen su
	// regla; Missing cuáles faltan; Stale cuántas reglas propias sobran
	// (herramientas que ya no existen).
	Expected int      `json:"expected"`
	Approved int      `json:"approved"`
	Missing  []string `json:"missing"`
	Stale    int      `json:"stale"`
	// RemovedByUser: las quitaste desde aquí y la app no las repone sola hasta
	// «Volver a sincronizar».
	RemovedByUser bool `json:"removedByUser"`
}

// agyRuleTool saca de `mcp(<servidor>/<herramienta>)` el nombre de la herramienta.
func agyRuleTool(rule string) string {
	if i := strings.Index(rule, "/"); i >= 0 {
		return strings.TrimSuffix(rule[i+1:], ")")
	}
	return rule
}

func (a *App) agyPermStatus() AntigravityPermissions {
	st := AntigravityPermissions{
		Path:          agySettingsPath(),
		Server:        agyServer(),
		MCPEnabled:    a.mcpEnabled(),
		RemovedByUser: !agyPermsManaged(),
		Missing:       []string{},
	}
	if ag, err := a.agentByID("antigravity"); err == nil {
		st.Installed = ag.Available
	}
	tools := a.agyPermTools()
	st.Expected = len(tools)
	if st.Path == "" {
		st.Problem = i18n.T(i18n.Msg{ES: "no se pudo ubicar el directorio home", EN: "couldn't locate the home directory"})
		return st
	}
	info, err := mcpconf.AgyPermStatus(st.Path, st.Server, tools)
	if err != nil {
		st.Problem = err.Error()
		return st
	}
	st.Exists, st.Valid, st.Problem = info.Exists, info.Valid, info.Problem
	st.Stale = len(info.Extra)
	for _, r := range info.Missing {
		st.Missing = append(st.Missing, agyRuleTool(r))
	}
	if st.Valid {
		st.Approved = st.Expected - len(st.Missing)
	}
	return st
}

// AntigravityPermissionsStatus lee el settings.json de Antigravity (sin
// escribir) y dice cuántas herramientas de mini-tools tienen su regla.
func (a *App) AntigravityPermissionsStatus() (AntigravityPermissions, error) {
	if err := a.requireUnlocked(); err != nil {
		return AntigravityPermissions{}, err
	}
	return a.agyPermStatus(), nil
}

// RepairAntigravityPermissions es «Volver a sincronizar» y «Reparar
// permisos»: borra la marca de «quitado» y deja las reglas del catálogo en el
// archivo aunque el usuario las hubiera quitado (la app vuelve a mantenerlas
// al día). Un archivo que no es JSON válido no se pisa y se devuelve el error.
func (a *App) RepairAntigravityPermissions() (AntigravityPermissions, error) {
	if err := a.requireUnlocked(); err != nil {
		return AntigravityPermissions{}, err
	}
	if err := setAgyPermsManaged(true); err != nil {
		return a.agyPermStatus(), err
	}
	res := a.syncAgyPermissions(true)
	if res.Path == "" {
		return a.agyPermStatus(), i18n.Errorf(msgAgyNoSettings)
	}
	if res.Err != nil {
		return a.agyPermStatus(), i18n.Errorf(msgAgyPermsFailed, res.Path, res.Err)
	}
	return a.agyPermStatus(), nil
}

// RemoveAntigravityPermissions quita las reglas `mcp(mini-tools/…)` del
// archivo —nunca otra— y deja la marca para que la app no las vuelva a agregar
// sola. La interfaz pide confirmación antes de llamarlo.
func (a *App) RemoveAntigravityPermissions() (AntigravityPermissions, error) {
	if err := a.requireUnlocked(); err != nil {
		return AntigravityPermissions{}, err
	}
	if agySettingsPath() == "" {
		return a.agyPermStatus(), i18n.Errorf(msgAgyNoSettings)
	}
	changed, err := removeAgyPermissions()
	if err != nil {
		log.Printf("quitar los permisos de Antigravity en %s: %v", agySettingsPath(), err)
		return a.agyPermStatus(), i18n.Errorf(msgAgyPermsFailed, agySettingsPath(), err)
	}
	if err := setAgyPermsManaged(false); err != nil {
		return a.agyPermStatus(), err
	}
	log.Printf("permisos de Antigravity quitados de %s (escribió: %v)", agySettingsPath(), changed)
	return a.agyPermStatus(), nil
}
