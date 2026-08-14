package main

import (
	"context"
	"fmt"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"path/filepath"
	"strings"
	"time"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/appdata"
	"mini-tools/backend/agentctx"
	"mini-tools/backend/agentmodels"
	"mini-tools/backend/agentplan"
	"mini-tools/backend/agentusage"
	"mini-tools/backend/agents"
	"mini-tools/backend/localterm"
	"mini-tools/backend/mcpconf"
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

// GitAgentContext devuelve qué le ofrece un repositorio a un agente: sus
// skills, sus subagentes, sus comandos y sus archivos de instrucciones
// (presentes Y ausentes — ver backend/agentctx).
//
// Vive en este archivo y no en app_git.go porque lo que motiva la lectura es
// el agente, no git: nada de esto sale del repositorio versionado, sale de los
// directorios de configuración que cada CLI lee. Lo único que aporta el módulo
// Git es la indirección por repoID, igual que el resto.
//
// Es solo lectura y no toca el vault, pero pasa por requireUnlocked como todo
// lo demás: expone rutas y nombres de archivos de la máquina del usuario.
func (a *App) GitAgentContext(repoID string) (agentctx.Context, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return agentctx.Context{}, err
	}
	return agentctx.Scan(path), nil
}

// GitMCPConfig devuelve qué servidores MCP ve cada agente en este
// repositorio, leídos de los configs de cada CLI (ver backend/mcpconf).
//
// **Los VALORES de las variables de entorno de un servidor no cruzan este
// binding, solo sus nombres.** Ahí es donde viajan los tokens de las
// integraciones, y enmascararlos en la UI no alcanzaría: si el valor llega al
// frontend ya salió del backend. Es la misma regla que impide que un DSN
// cruce (.claude/rules/technical.md punto 9), aplicada a una credencial que
// esta app ni siquiera administra.
//
// Es solo lectura: estos archivos son del usuario y de sus herramientas, y
// escribirlos requiere preservar todo lo que este código no entiende — otro
// problema, con su propio riesgo.
func (a *App) GitMCPConfig(repoID string) (mcpconf.Config, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return mcpconf.Config{}, err
	}
	return mcpconf.Scan(path), nil
}

// GitAgentUsage devuelve cuántos tokens consumió cada agente en los últimos
// `days` días, en total y atribuidos a ESTE repositorio.
//
// Dos cosas que conviene tener presentes al leer la respuesta, y que están
// desarrolladas en el doc de backend/agentusage:
//
//   - Los porcentajes son PROPORCIONES de lo consumido (qué parte se fue en
//     cada modelo, qué parte absorbió el caché), nunca fracciones del límite
//     de un plan. Ese límite no está en ningún archivo local: lo sabe el
//     servidor, y el propio CLI lo muestra preguntándoselo.
//   - Solo Claude Code tiene un lector verificado contra archivos reales.
//     Codex y Antigravity devuelven Available=false con una nota, en vez de
//     números salidos de un parser escrito a ciegas.
//
// days <= 0 usa la ventana por defecto.
func (a *App) GitAgentUsage(repoID string, days int) (agentusage.Usage, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return agentusage.Usage{}, err
	}
	return agentusage.Scan(path, days), nil
}

// --- Chat agéntico (modo headless) ---------------------------------------
//
// Camino paralelo al PTY, no un reemplazo: ver el doc de backend/agentchat
// para por qué conviven y qué se verificó de cada CLI antes de escribirlo.

// AgentChatSupported informa si un agente tiene adaptador VERIFICADO contra
// una corrida real. La UI lo usa para ofrecer el chat solo donde funciona, en
// vez de abrir una ventana que se queda muda.
func (a *App) AgentChatSupported(agentID string) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	return agentchat.Supports(agentID), nil
}

// AgentChatModes son los modos de permisos que soporta ESE agente, de menos a
// más permisivo. No son los mismos para todos —"auto" solo lo tiene Claude
// Code— y ofrecer en la lista uno que el CLI va a rechazar es peor que una
// lista más corta.
func (a *App) AgentChatModes(agentID string) ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return agentchat.ModesFor(agentID, a.approve != nil && a.approveSettings != ""), nil
}

