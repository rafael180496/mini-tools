package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/appdata"
	"mini-tools/backend/db"
	"mini-tools/backend/git"
	"mini-tools/backend/i18n"
	"mini-tools/backend/mcpserver"
	"mini-tools/backend/vault"
)

// Servidor MCP: las herramientas que la aplicación le ofrece a un agente.
//
// Hasta acá la app le mandaba contexto al agente (el sistema `@`, los botones
// de cada módulo). Esto invierte la relación: el agente puede **pedirlo él**,
// desde su propia conversación, sin que nadie arme el mensaje.
//
// **Apagado por defecto, y apagado significa apagado.** No hay listener, no hay
// socket y no hay goroutine mientras el interruptor esté en cero: encenderlo
// abre el canal y apagarlo lo cierra y borra el archivo. Una app que deja un
// servidor escuchando "por si acaso" gasta recursos por una función que quizá
// nadie use, y esta app existe justamente para lo contrario.
//
// **Y sin la ventana no hay datos.** El proceso `mini-tools --mcp` que lanza el
// CLI no tiene la clave maestra —vive solo en la memoria de la ventana— así que
// reenvía cada llamada por el socket. Si la app está cerrada, el vault
// bloqueado o el interruptor apagado, el agente recibe una explicación en vez
// de datos. No hay una segunda ruta.

// mcpAudit es el registro local de accesos: qué herramienta, sobre qué y
// cuándo. **Sin contenido**, solo el hecho — es lo que permite contestar "¿qué
// leyó el agente?" sin guardar una segunda copia de lo que leyó.
type mcpAudit struct {
	Tool     string `json:"tool"`
	Resource string `json:"resource"`
	At       int64  `json:"at"`
	Denied   bool   `json:"denied"`
}

// maxAuditEntries acota el registro. Vive en memoria y se va con la app: es
// para mirar lo que está pasando, no un registro de auditoría permanente —
// escribirlo en disco sería empezar a guardar rastros de lo que se consultó.
const maxAuditEntries = 200

// maxMCPNoteBytes acota lo que un agente puede dejar escrito de una. 64 KB son
// muchísimo para una nota que alguien va a leer y poquísimo para lo que un
// modelo puede generar si se lo deja suelto.
const maxMCPNoteBytes = 64 * 1024

type mcpState struct {
	mu     sync.Mutex
	bridge *mcpserver.Bridge
	audit  []mcpAudit
}

// MCPStatus es lo que ve el panel de configuración.
type MCPStatus struct {
	Enabled bool `json:"enabled"`
	// SocketPath es dónde escucha, para poder mostrarlo. Vacío si está apagado.
	SocketPath string `json:"socketPath"`
	// Tools es cuántas herramientas se exponen con la configuración actual.
	Tools int `json:"tools"`
	// NotesWrite es si el agente puede CREAR notas. Es un permiso aparte del
	// interruptor del servidor: ver SetMCPNotesWrite.
	NotesWrite bool `json:"notesWrite"`
	// Audit son los últimos accesos, del más reciente al más viejo.
	Audit []mcpAudit `json:"audit"`
	// Executable es la ruta absoluta de este binario, que es lo que hay que
	// poner en la configuración del CLI. Se informa siempre (encendido o no):
	// es el dato que hace falta para conectar, y esconderlo hasta encender
	// obligaría a encender para poder leer las instrucciones.
	Executable string `json:"executable"`
}

// MCPServerStatus devuelve el estado del servidor.
func (a *App) MCPServerStatus() (MCPStatus, error) {
	if err := a.requireUnlocked(); err != nil {
		return MCPStatus{}, err
	}
	a.mcp.mu.Lock()
	defer a.mcp.mu.Unlock()

	exe, _ := os.Executable()
	out := MCPStatus{
		Enabled:    a.mcp.bridge != nil,
		SocketPath: a.mcp.bridge.Path(),
		Tools:      len(a.mcpTools()),
		NotesWrite: a.mcpNotesWrite(),
		Executable: exe,
	}
	// Del más reciente al más viejo, que es como se lee.
	for i := len(a.mcp.audit) - 1; i >= 0; i-- {
		out.Audit = append(out.Audit, a.mcp.audit[i])
	}
	return out, nil
}

