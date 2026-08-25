package vault

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// OpenTabInfo is one restorable editor tab: its file path, plus which
// connection/language it was bound to (both optional — a tab can be
// unbound). See SetOpenTabs.
type OpenTabInfo struct {
	Path string `json:"path"`
	// ConnID is empty when the tab has no connection bound — never
	// resolved/validated here, the frontend drops the binding on restore if
	// the connection no longer exists (same "no code needed, the pool
	// simply never opens" story DeleteConnection cleanup already relies on).
	ConnID string `json:"connId,omitempty"`
	// Language is only meaningful while ConnID is empty (an unbound tab's
	// manually-picked editor language) — once a connection is bound, the
	// frontend derives the language from that connection's dbType instead
	// of trusting whatever was last persisted here.
	Language string `json:"language,omitempty"`
	// Kind distinguishes a plain CodeMirror editor tab ("", the zero value
	// — read as "editor") from a Redis Browser tab ("redis-browser"),
	// which has no file content to restore, only a ConnID to reopen
	// against.
	Kind string `json:"kind,omitempty"`
}

// Settings holds non-sensitive app preferences. Unlike connections'
// encrypted_dsn, nothing here is encrypted — see the settings table comment
// in store.go for why it's readable/writable even while the vault is
// locked.
type Settings struct {
	Theme string `json:"theme"`
	// OpenTabs is the last known set of open editor tabs (path + optional
	// connection/language binding), in tab order, so the workspace can
	// restore them on the next launch — see SetOpenTabs.
	OpenTabs []OpenTabInfo `json:"openTabs"`
	// SidebarCollapsed persists whether the sidebar is hidden altogether
	// (toggled from its header) — see SetSidebarCollapsed. It used to mean
	// the icon-only rail mode, which the master menu replaced: the menu is
	// already the compact form, so the remaining useful state is simply
	// "give the editor the whole width".
	SidebarCollapsed bool `json:"sidebarCollapsed"`
	// EditorHeight is the SQL editor pane's height in pixels, dragged via
	// the resize handle between the editor and the results grid — see
	// SetEditorHeight. Defaults to 256 (the old fixed h-64 Tailwind class).
	EditorHeight int `json:"editorHeight"`
	// GitSideWidth/GitDiffWidth are the Git tab's left (branches) and right
	// (diff) pane widths in pixels, dragged by the user — same "persist a
	// dragged size" pattern as EditorHeight. Clamped on write, not here.
	GitSideWidth int `json:"gitSideWidth"`
	GitDiffWidth int `json:"gitDiffWidth"`
	// Diff viewer preferences. GitDiffContext is the number of unchanged lines
	// shown around each change (git's -U); GitDiffIgnoreWs drops
	// whitespace-only changes; GitDiffWrap toggles line wrapping.
	GitDiffContext  int  `json:"gitDiffContext"`
	GitDiffIgnoreWs bool `json:"gitDiffIgnoreWs"`
	GitDiffWrap     bool `json:"gitDiffWrap"`
	// QueryPageSize es cuántas filas trae cada página de resultados; 0 = todas
	// (sin paginar). Ver backend/query/paging.go.
	QueryPageSize int `json:"queryPageSize"`
	// RememberMasterKey reflects the "Recordar clave" toggle — whether
	// TryAutoUnlock should try the OS keychain at startup. The flag itself
	// is harmless to read while locked (it's just an on/off preference);
	// the actual secret it gates lives only in the OS keychain, never here
	// — see backend/vault/remember.go.
	RememberMasterKey bool `json:"rememberMasterKey"`
	// EditorTheme is the CodeMirror color theme id (one of
	// frontend/src/codemirror/themes.ts's registry, e.g. "auto",
	// "githubDark", "dracula") — "auto" (the default) follows the app's own
	// dark/light Theme above instead of naming a fixed CodeMirror theme.
	EditorTheme string `json:"editorTheme"`
	// EditorAppearance is everything else about how the editors look and
	// behave. It is a nested struct rather than six more flat fields
	// because the six travel together: the settings dialog edits them as
	// one group and every editor consumes them as one group. EditorTheme
	// stays flat above only because it predates this and is already wired
	// through half the frontend — moving it would be churn for symmetry.
	EditorAppearance EditorAppearance `json:"editorAppearance"`
	// SidebarModule is which sidebar module the master menu has open —
	// "connections", "ssh", "git" or "notes". The sidebar shows one at a
	// time, so this is a single id and not a set; empty means "the default"
	// and lets the frontend decide, rather than baking a module name into
	// the schema. See SetSidebarModule.
	SidebarModule string `json:"sidebarModule"`
	// SidebarWidth is the sidebar's dragged width in pixels — same
	// "persist a dragged size" pattern as EditorHeight/GitSideWidth. 0 means
	// never dragged, so the frontend applies its own default. Clamped on
	// write, not here.
	SidebarWidth int `json:"sidebarWidth"`
	// SshTerminalTheme is the xterm.js color theme id (one of
	// frontend/src/xterm/terminalThemes.ts's registry, e.g. "auto",
	// "dracula", "nord") — same "auto follows the app's own dark/light
	// Theme" convention as EditorTheme above, just for the SSH terminal
	// instead of the SQL editor. One global setting, not per-connection —
	// same reasoning as EditorTheme.
	SshTerminalTheme string `json:"sshTerminalTheme"`
	// LocalShell is which shell the integrated local terminal launches (a
	// backend/localterm.Shell id: "zsh", "bash", "pwsh", "gitbash", …).
	// Empty — the default — means "whatever this machine already uses"
	// ($SHELL on Unix, the newest installed PowerShell on Windows), resolved
	// at open time rather than materialised here: the vault travels between
	// machines via backup/restore, so a hardcoded id could name a shell the
	// current machine doesn't have. See localterm.lookupShell's fallback.
	LocalShell string `json:"localShell"`
	// GitTermDock es dónde va anclada la terminal del módulo Git:
	// "bottom" (default), "left" o "right". Junto con los cuatro campos que
	// siguen forma el layout de la pestaña Git, que se persiste entero para
	// que la app abra exactamente como se dejó — ver SetGitLayout.
	GitTermDock string `json:"gitTermDock"`
	// GitTermSize es el alto del panel cuando está abajo, o su ancho cuando
	// está a un costado. Un solo número para las dos orientaciones a
	// propósito (ver la migración 27).
	GitTermSize int `json:"gitTermSize"`
	// GitPanelTab es qué solapa del panel quedó abierta: "" (cerrado),
	// "terminal" o "commands".
	GitPanelTab string `json:"gitPanelTab"`
	// GitPanelSessions son las sesiones que tenía abiertas el panel: una
	// terminal suelta, o una sesión de un agente de código. Se restaura la
	// LISTA, no los procesos — ver GitPanelSession.
	GitPanelSessions []GitPanelSession `json:"gitPanelSessions"`
	// GitSideHidden/GitDiffHidden ocultan el panel de ramas y el de diff.
	// Son "oculto" y no "ancho 0" porque el ancho tiene que sobrevivir a
	// ocultar y volver a mostrar: colapsar un panel no debería perder el
	// tamaño que le habías dado.
	GitSideHidden bool `json:"gitSideHidden"`
	GitDiffHidden bool `json:"gitDiffHidden"`
	// TerminalFontSize es el cuerpo de la fuente de TODAS las terminales de
	// la app (la local del módulo Git y las sesiones SSH) — ver
	// MinTerminalFontSize/MaxTerminalFontSize.
	TerminalFontSize int `json:"terminalFontSize"`
	// AutoBackupEnabled reflects the "Backup automático" toggle — whether
	// backend/autobackup.Scheduler should be ticking for this install. See
	// SetAutoBackupEnabled.
	AutoBackupEnabled bool `json:"autoBackupEnabled"`
	// AutoBackupIntervalHours is how often the automatic backup runs, in
	// hours (see MinAutoBackupIntervalHours/MaxAutoBackupIntervalHours).
	// Validated in SetAutoBackupIntervalHours, not here.
	AutoBackupIntervalHours int `json:"autoBackupIntervalHours"`
	// AutoBackupPath is the destination folder for the automatic backup —
	// the scheduler always writes the same fixed filename there, replacing
	// the previous run (unlike the timestamped manual backup from
	// BackupVault). Empty until the user picks a folder via
	// PickAutoBackupFolder; the scheduler treats an empty path as "not
	// configured yet" and stays stopped even if AutoBackupEnabled is true.
	AutoBackupPath string `json:"autoBackupPath"`
	// AutoSaveEnabled reflects the "Auto-guardar editores" toggle — whether
	// the frontend should periodically write dirty tabs that have a file path
	// back to disk. Unlike auto-backup there's no Go-side scheduler; the timer
	// lives in the frontend (Workspace.tsx), this is just the persisted
	// preference. See SetAutoSaveEnabled.
	AutoSaveEnabled bool `json:"autoSaveEnabled"`
	// AutoSaveIntervalSeconds is how often the frontend's auto-save timer
	// fires, in seconds (validated in SetAutoSaveIntervalSeconds against the
	// Min/Max bounds below).
	AutoSaveIntervalSeconds int `json:"autoSaveIntervalSeconds"`
	// ActiveAgent/ActiveModel/ActiveEffort son el agente de código elegido
	// para TODA la app (migración 33) — el chat es uno solo y se abre desde
	// cualquier módulo, así que el agente no puede ser una preferencia del
	// módulo Git. Vacío = todavía no se eligió ninguno, que no es lo mismo
	// que "ninguno disponible": la UI pregunta en vez de elegir por el
	// usuario un asistente que consume su cuota.
	//
	// El default por repositorio (`git_repos.default_agent`, migración 30) se
	// conserva y sigue teniendo prioridad cuando el contexto de trabajo es un
	// repositorio; esto es el piso para los módulos que no lo son.
	ActiveAgent  string `json:"activeAgent"`
	ActiveModel  string `json:"activeModel"`
	ActiveEffort string `json:"activeEffort"`
	// AgentDock es dónde va anclado el panel del chat unificado: "right"
	// (default), "left", "bottom" o "float" (ventana flotante). AgentSize es
	// su ancho cuando está a un costado o su alto cuando está abajo — un solo
	// número para las dos orientaciones, igual que GitTermSize.
	AgentDock string `json:"agentDock"`
	AgentSize int    `json:"agentSize"`
	// NotesLastOpen es la última nota abierta en el módulo de notas y
	// NotesSideWidth el ancho de su lista lateral (migración 36). Solo el ID:
	// el contenido se lee del vault al abrir, que es lo único correcto si la
	// nota cambió mientras tanto — mismo criterio que `git_repos.open_files`.
	NotesLastOpen  string `json:"notesLastOpen"`
	NotesSideWidth int    `json:"notesSideWidth"`
	// MCPEnabled recuerda si el servidor MCP quedó encendido la última vez.
	// **No lo enciende al arrancar**: es un recordatorio para la interfaz, no
	// un arranque automático — ver la migración 37.
	MCPEnabled bool `json:"mcpEnabled"`
	// MCPNotesWrite es si el servidor MCP puede CREAR notas. Interruptor
	// aparte del anterior a propósito: encender el servidor comparte lectura,
	// esto además deja escribir. Ver la migración 44.
	MCPNotesWrite bool `json:"mcpNotesWrite"`
	// UIFontScale es el tamaño de letra de TODA la interfaz, en porcentaje
	// (100 = el de siempre). Un multiplicador y no un cuerpo en píxeles: la
	// app no tiene un tamaño base único —cada componente pide el suyo según su
	// jerarquía— y multiplicar la conserva. 0 significa "sin elegir", que el
	// frontend lee como 100. Ver MinUIFontScale/MaxUIFontScale y la migración
	// 50.
	UIFontScale int `json:"uiFontScale"`
}

