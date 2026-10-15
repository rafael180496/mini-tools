package main

import (
	"context"
	"encoding/json"

	"path/filepath"
	"strings"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/agentctx"
	"mini-tools/backend/agentlimits"
	"mini-tools/backend/agentmodels"
	"mini-tools/backend/agentplan"
	"mini-tools/backend/agents"
	"mini-tools/backend/agentusage"
	"mini-tools/backend/appdata"
	"mini-tools/backend/i18n"
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
		return i18n.Errorf(i18n.Msg{ES: "app: falta el id de sesión de la terminal", EN: "app: the terminal session id is missing"})
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

// OpenLocalTerminalWith abre una terminal local con un INTÉRPRETE elegido, sin
// tocar el configurado en Configuración → Terminal.
//
// Existe para el módulo SSH: ahí una terminal local no es "la terminal de la
// app" sino una más entre varias, y en Windows conviven PowerShell, pwsh y cmd
// —abrir siempre el mismo obligaría a cambiar la preferencia global para probar
// algo en otro—. `shellID` vacío usa el configurado, que es el comportamiento
// de OpenLocalTerminal.
//
// El directorio es el home: una terminal del módulo SSH no cuelga de ningún
// repositorio.
func (a *App) OpenLocalTerminalWith(sessionID, shellID string, cols, rows int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if sessionID == "" {
		return i18n.Errorf(i18n.Msg{ES: "app: falta el id de sesión de la terminal", EN: "app: the terminal session id is missing"})
	}
	if shellID == "" {
		return a.OpenLocalTerminal(sessionID, "", cols, rows)
	}
	return a.localTerms.Open(sessionID, "", shellID, cols, rows)
}

// --- Historial de las terminales locales ------------------------------------
//
// Mismo trato que el de las terminales SSH y con el mismo interruptor
// (`ssh_history_enabled`): para quien lo usa es "el historial de las
// terminales", no dos ajustes separados que habría que apagar de a uno. Lo que
// cambia es la clave por la que se agrupa — el intérprete y no el servidor, ver
// backend/vault/local_history_repo.go.

// AppendLocalHistory guarda un comando ejecutado en una terminal local.
//
// Devuelve false cuando no se guardó: puede ser porque el registro está apagado
// o porque la línea parecía traer una credencial. Las dos son decisiones del
// backend a propósito — el frontend manda todo y no hay dos lugares que puedan
// discrepar sobre qué se guarda.
func (a *App) AppendLocalHistory(shellID, command string) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	enabled, err := a.vault.SshHistoryEnabled()
	if err != nil {
		return false, err
	}
	if !enabled {
		return false, nil
	}
	return a.vault.AppendLocalHistory(shellID, command)
}

// ListLocalHistory devuelve los últimos comandos de un intérprete.
func (a *App) ListLocalHistory(shellID string, limit int) ([]vault.SshHistoryEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListLocalHistory(shellID, limit)
}

