package agentchat

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

// maxLineBytes acota una línea del stream. Un evento puede traer el contenido
// de un archivo adentro, así que el tope es generoso; una línea de 16 MB
// significa que esto no es lo que creemos que es.
const maxLineBytes = 16 << 20

// Manager corre los turnos de chat y mantiene la continuidad de cada sesión.
//
// Un turno = un proceso. Los CLIs headless terminan cuando contestan, así que
// no hay un proceso vivo entre pregunta y pregunta: lo único que se conserva es
// el id de conversación que ellos devuelven, para pasárselo al turno
// siguiente. No se guarda acá el historial de la conversación — eso lo tiene el
// CLI, y duplicarlo sería una segunda memoria que se desincroniza con la real.
type Manager struct {
	mu      sync.Mutex
	convos  map[string]string
	cancels map[string]context.CancelFunc
	emit    EmitFunc
}

func NewManager(emit EmitFunc) *Manager {
	return &Manager{convos: map[string]string{}, cancels: map[string]context.CancelFunc{}, emit: emit}
}

// Mode es qué tiene permitido hacer el agente en este turno. Son tres y no
// seis a propósito: los CLIs exponen más modos (incluido uno que saltea TODO,
// comandos incluidos), y ofrecer acá el catálogo completo sería trasladarle al
// usuario una decisión que no puede evaluar desde una lista desplegable.
type Mode string

const (
	// ModeAsk es el default: sin modo explícito. Una edición que requiera
	// confirmación no se puede aprobar desde un chat sin diálogo propio, así
	// que el agente la salta. Sirve para preguntar, revisar y razonar.
	ModeAsk Mode = ""
	// ModePlan explora y propone sin tocar nada. Es el modo honesto para
	// "decime cómo harías esto".
	ModePlan Mode = "plan"
	// ModeAuto deja que el CLI apruebe solo lo que pasa su propio control de
	// seguridad y frene en lo riesgoso. **Solo Claude Code lo tiene**
	// (`--permission-mode auto`); Antigravity no expone un equivalente, y
	// mapearlo a su "accept-edits" sería darle MÁS permiso del que el usuario
	// pidió, que es la peor forma de equivocarse acá.
	ModeAuto Mode = "auto"
	// ModeApprove deja que el agente actúe, pero **preguntando por cada
	// acción** a la ventana de la app (ver backend/agentapprove). Es el modo
	// que el usuario pidió: el agente trabaja, y el cliente aprueba antes de
	// cada cosa.
	//
	// Solo se ofrece si el canal de aprobación se pudo abrir en esta máquina;
	// si no, no aparece en la lista en vez de comportarse como un modo
	// permisivo sin aviso.
	ModeApprove Mode = "approve"
	// ModeEdit aplica ediciones sin preguntar. Es una decisión EXPLÍCITA del
	// usuario, elegida turno a turno y con la advertencia a la vista — no un
	// default que la app active por su cuenta. Lo que lo hace aceptable es
	// que el resultado cae en el árbol de trabajo de un repositorio git: se ve
	// en el diff de la app y se descarta con un click.
	ModeEdit Mode = "edit"
)

// modesByAgent es qué modos soporta CADA CLI, que no es lo mismo para todos.
// La UI ofrece solo estos: un desplegable con una opción que el CLI va a
// rechazar es peor que uno más corto.
var modesByAgent = map[string][]Mode{
	// ModeApprove va después de Plan y antes de Auto: es más capaz que
	// planear y menos suelto que actuar por su cuenta. Solo Claude Code lo
	// tiene por ahora — es el único cuyo mecanismo de hooks se verificó
	// funcionando de punta a punta.
	"claude":      {ModeAsk, ModePlan, ModeApprove, ModeAuto, ModeEdit},
	"antigravity": {ModeAsk, ModePlan, ModeEdit},
	// Codex no expone un modo "plan"; sí sandbox y aprobaciones, que se mapean
	// a lo que hay: por defecto su sandbox de solo lectura, y para editar el
	// de escritura en el workspace.
	"codex": {ModeAsk, ModeEdit},
}