// GitPanelSession es una pestaña del panel de la pestaña Git: una terminal
// suelta, o una sesión de un agente de código (backend/agents).
//
// Se persiste la INTENCIÓN ("una shell", "una sesión de Claude Code"), nunca
// un identificador de proceso: un PTY muere con la app, así que al reabrir se
// crean procesos nuevos. Y el agente no se relanza solo al restaurar — la
// sesión abre su shell y queda esperando un clic: arrancar un asistente que
// consume cuota sin que nadie lo haya pedido en ESTA sesión es exactamente la
// clase de cosa que tiene que ser explícita.
type GitPanelSession struct {
	// Kind es "shell" o "agent".
	Kind string `json:"kind"`
	// AgentID es el id del catálogo (backend/agents) cuando Kind es "agent".
	AgentID string `json:"agentId,omitempty"`
	Title   string `json:"title"`
}

// AutoBackupIntervalHours must fall within these bounds — the scheduler
// (backend/autobackup) ticks on an interval that has to be a positive,
// bounded number of hours to make sense as a "every X hours" <select>
// (1..23, not 24 — "every 24h" and "every 0h/disabled" would be
// redundant/ambiguous).
const (
	MinAutoBackupIntervalHours = 1
	MaxAutoBackupIntervalHours = 23
)

