package main

import (
	"log"
	"strings"
	"sync"

	"mini-tools/backend/i18n"
)

// Cerebro: escritura automática de notas (fase 6 de
// .claude/specs/ia-ollama-chat-utilidades.md).
//
// Un chat con "Guardar en mi cerebro" encendido recibe, en cada turno, un texto
// que le pide ir dejando asentado lo que valga la pena conservar como notas del
// vault. **No agrega ningún permiso**: las notas las escribe con las
// herramientas `vault_*` del servidor MCP, bajo las mismas reglas de siempre
// (nada privado, nada del usuario se reescribe, escritura solo con
// mcpNotesWrite). El control es per-conversación y se apoya en dos permisos
// globales que ya existen —el servidor MCP encendido y la escritura de notas
// habilitada—, y si alguno se apaga después el texto deja de enviarse.

// BrainStatus es lo que la interfaz necesita para explicar por qué el control
// del cerebro está deshabilitado.
type BrainStatus struct {
	// MCPEnabled es si el servidor MCP está encendido.
	MCPEnabled bool `json:"mcpEnabled"`
	// NotesWrite es si el usuario dejó que un agente escriba notas.
	NotesWrite bool `json:"notesWrite"`
	// Root es la carpeta raíz donde escribe el cerebro.
	Root string `json:"root"`
}

// brainState guarda el cerebro encendido en conversaciones que todavía no
// tienen fila en agent_chats: el chat nace al mandar el primer mensaje, pero el
// control se puede encender antes. Vive en memoria porque un chat que nunca
// llegó a existir no tiene nada que recordar.
type brainState struct {
	mu      sync.Mutex
	pending map[string]bool
	// recalled son las notas que ya se enviaron como recuerdo en cada sesión
	// (sesión → ids): una nota no se repite en la misma sesión
	// (app_brain_recall.go). Vive en memoria, como la sesión misma.
	recalled map[string]map[string]bool
}

// recalledIDs devuelve una copia de las notas ya enviadas a esa sesión.
func (b *brainState) recalledIDs(session string) map[string]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]bool, len(b.recalled[session]))
	for id := range b.recalled[session] {
		out[id] = true
	}
	return out
}

// markRecalled anota notas como enviadas a esa sesión.
func (b *brainState) markRecalled(session string, ids []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.recalled == nil {
		b.recalled = map[string]map[string]bool{}
	}
	if b.recalled[session] == nil {
		b.recalled[session] = map[string]bool{}
	}
	for _, id := range ids {
		b.recalled[session][id] = true
	}
}

// forgetRecalled olvida lo enviado a una sesión (ResetAgentChat).
func (b *brainState) forgetRecalled(session string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.recalled, session)
}

func (b *brainState) set(id string, on bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == nil {
		b.pending = map[string]bool{}
	}
	if on {
		b.pending[id] = true
	} else {
		delete(b.pending, id)
	}
}

func (b *brainState) has(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pending[id]
}

// BrainStatus informa el estado de los permisos que el cerebro necesita.
func (a *App) BrainStatus() (BrainStatus, error) {
	if err := a.requireUnlocked(); err != nil {
		return BrainStatus{}, err
	}
	root, err := a.vault.BrainRoot()
	if err != nil {
		return BrainStatus{}, err
	}
	return BrainStatus{MCPEnabled: a.mcpEnabled(), NotesWrite: a.mcpNotesWrite(), Root: root}, nil
}

// GetBrainRoot devuelve la carpeta raíz del cerebro (por defecto "Cerebro").
func (a *App) GetBrainRoot() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return a.vault.BrainRoot()
}

// SetBrainRoot cambia la carpeta raíz del cerebro. Acepta un nombre ("Cerebro")
// o una ruta ("Notas/Cerebro"); rechaza segmentos vacíos, "." y "..". Vacío
// vuelve a "Cerebro". Las notas ya escritas no se mueven.
func (a *App) SetBrainRoot(root string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetBrainRoot(root)
}