// ModesFor filtra los que no se pueden ofrecer en esta máquina.
//
// approveReady lo decide quien llama (la app sabe si el canal se abrió). Un
// modo que se ofrece y no funciona es peor que uno que no aparece: acá lo que
// no funcionaría es justamente la aprobación.

// ModesFor devuelve los modos de un agente, en orden de menos a más permisivo
// — el orden importa: es el que ve el usuario en la lista.
func ModesFor(agentID string, approveReady bool) []string {
	modes := modesByAgent[agentID]
	out := make([]string, 0, len(modes))
	for _, m := range modes {
		if m == ModeApprove && !approveReady {
			continue
		}
		out = append(out, string(m))
	}
	return out
}

// Turn es lo que hace falta para un turno.
type Turn struct {
	SessionID string
	AgentID   string
	// Command es lo que el catálogo resolvió para este agente (puede traer
	// argumentos fijos del usuario).
	Command string
	// Exec es el argv con el que se lanza de verdad: el ejecutable ya
	// resuelto a ruta absoluta, más el `cmd /c` de adelante si en Windows es
	// un shim `.cmd`. Reemplaza al primer token de Command, conservando los
	// argumentos fijos que traiga.
	//
	// Existe porque `exec.Command` resuelve el nombre del programa con el
	// PATH **del proceso padre**, no con el que se le ponga en `cmd.Env`: una
	// app de macOS abierta desde Finder hereda un PATH mínimo sin
	// `~/.local/bin` ni el prefijo de npm, así que invocar "claude" por
	// nombre fallaba con "executable file not found in $PATH" aunque el
	// catálogo lo hubiera encontrado un segundo antes.
	Exec []string
	Cwd     string
	Env     []string
	Prompt  string
	Mode    Mode
	// ApproveSettings es la ruta del archivo de settings que instala el hook
	// de aprobación. Solo se usa con ModeApprove; vacío deshabilita el modo,
	// que es lo que pasa cuando el canal no se pudo abrir.
	ApproveSettings string
	// ApproveEnv son las variables que necesita el re-exec del hook.
	ApproveEnv []string
	// Model es el modelo para este turno. Vacío usa el del CLI. No se valida
	// contra una lista fija: los ids cambian con cada versión de cada
	// proveedor, y una lista hardcodeada acá quedaría vieja rechazando modelos
	// que sí existen. Si el id no vale, lo rechaza el CLI con su propio
	// mensaje — que es más exacto que cualquiera que pudiéramos inventar.
	Model string
	// Effort es el esfuerzo de razonamiento ("low"/"medium"/"high"). Vacío usa
	// el del CLI. No se valida contra una lista fija acá: los valores los
	// define cada CLI y difieren entre ellos (Claude Code agrega "xhigh" y
	// "max"), así que se pasa lo que la UI ofrezca y el CLI rechaza lo que no
	// conozca — con un mensaje suyo, que es mejor que uno inventado.
	Effort string
	// Images son rutas absolutas de imágenes adjuntas al mensaje.
	//
	// Cómo llegan al agente NO es igual en los tres, y por eso esto es una
	// lista de rutas y no un blob: Codex tiene una bandera propia (`-i`);
	// Claude Code no la tiene pero su herramienta de lectura abre imágenes,
	// así que alcanza con nombrarle el archivo. Verificado en el `--help` de
	// cada uno, no supuesto.
	Images []string
}

// Send arranca un turno y streamea sus eventos. Vuelve enseguida: el turno
// corre en su goroutine y todo lo demás llega por EmitFunc, igual que
// query.Executor y localterm.
func (m *Manager) Send(t Turn) error {
	if t.SessionID == "" {
		return fmt.Errorf("agentchat: falta el id de sesión")
	}
	if strings.TrimSpace(t.Prompt) == "" {
		return fmt.Errorf("agentchat: el mensaje está vacío")
	}
	adapt, ok := adapters[t.AgentID]
	if !ok {
		// Se falla claro en vez de correr el CLI y mostrar un chat mudo: sin
		// adaptador verificado no se puede leer nada de lo que conteste.
		return fmt.Errorf("agentchat: el chat todavía no está verificado para %q; usá la terminal para ese agente", t.AgentID)
	}

	m.mu.Lock()
	if _, busy := m.cancels[t.SessionID]; busy {
		m.mu.Unlock()
		return fmt.Errorf("agentchat: esa sesión todavía está contestando")
	}
	convo := m.convos[t.SessionID]
	ctx, cancel := context.WithCancel(context.Background())
	m.cancels[t.SessionID] = cancel
	m.mu.Unlock()

	args, err := buildArgs(t, convo)
	if err != nil {
		m.finish(t.SessionID)
		return err
	}

	go m.run(ctx, t, args, adapt)
	return nil
}

