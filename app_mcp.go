package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"mini-tools/backend/appdata"
	"mini-tools/backend/db"
	"mini-tools/backend/git"
	"mini-tools/backend/mcpserver"
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
	// Audit son los últimos accesos, del más reciente al más viejo.
	Audit []mcpAudit `json:"audit"`
}

// MCPServerStatus devuelve el estado del servidor.
func (a *App) MCPServerStatus() (MCPStatus, error) {
	if err := a.requireUnlocked(); err != nil {
		return MCPStatus{}, err
	}
	a.mcp.mu.Lock()
	defer a.mcp.mu.Unlock()

	out := MCPStatus{
		Enabled:    a.mcp.bridge != nil,
		SocketPath: a.mcp.bridge.Path(),
		Tools:      len(a.mcpTools()),
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

	return []mcpserver.ToolInfo{
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