// AutoSaveIntervalSeconds bounds — a positive, sane range for a "save every X
// seconds" timer (5s..600s = 10min); anything faster thrashes the disk, slower
// than 10min defeats the purpose.
const (
	MinAutoSaveIntervalSeconds = 5
	MaxAutoSaveIntervalSeconds = 600
)

// GetSettings returns the single settings row, seeded with defaults by Open.
func (s *Store) GetSettings() (Settings, error) {
	var theme string
	var openTabsJSON sql.NullString
	var sidebarCollapsed bool
	var editorHeight int
	var rememberMasterKey bool
	var editorTheme string
	var sidebarModule sql.NullString
	var sidebarWidth int
	var editorAppearance EditorAppearance
	var sshTerminalTheme string
	var autoBackupEnabled bool
	var autoBackupIntervalHours int
	var autoBackupPath string
	var autoSaveEnabled bool
	var autoSaveIntervalSeconds int
	var gitSideWidth, gitDiffWidth, gitDiffContext int
	var gitDiffIgnoreWs, gitDiffWrap bool
	var queryPageSize int
	var localShell string
	var gitTermDock, gitPanelTab string
	var gitTermSize, terminalFontSize int
	var gitSideHidden, gitDiffHidden bool
	var gitPanelSessionsJSON sql.NullString
	var activeAgent, activeModel, activeEffort, agentDock, notesLastOpen string
	var agentSize, notesSideWidth int
	var mcpEnabled, mcpNotesWrite bool
	var uiFontScale int
	if err := s.db.QueryRow(
		`SELECT theme, open_tabs, sidebar_collapsed, editor_height, remember_master_key, editor_theme, sidebar_module, sidebar_width, editor_font_family, editor_font_size, editor_line_wrap, editor_line_numbers, editor_tab_size, editor_toolbar, ssh_terminal_theme, auto_backup_enabled, auto_backup_interval_hours, auto_backup_path, auto_save_enabled, auto_save_interval_seconds, git_side_width, git_diff_width, git_diff_context, git_diff_ignore_ws, git_diff_wrap, query_page_size, local_shell, git_term_dock, git_term_size, git_panel_tab, git_side_hidden, git_diff_hidden, terminal_font_size, git_panel_sessions, active_agent, active_model, active_effort, agent_dock, agent_size, notes_last_open, notes_side_width, mcp_enabled, mcp_notes_write, ui_font_scale FROM settings WHERE id = 1`,
	).Scan(
		&theme, &openTabsJSON, &sidebarCollapsed, &editorHeight, &rememberMasterKey, &editorTheme, &sidebarModule, &sidebarWidth, &editorAppearance.FontFamily, &editorAppearance.FontSize, &editorAppearance.LineWrap, &editorAppearance.LineNumbers, &editorAppearance.TabSize, &editorAppearance.Toolbar, &sshTerminalTheme, &autoBackupEnabled, &autoBackupIntervalHours, &autoBackupPath, &autoSaveEnabled, &autoSaveIntervalSeconds, &gitSideWidth, &gitDiffWidth, &gitDiffContext, &gitDiffIgnoreWs, &gitDiffWrap, &queryPageSize, &localShell, &gitTermDock, &gitTermSize, &gitPanelTab, &gitSideHidden, &gitDiffHidden, &terminalFontSize, &gitPanelSessionsJSON, &activeAgent, &activeModel, &activeEffort, &agentDock, &agentSize, &notesLastOpen, &notesSideWidth, &mcpEnabled, &mcpNotesWrite, &uiFontScale,
	); err != nil {
		return Settings{}, fmt.Errorf("vault: leyendo settings: %w", err)
	}

	var openTabs []OpenTabInfo
	if openTabsJSON.Valid && openTabsJSON.String != "" {
		if err := json.Unmarshal([]byte(openTabsJSON.String), &openTabs); err != nil {
			// Backward compatibility: vault.db installs already in the wild
			// (see .claude/rules/technical.md point 13) have open_tabs
			// persisted as a plain []string from before tabs could bind a
			// connection/language. Fall back to that shape instead of
			// erroring out and losing the user's restored tabs on upgrade.
			var legacy []string
			if err2 := json.Unmarshal([]byte(openTabsJSON.String), &legacy); err2 != nil {
				return Settings{}, fmt.Errorf("vault: parseando open_tabs: %w", err)
			}
			openTabs = make([]OpenTabInfo, len(legacy))
			for i, p := range legacy {
				openTabs[i] = OpenTabInfo{Path: p}
			}
		}
	}

	// Una lista ilegible se trata como "sin sesiones guardadas" y no como un
	// error: perder el layout del panel es molesto, pero no poder leer las
	// settings deja la app entera sin tema, sin pestañas y sin nada.
	gitPanelSessions := []GitPanelSession{}
	if gitPanelSessionsJSON.Valid && gitPanelSessionsJSON.String != "" {
		var parsed []GitPanelSession
		if err := json.Unmarshal([]byte(gitPanelSessionsJSON.String), &parsed); err == nil {
			gitPanelSessions = parsed
		}
	}

	return Settings{
		Theme: theme, OpenTabs: openTabs, SidebarCollapsed: sidebarCollapsed,
		EditorHeight: editorHeight, RememberMasterKey: rememberMasterKey,
		EditorTheme: editorTheme, SidebarModule: sidebarModule.String, SidebarWidth: sidebarWidth, EditorAppearance: editorAppearance,
		SshTerminalTheme:  sshTerminalTheme,
		AutoBackupEnabled: autoBackupEnabled, AutoBackupIntervalHours: autoBackupIntervalHours,
		AutoBackupPath:          autoBackupPath,
		AutoSaveEnabled:         autoSaveEnabled,
		AutoSaveIntervalSeconds: autoSaveIntervalSeconds,
		GitSideWidth:            gitSideWidth,
		GitDiffWidth:            gitDiffWidth,
		GitDiffContext:          gitDiffContext,
		GitDiffIgnoreWs:         gitDiffIgnoreWs,
		GitDiffWrap:             gitDiffWrap,
		QueryPageSize:           queryPageSize,
		LocalShell:              localShell,
		GitTermDock:             gitTermDock,
		GitTermSize:             gitTermSize,
		GitPanelTab:             gitPanelTab,
		GitSideHidden:           gitSideHidden,
		GitDiffHidden:           gitDiffHidden,
		TerminalFontSize:        terminalFontSize,
		GitPanelSessions:        gitPanelSessions,
		ActiveAgent:             activeAgent,
		ActiveModel:             activeModel,
		ActiveEffort:            activeEffort,
		AgentDock:               agentDock,
		AgentSize:               agentSize,
		NotesLastOpen:           notesLastOpen,
		NotesSideWidth:          notesSideWidth,
		MCPEnabled:              mcpEnabled,
		MCPNotesWrite:           mcpNotesWrite,
		UIFontScale:             uiFontScale,
	}, nil
}