// SetMCPServerEnabled enciende o apaga el servidor.
//
// Encender abre el socket; apagar lo cierra y borra el archivo. No queda nada
// corriendo: es la diferencia entre una función disponible y una que cuesta
// recursos por si acaso.
func (a *App) SetMCPServerEnabled(enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.mcp.mu.Lock()
	defer a.mcp.mu.Unlock()

	if !enabled {
		if a.mcp.bridge != nil {
			_ = a.mcp.bridge.Close()
			a.mcp.bridge = nil
		}
		return a.vault.SetMCPEnabled(false)
	}
	if a.mcp.bridge != nil {
		return nil
	}

	dir, err := appdata.Dir()
	if err != nil {
		return err
	}
	b, err := mcpserver.StartBridge(dir, a)
	if err != nil {
		return err
	}
	a.mcp.bridge = b
	return a.vault.SetMCPEnabled(true)
}

// ListTools implementa mcpserver.Handler.
func (a *App) ListTools() []mcpserver.ToolInfo {
	a.mcp.mu.Lock()
	defer a.mcp.mu.Unlock()
	return a.mcpTools()
}

// CallTool implementa mcpserver.Handler.
//
// **Todo pasa por `requireUnlocked` acá también**, y no solo al encender: entre
// que se encendió el servidor y que llega una llamada, el usuario pudo haber
// bloqueado el vault, y esa es exactamente la situación en la que no se
// contesta.
func (a *App) CallTool(name string, args map[string]any) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "el vault de mini-tools está bloqueado: desbloquealo en la aplicación para que estas herramientas puedan responder", EN: "the mini-tools vault is locked: unlock it in the app so these tools can answer"})
	}

	out, resource, err := a.runMCPTool(name, args)
	a.recordMCPAccess(name, resource, err != nil)
	return out, err
}

// mcpNotesWrite lee el permiso de escritura. Se consulta EN CADA llamada y no
// se cachea: revocarlo tiene que valer para la herramienta que el agente está
// por invocar, no para la próxima vez que se abra la app.
//
// Un error leyendo la preferencia devuelve false: ante la duda, el agente no
// escribe.
func (a *App) mcpNotesWrite() bool {
	settings, err := a.vault.GetSettings()
	if err != nil {
		return false
	}
	return settings.MCPNotesWrite
}

// SetMCPNotesWrite deja —o deja de dejar— que el agente cree notas por MCP.
//
// **Es una decisión aparte de encender el servidor.** Hasta acá todas las
// herramientas eran de lectura, y esa era la promesa del módulo: el agente mira
// lo que se le comparte y no toca nada. Poder crear notas rompe esa promesa, así
// que no llega de arrastre al encender el servidor.
//
// Lo que este permiso NO habilita, y por eso sigue siendo acotado: **tocar lo
// que escribió el usuario, y borrar**. El agente agrega conocimiento nuevo y
// puede corregir SUS notas mientras nadie las haya editado después — ver
// vault.AgentCanEdit. Una nota privada le queda fuera de alcance también para
// escribir, porque la edición pasa por la misma puerta que la lectura.
func (a *App) SetMCPNotesWrite(enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetMCPNotesWrite(enabled)
}

func (a *App) recordMCPAccess(tool, resource string, denied bool) {
	a.mcp.mu.Lock()
	defer a.mcp.mu.Unlock()
	a.mcp.audit = append(a.mcp.audit, mcpAudit{Tool: tool, Resource: resource, At: time.Now().Unix(), Denied: denied})
	if len(a.mcp.audit) > maxAuditEntries {
		a.mcp.audit = a.mcp.audit[len(a.mcp.audit)-maxAuditEntries:]
	}
}