// Ask corre un turno de UNA sola vez y devuelve el texto de la respuesta, en
// vez de streamearlo.
//
// Es lo que necesitan las acciones agénticas del módulo Git —redactar un
// mensaje de commit desde el diff preparado, describir un PR, revisar antes de
// pushear—: ahí no hace falta una conversación, hace falta un texto que va a
// parar a un campo del formulario. Con el PTY esto era directamente imposible:
// la respuesta se veía en la terminal y había que copiarla a mano.
//
// Deliberadamente NO encadena conversación ni guarda estado: cada llamada es
// independiente. Y **no acepta ModeEdit** — una acción que dispara un botón y
// devuelve texto no tiene por qué poder tocar archivos; para eso está el chat,
// donde el modo se elige a la vista.
func (m *Manager) Ask(ctx context.Context, t Turn) (string, error) {
	adapt, ok := adapters[t.AgentID]
	if !ok {
		return "", fmt.Errorf("agentchat: no hay modo headless verificado para %q", t.AgentID)
	}
	if t.Mode == ModeEdit || t.Mode == ModeAuto {
		return "", fmt.Errorf("agentchat: una acción de un botón no corre en modo de edición")
	}
	if strings.TrimSpace(t.Prompt) == "" {
		return "", fmt.Errorf("agentchat: el mensaje está vacío")
	}

	args, err := buildArgs(t, "")
	if err != nil {
		return "", err
	}

	args = withExec(t, args)
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = t.Cwd
	cmd.Env = t.Env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("no se pudo ejecutar %q: %w", args[0], err)
	}

	var text strings.Builder
	var failure string
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		for _, ev := range adapt([]byte(line)) {
			switch ev.Kind {
			case KindText:
				text.WriteString(ev.Text)
			case KindError:
				failure = ev.Error
			}
		}
	}

	// Un error del scanner corta la lectura a la mitad: sin comprobarlo, una
	// respuesta truncada se devolvería como si estuviera completa — y acá esa
	// respuesta va a parar a un mensaje de commit.
	if err := sc.Err(); err != nil {
		return "", fmt.Errorf("se cortó la lectura de la respuesta: %w", err)
	}
	if waitErr := cmd.Wait(); waitErr != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", fmt.Errorf("%s", msg)
		}
		return "", waitErr
	}
	if failure != "" {
		return "", fmt.Errorf("%s", failure)
	}
	if strings.TrimSpace(text.String()) == "" {
		return "", fmt.Errorf("el agente no devolvió texto")
	}
	return strings.TrimSpace(text.String()), nil
}

// Resume ata una sesión del panel a una conversación que ya existía en el
// CLI, para que el próximo mensaje siga esa charla en vez de empezar una.
//
// Es lo que permite cerrar la app y retomar días después: el historial de la
// conversación lo tiene el CLI y esto solo vuelve a apuntar a él.
func (m *Manager) Resume(sessionID, conversationID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if conversationID == "" {
		delete(m.convos, sessionID)
		return
	}
	m.convos[sessionID] = conversationID
}