// SetActiveAgent persiste el agente de código elegido para toda la app, con el
// modelo y el esfuerzo con los que se lo estaba usando.
//
// Los tres en un solo UPDATE por el mismo motivo que SetGitLayout: se eligen
// desde el mismo control y en la misma interacción, y escribirlos por separado
// deja una elección a medio guardar si la app se cierra en el medio.
//
// Sin validación contra el catálogo: los ids válidos los define
// backend/agents (y los modelos, cada CLI), así que un agente desinstalado se
// resuelve al abrir el chat —mostrando que ya no está— en vez de rechazarse
// acá. Es el mismo criterio de "solo almacenamiento" de SetLocalShell, y por
// la misma razón: el vault viaja entre máquinas por backup/restore.
// agentDocks son los anclajes válidos del panel del chat. "float" es la
// ventana flotante — entra como opción y no como default, ver la migración 33.
var agentDocks = map[string]bool{"right": true, "left": true, "bottom": true, "float": true}

// SetAgentLayout persiste dónde va anclado el panel del chat y cuánto mide.
//
// Los valores fuera de rango se corrigen en vez de rechazarse, mismo criterio
// que SetGitLayout: esto lo escribe la UI en cada arrastre, y un error acá se
// traduciría en "el panel no se guarda" sin que nada lo explique. Un dock
// desconocido —el caso de un vault escrito por una versión más nueva— cae a
// "right", que es el default que toda instalación entiende.
func (s *Store) SetAgentLayout(dock string, size int) error {
	if !agentDocks[dock] {
		dock = "right"
	}
	if size < 240 {
		size = 240
	}
	if size > 1200 {
		size = 1200
	}
	if _, err := s.db.Exec(`UPDATE settings SET agent_dock = ?, agent_size = ? WHERE id = 1`, dock, size); err != nil {
		return fmt.Errorf("vault: guardando el layout del chat: %w", err)
	}
	return nil
}

