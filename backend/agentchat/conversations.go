// Listar las conversaciones que el propio CLI ya tiene de este repositorio.
//
// # Por qué existe
//
// El historial de chats de la app solo conoce lo que se abrió DESDE la app: un
// puntero por conversación en el vault. Pero los CLIs son los mismos que se
// usan por fuera —la extensión de VS Code, la terminal, otro editor— y todo
// eso queda guardado en el mismo lugar. Sin esto, abrir un repositorio en el
// que se venía trabajando hace semanas muestra un historial vacío, y la
// conclusión razonable del usuario es que la app perdió sus chats.
//
// Lo que se devuelve es un puntero, igual que el historial propio: el id de
// conversación que el CLI ya usa. Retomarla es pasarle ese id, exactamente
// como se retoma una creada acá — no hay una segunda copia de los mensajes.
//
// # De dónde sale, por agente
//
//   - **Claude Code**: un archivo `.jsonl` por conversación en
//     `~/.claude/projects/<slug>/`, donde el slug es la ruta del repositorio
//     con los separadores reemplazados. El nombre del archivo ES el id de
//     sesión. Es el mismo directorio que ya lee el panel de consumo.
//   - **Codex**: la tabla `threads` de `~/.codex/state_*.sqlite`, que guarda
//     `cwd`, `title` y `first_user_message` por hilo. Filtra por el
//     repositorio y descarta los archivados.
//   - **Antigravity**: devuelve vacío, pero ya NO porque no se pueda leer —
//     history.go lee sus mensajes del transcript JSONL que deja en
//     `brain/<id>/.system_generated/logs/`—. Lo que falta es el filtro: esta
//     función lista lo de UN repositorio, y no hay dónde leer a qué repositorio
//     pertenece cada conversación suya. Su `conversation_summaries.db` tiene la
//     columna `workspace_uris`, pero se comprobó que las versiones actuales del
//     CLI la dejan vacía y ni siquiera dan de alta ahí las conversaciones
//     nuevas; y la carpeta de `brain/` no guarda ninguna marca del directorio
//     de trabajo. Listarlas todas mezclaría las de cualquier proyecto en el
//     historial de este, que es peor que no ofrecerlas.
package agentchat

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// Conversation es una conversación que el CLI ya tiene guardada.
type Conversation struct {
	ID    string `json:"id"`
	Agent string `json:"agent"`
	// Title es con qué reconocerla: el primer mensaje que se le escribió,
	// recortado. Sin esto una lista de UUIDs no sirve para elegir.
	Title string `json:"title"`
	// UpdatedAt es unix en segundos, para ordenar y mostrar "hace cuánto".
	UpdatedAt int64 `json:"updatedAt"`
}

// titleLimit recorta el título. Suficiente para reconocer la conversación sin
// que una fila ocupe tres líneas del menú.
const titleLimit = 90

// Conversations devuelve lo que el CLI tiene guardado de ese repositorio, de
// la más reciente a la más vieja.
//
// Un agente que no sabe listar (o una máquina sin ese CLI) devuelve vacío sin
// error: es una función de conveniencia, y que falle no puede impedir abrir un
// chat nuevo.
func Conversations(agentID, repoRoot string) ([]Conversation, error) {
	if repoRoot == "" {
		return nil, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	switch agentID {
	case "claude":
		return claudeConversations(home, repoRoot)
	case "codex":
		return codexConversations(home, repoRoot)
	default:
		return nil, nil
	}
}

// --- Claude Code ----------------------------------------------------------

func claudeConversations(home, repoRoot string) ([]Conversation, error) {
	dir := filepath.Join(home, ".claude", "projects", claudeSlug(repoRoot))
	entries, err := os.ReadDir(dir)
	if err != nil {
		// Un repositorio sobre el que nunca se corrió Claude Code no tiene
		// directorio, y eso no es un error: es la respuesta.
		return nil, nil
	}

	out := make([]Conversation, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		c := Conversation{
			ID:        strings.TrimSuffix(e.Name(), ".jsonl"),
			Agent:     "claude",
			Title:     claudeFirstPrompt(path),
			UpdatedAt: info.ModTime().Unix(),
		}
		if c.Title == "" {
			// Un transcript sin ningún mensaje de usuario legible es una
			// sesión que no llegó a empezar; listarla sin título sería una
			// fila que no se puede elegir.
			continue
		}
		out = append(out, c)
	}
	sortByRecency(out)
	return out, nil
}

// claudeFirstPrompt devuelve el primer mensaje del usuario del transcript.
//
// Lee línea por línea y corta apenas lo encuentra: estos archivos llegan a
// decenas de MB en una sesión larga, y para el título alcanza con el principio.
func claudeFirstPrompt(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	// Una sola línea puede traer un mensaje enorme (un archivo pegado), y el
	// buffer por defecto del scanner corta en 64 KB y aborta la lectura.
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	for sc.Scan() {
		var ev struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			continue
		}
		if ev.Message.Role != "user" {
			continue
		}
		text := strings.TrimSpace(plainText(ev.Message.Content))
		// Los resultados de herramienta vuelven con rol `user` y no son algo
		// que la persona haya escrito; y los avisos del sistema viajan
		// envueltos en etiquetas.
		if text == "" || strings.HasPrefix(text, "<") {
			continue
		}
		// Puede quedar vacío después de sacarle los marcadores —una
		// conversación que arranca solo con capturas pegadas—; ahí se sigue
		// buscando en vez de descartarla, que la dejaría fuera de la lista.
		if title := trimTitle(text); title != "" {
			return title
		}
	}
	return ""
}

