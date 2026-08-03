package main

import (
	"fmt"

	"mini-tools/backend/agents"
	"mini-tools/backend/localterm"
	"mini-tools/backend/vault"
)

// Bindings de la terminal local integrada.
//
// Viven en su propio archivo por la misma razón que app_git.go: Wails bindea
// todo método exportado de *App sin importar en qué archivo esté declarado,
// así que esto es puramente legibilidad frente a las ~2500 líneas de app.go.
// El contrato completo está en .claude/specs/go-react-contract.md.
//
// La forma es deliberadamente idéntica a la de OpenSSHTerminal/
// WriteSSHTerminal/ResizeSSHTerminal/CloseSSHTerminal (app.go): el widget de
// xterm.js del frontend es el mismo para una shell local y una remota, y dos
// contratos distintos para el mismo stream de bytes solo obligarían a
// escribir dos veces el decodificador y el manejo de resize.
//
// Todos los métodos pasan por requireUnlocked, sin excepción
// (.claude/rules/technical.md punto 5). Una terminal local no lee el vault,
// pero abre un proceso con TODOS los permisos del usuario: es, de lejos, la
// superficie más potente que expone la app, así que gatearla detrás de la
// clave maestra es lo mínimo. La excepción documentada de GetSettings/SetTheme
// (nada sensible, evita un flash de tema en la pantalla de desbloqueo) no
// aplica ni de cerca acá.

// ListShells devuelve los shells que la app puede lanzar en ESTE sistema
// operativo, instalados o no (Available lo distingue) — es lo que puebla el
// selector de Configuración → Terminal. Nombres y rutas de ejecutables del
// sistema, nada sensible.
func (a *App) ListShells() ([]localterm.Shell, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return localterm.ListShells(), nil
}

// DefaultShellID es el id que se usa cuando settings.local_shell está vacío
// — lo consume el selector para etiquetar la opción "Automático" con el
// shell que realmente se va a abrir, en vez de dejarla como una incógnita.
func (a *App) DefaultShellID() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return localterm.DefaultShellID(), nil
}

// SetLocalShell persiste qué shell abre la terminal local. Toma efecto en la
// próxima terminal que se abra (o al reiniciar una ya abierta): cambiar el
// intérprete de un proceso vivo no es algo que exista.
func (a *App) SetLocalShell(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetLocalShell(id)
}

// OpenLocalTerminal abre una shell interactiva en el directorio de trabajo
// de repoID y empieza a streamear su salida en el evento llamado sessionID
// (ver localterm.Event), igual que OpenSSHTerminal con connID.
//
// El directorio llega como ID de repositorio y no como ruta, misma
// indirección que el resto del módulo Git: el frontend nunca maneja rutas
// del sistema de archivos que no haya elegido el usuario. repoID vacío abre
// en el home, que es el caso "terminal suelta, sin repo".
//
// sessionID lo genera el frontend y es a la vez el nombre del evento de
// Wails; suscribirse ANTES de llamar acá evita la carrera entre el primer
// chunk emitido y el EventsOn (mismo contrato que ExecuteQuery/queryID).
func (a *App) OpenLocalTerminal(sessionID, repoID string, cols, rows int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if sessionID == "" {
		return fmt.Errorf("app: falta el id de sesión de la terminal")
	}

	cwd := ""
	if repoID != "" {
		path, err := a.gitRepo(repoID)
		if err != nil {
			return err
		}
		cwd = path
	}

	// El shell se lee del vault en cada apertura en vez de cachearse: es
	// exactamente lo que hace que cambiarlo en Configuración se note al
	// abrir la siguiente terminal, sin reiniciar la app.
	shellID := ""
	if settings, err := a.vault.GetSettings(); err == nil {
		shellID = settings.LocalShell
	}

	return a.localTerms.Open(sessionID, cwd, shellID, cols, rows)
}

// OpenLocalTerminalAt es OpenLocalTerminal para una terminal que no cuelga
// de ningún repositorio: arranca directamente en el home del usuario.
func (a *App) OpenLocalTerminalAt(sessionID string, cols, rows int) error {
	return a.OpenLocalTerminal(sessionID, "", cols, rows)
}

// WriteLocalTerminal reenvía las teclas/pegado de xterm.js al stdin de la
// shell de sessionID.
func (a *App) WriteLocalTerminal(sessionID, data string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.localTerms.Write(sessionID, data)
}

// ResizeLocalTerminal reflowa el PTY después de que el FitAddon del frontend
// recalcula cols/rows.
func (a *App) ResizeLocalTerminal(sessionID string, cols, rows int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.localTerms.Resize(sessionID, cols, rows)
}

// CloseLocalTerminal mata la shell de sessionID. La llama el frontend cuando
// se cierra la pestaña que la contenía — a diferencia de un pool de base de
// datos, lo que queda vivo si no se cierra es un proceso del sistema
// operativo, igual que en CloseSSHTerminal.
func (a *App) CloseLocalTerminal(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.localTerms.Close(sessionID)
}

// --- Agentes de código --------------------------------------------------
//
// Ver el doc del paquete backend/agents para el porqué del diseño: los CLIs
// agénticos se EJECUTAN como los programas de terminal que son, sobre el PTY
// que localterm ya maneja, y cada uno sigue manejando su propia
// autenticación. Esta app no lee ni replica esas credenciales; solo ofrece
// guardar, opcionalmente y cifrada, una API key para quien prefiere el modo
// por variable de entorno.

