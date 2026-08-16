package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/agents"
	"mini-tools/backend/appdata"
)

// Bindings del agente de código a nivel APLICACIÓN.
//
// Hasta 1.3.x lo agéntico vivía dentro de la pestaña Git: el chat era un
// componente de ese módulo y el agente elegido se guardaba por repositorio
// (`git_repos.default_agent`). Eso alcanzaba mientras el único lugar donde se
// preguntaba algo era un repositorio, pero el trabajo real cruza módulos —se
// mira un EXPLAIN, se corrige la consulta, se revisa un log por SSH y se anota
// la conclusión—, y un chat por módulo parte ese hilo en pedazos que no se
// conocen entre sí.
//
// Este archivo es el piso del chat unificado: quién es el agente activo de la
// app, y cómo se le hace UNA pregunta desde cualquier módulo. El chat en
// streaming sigue siendo SendAgentChat (app_localterm.go) — son dos verbos
// distintos a propósito:
//
//   - AgentAsk: "contestame acá y ahora". Devuelve texto, no puede editar
//     archivos, tiene tope de tiempo. Es lo que usan NL2SQL, el analizador de
//     EXPLAIN y el debugger de la terminal.
//   - SendAgentChat: "llevate esto a la conversación". Streamea y mantiene la
//     continuidad.
//
// Todos los métodos pasan por requireUnlocked (.claude/rules/technical.md
// punto 5): abren un proceso con todos los permisos del usuario.

// ActiveAgent es el agente elegido para toda la app, ya resuelto contra el
// catálogo — la UI necesita saber no solo cuál está guardado sino si sigue
// instalado, que es la diferencia entre "elegí uno" y "el que elegiste ya no
// está".
type ActiveAgent struct {
	// ID es el id del catálogo (backend/agents), o "" si todavía no se eligió
	// ninguno. Vacío NO significa "no hay ninguno disponible": significa que la
	// app no eligió por el usuario, que es distinto y se muestra distinto.
	ID string `json:"id"`
	// Label es el nombre visible del agente ("Claude Code"). Vacío cuando el
	// agente guardado ya no está en el catálogo.
	Label string `json:"label"`
	// Available es si el binario está realmente en la máquina. Un agente
	// guardado que se desinstaló llega con Available=false y su ID intacto: se
	// puede decir CUÁL falta, que es lo único útil en ese momento.
	Available bool   `json:"available"`
	Model     string `json:"model"`
	Effort    string `json:"effort"`
	// ChatSupported es si ese agente tiene adaptador verificado para el chat
	// estructurado (backend/agentchat). Los que no lo tienen se pueden usar
	// igual en la terminal, pero no dibujan un chat.
	ChatSupported bool `json:"chatSupported"`
}

// AgentActive devuelve el agente activo de la app, resuelto contra el catálogo.
func (a *App) AgentActive() (ActiveAgent, error) {
	if err := a.requireUnlocked(); err != nil {
		return ActiveAgent{}, err
	}
	s, err := a.vault.GetSettings()
	if err != nil {
		return ActiveAgent{}, err
	}
	out := ActiveAgent{ID: s.ActiveAgent, Model: s.ActiveModel, Effort: s.ActiveEffort}
	if out.ID == "" {
		return out, nil
	}

	agent, err := a.agentByID(out.ID)
	if err != nil {
		// Un agente guardado que ya no está en el catálogo no es un error de
		// la llamada: es información que la UI tiene que poder mostrar. Se
		// devuelve el id tal cual, sin etiqueta y no disponible.
		return out, nil
	}
	out.Label = agent.Label
	out.Available = agent.Available
	out.ChatSupported = agentchat.Supports(agent.ID)
	return out, nil
}

// SetAgentActive persiste el agente activo de la app con su modelo y esfuerzo.
//
// Un id vacío es válido y significa "volver a preguntar" — es la forma de
// deshacer la elección sin tener que elegir otro.
func (a *App) SetAgentActive(agentID, model, effort string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	// Un id que no existe se rechaza acá y no al abrir el chat: guardarlo
	// dejaría la barra de agente mostrando algo que nunca va a arrancar, y el
	// error aparecería recién en el próximo turno, lejos de la acción que lo
	// causó.
	if agentID != "" {
		if _, err := a.agentByID(agentID); err != nil {
			return err
		}
	}
	return a.vault.SetActiveAgent(agentID, model, effort)
}

// SetAgentLayout persiste dónde va anclado el panel del chat y cuánto mide.
//
// A diferencia del resto de este archivo NO requiere el vault desbloqueado:
// es la misma excepción documentada de GetSettings/SetTheme
// (.claude/rules/technical.md punto 5) y por el mismo motivo — es una
// preferencia de disposición, sin nada sensible adentro, y gatearla solo
// causaría que el panel abra en el lugar equivocado durante el desbloqueo.
func (a *App) SetAgentLayout(dock string, size int) error {
	return a.vault.SetAgentLayout(dock, size)
}

// agentByID resuelve un agente del catálogo aplicando los overrides guardados
// en el vault (comando propio, API key).
//
// Estaba repetido tres veces (SendAgentChat, AskAgentOnce y acá): son ~20
// líneas idénticas cuyo único efecto de una copia desactualizada sería que un
// camino respete el comando configurado por el usuario y otro no.
func (a *App) agentByID(agentID string) (agents.Agent, error) {
	configs, err := a.vault.ListAgentConfigs()
	if err != nil {
		return agents.Agent{}, err
	}
	overrides := make(map[string]agents.Override, len(configs))
	for id, c := range configs {
		overrides[id] = agents.Override{Command: c.Command, HasKey: c.HasKey}
	}
	for _, cand := range agents.List(overrides) {
		if cand.ID == agentID {
			return cand, nil
		}
	}
	return agents.Agent{}, fmt.Errorf("app: agente desconocido %q", agentID)
}

