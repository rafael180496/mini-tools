package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/db"
	"mini-tools/backend/git"
)

// Resolución del sistema `@` (ver backend/agentctx/refs.go para el parser y la
// tabla de políticas).
//
// Cada resolvedor declara su política además de su función, y las políticas no
// son comentarios: son la razón por la que se puede escribir `@db:Prod/clientes`
// en un chat sin que salga una sola fila de la base. Lo que cruza es DDL —
// columnas, tipos, PK, FK— y nada más.
//
// Nada de esto pasa por el frontend: el mensaje viaja con el `@...` tal cual lo
// escribió el usuario y se expande acá. Que el frontend resolviera sería el
// mismo error que pasarle un DSN (.claude/rules/technical.md punto 9): para
// mostrarlo, primero tendría que haberlo recibido.

// maxRefBody acota lo que una sola referencia puede aportar al prompt. Un
// archivo de diez mil líneas o el diff de una migración entera no ayudan al
// agente: llenan su ventana de contexto y desplazan la pregunta.
const maxRefBody = 24000

// AgentResolveRefs resuelve las referencias de un texto SIN mandarlo.
//
// Es lo que alimenta las fichas desplegables del compositor: el usuario ve
// exactamente qué se va a mandar antes de mandarlo. No es un lujo de interfaz
// — una referencia que se expande en silencio es indistinguible de una fuga.
func (a *App) AgentResolveRefs(text, module, contextID string) ([]agentctx.Resolved, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	refs := agentctx.ParseRefs(text)
	out := make([]agentctx.Resolved, 0, len(refs))
	for _, r := range refs {
		out = append(out, a.resolveRef(r, module, contextID))
	}
	return out, nil
}

// AgentRefPolicies devuelve la tabla de qué inyecta y qué nunca inyecta cada
// tipo de referencia, para el panel de ayuda del selector.
func (a *App) AgentRefPolicies() []agentctx.Policy {
	return agentctx.Policies()
}

// expandRefs reemplaza cada referencia por su contenido y devuelve además lo
// resuelto, para poder informar lo que se bloqueó.
//
// Una referencia que no se pudo resolver se deja TAL CUAL en el texto en vez de
// borrarse: si el agente recibe "mirá @db:Prod/clientes" sin la tabla, al menos
// puede decir que no la tiene. Borrarla dejaría una frase que se refiere a algo
// que ya no está en el mensaje.
func (a *App) expandRefs(text, module, contextID string) (string, []agentctx.Resolved) {
	refs := agentctx.ParseRefs(text)
	if len(refs) == 0 {
		return text, nil
	}
	resolved := make([]agentctx.Resolved, 0, len(refs))
	out := text
	for _, r := range refs {
		res := a.resolveRef(r, module, contextID)
		resolved = append(resolved, res)
		if res.Err != "" || res.Body == "" {
			continue
		}
		block := fmt.Sprintf("\n\n<%s title=%q>\n%s\n</%s>\n", r.Kind, res.Title, res.Body, r.Kind)
		out = strings.Replace(out, r.Raw, block, 1)
	}
	return out, resolved
}

func (a *App) resolveRef(r agentctx.Ref, module, contextID string) agentctx.Resolved {
	res := agentctx.Resolved{Ref: r}
	switch r.Kind {
	case agentctx.KindFile:
		return a.resolveFileRef(res, module, contextID)
	case agentctx.KindDB:
		return a.resolveDBRef(res)
	case agentctx.KindExplain:
		return a.resolveExplainRef(res, module, contextID)
	case agentctx.KindGit:
		return a.resolveGitRef(res, module, contextID)
	case agentctx.KindSSH:
		// La terminal SSH streamea su salida y no la retiene: no hay buffer
		// del que leer. Se dice eso y no "no encontrado", que mandaría a
		// buscar un alias mal escrito que no es el problema.
		res.Err = "las referencias a la terminal SSH todavía no están disponibles: la terminal no guarda su salida"
		return res
	case agentctx.KindNote:
		res.Err = "el módulo de notas todavía no existe en esta versión"
		return res
	}
	res.Err = fmt.Sprintf("tipo de referencia desconocido: %q", r.Kind)
	return res
}