// SetNotesLastOpen persiste qué nota quedó abierta, para reabrirla al arrancar.
func (s *Store) SetNotesLastOpen(noteID string) error {
	if _, err := s.db.Exec(`UPDATE settings SET notes_last_open = ? WHERE id = 1`, noteID); err != nil {
		return fmt.Errorf("vault: guardando la última nota abierta: %w", err)
	}
	return nil
}

// SetNotesSideWidth persiste el ancho de la lista de notas. Separado del
// anterior a propósito: se cambian en momentos distintos, y guardarlos juntos
// hacía que abrir una nota pisara el ancho que el usuario había dejado.
// Acotado en vez de rechazado, mismo criterio que SetAgentLayout.
func (s *Store) SetNotesSideWidth(width int) error {
	if width < 180 {
		width = 180
	}
	if width > 700 {
		width = 700
	}
	if _, err := s.db.Exec(`UPDATE settings SET notes_side_width = ? WHERE id = 1`, width); err != nil {
		return fmt.Errorf("vault: guardando el ancho de la lista de notas: %w", err)
	}
	return nil
}

func (s *Store) SetActiveAgent(agentID, model, effort string) error {
	if _, err := s.db.Exec(
		`UPDATE settings SET active_agent = ?, active_model = ?, active_effort = ? WHERE id = 1`,
		agentID, model, effort,
	); err != nil {
		return fmt.Errorf("vault: guardando el agente activo: %w", err)
	}
	return nil
}

// SetTheme persists the theme preference ("dark" or "light").
func (s *Store) SetTheme(theme string) error {
	if theme != "dark" && theme != "light" {
		return fmt.Errorf("vault: tema inválido %q", theme)
	}
	if _, err := s.db.Exec(`UPDATE settings SET theme = ? WHERE id = 1`, theme); err != nil {
		return fmt.Errorf("vault: guardando tema: %w", err)
	}
	return nil
}

// SetOpenTabs persists the current set of open editor tabs (path plus
// optional connection/language binding, in tab order) so Workspace.tsx can
// restore them the next time the app starts. Only tabs with a path are
// ever included — an unsaved scratch tab has nothing on disk to reopen, so
// its binding is session-only by the same logic.
func (s *Store) SetOpenTabs(tabs []OpenTabInfo) error {
	encoded, err := json.Marshal(tabs)
	if err != nil {
		return fmt.Errorf("vault: serializando open_tabs: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE settings SET open_tabs = ? WHERE id = 1`, string(encoded)); err != nil {
		return fmt.Errorf("vault: guardando open_tabs: %w", err)
	}
	return nil
}

// SetSidebarCollapsed persists whether the connection tree is showing as a
// full sidebar or an icon-only rail.
func (s *Store) SetSidebarCollapsed(collapsed bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET sidebar_collapsed = ? WHERE id = 1`, collapsed); err != nil {
		return fmt.Errorf("vault: guardando sidebar_collapsed: %w", err)
	}
	return nil
}

// Bounds for the Git tab's draggable panes. Clamping here rather than trusting
// the frontend is what stops a stored width from making a pane unusable: a
// dragged-to-zero pane cannot be dragged back, and one wider than the window
// hides everything else — both would persist across restarts and leave the user
// with no way to recover short of editing the database.
const (
	MinGitPaneWidth = 160
	MaxGitPaneWidth = 1200
)

func clampGitPane(w int) int {
	if w < MinGitPaneWidth {
		return MinGitPaneWidth
	}
	if w > MaxGitPaneWidth {
		return MaxGitPaneWidth
	}
	return w
}

// SetGitPaneWidths persists both Git tab pane widths in one write — they are
// always adjusted from the same layout, and a single UPDATE avoids a half-saved
// layout if the app exits between two calls.
func (s *Store) SetGitPaneWidths(sideWidth, diffWidth int) error {
	if _, err := s.db.Exec(
		`UPDATE settings SET git_side_width = ?, git_diff_width = ? WHERE id = 1`,
		clampGitPane(sideWidth), clampGitPane(diffWidth),
	); err != nil {
		return fmt.Errorf("vault: guardando anchos de paneles git: %w", err)
	}
	return nil
}

// TerminalFontSize se acota a un rango donde el widget sigue siendo
// utilizable: por debajo de 8px el texto deja de leerse y por encima de 32
// entran tan pocas columnas que un `git log` o una tabla se rompen solos.
const (
	MinTerminalFontSize = 8
	MaxTerminalFontSize = 32
)

// gitTermDocks son los anclajes válidos del panel de la pestaña Git.
var gitTermDocks = map[string]bool{"bottom": true, "left": true, "right": true}

// gitPanelTabs son las solapas válidas del panel ("" = cerrado).
var gitPanelTabs = map[string]bool{"": true, "terminal": true, "commands": true}

// SetGitLayout persiste TODO el layout de la pestaña Git de una sola vez:
// dónde está anclado el panel, cuánto mide, qué solapa quedó abierta y qué
// paneles están ocultos.
//
// Un solo UPDATE y no un setter por campo, misma razón que
// SetGitPaneWidths: todos se ajustan desde la misma pantalla y en la misma
// interacción, y escribirlos por separado deja un layout a medio guardar si
// la app se cierra entre dos llamadas.
//
// Los valores fuera de rango se corrigen en vez de rechazarse: esto lo
// escribe la UI en cada arrastre y cada clic, y un error acá se traduciría
// en "el panel no se guarda" sin que nada lo explique. Un dock desconocido
// —el caso de un vault escrito por una versión más nueva de la app— cae a
// "bottom", que es el layout que toda instalación entiende.
func (s *Store) SetGitLayout(dock string, size int, tab string, sideHidden, diffHidden bool) error {
	if !gitTermDocks[dock] {
		dock = "bottom"
	}
	if !gitPanelTabs[tab] {
		tab = ""
	}
	if size < 140 {
		size = 140
	}
	if size > 2000 {
		size = 2000
	}
	if _, err := s.db.Exec(
		`UPDATE settings SET git_term_dock = ?, git_term_size = ?, git_panel_tab = ?, git_side_hidden = ?, git_diff_hidden = ? WHERE id = 1`,
		dock, size, tab, sideHidden, diffHidden,
	); err != nil {
		return fmt.Errorf("vault: guardando layout de la pestaña git: %w", err)
	}
	return nil
}

// SetGitPanelSessions persiste qué sesiones tenía abiertas el panel de la
// pestaña Git. Se guarda la lista tal cual la manda el frontend: son
// descriptores de intención (ver GitPanelSession), no referencias a nada que
// haya que validar contra el sistema — un agente que ya no esté instalado
// aparece como una sesión que no arranca, con su motivo, en vez de
// desaparecer sin explicación.
func (s *Store) SetGitPanelSessions(sessions []GitPanelSession) error {
	if sessions == nil {
		sessions = []GitPanelSession{}
	}
	blob, err := json.Marshal(sessions)
	if err != nil {
		return fmt.Errorf("vault: serializando las sesiones del panel git: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE settings SET git_panel_sessions = ? WHERE id = 1`, string(blob)); err != nil {
		return fmt.Errorf("vault: guardando las sesiones del panel git: %w", err)
	}
	return nil
}