// SendAgentChat manda un mensaje y streamea la respuesta como
// agentchat.Event en el evento de Wails llamado sessionID — mismo contrato de
// "un evento por sesión" que la terminal y las queries. Suscribirse ANTES de
// llamar evita la carrera con el primer evento.
//
// Vuelve enseguida: el turno corre en su goroutine.
//
// Cada turno es un proceso nuevo (los CLIs headless terminan cuando
// contestan); la continuidad la da el id de conversación que ellos devuelven y
// que el manager guarda por sesión.
// mode es "" (solo consulta), "plan" o "edit"; effort es el nivel de
// razonamiento que ofrezca la UI ("" usa el del CLI). El modo "edit" aplica
// cambios sin preguntar y por eso es una elección explícita del usuario turno
// a turno, nunca un default: lo que la hace aceptable es que el resultado cae
// en el árbol de trabajo de un repositorio git, donde se ve en el diff de la
// app y se descarta con un click.
func (a *App) SendAgentChat(sessionID, repoID, agentID, prompt, mode, effort, model string, images []string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
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
			agent, found = cand, true
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

	// Mismo entorno que una sesión de terminal: PATH ampliado y, si hay una,
	// la API key por variable — nunca por la línea de comandos, donde quedaría
	// visible en `ps`.
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

	// El modo se valida contra la unión conocida en vez de reenviarse tal
	// cual: es lo único que separa "consultá" de "modificá archivos", y no
	// puede depender de que el frontend mande un string bien escrito.
	var m agentchat.Mode
	switch mode {
	case "plan":
		m = agentchat.ModePlan
	case "auto":
		m = agentchat.ModeAuto
	case "approve":
		m = agentchat.ModeApprove
	case "edit":
		m = agentchat.ModeEdit
	case "":
		m = agentchat.ModeAsk
	default:
		return fmt.Errorf("app: modo de chat desconocido %q", mode)
	}

	return a.agentChats.Send(agentchat.Turn{
		SessionID: sessionID,
		AgentID:   agentID,
		Command:   agent.Command,
		Cwd:       cwd,
		Env:       env,
		Prompt:    prompt,
		Images:          images,
		Mode:            m,
		Effort:          effort,
		Model:           model,
		ApproveSettings: a.approveSettings,
		ApproveEnv:      agentapprove.HookEnv(a.approve.Path()),
	})
}

// AskAgentOnce corre UN turno y devuelve el texto de la respuesta, en vez de
// streamearlo. Es lo que usan las acciones agénticas del módulo Git —redactar
// el mensaje de commit desde el diff preparado, revisar antes de pushear— donde
// no hace falta una conversación sino un texto que va a un campo del
// formulario.
//
// **El agente propone; aplicar sigue siendo un clic del usuario.** Esto
// devuelve texto y nada más: no commitea, no pushea y no escribe archivos
// (`agentchat.Ask` rechaza los modos que editan). Un asistente que commitea
// solo porque interpretó bien un diff es exactamente el producto que nadie
// pidió.
func (a *App) AskAgentOnce(repoID, agentID, prompt string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	configs, err := a.vault.ListAgentConfigs()
	if err != nil {
		return "", err
	}
	overrides := make(map[string]agents.Override, len(configs))
	for id, c := range configs {
		overrides[id] = agents.Override{Command: c.Command, HasKey: c.HasKey}
	}

	var agent agents.Agent
	found := false
	for _, cand := range agents.List(overrides) {
		if cand.ID == agentID {
			agent, found = cand, true
			break
		}
	}
	if !found {
		return "", fmt.Errorf("app: agente desconocido %q", agentID)
	}

	cwd := ""
	if repoID != "" {
		path, err := a.gitRepo(repoID)
		if err != nil {
			return "", err
		}
		cwd = path
	}

	env := []string{"PATH=" + agents.PathEnv()}
	if agent.KeyEnv != "" {
		key, err := a.vault.AgentKey(agentID)
		if err != nil {
			return "", err
		}
		if key != "" {
			env = append(env, agent.KeyEnv+"="+key)
		}
	}

	// Tope de tiempo: esto lo dispara un botón y bloquea un formulario, así
	// que un agente que se cuelga tiene que fallar y no dejar el botón girando
	// para siempre.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	return a.agentChats.Ask(ctx, agentchat.Turn{
		AgentID: agentID,
		Command: agent.Command,
		Cwd:     cwd,
		Env:     env,
		Prompt:  prompt,
	})
}