// agentEnv arma el entorno del subproceso: el del proceso entero más la API
// key por variable si hay una guardada.
//
// El entorno COMPLETO y no una lista armada a mano: cmd.Env reemplaza en vez de
// agregar, y sin HOME Claude Code no encuentra su sesión y Antigravity ni
// siquiera llega a leer el prompt (ver el fix de 1.3.1). La key va por variable
// y nunca por la línea de comandos, donde quedaría visible en `ps`.
func (a *App) agentEnv(agent agents.Agent) ([]string, error) {
	env := agents.Env()
	if agent.KeyEnv == "" {
		return env, nil
	}
	key, err := a.vault.AgentKey(agent.ID)
	if err != nil {
		return nil, err
	}
	if key != "" {
		env = append(env, agent.KeyEnv+"="+key)
	}
	return env, nil
}

// agentCwd resuelve el directorio de trabajo del subproceso según el módulo
// desde el que se pregunta.
//
// Un repositorio es el caso fácil: el agente trabaja adentro, que es lo que ya
// hacía. Los demás módulos —el editor SQL, una terminal SSH, una nota— no
// tienen un directorio propio, y ahí la elección importa más de lo que parece:
// el directorio de trabajo es lo que el agente puede leer sin que nadie se lo
// pase. Lanzarlo en el home del usuario le daría acceso de lectura a todo lo
// que hay ahí para responder una pregunta sobre un esquema de base de datos.
//
// Por eso usa un directorio propio y VACÍO dentro de los datos de la app. El
// contexto de esas preguntas viaja en el prompt (el DDL, el plan, las líneas de
// log), no en el disco: un agente que no encuentra nada donde está parado es
// exactamente el comportamiento correcto.
func (a *App) agentCwd(module, contextID string) (string, error) {
	if module == "git" && contextID != "" {
		return a.gitRepo(contextID)
	}
	dir, err := appdata.Dir()
	if err != nil {
		return "", err
	}
	scratch := filepath.Join(dir, "consultas")
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		return "", fmt.Errorf("app: preparando el directorio de consultas: %w", err)
	}
	return scratch, nil
}

// AgentAskTimeout acota una consulta puntual. Esto lo dispara un botón y
// bloquea un formulario, así que un agente colgado tiene que fallar en vez de
// dejar el botón girando para siempre.
const AgentAskTimeout = 3 * time.Minute

// AgentAsk corre UN turno con el agente activo y devuelve el texto de la
// respuesta. Es el verbo que usan todos los módulos para una pregunta puntual.
//
// **El agente propone; aplicar sigue siendo un clic del usuario.** Esto
// devuelve texto y nada más: agentchat.Ask rechaza los modos que editan, así
// que no escribe archivos, no ejecuta la consulta que generó y no toca la base
// de datos. Un asistente que ejecuta lo que acaba de escribir contra una
// conexión de producción es exactamente el producto que nadie pidió.
//
// module/contextID describen desde dónde se pregunta ("git" + id de
// repositorio, "db" + id de conexión, "ssh" + id de conexión, "note" + id de
// nota). Determinan el directorio de trabajo del subproceso — ver agentCwd.
func (a *App) AgentAsk(prompt, module, contextID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if prompt == "" {
		return "", fmt.Errorf("app: la consulta al agente está vacía")
	}

	active, err := a.AgentActive()
	if err != nil {
		return "", err
	}
	if active.ID == "" {
		return "", fmt.Errorf("app: no hay ningún agente elegido — elegí uno en la barra de agente")
	}
	agent, err := a.agentByID(active.ID)
	if err != nil {
		return "", err
	}
	if !agent.Available {
		return "", fmt.Errorf("app: %s no está instalado en esta máquina", agent.Label)
	}

	env, err := a.agentEnv(agent)
	if err != nil {
		return "", err
	}
	cwd, err := a.agentCwd(module, contextID)
	if err != nil {
		return "", err
	}

	// Mismo criterio que SendAgentChat: las referencias `@tipo:valor` se
	// expanden en Go, nunca en el frontend.
	prompt, _ = a.expandRefs(prompt, module, contextID)

	ctx, cancel := context.WithTimeout(context.Background(), AgentAskTimeout)
	defer cancel()

	return a.agentChats.Ask(ctx, agentchat.Turn{
		AgentID: agent.ID,
		Command: agent.Command,
		// El ejecutable va resuelto a ruta absoluta: lanzarlo por nombre lo
		// hace depender del PATH que heredó la ventana, que abierta desde
		// Finder no incluye ~/.local/bin ni el prefijo de npm (fix de 1.3.1).
		Exec:   agents.Launcher(agent.Path),
		Cwd:    cwd,
		Env:    env,
		Prompt: prompt,
		// El modelo del agente activo, sí; el esfuerzo también. El MODO no se
		// pasa a propósito: Ask rechaza los permisivos, y mandar uno sería
		// pedir un permiso para algo que este camino no hace.
		Model:  active.Model,
		Effort: active.Effort,
	})
}