// resolveFileRef inyecta un archivo del repositorio abierto.
//
// Reusa git.ReadWorkFile, que ya valida que la ruta resuelta caiga DENTRO del
// repositorio (anti path traversal), corta por tamaño y detecta binarios. Es la
// única guarda entre "leé un archivo de tu repo" y "leé cualquier cosa del
// disco", y por eso no se reimplementa acá.
func (a *App) resolveFileRef(res agentctx.Resolved, module, contextID string) agentctx.Resolved {
	if module != "git" || contextID == "" {
		res.Err = "@file solo funciona con un repositorio abierto: es su árbol de trabajo lo que se lee"
		return res
	}
	f, err := a.GitReadWorkFile(contextID, res.Value)
	if err != nil {
		res.Err = err.Error()
		return res
	}
	if f.Binary {
		res.Err = "es un archivo binario"
		return res
	}
	if f.TooLarge {
		res.Err = "el archivo supera el tope de lectura"
		return res
	}
	res.Title = f.Path
	res.Body = truncateBody(f.Content)
	return res
}

// resolveDBRef inyecta el DDL de una tabla: columnas, tipos, PK y FK.
//
// **Cero filas, cero credenciales.** El esquema describe la forma de los datos
// y es lo que un agente necesita para escribir una consulta; las filas son los
// datos del usuario y no tienen por qué salir de la máquina para eso.
func (a *App) resolveDBRef(res agentctx.Resolved) agentctx.Resolved {
	name, table, ok := strings.Cut(res.Value, "/")
	if !ok || name == "" || table == "" {
		res.Err = `se escribe @db:Conexión/tabla`
		return res
	}

	conn, err := a.connByNameOrID(name)
	if err != nil {
		res.Err = err.Error()
		return res
	}
	if conn.DBType == "ssh" {
		res.Err = fmt.Sprintf("%q es una conexión SSH, no una base de datos", conn.Name)
		return res
	}

	meta, err := a.GetSchemaMetadata(conn.ID, false)
	if err != nil {
		res.Err = err.Error()
		return res
	}
	found := findTable(meta, table)
	if found == nil {
		res.Err = fmt.Sprintf("no hay ninguna tabla %q en %s", table, conn.Name)
		return res
	}

	res.Title = fmt.Sprintf("%s · %s", conn.Name, qualified(*found))
	res.Body = renderTableDDL(*found)
	return res
}

// resolveExplainRef inyecta el último plan de ejecución guardado.
func (a *App) resolveExplainRef(res agentctx.Resolved, module, contextID string) agentctx.Resolved {
	connID := contextID
	if res.Value != "last" {
		conn, err := a.connByNameOrID(res.Value)
		if err != nil {
			res.Err = err.Error()
			return res
		}
		connID = conn.ID
	}
	if module != "db" && res.Value == "last" {
		res.Err = "@explain:last necesita una pestaña de base de datos activa, o escribí @explain:Conexión"
		return res
	}

	entries, err := a.vault.ListExplainHistory(connID, 1)
	if err != nil {
		res.Err = err.Error()
		return res
	}
	if len(entries) == 0 {
		res.Err = "todavía no se corrió ningún EXPLAIN en esta conexión"
		return res
	}
	e := entries[0]
	planJSON, err := json.Marshal(e.Plan)
	if err != nil {
		res.Err = err.Error()
		return res
	}
	res.Title = "Último plan de ejecución"
	// La consulta va junto al plan: un plan sin su SQL obliga al agente a
	// deducir qué se ejecutó, y esa deducción es donde se equivoca.
	res.Body = truncateBody("-- consulta\n" + e.SQLText + "\n\n-- plan\n" + string(planJSON))
	return res
}