// mcpTools es el catálogo. Cada entrada declara su política en la descripción,
// que es lo que el modelo lee antes de llamarla: decirle ahí que `db_get_schema`
// no devuelve filas evita que la pida y se lleve un error.
func (a *App) mcpTools() []mcpserver.ToolInfo {
	str := func(desc string) map[string]any {
		return map[string]any{"type": "string", "description": desc}
	}
	obj := func(props map[string]any, required ...string) map[string]any {
		m := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			m["required"] = required
		}
		return m
	}

	tools := []mcpserver.ToolInfo{
		{
			Name:        "vault_search_notes",
			Description: i18n.T(i18n.Msg{ES: "Busca en la base de conocimiento del usuario (runbooks, procedimientos, notas técnicas). Devuelve títulos y fragmentos. SOLO incluye notas que el usuario NO marcó como privadas.", EN: "Searches the user's knowledge base (runbooks, procedures, technical notes). Returns titles and snippets. ONLY includes notes the user did NOT mark as private."}),
			InputSchema: obj(map[string]any{"query": str(i18n.T(i18n.Msg{ES: "Qué buscar. Varias palabras: todas tienen que aparecer.", EN: "What to search for. Several words: all of them must appear."}))}, "query"),
		},
		{
			Name:        "vault_read_note",
			Description: i18n.T(i18n.Msg{ES: "Devuelve el Markdown completo de una nota, por su título. Si el usuario la marcó como privada, devuelve un error de permiso y NO su contenido.", EN: "Returns the full Markdown of a note, by its title. If the user marked it as private, returns a permission error and NOT its content."}),
			InputSchema: obj(map[string]any{"title": str(i18n.T(i18n.Msg{ES: "Título exacto de la nota.", EN: "Exact title of the note."}))}, "title"),
		},
		{
			Name:        "db_list_connections",
			Description: i18n.T(i18n.Msg{ES: "Lista las bases de datos guardadas: alias, motor y entorno (producción/staging/desarrollo). NUNCA devuelve DSN, host, usuario ni contraseña.", EN: "Lists the saved databases: alias, engine and environment (production/staging/development). NEVER returns DSN, host, user or password."}),
			InputSchema: obj(map[string]any{}),
		},
		{
			Name:        "db_get_schema",
			Description: i18n.T(i18n.Msg{ES: "Devuelve el DDL de una o varias tablas: columnas, tipos, clave primaria y claves foráneas. NUNCA devuelve filas de datos.", EN: "Returns the DDL of one or more tables: columns, types, primary key and foreign keys. NEVER returns data rows."}),
			InputSchema: obj(map[string]any{
				"connection": str(i18n.T(i18n.Msg{ES: "Alias de la conexión, tal como lo devuelve db_list_connections.", EN: "Connection alias, as returned by db_list_connections."})),
				"tables":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": i18n.T(i18n.Msg{ES: "Nombres de tabla. Vacío = solo la lista de nombres disponibles.", EN: "Table names. Empty = just the list of available names."})},
			}, "connection"),
		},
		{
			Name:        "db_explain_query",
			Description: i18n.T(i18n.Msg{ES: "Devuelve el plan de ejecución de una consulta SELECT, con el diagnóstico que ya calculó la app (escaneos completos, estimaciones erradas, índices sugeridos). NO ejecuta la consulta.", EN: "Returns the execution plan of a SELECT query, with the diagnosis the app already computed (full scans, wrong estimates, suggested indexes). Does NOT run the query."}),
			InputSchema: obj(map[string]any{
				"connection": str(i18n.T(i18n.Msg{ES: "Alias de la conexión.", EN: "Connection alias."})),
				"query":      str(i18n.T(i18n.Msg{ES: "La consulta SELECT a analizar.", EN: "The SELECT query to analyze."})),
			}, "connection", "query"),
		},
		{
			Name:        "ssh_get_recent_logs",
			Description: i18n.T(i18n.Msg{ES: "Devuelve las últimas líneas de una terminal SSH que el usuario ya tiene abierta. No abre conexiones ni ejecuta comandos.", EN: "Returns the last lines of an SSH terminal the user already has open. Doesn't open connections or run commands."}),
			InputSchema: obj(map[string]any{
				"server": str(i18n.T(i18n.Msg{ES: "Alias de la conexión SSH.", EN: "SSH connection alias."})),
				"lines":  map[string]any{"type": "number", "description": i18n.T(i18n.Msg{ES: "Cuántas líneas (por defecto 50).", EN: "How many lines (50 by default)."})},
			}, "server"),
		},
		{
			Name:        "git_status",
			Description: i18n.T(i18n.Msg{ES: "Estado de un repositorio abierto en la aplicación: rama, archivos modificados y diff preparado.", EN: "Status of a repository open in the app: branch, modified files and staged diff."}),
			InputSchema: obj(map[string]any{"repo": str(i18n.T(i18n.Msg{ES: "Nombre del repositorio tal como aparece en la app.", EN: "Repository name as it appears in the app."}))}, "repo"),
		},
	}

	// La herramienta de ESCRITURA solo existe si el usuario la habilitó. No se
	// declara y se rechaza al llamarla: una herramienta que aparece en la lista
	// y siempre falla es una invitación a que el modelo la intente igual, y el
	// catálogo es lo único que el agente lee antes de decidir.
	if a.mcpNotesWrite() {
		tools = append(tools, mcpserver.ToolInfo{
			Name:        "vault_create_note",
			Description: i18n.T(i18n.Msg{ES: "Crea una nota NUEVA en la base de conocimiento del usuario (su 'cerebro'), con título y contenido en Markdown. Sirve para dejar asentado lo que se averiguó: un procedimiento, un diagnóstico, una decisión. NO pisa nada: un título repetido se rechaza, elegí otro. Para corregir una nota que creaste vos, usá vault_update_note. La nota queda marcada como creada por un agente y visible para el usuario en su aplicación.", EN: "Creates a NEW note in the user's knowledge base (their 'brain'), with a title and Markdown content. Use it to record what was found out: a procedure, a diagnosis, a decision. It does NOT overwrite anything: a repeated title is rejected, pick another. To fix a note you created, use vault_update_note. The note is marked as created by an agent and visible to the user in their app."}),
			InputSchema: obj(map[string]any{
				"title":   str(i18n.T(i18n.Msg{ES: "Título de la nota. Único: es lo que la hace enlazable con [[…]] desde otras notas.", EN: "Note title. Unique: it's what makes it linkable with [[…]] from other notes."})),
				"content": str(i18n.T(i18n.Msg{ES: "Contenido en Markdown. Podés enlazar otras notas con [[Título]] y etiquetar con #etiqueta.", EN: "Markdown content. You can link other notes with [[Title]] and tag with #tag."})),
			}, "title", "content"),
		})
		tools = append(tools, mcpserver.ToolInfo{
			Name:        "vault_update_note",
			Description: i18n.T(i18n.Msg{ES: "Reescribe el contenido de una nota que VOS creaste antes con vault_create_note — para corregirla o ampliarla. Solo funciona sobre tus propias notas: las que escribió el usuario, y las tuyas que él haya editado después, se rechazan. Tampoco toca ninguna nota marcada como privada. REEMPLAZA el contenido entero: leelo antes con vault_read_note si querés conservar parte.", EN: "Rewrites the content of a note that YOU created earlier with vault_create_note — to fix or extend it. It only works on your own notes: the ones the user wrote, and yours that they edited afterwards, are rejected. It doesn't touch any note marked as private either. It REPLACES the whole content: read it first with vault_read_note if you want to keep part of it."}),
			InputSchema: obj(map[string]any{
				"title":   str(i18n.T(i18n.Msg{ES: "Título exacto de la nota a reescribir. El título no cambia.", EN: "Exact title of the note to rewrite. The title doesn't change."})),
				"content": str(i18n.T(i18n.Msg{ES: "El contenido completo en Markdown que reemplaza al anterior.", EN: "The full Markdown content that replaces the previous one."})),
			}, "title", "content"),
		})
	}
	return tools
}