// SaveChatAttachment guarda una imagen pegada o elegida y devuelve su ruta,
// que es lo que se le pasa al agente.
//
// Va a un directorio de la app y **nunca dentro del repositorio**: escribir
// ahí ensuciaría el árbol de trabajo con archivos que el usuario no creó,
// aparecerían en Cambios y se podrían commitear sin querer — justo en el panel
// que sirve para revisar lo que hizo el agente.
func (a *App) SaveChatAttachment(name, dataBase64 string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	dir, err := appdata.Dir()
	if err != nil {
		return "", err
	}
	return agentchat.SaveAttachment(filepath.Join(dir, "adjuntos"), name, dataBase64)
}

// CancelAgentChat corta el turno en curso. Es la única forma de parar un
// agente que se fue por las ramas.
func (a *App) CancelAgentChat(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.Cancel(sessionID)
	return nil
}

// ResetAgentChat olvida la conversación: el próximo mensaje arranca de cero en
// vez de encadenar con lo anterior.
func (a *App) ResetAgentChat(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.Reset(sessionID)
	return nil
}

// GitRemoveMCPServer saca un servidor MCP de un archivo de configuración.
//
// El archivo llega por RUTA y no por id porque es un archivo del usuario, no
// una entidad de esta app: viene de la lista que devolvió GitMCPConfig, que ya
// dice cuáles se pueden escribir. Se vuelve a comprobar acá igual — que la UI
// no ofrezca el botón no es una garantía de que no llegue la llamada.
func (a *App) GitRemoveMCPServer(path, name string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if !mcpconf.Writable(mcpconf.File{Path: path, Agent: agentForPath(path)}) {
		return fmt.Errorf("app: %q no se edita desde la app", path)
	}
	return mcpconf.RemoveServer(path, name)
}

// GitUpsertMCPServer agrega o reemplaza un servidor MCP.
//
// Los valores de `env` vienen del formulario y van al archivo del usuario en
// texto plano, que es como esos configs funcionan. **No se guardan en el vault
// de esta app**: administrar credenciales de otros programas no es algo que
// nadie le haya pedido, y duplicarlas sería un lugar más del que se pueden
// filtrar.
func (a *App) GitUpsertMCPServer(path string, in mcpconf.ServerInput) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if !mcpconf.Writable(mcpconf.File{Path: path, Agent: agentForPath(path)}) {
		return fmt.Errorf("app: %q no se edita desde la app", path)
	}
	return mcpconf.UpsertServer(path, in)
}