// --- Codex ----------------------------------------------------------------

func codexConversations(home, repoRoot string) ([]Conversation, error) {
	matches, err := filepath.Glob(filepath.Join(home, ".codex", "state_*.sqlite"))
	if err != nil || len(matches) == 0 {
		return nil, nil
	}
	sort.Strings(matches)
	path := matches[len(matches)-1]

	abs, err := filepath.Abs(repoRoot)
	if err != nil {
		abs = repoRoot
	}

	// Solo lectura e `immutable`: esta base la tiene abierta el propio Codex, y
	// leerla no puede ser un motivo para bloquearlo ni para tocar su WAL.
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&immutable=1")
	if err != nil {
		return nil, nil
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT id,
		       COALESCE(NULLIF(title, ''), first_user_message, ''),
		       COALESCE(updated_at, created_at, 0)
		  FROM threads
		 WHERE cwd = ? AND COALESCE(archived, 0) = 0`, abs)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()

	var out []Conversation
	for rows.Next() {
		var c Conversation
		var updated int64
		if err := rows.Scan(&c.ID, &c.Title, &updated); err != nil {
			continue
		}
		c.Agent = "codex"
		c.Title = trimTitle(strings.TrimSpace(c.Title))
		if c.Title == "" {
			continue
		}
		// Codex guarda esa columna en segundos en unas versiones y en
		// milisegundos en otras. Un valor así de grande solo puede ser ms:
		// tomarlo como segundos daría una fecha del año 50.000.
		if updated > 1e11 {
			updated /= 1000
		}
		c.UpdatedAt = updated
		out = append(out, c)
	}
	sortByRecency(out)
	return out, nil
}

// --- comunes --------------------------------------------------------------

func sortByRecency(cs []Conversation) {
	sort.SliceStable(cs, func(i, j int) bool { return cs[i].UpdatedAt > cs[j].UpdatedAt })
}

// noiseInTitle son los marcadores que los CLIs meten en el texto del mensaje
// y que no dicen nada como título: los adjuntos y los avisos de la propia
// herramienta. Una conversación que arranca con dos capturas pegadas se
// titulaba "[Image #1] [Image #2] en el git hay un botón…", y los primeros
// caracteres —los que se ven cuando la fila se corta— eran justamente los que
// no distinguen una conversación de otra.
var noiseInTitle = regexp.MustCompile(`\[(Image|Imagen|Screenshot|Captura|Pasted [^\]]*|Request interrupted[^\]]*)[^\]]*\]`)

func trimTitle(s string) string {
	s = noiseInTitle.ReplaceAllString(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= titleLimit {
		return s
	}
	// Se corta en runas y no en bytes: un corte a la mitad de un carácter
	// multibyte deja un símbolo roto en el menú.
	r := []rune(s)
	if len(r) <= titleLimit {
		return s
	}
	return strings.TrimSpace(string(r[:titleLimit])) + "…"
}

// claudeSlug es la ruta del repositorio con los separadores reemplazados, que
// es como Claude Code nombra el directorio de cada proyecto.
func claudeSlug(repoRoot string) string {
	abs, err := filepath.Abs(repoRoot)
	if err != nil {
		abs = repoRoot
	}
	return strings.NewReplacer("/", "-", "\\", "-", "_", "-", ".", "-").Replace(abs)
}