// SetAgentChatBrain enciende o apaga el cerebro de UNA conversación.
//
// Encenderlo exige el servidor MCP encendido y mcpNotesWrite activo: sin eso el
// agente no tendría con qué escribir y el control mentiría. Apagarlo se permite
// siempre.
//
// **No exige que la conversación exista.** El chat nace en el primer envío; si
// todavía no tiene fila, el pedido se recuerda en memoria y se persiste cuando
// la fila aparece (al terminar SendAgentChat). Con fila, se guarda de una y
// sobrevive al reinicio: AgentChat.Brain viaja en el historial.
func (a *App) SetAgentChatBrain(chatID string, enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if chatID == "" {
		return i18n.Errorf(i18n.Msg{ES: "app: falta el id del chat", EN: "app: the chat id is missing"})
	}
	if enabled {
		if !a.mcpEnabled() {
			return i18n.Errorf(i18n.Msg{ES: "app: para guardar en el cerebro hay que encender el servidor MCP (Configuración → Acceso de IA)", EN: "app: saving to the brain requires the MCP server to be on (Settings → AI access)"})
		}
		if !a.mcpNotesWrite() {
			return i18n.Errorf(i18n.Msg{ES: "app: para guardar en el cerebro hay que permitir que un agente escriba notas (Configuración → Acceso de IA)", EN: "app: saving to the brain requires allowing an agent to write notes (Settings → AI access)"})
		}
	}
	exists, err := a.vault.AgentChatExists(chatID)
	if err != nil {
		return err
	}
	if !exists {
		a.brain.set(chatID, enabled)
		return nil
	}
	a.brain.set(chatID, false)
	return a.vault.SetAgentChatBrain(chatID, enabled)
}

// chatBrainOn dice si el cerebro de esa conversación está encendido Y los dos
// permisos globales siguen dados.
func (a *App) chatBrainOn(chatID string) bool {
	if !a.mcpEnabled() || !a.mcpNotesWrite() {
		return false
	}
	return a.brain.has(chatID) || a.vault.AgentChatBrain(chatID)
}

// flushPendingBrain persiste el cerebro pedido antes de que existiera la fila.
func (a *App) flushPendingBrain(chatID string) {
	if !a.brain.has(chatID) {
		return
	}
	if ok, err := a.vault.AgentChatExists(chatID); err != nil || !ok {
		return
	}
	if err := a.vault.SetAgentChatBrain(chatID, true); err != nil {
		log.Printf("cerebro del chat %s: %v", chatID, err)
		return
	}
	a.brain.set(chatID, false)
}

// brainProject deriva el proyecto de la conversación desde su módulo y el id
// de recurso, con las mismas búsquedas que ya usa el resto de la app. "" = la
// conversación no tiene proyecto (va a Temas).
//
//   - git y utilities (con un repositorio elegido): nombre del repositorio.
//   - db: alias de la conexión.   - ssh: alias del servidor.
//   - cualquier otro módulo, o un recurso que ya no existe: sin proyecto.
func (a *App) brainProject(module, contextID string) string {
	if contextID == "" {
		return ""
	}
	switch module {
	case "git", "utilities":
		if repo, err := a.vault.GetGitRepo(contextID); err == nil && repo != nil {
			return folderSafeName(repo.Name)
		}
	case "db", "ssh":
		if conn, err := a.connByNameOrID(contextID); err == nil {
			return folderSafeName(conn.Name)
		}
	}
	return ""
}

// folderSafeName vuelve un nombre usable como UN segmento de carpeta: una barra
// dentro de un alias partiría la ruta en dos niveles.
func folderSafeName(name string) string {
	r := strings.NewReplacer("/", "-", "\\", "-")
	return strings.TrimSpace(r.Replace(name))
}

// brainInstructions arma el texto del cerebro para este turno, o "" si el
// cerebro no aplica (apagado en la conversación o sin los permisos).
func (a *App) brainInstructions(chatID, module, contextID string) string {
	if !a.chatBrainOn(chatID) {
		return ""
	}
	root, err := a.vault.BrainRoot()
	if err != nil {
		return ""
	}
	return buildBrainInstructions(root, a.brainProject(module, contextID))
}