// agentForPath deduce el agente de la ruta, solo para la comprobación de
// escritura: lo único que cambia el resultado es si es el config.toml de
// Codex, que se reconoce por su extensión.
func agentForPath(path string) string {
	if strings.EqualFold(filepath.Ext(path), ".toml") {
		return "codex"
	}
	return ""
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

// --- Aprobación por acción -----------------------------------------------

// askApproval lleva la pregunta del agente a la ventana y espera la respuesta.
//
// Corre en la goroutine del canal, no en la del turno: acá se bloquea hasta
// que el usuario decide, y el timeout lo maneja el canal (que deniega si nadie
// contesta — el silencio no es un sí).
func (a *App) askApproval(req agentapprove.Request) agentapprove.Decision {
	reply := make(chan agentapprove.Decision, 1)

	a.approveMu.Lock()
	a.approvePending[req.ID] = reply
	a.approveMu.Unlock()

	defer func() {
		a.approveMu.Lock()
		delete(a.approvePending, req.ID)
		a.approveMu.Unlock()
	}()

	runtime.EventsEmit(a.ctx, "agent-approval", req)
	return <-reply
}

// RespondAgentApproval es la respuesta del usuario. La llama el diálogo.
//
// Una respuesta para un id que ya no está esperando se ignora en silencio: el
// caso normal es que el turno se haya cancelado o que el timeout haya vencido
// mientras el diálogo seguía abierto, y ahí ya se denegó.
func (a *App) RespondAgentApproval(id string, allow bool, reason string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.approveMu.Lock()
	reply := a.approvePending[id]
	a.approveMu.Unlock()

	if reply != nil {
		reply <- agentapprove.Decision{Allow: allow, Reason: reason}
	}
	return nil
}


// --- Historial de chats ---------------------------------------------------
//
// Lo que se guarda es el PUNTERO a la conversación (el id del propio CLI) y no
// los mensajes: el historial lo tiene el CLI, y duplicarlo acá sería una
// segunda memoria que se desincroniza. Ver backend/vault/agent_chats_repo.go.

// ListAgentChats devuelve las conversaciones guardadas de un repositorio.
func (a *App) ListAgentChats(repoID string) ([]vault.AgentChat, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListAgentChats(repoID)
}

// CreateAgentChat registra una conversación nueva. El id lo genera el frontend
// y es el mismo que identifica la sesión del panel.
func (a *App) CreateAgentChat(id, repoID, agentID, title string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.CreateAgentChat(id, repoID, agentID, title)
}

// RenameAgentChat cambia el nombre visible de una conversación.
func (a *App) RenameAgentChat(id, title string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.RenameAgentChat(id, title)
}

// DeleteAgentChat saca la conversación del historial. **No borra la
// conversación del CLI**: esa vive en su propio almacenamiento y esta app no
// la administra; lo que se pierde es el atajo para retomarla desde acá.
func (a *App) DeleteAgentChat(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteAgentChat(id)
}

// ResumeAgentChat retoma una conversación guardada: le dice al manager con qué
// id del CLI encadenar el próximo mensaje.
func (a *App) ResumeAgentChat(sessionID, conversationID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.Resume(sessionID, conversationID)
	return nil
}

// TouchAgentChat guarda el id de conversación que devolvió el CLI y marca
// actividad. Es lo que convierte una entrada del historial en algo que se
// puede retomar de verdad.
func (a *App) TouchAgentChat(id, conversationID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.TouchAgentChat(id, conversationID)
}

// AgentChatHistory recupera los mensajes de una conversación anterior, para
// que al retomar un chat el panel no arranque vacío.
//
// **No sale igual para los tres agentes** y eso es parte del contrato: Claude
// Code se lee entero, Codex se lee con una heurística documentada para separar
// sus mensajes inyectados de los reales, y Antigravity devuelve vacío porque
// guarda sus pasos como blobs binarios. Un vacío NO es un error: la
// conversación sigue encadenando igual, porque eso lo hace el id del CLI y no
// esto.
func (a *App) AgentChatHistory(agentID, conversationID string) ([]agentchat.PastTurn, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return agentchat.History(agentID, conversationID)
}

// AgentModelCatalog devuelve los modelos y niveles de esfuerzo que ofrece ese
// agente, sacados del propio CLI en vez de una lista escrita a mano que
// envejecería (ver backend/agentmodels).
func (a *App) AgentModelCatalog(agentID string) (agentmodels.Catalog, error) {
	if err := a.requireUnlocked(); err != nil {
		return agentmodels.Catalog{}, err
	}
	return agentmodels.For(agentID), nil
}

// AgentPlans informa con qué plan está cada agente en esta máquina.
//
// Sirve para darle escala al panel de consumo: un total de tokens no
// significa lo mismo en un plan gratuito que en uno de pago. **El token de
// sesión no sale de acá**: del JWT de Codex se extrae únicamente el claim del
// plan (ver backend/agentplan).
func (a *App) AgentPlans() ([]agentplan.Plan, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return agentplan.All(), nil
}

// SetAgentChatSettings guarda el modelo, el esfuerzo y el modo con los que se
// estaba trabajando en un chat, para que retomarlo lo continúe como venía.
func (a *App) SetAgentChatSettings(id, model, effort, mode string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAgentChatSettings(id, model, effort, mode)
}