// SetTerminalFontSize persiste el cuerpo de fuente de todas las terminales,
// acotado a Min/MaxTerminalFontSize.
func (s *Store) SetTerminalFontSize(size int) error {
	if size < MinTerminalFontSize {
		size = MinTerminalFontSize
	}
	if size > MaxTerminalFontSize {
		size = MaxTerminalFontSize
	}
	if _, err := s.db.Exec(`UPDATE settings SET terminal_font_size = ? WHERE id = 1`, size); err != nil {
		return fmt.Errorf("vault: guardando terminal_font_size: %w", err)
	}
	return nil
}

// UIFontScale se acota a un rango donde la interfaz sigue siendo una
// interfaz: por debajo del 80% el texto de 9px queda en 7 y deja de leerse
// —que es lo contrario de para qué existe el ajuste—, y por encima del 200%
// las barras de herramientas empiezan a no entrar en la ventana.
const (
	MinUIFontScale = 80
	MaxUIFontScale = 200
)

// SetUIFontScale persiste el tamaño de letra de la interfaz, en porcentaje.
//
// El 0 se acepta tal cual y NO se acota: es "sin elegir", el valor con el que
// arranca una instalación, y acotarlo lo convertiría en 80 — encogiendo la
// interfaz de todo el que nunca tocó el ajuste.
func (s *Store) SetUIFontScale(pct int) error {
	if pct != 0 {
		if pct < MinUIFontScale {
			pct = MinUIFontScale
		}
		if pct > MaxUIFontScale {
			pct = MaxUIFontScale
		}
	}
	if _, err := s.db.Exec(`UPDATE settings SET ui_font_scale = ? WHERE id = 1`, pct); err != nil {
		return fmt.Errorf("vault: guardando ui_font_scale: %w", err)
	}
	return nil
}

// SetQueryPageSize persiste cuántas filas trae cada página. Se acota a un
// máximo sano: una página gigantesca anula el propósito de paginar y puede
// tumbar la UI. 0 ("All") se acepta tal cual — es una elección explícita.
func (s *Store) SetQueryPageSize(n int) error {
	if n < 0 {
		n = 0
	}
	if n > 100000 {
		n = 100000
	}
	if _, err := s.db.Exec(`UPDATE settings SET query_page_size = ? WHERE id = 1`, n); err != nil {
		return fmt.Errorf("vault: guardando query_page_size: %w", err)
	}
	return nil
}

// SetGitDiffPrefs persists the diff viewer's display preferences.
//
// context is clamped to a sane window: 0 is a valid git value (no context at
// all) but makes a diff nearly unreadable, and an unbounded upper value just
// re-renders the whole file slower than asking for the file. 200 is well past
// "show me the surrounding function" without being a footgun.
func (s *Store) SetGitDiffPrefs(context int, ignoreWs, wrap bool) error {
	if context < 1 {
		context = 1
	}
	if context > 200 {
		context = 200
	}
	if _, err := s.db.Exec(
		`UPDATE settings SET git_diff_context = ?, git_diff_ignore_ws = ?, git_diff_wrap = ? WHERE id = 1`,
		context, ignoreWs, wrap,
	); err != nil {
		return fmt.Errorf("vault: guardando preferencias de diff: %w", err)
	}
	return nil
}