// runMCPTool ejecuta una herramienta. Devuelve además qué recurso se tocó, para
// el registro de accesos.
//
// **Ninguna abre una conexión nueva ni ejecuta nada que modifique.** Operan
// sobre lo que el usuario ya tiene abierto y sobre metadatos; `db_explain_query`
// corre EXPLAIN, que no ejecuta el plan, y rechaza cualquier sentencia que no
// sea de lectura.
func (a *App) runMCPTool(name string, args map[string]any) (string, string, error) {
	switch name {
	case "vault_search_notes":
		q := mcpserver.StringArg(args, "query")
		hits, err := a.vault.SearchNotesForAI(q, 10)
		if err != nil {
			return "", q, err
		}
		if len(hits) == 0 {
			return i18n.T(i18n.Msg{ES: "No hay ninguna nota compartida que coincida. Puede que exista pero esté marcada como privada por el usuario.", EN: "No shared note matches. It may exist but be marked as private by the user."}), q, nil
		}
		var b strings.Builder
		for _, h := range hits {
			fmt.Fprintf(&b, "- %s\n", h.Title)
		}
		return b.String(), q, nil

	case "vault_read_note":
		title := mcpserver.StringArg(args, "title")
		// El cortafuegos vive en NoteForAI, que filtra en la propia consulta
		// SQL. Acá no hay ninguna decisión de permisos que tomar — y eso es a
		// propósito.
		note, err := a.vault.NoteForAI(title)
		if err != nil {
			return "", title, err
		}
		return note.Content, title, nil

	case "vault_create_note":
		// El permiso se vuelve a comprobar acá y no solo al armar el catálogo:
		// entre que el agente leyó la lista y llama pueden pasar minutos, y en
		// el medio el usuario pudo revocarlo. Un permiso que solo se mira al
		// listar es un permiso que no se puede revocar.
		if !a.mcpNotesWrite() {
			return "", "", i18n.Errorf(i18n.Msg{ES: "el usuario no habilitó que un agente cree notas. Se activa en la aplicación, en Acceso de IA", EN: "the user hasn't allowed agents to create notes. It's enabled in the app, under AI access"})
		}
		title := strings.TrimSpace(mcpserver.StringArg(args, "title"))
		content := mcpserver.StringArg(args, "content")
		if title == "" || strings.TrimSpace(content) == "" {
			return "", title, i18n.Errorf(i18n.Msg{ES: "hacen falta un título y un contenido", EN: "a title and content are required"})
		}
		// Tope de tamaño: una nota es algo que una persona va a leer. Sin
		// límite, una respuesta larga del modelo termina volcada entera en el
		// vault del usuario.
		if len(content) > maxMCPNoteBytes {
			return "", title, i18n.Errorf(i18n.Msg{ES: "la nota es demasiado grande (%d KB, máximo %d KB) — resumila o partila en varias", EN: "the note is too large (%d KB, max %d KB) — summarize it or split it into several"}, len(content)/1024, maxMCPNoteBytes/1024)
		}

		// El frontmatter es lo que hace que "¿esto lo escribí yo o el agente?"
		// tenga respuesta seis meses después. Va como metadato y no dentro del
		// texto: la nota se lee limpia, y el dato sigue ahí.
		fm := vault.NewAgentFrontmatter(time.Now())
		id, err := a.createNote(title, content, fm)
		if err != nil {
			return "", title, err
		}
		// La nota nace NO privada a propósito: la escribió el agente, no es un
		// secreto del usuario, y marcarla privada haría que ni siquiera pueda
		// releer lo que acaba de dejar asentado. Esconderla después es un clic
		// en la aplicación.
		runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": id, "title": title})
		return i18n.T(i18n.Msg{ES: "Nota creada: %q. El usuario ya la ve en su base de conocimiento.", EN: "Note created: %q. The user can already see it in their knowledge base."}, title), title, nil

	case "vault_update_note":
		if !a.mcpNotesWrite() {
			return "", "", i18n.Errorf(i18n.Msg{ES: "el usuario no habilitó que un agente escriba notas. Se activa en la aplicación, en Acceso de IA", EN: "the user hasn't allowed agents to write notes. It's enabled in the app, under AI access"})
		}
		title := strings.TrimSpace(mcpserver.StringArg(args, "title"))
		content := mcpserver.StringArg(args, "content")
		if title == "" || strings.TrimSpace(content) == "" {
			return "", title, i18n.Errorf(i18n.Msg{ES: "hacen falta el título de la nota y el contenido nuevo", EN: "the note title and the new content are required"})
		}
		if len(content) > maxMCPNoteBytes {
			return "", title, i18n.Errorf(i18n.Msg{ES: "la nota es demasiado grande (%d KB, máximo %d KB)", EN: "the note is too large (%d KB, max %d KB)"}, len(content)/1024, maxMCPNoteBytes/1024)
		}

		// **La misma puerta que para leer.** NoteForAI ya rechaza las notas
		// privadas con un mensaje que explica por qué, así que la regla "una
		// nota privada no se toca" no se vuelve a escribir acá: si el agente no
		// la puede leer, tampoco la puede editar, y las dos cosas dependen de
		// una sola comprobación.
		note, err := a.vault.NoteForAI(title)
		if err != nil {
			return "", title, err
		}
		if !vault.AgentCanEdit(note.Frontmatter) {
			return "", title, i18n.Errorf(i18n.Msg{
				ES: "la nota %q no la creaste vos: la escribió el usuario, o vos la creaste y él la editó después. " +
					"Un agente solo puede reescribir sus propias notas intactas. " +
					"Si hace falta cambiarla, decíselo al usuario o creá una nota nueva que la complemente",
				EN: "you didn't create the note %q: the user wrote it, or you created it and they edited it afterwards. " +
					"An agent can only rewrite its own untouched notes. " +
					"If it needs changing, tell the user or create a new note that complements it",
			}, title)
		}

		// El frontmatter conserva el origen y suma cuándo fue la última
		// reescritura: la nota sigue diciendo quién la escribió y cuándo se
		// tocó por última vez.
		fm := vault.WithAgentUpdate(note.Frontmatter, time.Now())
		if err := a.vault.UpdateNote(note.ID, title, content, fm); err != nil {
			return "", title, err
		}
		runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": note.ID, "title": title})
		return i18n.T(i18n.Msg{ES: "Nota %q actualizada.", EN: "Note %q updated."}, title), title, nil

	case "db_list_connections":
		conns, err := a.vault.ListConnections()
		if err != nil {
			return "", "", err
		}
		var b strings.Builder
		for _, c := range conns {
			env := c.Environment
			if env == "" {
				env = i18n.T(i18n.Msg{ES: "sin marcar", EN: "unmarked"})
			}
			fmt.Fprintf(&b, "- %s (%s, %s)\n", c.Name, c.DBType, env)
		}
		if b.Len() == 0 {
			return i18n.T(i18n.Msg{ES: "No hay conexiones guardadas.", EN: "There are no saved connections."}), "", nil
		}
		return b.String(), "", nil

	case "db_get_schema":
		alias := mcpserver.StringArg(args, "connection")
		conn, err := a.connByNameOrID(alias)
		if err != nil {
			return "", alias, err
		}
		meta, err := a.GetSchemaMetadata(conn.ID, false)
		if err != nil {
			return "", alias, err
		}
		wanted := mcpserver.StringsArg(args, "tables")
		return renderSchemaForMCP(meta, wanted), alias + "/" + strings.Join(wanted, ","), nil

	case "db_explain_query":
		alias := mcpserver.StringArg(args, "connection")
		query := mcpserver.StringArg(args, "query")
		if !isReadOnlyStatement(query) {
			return "", alias, i18n.Errorf(i18n.Msg{ES: "solo se pueden analizar sentencias de lectura (SELECT / WITH)", EN: "only read statements (SELECT / WITH) can be analyzed"})
		}
		conn, err := a.connByNameOrID(alias)
		if err != nil {
			return "", alias, err
		}
		plan, err := a.ExplainQuery(conn.ID, query, false)
		if err != nil {
			return "", alias, err
		}
		out, err := json.Marshal(plan)
		if err != nil {
			return "", alias, err
		}
		return string(out), alias, nil

	case "ssh_get_recent_logs":
		alias := mcpserver.StringArg(args, "server")
		conn, err := a.connByNameOrID(alias)
		if err != nil {
			return "", alias, err
		}
		lines, err := a.SSHTail(conn.ID, mcpserver.IntArg(args, "lines", 50))
		if err != nil {
			return "", alias, err
		}
		return strings.Join(lines, "\n"), alias, nil

	case "git_status":
		repoName := mcpserver.StringArg(args, "repo")
		repos, err := a.vault.ListGitRepos()
		if err != nil {
			return "", repoName, err
		}
		for _, r := range repos {
			if !strings.EqualFold(r.Name, repoName) {
				continue
			}
			st, err := a.GitStatus(r.ID)
			if err != nil {
				return "", repoName, err
			}
			d, err := a.GitDiff(r.ID, git.DiffTarget{Mode: "staged"})
			out, _ := json.Marshal(st)
			if err == nil && d != nil && d.Patch != "" {
				return string(out) + "\n\n--- " + i18n.T(i18n.Msg{ES: "diff preparado", EN: "staged diff"}) + " ---\n" + d.Patch, repoName, nil
			}
			return string(out), repoName, nil
		}
		return "", repoName, i18n.Errorf(i18n.Msg{ES: "no hay ningún repositorio abierto que se llame %q", EN: "there's no open repository named %q"}, repoName)
	}
	return "", "", i18n.Errorf(i18n.Msg{ES: "herramienta desconocida: %s", EN: "unknown tool: %s"}, name)
}