// ClearLocalHistory borra el historial de un intérprete y devuelve cuántos
// comandos se borraron.
func (a *App) ClearLocalHistory(shellID string) (int64, error) {
	if err := a.requireUnlocked(); err != nil {
		return 0, err
	}
	return a.vault.ClearLocalHistory(shellID)
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
// (instalado o no) y contra la configuración guardada, más los servidores de
// modelos como agentes `llm:<id>` (ver app_modelservers.go). Nunca incluye la API
// key, solo si hay una — misma regla que SSHKeySummary con el material de la
// llave.
func (a *App) ListAgents() ([]agents.Agent, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.agentCatalog()
}

// SetAgentCommand cambia con qué comando se abre un agente. Vacío restaura el
// default del catálogo.
func (a *App) SetAgentCommand(agentID, command string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if _, ok := agents.Find(agentID); !ok {
		return i18n.Errorf(i18n.Msg{ES: "app: agente desconocido %q", EN: "app: unknown agent %q"}, agentID)
	}
	return a.vault.SetAgentCommand(agentID, command)
}

// SetAgentKey guarda cifrada la API key de un agente.
func (a *App) SetAgentKey(agentID, apiKey string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if _, ok := agents.Find(agentID); !ok {
		return i18n.Errorf(i18n.Msg{ES: "app: agente desconocido %q", EN: "app: unknown agent %q"}, agentID)
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
		return i18n.Errorf(i18n.Msg{ES: "app: falta el id de sesión de la terminal", EN: "app: the terminal session id is missing"})
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
		return i18n.Errorf(i18n.Msg{ES: "app: agente desconocido %q", EN: "app: unknown agent %q"}, agentID)
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
	// El entorno del proceso entero, no solo el PATH: cmd.Env reemplaza, y sin
	// HOME el agente no encuentra su sesión (ver agents.Env).
	env := agents.Env()
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

// AgentUsageAll es el mismo consumo pero SIN repositorio: lo gastado en toda la
// máquina, que es lo que corresponde mirar desde el chat.
//
// El chat no vive en un repositorio —se abre sobre una conexión, una terminal o
// una nota—, así que la parte "de este repo" del panel de Git no aplica acá y
// se pasa vacía a propósito. Lo demás es idéntico: los mismos lectores por CLI,
// la misma ventana de días.
func (a *App) AgentUsageAll(days int) (agentusage.Usage, error) {
	if err := a.requireUnlocked(); err != nil {
		return agentusage.Usage{}, err
	}
	return agentusage.Scan("", days), nil
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
//
// images lleva las rutas de TODOS los adjuntos del mensaje, sean imágenes,
// PDF o archivos de texto (el nombre quedó por compatibilidad): las rutas que
// devolvió SaveChatFile o SaveChatAttachment. Cada una se vuelve a clasificar
// por su contenido y tiene que estar en la carpeta de adjuntos de la app. Se
// validan contra AgentAttachmentCapabilities antes de llamar al proveedor:
// imagen → como siempre; texto → pegado en el mensaje para todos los
// proveedores; PDF → bloque `document` en Anthropic, por ruta en Claude Code, y
// un error claro en cualquier otro. Con adjuntos y sin texto, el mensaje es
// «Revisá los archivos adjuntos.».
func (a *App) SendAgentChat(sessionID, module, contextID, agentID, prompt, mode, effort, model string, images []string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}

	agent, err := a.agentByID(agentID)
	if err != nil {
		return err
	}

	// Un repositorio abierto es el directorio de trabajo; en cualquier otro
	// módulo, el directorio vacío de consultas — ver agentCwd (app_agent.go)
	// para por qué no es el home del usuario.
	cwd, err := a.agentCwd(module, contextID)
	if err != nil {
		return err
	}

	// Los adjuntos se resuelven y validan primero: un PDF para un modelo que no
	// lo lee tiene que fallar antes de armar nada, con el motivo.
	prep, atts, err := a.prepareAttachments(agentID, model, images)
	if err != nil {
		return err
	}
	typed := prompt
	if strings.TrimSpace(prompt) == "" && len(atts) > 0 {
		// Al historial no va el mensaje por defecto: la persona no escribió nada.
		typed = ""
		prompt = agentchat.DefaultAttachmentPrompt()
	}

	// Las referencias `@tipo:valor` se expanden ACÁ, no en el frontend: para
	// que el frontend las resolviera tendría que haber recibido antes el
	// contenido, que es exactamente lo que no puede pasar (ver app_refs.go).
	// El `@ruta` suelto del módulo Git no se toca: ese le pasa la ruta al
	// agente a propósito, para que la lea él.
	//
	// Al historial va lo que llegó, SIN expandir (ver app_chatrecord.go).
	prompt, _ = a.expandRefs(prompt, module, contextID)
	// El texto de los archivos se pega DESPUÉS de expandir las referencias: un
	// archivo adjunto que contenga «@nota:…» es contenido, no una orden.
	prompt = agentchat.WithText(prompt, prep.Text)

	// Cerebro: si la conversación tiene "Guardar en mi cerebro" encendido, el
	// turno lleva las instrucciones para ir dejando notas (app_brain.go). Vacío
	// si está apagado o si los permisos de MCP ya no lo permiten.
	brain := a.brainInstructions(sessionID, module, contextID)
	// El pedido de encender el cerebro hecho antes de que existiera la fila se
	// persiste cuando el envío la crea.
	defer a.flushPendingBrain(sessionID)

	// Un servidor de modelos no es un proceso: sin ejecutable, entorno ni
	// aprobación por hook, solo el cliente HTTP. Sus herramientas (las del
	// servidor MCP y, con un repositorio, las de archivos y comandos) corren en
	// este proceso y las arma buildLLMTools según el modo — ver
	// app_llmtools.go.
	if agentchat.IsLLM(agentID) {
		llmMode, err := parseChatMode(mode)
		if err != nil {
			return err
		}
		client, err := a.llmClientForTurn(agentID)
		if err != nil {
			return err
		}
		turn := agentchat.Turn{
			SessionID:  sessionID,
			AgentID:    agentID,
			AgentLabel: agent.Label,
			Cwd:        cwd,
			Prompt:     prompt,
			Images:     prep.Images,
			PDFs:       prep.PDFs,
			// Todos los adjuntos, también los de texto (ya pegados en Prompt):
			// de acá salen sus nombres para el historial.
			Attachments: atts,
			Model:       model,
			Mode:        llmMode,
			LLM:         client,
			// Ventana de contexto del servidor, solo para avisar si el prompt
			// estimado no entra (agentchat.noticeContextOverflow).
			ContextTokens: a.llmContextTokens(agentID),
			// Si la app se reinició y este chat se retoma, el Manager no
			// tiene su memoria: se la arma desde lo guardado.
			History: agentchat.SeedHistory(a.llmSeedHistory(sessionID), llmSeedMessages, llmSeedChars),
		}
		a.attachLLMTools(&turn, module, contextID)
		// Recuerdo del cerebro (app_brain_recall.go): se busca con lo que
		// escribió la persona, no con el prompt ya expandido.
		brain, turn.Recalled = a.withRecall(brain, agentID, sessionID, module, contextID, typed)
		turn.System = withBrain(turn.System, brain)
		return a.sendRecorded(module, contextID, typed, turn)
	}

	// Mismo entorno que una sesión de terminal: PATH ampliado y, si hay una,
	// la API key por variable — nunca por la línea de comandos, donde quedaría
	// visible en `ps`.
	env, err := a.agentEnv(agent)
	if err != nil {
		return err
	}

	m, err := parseChatMode(mode)
	if err != nil {
		return err
	}

	// Claude Code recibe las instrucciones como system prompt agregado; Codex
	// y Antigravity no tienen un equivalente que no reemplace las suyas, así
	// que van adelante del mensaje que se le manda al CLI. `typed` —lo que se
	// graba en el historial— no las lleva.
	brain, recalled := a.withRecall(brain, agentID, sessionID, module, contextID, typed)
	system, prompt := brainDelivery(agentID, brain, prompt)

	return a.sendRecorded(module, contextID, typed, agentchat.Turn{
		SessionID: sessionID,
		Recalled:  recalled,
		AgentID:   agentID,
		Command:   agent.Command,
		// El ejecutable va resuelto a ruta absoluta: lanzarlo por nombre lo
		// hace depender del PATH que heredó la ventana, que abierta desde
		// Finder no incluye ~/.local/bin ni el prefijo de npm.
		Exec:            agents.Launcher(agent.Path),
		AgentLabel:      agent.Label,
		Cwd:             cwd,
		Env:             env,
		Prompt:          prompt,
		System:          system,
		Images:          prep.Images,
		PDFs:            prep.PDFs,
		Attachments:     atts,
		Mode:            m,
		Effort:          effort,
		Model:           model,
		ApproveSettings: a.approveSettings,
		// El id de la sesión viaja en el entorno del CLI, que el hook hereda:
		// así la pregunta de permiso llega rotulada con su chat.
		ApproveEnv: agentapprove.HookEnvFor(a.approve.Path(), sessionID),
	})
}

// parseChatMode valida el modo contra la unión conocida en vez de reenviarlo
// tal cual: es lo único que separa «consultá» de «modificá archivos», y no
// puede depender de que el frontend mande un string bien escrito.
func parseChatMode(mode string) (agentchat.Mode, error) {
	switch mode {
	case "plan":
		return agentchat.ModePlan, nil
	case "auto":
		return agentchat.ModeAuto, nil
	case "approve":
		return agentchat.ModeApprove, nil
	case "edit":
		return agentchat.ModeEdit, nil
	case "":
		return agentchat.ModeAsk, nil
	}
	return agentchat.ModeAsk, i18n.Errorf(i18n.Msg{ES: "app: modo de chat desconocido %q", EN: "app: unknown chat mode %q"}, mode)
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

	agent, err := a.agentByID(agentID)
	if err != nil {
		return "", err
	}

	cwd, err := a.agentCwd("git", repoID)
	if err != nil {
		return "", err
	}

	// Tope de tiempo: esto lo dispara un botón y bloquea un formulario, así
	// que un agente que se cuelga tiene que fallar y no dejar el botón girando
	// para siempre.
	ctx, cancel := context.WithTimeout(context.Background(), AgentAskTimeout)
	defer cancel()

	if agentchat.IsLLM(agentID) {
		client, err := a.llmClientForTurn(agentID)
		if err != nil {
			return "", err
		}
		return a.agentChats.Ask(ctx, agentchat.Turn{AgentID: agentID, Cwd: cwd, Prompt: prompt, LLM: client})
	}

	env, err := a.agentEnv(agent)
	if err != nil {
		return "", err
	}

	return a.agentChats.Ask(ctx, agentchat.Turn{
		AgentID: agentID,
		Command: agent.Command,
		Exec:    agents.Launcher(agent.Path),
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
//
// También borra los mensajes que la app guardó de ese chat (la entrada del
// historial queda): el botón promete empezar de cero, y dejar lo anterior en el
// vault haría que un servidor de modelos lo recuperara al retomar el chat, o
// que el historial mostrara una conversación que la persona ya descartó. La
// conversación propia del CLI no se toca.
func (a *App) ResetAgentChat(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.discardChatTurn(sessionID)
	a.agentChats.Reset(sessionID)
	a.brain.forgetRecalled(sessionID)
	return a.vault.DeleteAgentChatMessages(sessionID)
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
		return i18n.Errorf(i18n.Msg{ES: "app: %q no se edita desde la app", EN: "app: %q can't be edited from the app"}, path)
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
		return i18n.Errorf(i18n.Msg{ES: "app: %q no se edita desde la app", EN: "app: %q can't be edited from the app"}, path)
	}
	return mcpconf.UpsertServer(path, in)
}

// agentForPath deduce el agente de la ruta, solo para la comprobación de
// escritura: lo único que cambia el resultado es si es el config.toml de
// Codex, que se reconoce por su extensión, o un config de OpenCode, por su
// nombre.
func agentForPath(path string) string {
	if strings.EqualFold(filepath.Ext(path), ".toml") {
		return "codex"
	}
	if mcpconf.IsOpencodeConfig(path) {
		return "opencode"
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

// askApproval lleva la pregunta de un CLI (Claude Code, por el hook) a la
// ventana y espera la respuesta.
//
// Corre en la goroutine del canal, no en la del turno: acá se bloquea hasta
// que el usuario decide, el plazo vence (5 min: el silencio no es un sí) o
// cortan el turno. Los dos últimos descartan la pregunta — antes la goroutine
// quedaba esperando para siempre y la pregunta seguía en pantalla aunque el
// hook ya hubiera recibido el "no".
//
// La sesión dueña (req.SessionID) viene del hook; sin ella la pregunta se
// muestra igual, sin rótulo, y no frena el estado de ningún chat.
func (a *App) askApproval(req agentapprove.Request) agentapprove.Decision {
	ctx := context.Background()
	if a.agentChats != nil && req.SessionID != "" {
		ctx = a.agentChats.TurnContext(req.SessionID)
	}
	return a.askApprovalWith(ctx, req, agentapprove.Timeout, a.approvalEmitter())
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
		// No bloqueante: si ya se respondió (doble clic) el canal tiene su
		// único lugar ocupado y nadie lo va a leer.
		select {
		case reply <- agentapprove.Decision{Allow: allow, Reason: reason}:
		default:
		}
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

// AgentCLIConversations lista las conversaciones que el propio CLI ya tiene
// guardadas de este repositorio.
//
// Es distinto de ListAgentChats, que devuelve solo lo abierto DESDE la app.
// Los CLIs son los mismos que se usan por fuera —la extensión de VS Code, la
// terminal— y todo eso queda en el mismo almacenamiento; sin esto, abrir un
// repositorio con semanas de trabajo encima muestra un historial vacío y
// parece que la app perdió los chats.
//
// Devuelve punteros, no mensajes: el id que el CLI ya usa para encadenar.
func (a *App) AgentCLIConversations(agentID, repoID string) ([]agentchat.Conversation, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	// Un servidor de modelos no tiene conversaciones propias que listar.
	if agentchat.IsLLM(agentID) {
		return []agentchat.Conversation{}, nil
	}
	root, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	cs, err := agentchat.Conversations(agentID, root)
	if err != nil {
		return nil, err
	}
	// Nunca nil: el frontend recorre esto con .map, y un null lo rompe.
	if cs == nil {
		cs = []agentchat.Conversation{}
	}
	return cs, nil
}

// CreateAgentChat registra una conversación nueva. El id lo genera el frontend
// y es el mismo que identifica la sesión del panel.
//
// module/contextID dicen desde qué módulo nació ("git", "db", "ssh", "note")
// y sobre qué recurso — el chat es uno solo para toda la app, así que una
// conversación puede empezar en el editor SQL sin repositorio de por medio. Se
// guarda el ID del recurso y nunca su nombre visible: ver AgentChat.Module.
func (a *App) CreateAgentChat(id, repoID, agentID, title, module, contextID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.CreateAgentChat(id, repoID, agentID, title, module, contextID)
}

// ListAllAgentChats devuelve el historial COMPLETO, de todos los módulos.
//
// ListAgentChats (por repositorio) sigue existiendo para la vista del módulo
// Git; esta es la que necesita el chat unificado, donde una conversación puede
// no venir de ningún repositorio y filtrar por repo la dejaría invisible.
func (a *App) ListAllAgentChats() ([]vault.AgentChat, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListAllAgentChats()
}

// SetAgentChatContext reasigna una conversación al módulo donde se la está
// usando ahora. Ver Store.SetAgentChatContext para por qué se mueve en vez de
// abrir una conversación nueva por módulo.
func (a *App) SetAgentChatContext(id, module, contextID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAgentChatContext(id, module, contextID)
}

// maxChatTitle es el largo máximo del nombre de una conversación (en
// caracteres). El frontend aplica el mismo tope (lib/chatTitle.ts).
const maxChatTitle = 120

var msgChatTitleEmpty = i18n.Msg{ES: "el nombre de la conversación no puede estar vacío", EN: "the conversation name cannot be empty"}

// RenameAgentChat cambia el nombre visible de una conversación: lo recorta, lo
// limita a maxChatTitle y rechaza uno vacío (la interfaz vuelve al nombre
// anterior en ese caso). También actualiza el título de la sesión viva, para que
// «Activas» y las pestañas lo muestren sin esperar a reabrirla.
func (a *App) RenameAgentChat(id, title string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		return i18n.New(msgChatTitleEmpty)
	}
	if r := []rune(title); len(r) > maxChatTitle {
		title = strings.TrimSpace(string(r[:maxChatTitle]))
	}
	if err := a.vault.RenameAgentChat(id, title); err != nil {
		return err
	}
	if a.agentChats != nil {
		a.agentChats.SetTitle(id, title)
	}
	return nil
}

// DeleteAgentChat saca la conversación del historial. **No borra la
// conversación del CLI**: esa vive en su propio almacenamiento y esta app no
// la administra; lo que se pierde es el atajo para retomarla desde acá.
func (a *App) DeleteAgentChat(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	// Un turno en vuelo no debe volver a escribir en un chat borrado, y la
	// sesión viva (si la hay) se corta y sale de la lista de Abiertas.
	a.discardChatTurn(id)
	if a.agentChats != nil {
		a.agentChats.CloseSession(id)
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

// AgentChatMessage es un mensaje guardado de una conversación.
//
// Role es "user", "assistant" o "tool". En las filas "tool", ToolName es la
// herramienta y Content su resumen (primera línea) y detalle (segunda, si hay).
// Un error del turno es una fila "assistant" cuyo Content empieza con "⚠ "
// (agentchat.ErrorRowPrefix). Dentro de un turno las herramientas van antes de
// la respuesta; los tokens (Usage) están en la última fila del turno.
// CreatedAt son segundos Unix. Attachments son los adjuntos de una fila "user"
// (nombre, tipo, tamaño; nunca el contenido), siempre una lista —vacía si no
// hubo—.
type AgentChatMessage struct {
	Seq         int                        `json:"seq"`
	Role        string                     `json:"role"`
	Content     string                     `json:"content"`
	ToolName    string                     `json:"toolName"`
	Usage       *agentchat.Usage           `json:"usage"`
	Attachments []agentchat.AttachmentMeta `json:"attachments"`
	CreatedAt   int64                      `json:"createdAt"`
}

// AgentChatMessages devuelve los mensajes guardados de una conversación, del
// primero al último. Es el historial genérico de la app: sirve igual para un
// CLI que para un servidor de modelos. Una conversación sin mensajes
// guardados (anterior a esta función) devuelve una lista vacía — para esas, el
// transcript del CLI sigue disponible vía AgentChatHistory.
func (a *App) AgentChatMessages(chatID string) ([]AgentChatMessage, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	rows, err := a.vault.ListAgentChatMessages(chatID)
	if err != nil {
		return nil, err
	}
	out := make([]AgentChatMessage, 0, len(rows))
	for _, m := range rows {
		msg := AgentChatMessage{Seq: m.Seq, Role: m.Role, Content: m.Content, ToolName: m.ToolName, Attachments: attachmentsFromMeta(m.Meta), CreatedAt: m.CreatedAt}
		if m.Usage != "" {
			var u agentchat.Usage
			if json.Unmarshal([]byte(m.Usage), &u) == nil {
				msg.Usage = &u
			}
		}
		out = append(out, msg)
	}
	return out, nil
}

// SearchAgentChats busca texto en los títulos y los mensajes de todas las
// conversaciones, de cualquier proveedor, y devuelve las que aciertan —las más
// recientes primero—. Sin distinguir mayúsculas ni acentos; varias palabras
// deben aparecer todas (en el título o en cualquier mensaje) y las comillas
// piden una frase literal. Una búsqueda vacía devuelve una lista vacía: para
// listar todo está ListAllAgentChats.
func (a *App) SearchAgentChats(query string) ([]vault.AgentChat, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SearchAgentChats(query, 200)
}

// AgentChatHistory recupera los mensajes de una conversación anterior, para
// que al retomar un chat el panel no arranque vacío.
//
// Lee primero los mensajes que guardó la app (AgentChatMessages), ubicando el
// chat por su id de conversación. Solo si ese chat no tiene mensajes guardados
// —uno anterior a esa función, o una conversación del CLI adoptada— cae a la
// transcripción del propio CLI.
//
// **La transcripción no sale igual para los tres agentes** y eso es parte del
// contrato: Claude Code se lee entero, Codex se lee con una heurística
// documentada para separar sus mensajes inyectados de los reales, y
// Antigravity lee su transcript en JSONL. Un vacío NO es un error: la
// conversación sigue encadenando igual, porque eso lo hace el id del CLI y no
// esto.
func (a *App) AgentChatHistory(agentID, conversationID string) ([]agentchat.PastTurn, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	chatID, err := a.vault.AgentChatIDByConversation(agentID, conversationID)
	if err != nil {
		return nil, err
	}
	// Un servidor de modelos usa el id de la sesión como id de conversación:
	// si la fila todavía no apunta a él (el Touch del frontend puede llegar
	// después), el id de conversación ES el del chat.
	if chatID == "" && agentchat.IsLLM(agentID) {
		chatID = conversationID
	}
	if chatID != "" {
		rows, err := a.vault.ListAgentChatMessages(chatID)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			return agentchat.PastTurnsFromStored(storedToHistory(rows)), nil
		}
	}
	// Un servidor de modelos no tiene transcripción propia: vacío, sin error.
	if agentchat.IsLLM(agentID) {
		return []agentchat.PastTurn{}, nil
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
	// Los modelos de un servidor salen de él en el momento (sin la caché de
	// los CLIs: bajar un modelo nuevo tiene que verse enseguida).
	if agentchat.IsLLM(agentID) {
		return a.llmModelCatalog(agentID), nil
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

// AgentUsageLimits informa **cuánto se lleva usado del límite** de cada agente:
// el porcentaje de la ventana corta, el de la semanal y los por modelo, cuando
// el proveedor los publica.
//
// Es el complemento exacto de AgentUsageAll y no lo reemplaza, porque contestan
// preguntas distintas con datos de distinto origen:
//
//   - `AgentUsageAll` mide CONSUMO —tokens contados de los transcripts locales—
//     y sus porcentajes son proporciones de lo gastado, nunca de un tope.
//   - `AgentUsageLimits` lee el porcentaje del TOPE **ya calculado por el
//     servidor del proveedor** y cacheado por el propio CLI en el disco. No hay
//     ninguna división inventada acá: lo único que agrega esta app es leerlo y
//     decir de cuándo es, porque es un dato fechado y no en vivo.
//
// Ver backend/agentlimits para qué archivo publica cada CLI y qué se verificó
// contra instalaciones reales.
func (a *App) AgentUsageLimits() ([]agentlimits.AgentLimits, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return agentlimits.All(), nil
}

// AgentQueryLimits le PREGUNTA el límite al CLI de un agente que no lo deja
// escrito en el disco, y lo cachea para el resto de la sesión de la app.
//
// Hoy solo Antigravity: no guarda su cuota en ningún archivo, pero contesta
// `agy --print "/usage" --output-format json` con los grupos de modelos, sus
// ventanas y cuánto queda de cada una. Es su interfaz pública, la misma que
// usaría el usuario a mano — no se imita ningún protocolo interno.
//
// **Lo dispara un botón y no la apertura del panel**: cuesta un subproceso y
// unos segundos, y falla por red de vez en cuando (el propio CLI devuelve
// `context deadline exceeded` y anda al reintentar). No consume cuota: el CLI
// informa cero tokens para este comando.
func (a *App) AgentQueryLimits(agentID string) (agentlimits.AgentLimits, error) {
	if err := a.requireUnlocked(); err != nil {
		return agentlimits.AgentLimits{}, err
	}
	if !agentlimits.Queryable(agentID) {
		return agentlimits.AgentLimits{}, i18n.Errorf(i18n.Msg{ES: "app: a ese agente no se le puede preguntar el límite por línea de comandos", EN: "app: that agent can't be asked for its limit from the command line"})
	}

	agent, err := a.agentByID(agentID)
	if err != nil {
		return agentlimits.AgentLimits{}, err
	}
	if !agent.Available {
		return agentlimits.AgentLimits{}, i18n.Errorf(i18n.Msg{ES: "app: %s no está instalado en esta máquina", EN: "app: %s is not installed on this machine"}, agent.Label)
	}

	env, err := a.agentEnv(agent)
	if err != nil {
		return agentlimits.AgentLimits{}, err
	}
	// Directorio propio y vacío, el mismo criterio que las consultas puntuales:
	// esto no se pregunta sobre ningún repositorio ni necesita ver archivos.
	cwd, err := a.agentCwd("", "")
	if err != nil {
		return agentlimits.AgentLimits{}, err
	}

	return agentlimits.Query(context.Background(), agentlimits.QuerySpec{
		AgentID: agentID,
		// Ruta absoluta, igual que el resto: lanzarlo por nombre lo hace
		// depender del PATH que heredó la ventana (fix de 1.3.1).
		Argv: agents.Launcher(agent.Path),
		Env:  env,
		Cwd:  cwd,
	})
}

// SetAgentChatSettings guarda el modelo, el esfuerzo y el modo con los que se
// estaba trabajando en un chat, para que retomarlo lo continúe como venía.
func (a *App) SetAgentChatSettings(id, model, effort, mode string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAgentChatSettings(id, model, effort, mode)
}

// SetAgentChatAgent pasa un chat de un proveedor de modelos a otro (estilo
// Hermes: se empieza con uno y se sigue con otro sin perder la conversación).
//
// Solo entre servidores de modelos (`llm:`): la historia de un chat con un CLI
// la guarda el propio CLI, atada a su conversación, y no se puede reasignar a
// otro. El destino tiene que existir y estar activado.
//
// Cambia agent_chats.agent_id y vacía el modelo guardado (el de un proveedor no
// existe en el otro); el historial no se toca: el contexto de los turnos
// siguientes sale de la memoria de la sesión y, tras reiniciar, de lo guardado.
// El consumo ya hecho queda con el proveedor que lo produjo (ver
// vault.SetAgentChatAgent). Cambiar al mismo proveedor no hace nada.
func (a *App) SetAgentChatAgent(chatID, agentID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	current, ok, err := a.vault.AgentChatAgent(chatID)
	if err != nil {
		return err
	}
	if !ok {
		return i18n.Errorf(i18n.Msg{ES: "app: el chat no existe", EN: "app: the chat does not exist"})
	}
	if !agentchat.IsLLM(current) || !agentchat.IsLLM(agentID) {
		return i18n.Errorf(i18n.Msg{
			ES: "app: solo se puede cambiar de proveedor entre servidores de modelos; un chat con un CLI conserva su propio historial",
			EN: "app: you can only switch between model servers; a CLI chat keeps its own history",
		})
	}
	m, err := a.vault.GetModelServer(strings.TrimPrefix(agentID, agentchat.LLMPrefix))
	if err != nil {
		return err
	}
	if !m.Enabled {
		return errProviderDisabled(m.Name)
	}
	if current == agentID {
		return nil
	}
	return a.vault.SetAgentChatAgent(chatID, current, agentID)
}