// SetEditorHeight persists the SQL editor pane's height in pixels. The
// frontend clamps the value while dragging (see Workspace.tsx) — this is
// just storage, no range validation here.
func (s *Store) SetEditorHeight(height int) error {
	if _, err := s.db.Exec(`UPDATE settings SET editor_height = ? WHERE id = 1`, height); err != nil {
		return fmt.Errorf("vault: guardando editor_height: %w", err)
	}
	return nil
}

// SetEditorTheme persists the CodeMirror theme id. No validation against a
// fixed list here — the registry of valid ids lives in
// frontend/src/codemirror/themes.ts, and an unrecognized id just falls back
// to "auto" there, same "storage only" reasoning as SetEditorHeight.
func (s *Store) SetEditorTheme(theme string) error {
	if _, err := s.db.Exec(`UPDATE settings SET editor_theme = ? WHERE id = 1`, theme); err != nil {
		return fmt.Errorf("vault: guardando editor_theme: %w", err)
	}
	return nil
}

// SetSshTerminalTheme persists the xterm.js theme id. No validation against
// a fixed list here, same "storage only" reasoning as SetEditorTheme — the
// registry of valid ids lives in frontend/src/xterm/terminalThemes.ts, and
// an unrecognized id just falls back to "auto" there.
func (s *Store) SetSshTerminalTheme(theme string) error {
	if _, err := s.db.Exec(`UPDATE settings SET ssh_terminal_theme = ? WHERE id = 1`, theme); err != nil {
		return fmt.Errorf("vault: guardando ssh_terminal_theme: %w", err)
	}
	return nil
}

// SetLocalShell persists which shell the integrated local terminal opens.
// Storage only, same reasoning as SetEditorTheme/SetSshTerminalTheme — the
// registry of valid ids is backend/localterm's, and an id that doesn't
// resolve on this machine falls back to the system default at open time
// rather than being rejected here (see Settings.LocalShell).
func (s *Store) SetLocalShell(id string) error {
	if _, err := s.db.Exec(`UPDATE settings SET local_shell = ? WHERE id = 1`, id); err != nil {
		return fmt.Errorf("vault: guardando local_shell: %w", err)
	}
	return nil
}

// SetAutoBackupEnabled persists the "Backup automático" toggle. Storage
// only — App.SetAutoBackupEnabled is responsible for telling
// backend/autobackup.Scheduler to start/stop after this succeeds.
func (s *Store) SetAutoBackupEnabled(enabled bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET auto_backup_enabled = ? WHERE id = 1`, enabled); err != nil {
		return fmt.Errorf("vault: guardando auto_backup_enabled: %w", err)
	}
	return nil
}

// SetAutoBackupIntervalHours persists how often the automatic backup runs.
// Unlike SetEditorHeight/SetEditorTheme (storage only), this DOES validate
// the range: an out-of-range value would feed
// autobackup.Scheduler.Reconfigure a nonsensical duration — 0 or negative
// hours panics time.NewTicker.
func (s *Store) SetAutoBackupIntervalHours(hours int) error {
	if hours < MinAutoBackupIntervalHours || hours > MaxAutoBackupIntervalHours {
		return fmt.Errorf("vault: intervalo de backup automático inválido: %d (debe ser entre %d y %d horas)", hours, MinAutoBackupIntervalHours, MaxAutoBackupIntervalHours)
	}
	if _, err := s.db.Exec(`UPDATE settings SET auto_backup_interval_hours = ? WHERE id = 1`, hours); err != nil {
		return fmt.Errorf("vault: guardando auto_backup_interval_hours: %w", err)
	}
	return nil
}

// SetAutoBackupPath persists the automatic backup's destination folder. No
// existence check here — App.PickAutoBackupFolder only ever passes a path
// the OS's native picker just returned, which by construction exists and is
// a directory.
func (s *Store) SetAutoBackupPath(path string) error {
	if _, err := s.db.Exec(`UPDATE settings SET auto_backup_path = ? WHERE id = 1`, path); err != nil {
		return fmt.Errorf("vault: guardando auto_backup_path: %w", err)
	}
	return nil
}

// SetAutoSaveEnabled persists the "Auto-guardar editores" toggle. Storage only
// — the timer that acts on it lives entirely in the frontend (Workspace.tsx),
// so there's nothing server-side to reconfigure.
func (s *Store) SetAutoSaveEnabled(enabled bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET auto_save_enabled = ? WHERE id = 1`, enabled); err != nil {
		return fmt.Errorf("vault: guardando auto_save_enabled: %w", err)
	}
	return nil
}

// SetAutoSaveIntervalSeconds persists the auto-save cadence, validating the
// range (a 0/negative interval would make setInterval useless / thrash).
func (s *Store) SetAutoSaveIntervalSeconds(seconds int) error {
	if seconds < MinAutoSaveIntervalSeconds || seconds > MaxAutoSaveIntervalSeconds {
		return fmt.Errorf("vault: intervalo de auto-guardado inválido: %d (debe ser entre %d y %d segundos)", seconds, MinAutoSaveIntervalSeconds, MaxAutoSaveIntervalSeconds)
	}
	if _, err := s.db.Exec(`UPDATE settings SET auto_save_interval_seconds = ? WHERE id = 1`, seconds); err != nil {
		return fmt.Errorf("vault: guardando auto_save_interval_seconds: %w", err)
	}
	return nil
}