// isReadOnlyStatement acepta solo lo que no modifica.
//
// Lista blanca y no lista negra: una lista negra deja pasar todo lo que nadie
// pensó, y acá lo que pasa se ejecuta contra la base del usuario.
func isReadOnlyStatement(s string) bool {
	t := strings.ToUpper(strings.TrimSpace(s))
	// Un `;` de más no convierte una sentencia en dos, pero dos sentencias sí:
	// se rechaza cualquier cosa con un punto y coma en el medio.
	if i := strings.Index(t, ";"); i >= 0 && strings.TrimSpace(t[i+1:]) != "" {
		return false
	}
	return strings.HasPrefix(t, "SELECT") || strings.HasPrefix(t, "WITH")
}

func renderSchemaForMCP(meta *db.SchemaMetadata, wanted []string) string {
	if meta == nil || len(meta.Tables) == 0 {
		return i18n.T(i18n.Msg{ES: "No se pudo leer el esquema de esa conexión.", EN: "Couldn't read that connection's schema."})
	}
	var b strings.Builder
	if len(wanted) == 0 {
		b.WriteString("-- " + i18n.T(i18n.Msg{ES: "%d tablas. Pedí las que necesites en `tables`.", EN: "%d tables. Ask for the ones you need in `tables`."}, len(meta.Tables)) + "\n")
		for i := range meta.Tables {
			fmt.Fprintf(&b, "%s\n", qualified(meta.Tables[i]))
		}
		return b.String()
	}
	found := 0
	for _, w := range wanted {
		t := findTable(meta, w)
		if t == nil {
			b.WriteString("-- " + i18n.T(i18n.Msg{ES: "no existe ninguna tabla %q", EN: "there's no table %q"}, w) + "\n")
			continue
		}
		found++
		b.WriteString(renderTableDDL(*t))
		b.WriteString("\n")
	}
	if found == 0 {
		b.WriteString("-- " + i18n.T(i18n.Msg{ES: "ninguna de las tablas pedidas existe en esta conexión", EN: "none of the requested tables exist on this connection"}) + "\n")
	}
	return b.String()
}