// ListAgents devuelve el catálogo de agentes resuelto contra esta máquina
// (instalado o no) y contra la configuración guardada. Nunca incluye la API
// key, solo si hay una — misma regla que SSHKeySummary con el material de la
// llave.
func (a *App) ListAgents() ([]agents.Agent, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	configs, err := a.vault.ListAgentConfigs()
	if err != nil {
		return nil, err
	}
	overrides := make(map[string]agents.Override, len(configs))
	for id, c := range configs {
		overrides[id] = agents.Override{Command: c.Command, HasKey: c.HasKey}
	}
	return agents.List(overrides), nil
}

// SetAgentCommand cambia con qué comando se abre un agente. Vacío restaura el
// default del catálogo.
func (a *App) SetAgentCommand(agentID, command string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if _, ok := agents.Find(agentID); !ok {
		return fmt.Errorf("app: agente desconocido %q", agentID)
	}
	return a.vault.SetAgentCommand(agentID, command)
}

// SetAgentKey guarda cifrada la API key de un agente.
func (a *App) SetAgentKey(agentID, apiKey string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if _, ok := agents.Find(agentID); !ok {
		return fmt.Errorf("app: agente desconocido %q", agentID)
	}
	return a.vault.SetAgentKey(agentID, apiKey)
}

// ClearAgentKey borra la API key guardada, dejando el comando intacto.
func (a *App) ClearAgentKey(agentID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.ClearAgentKey(agentID)
}

// OpenAgentSession abre una terminal en el repositorio y arranca el agente
// dentro de ella.
//
// El agente corre DENTRO del shell, no en lugar del shell: cuando termina (o
// lo cortás con Ctrl+C) te queda la terminal viva en el mismo directorio en
// vez de una sesión muerta. Y si hay una API key guardada, entra por el
// entorno del proceso, nunca por la línea de comandos — ahí quedaría visible
// en `ps` para cualquier proceso de la máquina.
//
// runCommand a false abre la sesión SIN arrancar el agente: es lo que usa la
// restauración del layout, porque lanzar un asistente que consume cuota
// porque la app se reinició no es algo que nadie haya pedido.
func (a *App) OpenAgentSession(sessionID, repoID, agentID string, cols, rows int, runCommand bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if sessionID == "" {
		return fmt.Errorf("app: falta el id de sesión de la terminal")
	}

	configs, err := a.vault.ListAgentConfigs()
	if err != nil {
		return err
	}
	overrides := make(map[string]agents.Override, len(configs))
	for id, c := range configs {
		overrides[id] = agents.Override{Command: c.Command, HasKey: c.HasKey}
	}

	var agent agents.Agent
	found := false
	for _, cand := range agents.List(overrides) {
		if cand.ID == agentID {
			agent = cand
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("app: agente desconocido %q", agentID)
	}

	cwd := ""
	if repoID != "" {
		path, err := a.gitRepo(repoID)
		if err != nil {
			return err
		}
		cwd = path
	}

	shellID := ""
	if settings, err := a.vault.GetSettings(); err == nil {
		shellID = settings.LocalShell
	}

	// PATH ampliado con los directorios donde suelen vivir estos CLIs: una
	// app abierta desde el Dock no hereda ~/.local/bin ni los binarios de
	// npm/bun, que es justo donde se instalan.
	env := []string{"PATH=" + agents.PathEnv()}
	if agent.KeyEnv != "" {
		key, err := a.vault.AgentKey(agentID)
		if err != nil {
			return err
		}
		if key != "" {
			env = append(env, agent.KeyEnv+"="+key)
		}
	}

	command := ""
	if runCommand {
		command = agent.Command
	}
	return a.localTerms.OpenWith(sessionID, cwd, shellID, cols, rows, env, command)
}

// SetGitPanelSessions persiste qué sesiones tenía abiertas el panel de la
// pestaña Git (una terminal, o una sesión de un agente).
func (a *App) SetGitPanelSessions(sessions []vault.GitPanelSession) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetGitPanelSessions(sessions)
}

// SetGitLayout persiste el layout de la pestaña Git: dónde está anclado el
// panel de la terminal ("bottom"/"left"/"right"), cuánto mide, qué solapa
// quedó abierta ("", "terminal", "commands") y qué paneles están ocultos.
//
// Vive acá y no en app_git.go porque lo que motiva el layout es la terminal:
// el resto del módulo Git ya persistía sus anchos con GitSetPaneWidths.
func (a *App) SetGitLayout(dock string, size int, tab string, sideHidden, diffHidden bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetGitLayout(dock, size, tab, sideHidden, diffHidden)
}

// SetTerminalFontSize persiste el cuerpo de fuente de TODAS las terminales
// de la app — la local y las sesiones SSH comparten el ajuste, porque son el
// mismo widget y tener dos tamaños distintos para "la terminal" no
// significaría nada para quien la usa.
func (a *App) SetTerminalFontSize(size int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetTerminalFontSize(size)
}

// LocalShellLabel es la etiqueta legible del shell que se abriría con el id
// guardado ("zsh", "Git Bash") — lo muestra la barra de la terminal para que
// se vea CUÁL intérprete está corriendo sin tener que replicar en el
// frontend el fallback al default del sistema.
func (a *App) LocalShellLabel(id string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return localterm.ShellLabelFor(id), nil
}