// EditorAppearance is how every CodeMirror editor in the app renders: the
// SQL editor, the Git module's file editor and the notes editor.
//
// One shape for the three of them on purpose. Each used to carry its own
// hard-coded font, size and behaviour, which is how they drifted apart in
// the first place — a preference the user sets once should not depend on
// which of the three they happen to be looking at.
//
// The zero value means "use the frontend's defaults" for every field, so a
// vault that predates this (or a user who never opened the settings) gets
// whatever the code decides rather than a number frozen into the schema.
type EditorAppearance struct {
	// FontFamily is an id from the frontend's curated list, not a CSS font
	// stack: the app is offline and ships exactly one font, so the list has
	// to be able to say which options depend on the OS having them. Empty =
	// the default.
	FontFamily string `json:"fontFamily,omitempty"`
	// FontSize in px; 0 = the default.
	FontSize int `json:"fontSize,omitempty"`
	// LineWrap wraps long lines instead of scrolling horizontally.
	LineWrap bool `json:"lineWrap,omitempty"`
	// LineNumbers toggles the gutter. Defaults to on, which is why it is
	// the one field whose column defaults to 1 rather than 0.
	LineNumbers bool `json:"lineNumbers"`
	// TabSize in spaces; 0 = the default.
	TabSize int `json:"tabSize,omitempty"`
	// Toolbar is the editor's action row: "normal" (icons and labels),
	// "compact" (icons only) or "hidden" (no row at all — the keyboard
	// shortcuts keep working). Empty = "normal".
	Toolbar string `json:"toolbar,omitempty"`
}

// SetEditorAppearance persists the whole appearance group at once. Values
// are clamped here rather than trusted: a font size of 0 or 400 stored once
// would be re-applied on every launch afterwards, and an editor that cannot
// be read is not a preference, it is a lockout.
func (s *Store) SetEditorAppearance(a EditorAppearance) error {
	if a.FontSize != 0 {
		if a.FontSize < 9 {
			a.FontSize = 9
		}
		if a.FontSize > 32 {
			a.FontSize = 32
		}
	}
	if a.TabSize != 0 {
		if a.TabSize < 1 {
			a.TabSize = 1
		}
		if a.TabSize > 8 {
			a.TabSize = 8
		}
	}
	_, err := s.db.Exec(
		`UPDATE settings SET editor_font_family = ?, editor_font_size = ?, editor_line_wrap = ?,
		 editor_line_numbers = ?, editor_tab_size = ?, editor_toolbar = ? WHERE id = 1`,
		a.FontFamily, a.FontSize, a.LineWrap, a.LineNumbers, a.TabSize, a.Toolbar,
	)
	if err != nil {
		return fmt.Errorf("vault: guardando apariencia del editor: %w", err)
	}
	return nil
}

// SetSidebarWidth persists the sidebar's dragged width, clamped to a range
// that keeps it usable: too narrow and the tree is unreadable, too wide and
// it crowds out the editor the app exists for. Clamping here rather than
// trusting the caller means a bad value can never be stored and re-applied
// on every launch afterwards.
func (s *Store) SetSidebarWidth(px int) error {
	if px < 180 {
		px = 180
	}
	if px > 640 {
		px = 640
	}
	if _, err := s.db.Exec(`UPDATE settings SET sidebar_width = ? WHERE id = 1`, px); err != nil {
		return fmt.Errorf("vault: guardando sidebar_width: %w", err)
	}
	return nil
}

// SetSidebarModule persists which sidebar module the master menu has open.
func (s *Store) SetSidebarModule(id string) error {
	if _, err := s.db.Exec(`UPDATE settings SET sidebar_module = ? WHERE id = 1`, id); err != nil {
		return fmt.Errorf("vault: guardando sidebar_module: %w", err)
	}
	return nil
}

// SetMCPNotesWrite persiste si el servidor MCP puede crear notas.
//
// Separado de SetMCPEnabled porque son dos decisiones distintas: una comparte
// lectura, la otra deja escribir en la base de conocimiento. Apagar el servidor
// no borra este permiso —al volver a encenderlo queda como estaba— pero sin
// servidor no hay nadie que pueda usarlo.
func (s *Store) SetMCPNotesWrite(enabled bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET mcp_notes_write = ? WHERE id = 1`, enabled); err != nil {
		return fmt.Errorf("vault: guardando mcp_notes_write: %w", err)
	}
	return nil
}

// SetMCPEnabled persiste si el servidor MCP quedó encendido.
//
// Es solo el recuerdo de la preferencia: encender el servidor de verdad es
// abrir el socket, y eso lo hace App.SetMCPServerEnabled. Guardar el flag sin
// abrir nada es exactamente lo que se quiere — al reabrir la app, el usuario
// decide si volver a encenderlo.
func (s *Store) SetMCPEnabled(enabled bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET mcp_enabled = ? WHERE id = 1`, enabled); err != nil {
		return fmt.Errorf("vault: guardando mcp_enabled: %w", err)
	}
	return nil
}