var (
	msgBrainIntro = i18n.Msg{
		ES: `Tenés acceso a la base de conocimiento personal del usuario —su «cerebro»— con las herramientas vault_*. En esta conversación el usuario encendió «Guardar en mi cerebro»: quiere que lo que se descubra acá quede asentado como notas que va a leer más adelante, cuando ya no recuerde el detalle. Por eso cada nota tiene que entenderse sola.

Qué vale la pena guardar: conocimiento que dure —un procedimiento que funcionó, un diagnóstico con su causa, una decisión con su motivo, una configuración que no es obvia—. Qué no: charla suelta, preguntas que se contestan solas, pasos intermedios que no llevaron a nada, ni algo que ya esté escrito.`,
		EN: `You have access to the user's personal knowledge base —their "brain"— through the vault_* tools. In this conversation the user turned on "Save to my brain": they want what is found out here to be recorded as notes they will read later, when they no longer remember the detail. So each note has to make sense on its own.

What is worth saving: knowledge that lasts —a procedure that worked, a diagnosis with its cause, a decision with its reason, a configuration that isn't obvious—. What isn't: loose chit-chat, questions that answer themselves, intermediate steps that led nowhere, or anything already written down.`,
	}
	msgBrainWhereProject = i18n.Msg{
		ES: `Dónde: esta conversación trabaja en el proyecto «%[2]s». Las notas van en la carpeta «%[1]s/Proyectos/%[2]s» (vault_create_note con folder; las carpetas que falten se crean solas).`,
		EN: `Where: this conversation works on the project "%[2]s". Notes go in the folder "%[1]s/Proyectos/%[2]s" (vault_create_note with folder; missing folders are created automatically).`,
	}
	msgBrainWhereTopic = i18n.Msg{
		ES: `Dónde: esta conversación no pertenece a un proyecto. Elegí un tema corto y estable (por ejemplo «Oracle - bloqueos») y usá la carpeta «%[1]s/Temas/<tema>», reutilizando el tema si ya existe (mirá vault_list_folders).`,
		EN: `Where: this conversation doesn't belong to a project. Pick a short, stable topic (for example "Oracle - locks") and use the folder "%[1]s/Temas/<topic>", reusing the topic if it already exists (check vault_list_folders).`,
	}
	msgBrainHow = i18n.Msg{
		ES: `Cómo:
1. Antes de crear, buscá con vault_search_notes (con folder y tag) si el tema ya está. Si hay una nota tuya, ampliala con vault_append_to_note en vez de duplicarla. Si la escribió el usuario, o la editó después, no se puede modificar: creá una nota nueva que la enlace con [[Título]].
2. Escribí en Markdown con un título concreto y único, enlazá las notas relacionadas con [[Título]] y etiquetá con #etiquetas cortas en minúsculas.
3. Mantené en esa misma carpeta una nota «_Índice %[1]s» que enlace a cada nota de ahí. Si no existe, creala; cada vez que sumes una nota, agregá su enlace al índice con vault_append_to_note.
4. Las notas privadas del usuario no existen para vos: no intentes acceder a ellas. Nunca guardes contraseñas, tokens ni datos personales; si hace falta mencionarlos, anotá dónde están y no su valor.
5. Al terminar de escribir, decile al usuario en una línea qué notas guardaste, con su [[título]].`,
		EN: `How:
1. Before creating, check with vault_search_notes (with folder and tag) whether the topic is already there. If one of your own notes exists, extend it with vault_append_to_note instead of duplicating it. If the user wrote it, or edited it afterwards, it can't be modified: create a new note that links to it with [[Title]].
2. Write in Markdown with a concrete, unique title, link related notes with [[Title]] and tag with short lowercase #tags.
3. Keep, in that same folder, a note "_Índice %[1]s" linking to every note in it. If it doesn't exist, create it; every time you add a note, append its link to the index with vault_append_to_note.
4. The user's private notes don't exist for you: don't try to reach them. Never save passwords, tokens or personal data; if they need a mention, note where they are, not their value.
5. When you finish writing, tell the user in one line which notes you saved, with their [[title]].`,
	}
)

// buildBrainInstructions es el texto puro: root es la carpeta raíz y project el
// proyecto ("" = Temas). Separado de brainInstructions para probar el texto sin
// un vault.
func buildBrainInstructions(root, project string) string {
	name := project
	var where string
	if project != "" {
		where = i18n.T(msgBrainWhereProject, root, project)
	} else {
		name = i18n.T(i18n.Msg{ES: "<tema>", EN: "<topic>"})
		where = i18n.T(msgBrainWhereTopic, root)
	}
	return strings.Join([]string{i18n.T(msgBrainIntro), where, i18n.T(msgBrainHow, name)}, "\n\n")
}

// withBrain suma el texto del cerebro a un system prompt existente.
func withBrain(system, brain string) string {
	switch {
	case brain == "":
		return system
	case strings.TrimSpace(system) == "":
		return brain
	}
	return system + "\n\n" + brain
}

// brainDelivery decide cómo llega el texto del cerebro a cada tipo de agente.
//
//   - `llm:*`: va en Turn.System (lo arma quien llama, junto a las notas de
//     herramientas), así que acá no se toca el prompt.
//   - `claude`: Turn.System, que buildArgs agrega al system prompt junto al
//     idioma de respuesta.
//   - cualquier otro CLI (`codex`, `antigravity`): no tienen un system prompt
//     agregable que no reemplace el suyo, así que el texto se antepone al
//     mensaje que recibe el CLI. **Solo al mensaje enviado**: lo que se graba
//     en el historial es lo que escribió el usuario.
func brainDelivery(agentID, brain, prompt string) (system, newPrompt string) {
	if brain == "" {
		return "", prompt
	}
	if agentID == "claude" {
		return brain, prompt
	}
	return "", brain + "\n\n---\n\n" + prompt
}