// Cancel corta el turno en curso. Es la única forma de parar un agente que se
// fue por las ramas, y por eso el contexto se guarda por sesión.
func (m *Manager) Cancel(sessionID string) {
	m.mu.Lock()
	cancel := m.cancels[sessionID]
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Reset olvida la conversación de una sesión: el próximo turno arranca de
// cero en vez de encadenar.
func (m *Manager) Reset(sessionID string) {
	m.Cancel(sessionID)
	m.mu.Lock()
	delete(m.convos, sessionID)
	m.mu.Unlock()
}

func (m *Manager) finish(sessionID string) {
	m.mu.Lock()
	delete(m.cancels, sessionID)
	m.mu.Unlock()
}

func (m *Manager) run(ctx context.Context, t Turn, args []string, adapt adapter) {
	defer m.finish(t.SessionID)

	if len(args) == 0 {
		m.emit(t.SessionID, Event{Kind: KindError, Error: "no se pudo armar el comando del agente"})
		return
	}

	args = withExec(t, args)
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = t.Cwd
	// El entorno del hook viaja al proceso del agente para que lo herede el
	// re-exec que el CLI va a lanzar: el hook necesita saber a qué socket
	// contestar, y solo puede saberlo por herencia.
	cmd.Env = append(append([]string{}, t.Env...), t.ApproveEnv...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.emit(t.SessionID, Event{Kind: KindError, Error: err.Error()})
		return
	}
	// stderr se junta aparte: es donde el CLI explica por qué no arrancó
	// (sesión vencida, modelo inexistente), y sin eso el error sería un código
	// de salida pelado.
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		m.emit(t.SessionID, Event{Kind: KindError, Error: fmt.Sprintf("no se pudo ejecutar %q: %v", args[0], err)})
		return
	}

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		for _, ev := range adapt([]byte(line)) {
			// El id de conversación se retiene apenas aparece, no al final:
			// si el turno se corta a la mitad, el siguiente igual encadena con
			// lo que ya se dijo en vez de empezar de cero.
			if ev.ConversationID != "" {
				m.mu.Lock()
				m.convos[t.SessionID] = ev.ConversationID
				m.mu.Unlock()
			}
			m.emit(t.SessionID, ev)
		}
	}

	// Igual que en Ask: un scanner que se corta dejaría la respuesta a medias
	// sin que nada lo diga.
	if err := sc.Err(); err != nil {
		m.emit(t.SessionID, Event{Kind: KindError, Error: fmt.Sprintf("se cortó la lectura de la respuesta: %v", err)})
	}

	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		m.emit(t.SessionID, Event{Kind: KindError, Error: "turno cancelado"})
		return
	}
	if waitErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		m.emit(t.SessionID, Event{Kind: KindError, Error: msg})
	}
}

// withImagePaths nombra las imágenes adjuntas dentro del prompt, para los
// CLIs que no tienen una bandera propia.
func withImagePaths(prompt string, images []string) string {
	if len(images) == 0 {
		return prompt
	}
	var b strings.Builder
	b.WriteString(prompt)
	b.WriteString("\n\nImágenes adjuntas (abrilas para verlas):")
	for _, img := range images {
		b.WriteString("\n- ")
		b.WriteString(img)
	}
	return b.String()
}

// buildArgs arma la línea de comandos del turno.
//
// El comando base sale del catálogo y puede traer argumentos fijos que puso el
// usuario, así que se parte por espacios y se le agregan los del modo
// headless. Es una división simple a propósito: un comando con comillas y
// espacios adentro de un argumento no se soporta, y es preferible eso a meter
// un parser de línea de comandos que se equivoque en silencio.
//
// **La bandera que saltea TODOS los permisos no se pasa nunca**, ni siquiera
// en ModeEdit. Los CLIs la tienen (`--dangerously-skip-permissions`,
// `bypassPermissions`) y cubre también la ejecución de comandos, no solo la
// edición de archivos: es la diferencia entre "que modifique archivos del
// repositorio, que se ven en el diff y se descartan" y "que haga cualquier
// cosa en la máquina". Lo primero puede ser una elección informada del
// usuario; lo segundo no es algo que una lista desplegable pueda representar
// honestamente.
// withExec reemplaza el primer token de los argumentos por el ejecutable ya
// resuelto, conservando los argumentos fijos que el usuario haya configurado.
func withExec(t Turn, args []string) []string {
	if len(t.Exec) == 0 || len(args) == 0 {
		return args
	}
	return append(append([]string{}, t.Exec...), args[1:]...)
}

