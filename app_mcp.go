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
		return "", fmt.Errorf("el vault de mini-tools está bloqueado: desbloquealo en la aplicación para que estas herramientas puedan responder")
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
			Name: "vault_search_notes",
			Description: "Busca en la base de conocimiento del usuario (runbooks, procedimientos, notas técnicas). " +
				"Devuelve títulos y fragmentos. SOLO incluye notas que el usuario NO marcó como privadas.",
			InputSchema: obj(map[string]any{"query": str("Qué buscar. Varias palabras: todas tienen que aparecer.")}, "query"),
		},
		{
			Name: "vault_read_note",
			Description: "Devuelve el Markdown completo de una nota, por su título. " +
				"Si el usuario la marcó como privada, devuelve un error de permiso y NO su contenido.",
			InputSchema: obj(map[string]any{"title": str("Título exacto de la nota.")}, "title"),
		},
		{
			Name: "db_list_connections",
			Description: "Lista las bases de datos guardadas: alias, motor y entorno (producción/staging/desarrollo). " +
				"NUNCA devuelve DSN, host, usuario ni contraseña.",
			InputSchema: obj(map[string]any{}),
		},
		{
			Name: "db_get_schema",
			Description: "Devuelve el DDL de una o varias tablas: columnas, tipos, clave primaria y claves foráneas. " +
				"NUNCA devuelve filas de datos.",
			InputSchema: obj(map[string]any{
				"connection": str("Alias de la conexión, tal como lo devuelve db_list_connections."),
				"tables":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Nombres de tabla. Vacío = solo la lista de nombres disponibles."},
			}, "connection"),
		},
		{
			Name: "db_explain_query",
			Description: "Devuelve el plan de ejecución de una consulta SELECT, con el diagnóstico que ya calculó la app " +
				"(escaneos completos, estimaciones erradas, índices sugeridos). NO ejecuta la consulta.",
			InputSchema: obj(map[string]any{
				"connection": str("Alias de la conexión."),
				"query":      str("La consulta SELECT a analizar."),
			}, "connection", "query"),
		},
		{
			Name: "ssh_get_recent_logs",
			Description: "Devuelve las últimas líneas de una terminal SSH que el usuario ya tiene abierta. " +
				"No abre conexiones ni ejecuta comandos.",
			InputSchema: obj(map[string]any{
				"server": str("Alias de la conexión SSH."),
				"lines":  map[string]any{"type": "number", "description": "Cuántas líneas (por defecto 50)."},
			}, "server"),
		},
		{
			Name:        "git_status",
			Description: "Estado de un repositorio abierto en la aplicación: rama, archivos modificados y diff preparado.",
			InputSchema: obj(map[string]any{"repo": str("Nombre del repositorio tal como aparece en la app.")}, "repo"),
		},
	}

	// La herramienta de ESCRITURA solo existe si el usuario la habilitó. No se
	// declara y se rechaza al llamarla: una herramienta que aparece en la lista
	// y siempre falla es una invitación a que el modelo la intente igual, y el
	// catálogo es lo único que el agente lee antes de decidir.
	if a.mcpNotesWrite() {
		tools = append(tools, mcpserver.ToolInfo{
			Name: "vault_create_note",
			Description: "Crea una nota NUEVA en la base de conocimiento del usuario (su 'cerebro'), con título y contenido en Markdown. " +
				"Sirve para dejar asentado lo que se averiguó: un procedimiento, un diagnóstico, una decisión. " +
				"NO pisa nada: un título repetido se rechaza, elegí otro. Para corregir una nota que creaste vos, usá vault_update_note. " +
				"La nota queda marcada como creada por un agente y visible para el usuario en su aplicación.",
			InputSchema: obj(map[string]any{
				"title":   str("Título de la nota. Único: es lo que la hace enlazable con [[…]] desde otras notas."),
				"content": str("Contenido en Markdown. Podés enlazar otras notas con [[Título]] y etiquetar con #etiqueta."),
			}, "title", "content"),
		})
		tools = append(tools, mcpserver.ToolInfo{
			Name: "vault_update_note",
			Description: "Reescribe el contenido de una nota que VOS creaste antes con vault_create_note — para corregirla o ampliarla. " +
				"Solo funciona sobre tus propias notas: las que escribió el usuario, y las tuyas que él haya editado después, se rechazan. " +
				"Tampoco toca ninguna nota marcada como privada. " +
				"REEMPLAZA el contenido entero: leelo antes con vault_read_note si querés conservar parte.",
			InputSchema: obj(map[string]any{
				"title":   str("Título exacto de la nota a reescribir. El título no cambia."),
				"content": str("El contenido completo en Markdown que reemplaza al anterior."),
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
			return "No hay ninguna nota compartida que coincida. Puede que exista pero esté marcada como privada por el usuario.", q, nil
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
			return "", "", fmt.Errorf("el usuario no habilitó que un agente cree notas. Se activa en la aplicación, en Acceso de IA")
		}
		title := strings.TrimSpace(mcpserver.StringArg(args, "title"))
		content := mcpserver.StringArg(args, "content")
		if title == "" || strings.TrimSpace(content) == "" {
			return "", title, fmt.Errorf("hacen falta un título y un contenido")
		}
		// Tope de tamaño: una nota es algo que una persona va a leer. Sin
		// límite, una respuesta larga del modelo termina volcada entera en el
		// vault del usuario.
		if len(content) > maxMCPNoteBytes {
			return "", title, fmt.Errorf("la nota es demasiado grande (%d KB, máximo %d KB) — resumila o partila en varias", len(content)/1024, maxMCPNoteBytes/1024)
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
		return fmt.Sprintf("Nota creada: %q. El usuario ya la ve en su base de conocimiento.", title), title, nil

	case "vault_update_note":
		if !a.mcpNotesWrite() {
			return "", "", fmt.Errorf("el usuario no habilitó que un agente escriba notas. Se activa en la aplicación, en Acceso de IA")
		}
		title := strings.TrimSpace(mcpserver.StringArg(args, "title"))
		content := mcpserver.StringArg(args, "content")
		if title == "" || strings.TrimSpace(content) == "" {
			return "", title, fmt.Errorf("hacen falta el título de la nota y el contenido nuevo")
		}
		if len(content) > maxMCPNoteBytes {
			return "", title, fmt.Errorf("la nota es demasiado grande (%d KB, máximo %d KB)", len(content)/1024, maxMCPNoteBytes/1024)
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
			return "", title, fmt.Errorf(
				"la nota %q no la creaste vos: la escribió el usuario, o vos la creaste y él la editó después. "+
					"Un agente solo puede reescribir sus propias notas intactas. "+
					"Si hace falta cambiarla, decíselo al usuario o creá una nota nueva que la complemente", title)
		}

		// El frontmatter conserva el origen y suma cuándo fue la última
		// reescritura: la nota sigue diciendo quién la escribió y cuándo se
		// tocó por última vez.
		fm := vault.WithAgentUpdate(note.Frontmatter, time.Now())
		if err := a.vault.UpdateNote(note.ID, title, content, fm); err != nil {
			return "", title, err
		}
		runtime.EventsEmit(a.ctx, NoteChangedEvent, map[string]string{"id": note.ID, "title": title})
		return fmt.Sprintf("Nota %q actualizada.", title), title, nil

	case "db_list_connections":
		conns, err := a.vault.ListConnections()
		if err != nil {
			return "", "", err
		}
		var b strings.Builder
		for _, c := range conns {
			env := c.Environment
			if env == "" {
				env = "sin marcar"
			}
			fmt.Fprintf(&b, "- %s (%s, %s)\n", c.Name, c.DBType, env)
		}
		if b.Len() == 0 {
			return "No hay conexiones guardadas.", "", nil
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
			return "", alias, fmt.Errorf("solo se pueden analizar sentencias de lectura (SELECT / WITH)")
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
				return string(out) + "\n\n--- diff preparado ---\n" + d.Patch, repoName, nil
			}
			return string(out), repoName, nil
		}
		return "", repoName, fmt.Errorf("no hay ningún repositorio abierto que se llame %q", repoName)
	}
	return "", "", fmt.Errorf("herramienta desconocida: %s", name)
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
		return "No se pudo leer el esquema de esa conexión."
	}
	var b strings.Builder
	if len(wanted) == 0 {
		fmt.Fprintf(&b, "-- %d tablas. Pedí las que necesites en `tables`.\n", len(meta.Tables))
		for i := range meta.Tables {
			fmt.Fprintf(&b, "%s\n", qualified(meta.Tables[i]))
		}
		return b.String()
	}
	found := 0
	for _, w := range wanted {
		t := findTable(meta, w)
		if t == nil {
			fmt.Fprintf(&b, "-- no existe ninguna tabla %q\n", w)
			continue
		}
		found++
		b.WriteString(renderTableDDL(*t))
		b.WriteString("\n")
	}
	if found == 0 {
		b.WriteString("-- ninguna de las tablas pedidas existe en esta conexión\n")
	}
	return b.String()
}