// resolveGitRef inyecta el diff preparado del repositorio abierto.
func (a *App) resolveGitRef(res agentctx.Resolved, module, contextID string) agentctx.Resolved {
	if module != "git" || contextID == "" {
		res.Err = "@git solo funciona con un repositorio abierto"
		return res
	}
	mode := ""
	switch res.Value {
	case "staged":
		mode = "staged"
	case "worktree", "unstaged":
		mode = "worktree"
	default:
		res.Err = `se escribe @git:staged o @git:worktree`
		return res
	}

	d, err := a.GitDiff(contextID, git.DiffTarget{Mode: mode})
	if err != nil {
		res.Err = err.Error()
		return res
	}
	if d == nil || strings.TrimSpace(d.Patch) == "" {
		res.Err = "no hay cambios " + map[string]string{"staged": "preparados", "worktree": "sin preparar"}[mode]
		return res
	}
	res.Title = map[string]string{"staged": "Cambios preparados", "worktree": "Cambios sin preparar"}[mode]
	res.Body = truncateBody(d.Patch)
	return res
}

// connByNameOrID busca una conexión por su nombre visible y, si no aparece,
// por su id.
//
// Por nombre primero porque es lo que el usuario escribe y lo que el selector
// inserta; el id queda como salida de emergencia para dos conexiones con el
// mismo nombre. **Nunca devuelve el DSN** — ConnectionSummary no lo tiene, que
// es justamente por qué se usa esta y no la fila cruda.
func (a *App) connByNameOrID(nameOrID string) (*vaultConn, error) {
	conns, err := a.vault.ListConnections()
	if err != nil {
		return nil, err
	}
	for _, c := range conns {
		if strings.EqualFold(c.Name, nameOrID) {
			return &vaultConn{ID: c.ID, Name: c.Name, DBType: c.DBType}, nil
		}
	}
	for _, c := range conns {
		if c.ID == nameOrID {
			return &vaultConn{ID: c.ID, Name: c.Name, DBType: c.DBType}, nil
		}
	}
	return nil, fmt.Errorf("no hay ninguna conexión guardada que se llame %q", nameOrID)
}

// vaultConn es lo mínimo que necesitan los resolvedores de una conexión. Un
// tipo propio y no vault.ConnectionSummary para que agregar un campo sensible a
// ese struct no lo arrastre acá sin que nadie lo note.
type vaultConn struct {
	ID     string
	Name   string
	DBType string
}

func findTable(meta *db.SchemaMetadata, want string) *db.Table {
	if meta == nil {
		return nil
	}
	schema, name, qualifiedName := "", want, strings.Contains(want, ".")
	if qualifiedName {
		schema, name, _ = strings.Cut(want, ".")
	}
	for i := range meta.Tables {
		t := &meta.Tables[i]
		if !strings.EqualFold(t.Name, name) {
			continue
		}
		if qualifiedName && !strings.EqualFold(t.Schema, schema) {
			continue
		}
		return t
	}
	return nil
}

func qualified(t db.Table) string {
	if t.Schema == "" {
		return t.Name
	}
	return t.Schema + "." + t.Name
}

// renderTableDDL escribe la tabla como un CREATE TABLE legible.
//
// Como texto y no como JSON a propósito: los tres CLIs leen SQL mucho mejor que
// un objeto anidado, y el formato ya lleva implícito qué es clave y qué es
// referencia sin necesidad de explicarlo en el prompt.
func renderTableDDL(t db.Table) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", qualified(t))
	for i, c := range t.Columns {
		fmt.Fprintf(&b, "    %s %s", c.Name, c.DataType)
		if !c.Nullable {
			b.WriteString(" NOT NULL")
		}
		if c.IsPrimaryKey {
			b.WriteString(" -- clave primaria")
		}
		if i < len(t.Columns)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString(");\n")
	for _, fk := range t.ForeignKeys {
		fmt.Fprintf(&b, "-- %s.%s → %s.%s\n", t.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn)
	}
	return b.String()
}

func truncateBody(s string) string {
	if len(s) <= maxRefBody {
		return s
	}
	// Se corta y se DICE que se cortó: un contenido truncado en silencio hace
	// que el agente razone sobre un archivo que cree completo.
	return s[:maxRefBody] + "\n\n… (recortado: la referencia superaba el tope de contexto)"
}