func buildArgs(t Turn, conversation string) ([]string, error) {
	base := strings.Fields(strings.TrimSpace(t.Command))
	if len(base) == 0 {
		return nil, fmt.Errorf("agentchat: el comando de %q está vacío", t.AgentID)
	}

	switch t.AgentID {
	case "claude":
		// Claude Code no tiene bandera de imagen: se le nombran los archivos
		// en el prompt y los abre con su propia herramienta de lectura, que
		// soporta imágenes. Nombrar la ruta es además lo mismo que hace el
		// selector de @: el agente lee, la app no le pega bytes.
		args := append(base, "-p", withImagePaths(t.Prompt, t.Images), "--output-format", "stream-json", "--verbose")
		if conversation != "" {
			args = append(args, "--resume", conversation)
		}
		switch t.Mode {
		case ModePlan:
			args = append(args, "--permission-mode", "plan")
		case ModeApprove:
			// El hook decide acción por acción, así que el modo de permisos
			// del CLI tiene que dejarlo actuar: si además pidiera confirmación
			// por su cuenta, en headless no habría quién se la dé y todo
			// quedaría bloqueado. Quien autoriza es la ventana, vía el hook.
			if t.ApproveSettings == "" {
				return nil, fmt.Errorf("agentchat: la aprobación por acción no está disponible en este equipo")
			}
			args = append(args, "--permission-mode", "acceptEdits", "--settings", t.ApproveSettings)
		case ModeAuto:
			args = append(args, "--permission-mode", "auto")
		case ModeEdit:
			args = append(args, "--permission-mode", "acceptEdits")
		}
		if t.Effort != "" {
			args = append(args, "--effort", t.Effort)
		}
		if t.Model != "" {
			args = append(args, "--model", t.Model)
		}
		return args, nil

	case "codex":
		// `exec --json` es su modo headless; --skip-git-repo-check porque el
		// directorio ya lo eligió el usuario al agregar el repositorio y esa
		// comprobación acá solo estorbaría.
		args := append(base, "exec", "--json", "--skip-git-repo-check")
		if conversation != "" {
			args = append(args, "resume", conversation)
		}
		switch t.Mode {
		case ModeEdit:
			// Su sandbox de escritura acotada al workspace: el equivalente más
			// cercano a "puede editar el repositorio", sin darle la máquina.
			args = append(args, "--sandbox", "workspace-write")
		}
		if t.Model != "" {
			args = append(args, "--model", t.Model)
		}
		// Codex SÍ tiene bandera propia (`-i`), así que las imágenes van por
		// ahí en vez de nombradas en el texto: es el camino que el CLI
		// documenta y el que le llega como imagen de verdad.
		for _, img := range t.Images {
			args = append(args, "-i", img)
		}
		// El prompt va ÚLTIMO y sin bandera: es el argumento posicional.
		args = append(args, t.Prompt)
		return args, nil

	case "antigravity":
		// Sin bandera de imagen documentada: se nombran las rutas en el
		// prompt, igual que con Claude Code. Si el CLI no sabe abrirlas, lo va
		// a decir él — que es mejor que una bandera inventada que lo haga
		// fallar al arrancar.
		args := append(base, "--print", withImagePaths(t.Prompt, t.Images), "--output-format", "stream-json")
		if conversation != "" {
			args = append(args, "--conversation", conversation)
		}
		switch t.Mode {
		case ModePlan:
			args = append(args, "--mode", "plan")
		case ModeEdit:
			args = append(args, "--mode", "accept-edits")
		case ModeAuto:
			// Antigravity no tiene un equivalente. Se ignora en vez de
			// traducirlo a "accept-edits": eso sería darle más permiso del
			// pedido. La UI ya no ofrece este modo para este agente; esto es
			// la red por si igual llega.
		}
		if t.Effort != "" {
			args = append(args, "--effort", t.Effort)
		}
		if t.Model != "" {
			args = append(args, "--model", t.Model)
		}
		return args, nil
	}
	return nil, fmt.Errorf("agentchat: no hay modo headless verificado para %q", t.AgentID)
}
