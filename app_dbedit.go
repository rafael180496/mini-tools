package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"mini-tools/backend/db"
	"mini-tools/backend/query"
)

// Editar el resultado y que la app escriba el UPDATE.
//
// **La regla que gobierna todo este archivo: nunca escribir una fila que no se
// pueda identificar sin ninguna duda.** Editar en la grilla es cómodo hasta que
// el WHERE generado alcanza más filas de las que se veían, y eso no se deshace
// con Ctrl+Z. Por eso:
//
//   - La consulta tiene que salir de UNA tabla, sin JOIN ni GROUP BY ni
//     subconsultas (backend/query/editable.go).
//   - La tabla tiene que tener **clave primaria**, y la clave completa tiene
//     que estar en el resultado. Sin eso no se ofrece editar: un `SELECT name
//     FROM contacts` no dice cuál de los tres "rafael" es.
//   - Cada UPDATE se ejecuta **en una transacción** y tiene que afectar
//     exactamente **una** fila. Si afecta cero o dos, se revierte TODO el lote
//     y se explica: dos filas con la misma clave significa que la clave no era
//     única, y una promesa rota ahí vale más que el cambio.
//   - Los valores viajan como **parámetros bind**, jamás concatenados. El SQL
//     de la vista previa es para leer; el que corre lleva los valores aparte.

// EditColumn es una columna del resultado, con lo que hace falta para dibujar
// el editor correcto.
type EditColumn struct {
	Name     string `json:"name"`
	DataType string `json:"dataType"`
	Nullable bool   `json:"nullable"`
	IsKey    bool   `json:"isKey"`
	// Kind es la clase de editor: "text" | "number" | "bool" | "datetime" |
	// "date" | "json". Se deduce del tipo del motor acá y no en el frontend
	// para que la regla viva en un solo lugar — son cuatro motores con nombres
	// distintos para lo mismo.
	Kind string `json:"kind"`
	// Editable en false marca las columnas que no se pueden tocar (las de la
	// clave: cambiar la clave es mover la fila, no corregir un dato).
	Editable bool `json:"editable"`
}

// EditTarget es la respuesta de "¿este resultado se puede editar?".
type EditTarget struct {
	Editable bool `json:"editable"`
	// Table es el nombre calificado listo para el UPDATE.
	Table   string       `json:"table"`
	Columns []EditColumn `json:"columns"`
	KeyCols []string     `json:"keyCols"`
	// Reason explica por qué NO se puede, cuando Editable es false.
	Reason string `json:"reason"`
}

// CellEdit es un cambio pendiente: qué columna, de qué fila, a qué valor.
type CellEdit struct {
	Column string `json:"column"`
	// Value nil significa NULL. Un string vacío es un string vacío, que no es
	// lo mismo — y confundirlos es cómo se pierde la diferencia entre "sin
	// dato" y "dato en blanco".
	Value *string `json:"value"`
	// Key son los valores de la clave primaria de esa fila, como se leyeron.
	Key map[string]string `json:"key"`
}

// EditApplied es el resultado de guardar.
type EditApplied struct {
	Statements []string `json:"statements"`
	Rows       int64    `json:"rows"`
}

// ResultEditTarget dice si el resultado de `sqlText` se puede editar.
//
// Nunca devuelve error por "no se puede editar": eso es información normal y
// viaja en Reason. El error queda para lo que sí es un fallo (la conexión, el
// catálogo).
func (a *App) ResultEditTarget(connID, sqlText string) (EditTarget, error) {
	if err := a.requireUnlocked(); err != nil {
		return EditTarget{}, err
	}

	src, err := query.DetectEditSource(sqlText)
	if err != nil {
		return EditTarget{Reason: err.Error()}, nil
	}

	meta, err := a.GetSchemaMetadata(connID, false)
	if err != nil || meta == nil {
		return EditTarget{Reason: "todavía no se leyó el catálogo de esta conexión"}, nil
	}

	// Se reusa el buscador de app_refs.go: mismo criterio de mayúsculas y de
	// nombre calificado que usa el resolvedor de `@db`, para que "la tabla que
	// encontró el agente" y "la tabla que se va a editar" no puedan diferir.
	want := src.Table
	if src.Schema != "" {
		want = src.Schema + "." + src.Table
	}
	table := findTable(meta, want)
	if table == nil {
		return EditTarget{Reason: fmt.Sprintf("no se encontró la tabla %q en el catálogo — puede ser una vista o estar en otro esquema", src.Table)}, nil
	}

	out := EditTarget{Table: qualify(table.Schema, table.Name)}
	for _, c := range table.Columns {
		out.Columns = append(out.Columns, EditColumn{
			Name:     c.Name,
			DataType: c.DataType,
			Nullable: c.Nullable,
			IsKey:    c.IsPrimaryKey,
			Kind:     columnKind(c.DataType),
			// La clave no se edita: cambiarla no corrige un dato, mueve la
			// fila a otra identidad. Eso es un UPDATE que se escribe a mano y
			// se mira dos veces.
			Editable: !c.IsPrimaryKey,
		})
		if c.IsPrimaryKey {
			out.KeyCols = append(out.KeyCols, c.Name)
		}
	}

	if len(out.KeyCols) == 0 {
		out.Reason = fmt.Sprintf("la tabla %s no tiene clave primaria: sin ella no hay forma de escribirle a UNA fila y solo a esa", out.Table)
		return out, nil
	}

	out.Editable = true
	return out, nil
}

// PreviewRowEdits arma el SQL que se va a ejecutar, para poder leerlo antes.
//
// **Es para mirar, no es lo que corre**: acá los valores van escritos adentro
// de la sentencia para que se entienda de un vistazo; en ApplyRowEdits van como
// parámetros bind. Se genera del mismo lugar y en el mismo orden, así que lo
// que se lee es lo que va a pasar.
func (a *App) PreviewRowEdits(connID, sqlText string, edits []CellEdit) ([]string, error) {
	target, err := a.ResultEditTarget(connID, sqlText)
	if err != nil {
		return nil, err
	}
	if !target.Editable {
		return nil, fmt.Errorf("app: este resultado no se puede editar: %s", target.Reason)
	}

	out := make([]string, 0, len(edits))
	for _, e := range edits {
		stmt, _, err := buildUpdate(target, e, literalStyle)
		if err != nil {
			return nil, err
		}
		out = append(out, stmt)
	}
	return out, nil
}

// ApplyRowEdits guarda los cambios pendientes.
func (a *App) ApplyRowEdits(connID, sqlText string, edits []CellEdit) (EditApplied, error) {
	target, err := a.ResultEditTarget(connID, sqlText)
	if err != nil {
		return EditApplied{}, err
	}
	if !target.Editable {
		return EditApplied{}, fmt.Errorf("app: este resultado no se puede editar: %s", target.Reason)
	}
	if len(edits) == 0 {
		return EditApplied{}, fmt.Errorf("app: no hay ningún cambio pendiente")
	}

	pool, err := a.pools.Get(connID)
	if err != nil {
		return EditApplied{}, err
	}
	dbType, _ := a.pools.Type(connID)
	style := bindStyleFor(dbType)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		return EditApplied{}, fmt.Errorf("app: no se pudo abrir la transacción: %w", err)
	}
	// Rollback siempre en el camino de error: un defer que no se dispara deja
	// la conexión con una transacción abierta, y esa conexión vuelve al pool.
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	applied := EditApplied{}
	for _, e := range edits {
		stmt, args, err := buildUpdate(target, e, style)
		if err != nil {
			return EditApplied{}, err
		}
		res, err := tx.ExecContext(ctx, stmt, args...)
		if err != nil {
			return EditApplied{}, fmt.Errorf("app: no se pudo guardar %s: %w", e.Column, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			// Un driver que no informa filas afectadas no permite comprobar la
			// promesa de "una y solo una", así que no se sigue.
			return EditApplied{}, fmt.Errorf("app: el motor no informó cuántas filas cambió, así que no se puede confirmar que fue una sola: %w", err)
		}
		if n != 1 {
			return EditApplied{}, fmt.Errorf(
				"app: ese cambio afectaba %d filas y tenía que afectar exactamente una — se revirtió TODO el lote. Sentencia: %s", n, stmt)
		}
		applied.Statements = append(applied.Statements, stmt)
		applied.Rows += n
	}

	if err := tx.Commit(); err != nil {
		return EditApplied{}, fmt.Errorf("app: no se pudo confirmar la transacción: %w", err)
	}
	committed = true
	return applied, nil
}

// bindStyle es cómo se escribe un parámetro en cada motor.
type bindStyle func(n int) string

func bindStyleFor(t db.DBType) bindStyle {
	switch t {
	case db.DBTypePostgres:
		return func(n int) string { return fmt.Sprintf("$%d", n) }
	case db.DBTypeOracle:
		// go-ora no soporta parámetros con nombre: posicionales.
		return func(n int) string { return fmt.Sprintf(":%d", n) }
	case db.DBTypeSQLServer:
		return func(n int) string { return fmt.Sprintf("@p%d", n) }
	default:
		return func(int) string { return "?" }
	}
}

// literalStyle marca los huecos de la vista previa. No se usa nunca para
// ejecutar: los valores se pegan aparte en buildUpdate.
func literalStyle(int) string { return "\x00" }

// buildUpdate arma la sentencia y sus parámetros.
func buildUpdate(target EditTarget, e CellEdit, style bindStyle) (string, []any, error) {
	col := findColumn(target, e.Column)
	if col == nil {
		return "", nil, fmt.Errorf("app: la columna %q no existe en %s", e.Column, target.Table)
	}
	if !col.Editable {
		return "", nil, fmt.Errorf("app: %q es parte de la clave primaria: cambiarla no corrige un dato, mueve la fila", e.Column)
	}
	if e.Value == nil && !col.Nullable {
		return "", nil, fmt.Errorf("app: %q no admite NULL", e.Column)
	}

	args := []any{}
	value, err := convert(e.Value, col.Kind)
	if err != nil {
		return "", nil, fmt.Errorf("app: %q: %w", e.Column, err)
	}
	args = append(args, value)

	var where []string
	for _, k := range target.KeyCols {
		raw, ok := e.Key[k]
		if !ok {
			return "", nil, fmt.Errorf("app: falta el valor de la clave %q para identificar la fila", k)
		}
		kc := findColumn(target, k)
		kind := "text"
		if kc != nil {
			kind = kc.Kind
		}
		v, err := convert(&raw, kind)
		if err != nil {
			return "", nil, fmt.Errorf("app: clave %q: %w", k, err)
		}
		args = append(args, v)
		where = append(where, fmt.Sprintf("%s = %s", quoteIdent(k), style(len(args))))
	}

	stmt := fmt.Sprintf("UPDATE %s SET %s = %s WHERE %s",
		target.Table, quoteIdent(e.Column), style(1), strings.Join(where, " AND "))

	// Vista previa: se reemplazan los huecos por los valores, en orden.
	if strings.Contains(stmt, "\x00") {
		for _, v := range args {
			stmt = strings.Replace(stmt, "\x00", literal(v), 1)
		}
		return stmt, nil, nil
	}
	return stmt, args, nil
}

// convert lleva el texto que se escribió en la celda al tipo que espera el
// motor.
//
// Se convierte acá y no se manda todo como texto porque no todos los motores
// convierten igual: una fecha como cadena contra Oracle depende del NLS de la
// sesión y falla con un error que no dice nada. Un `time.Time` o un número lo
// entienden los cuatro.
func convert(v *string, kind string) (any, error) {
	if v == nil {
		return nil, nil
	}
	s := *v
	switch kind {
	case "number":
		t := strings.TrimSpace(s)
		if t == "" {
			return nil, fmt.Errorf("está vacío y la columna es numérica — para dejarla sin dato, poné NULL")
		}
		if i, err := strconv.ParseInt(t, 10, 64); err == nil {
			return i, nil
		}
		f, err := strconv.ParseFloat(strings.Replace(t, ",", ".", 1), 64)
		if err != nil {
			return nil, fmt.Errorf("%q no es un número", s)
		}
		return f, nil
	case "bool":
		t := strings.ToLower(strings.TrimSpace(s))
		switch t {
		case "true", "t", "1", "yes", "si", "sí":
			return true, nil
		case "false", "f", "0", "no":
			return false, nil
		}
		return nil, fmt.Errorf("%q no es verdadero ni falso", s)
	case "datetime", "date":
		t := strings.TrimSpace(s)
		if t == "" {
			return nil, fmt.Errorf("está vacío — para dejar la fecha sin dato, poné NULL")
		}
		for _, layout := range []string{
			"2006-01-02 15:04:05.999999999",
			"2006-01-02T15:04:05.999999999",
			"2006-01-02 15:04:05",
			"2006-01-02T15:04:05",
			"2006-01-02T15:04",
			"2006-01-02",
		} {
			if parsed, err := time.Parse(layout, t); err == nil {
				return parsed, nil
			}
		}
		return nil, fmt.Errorf("%q no se entiende como fecha (probá 2006-01-02 15:04:05)", s)
	default:
		return s, nil
	}
}

// literal escribe un valor para la VISTA PREVIA. Nunca se ejecuta: lo que se
// ejecuta lleva parámetros bind.
func literal(v any) string {
	switch t := v.(type) {
	case nil:
		return "NULL"
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "TRUE"
		}
		return "FALSE"
	case time.Time:
		return "'" + t.Format("2006-01-02 15:04:05") + "'"
	default:
		return "'" + strings.ReplaceAll(fmt.Sprint(v), "'", "''") + "'"
	}
}

// quoteIdent entrecomilla un identificador con comillas dobles, que es el
// estándar y lo aceptan los cuatro motores relacionales que soporta la app.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func qualify(schema, table string) string {
	if schema == "" {
		return quoteIdent(table)
	}
	return quoteIdent(schema) + "." + quoteIdent(table)
}

func findColumn(t EditTarget, name string) *EditColumn {
	for i := range t.Columns {
		if strings.EqualFold(t.Columns[i].Name, name) {
			return &t.Columns[i]
		}
	}
	return nil
}

// columnKind traduce el tipo del motor a la clase de editor.
//
// Cuatro motores con nombres distintos para lo mismo: `int4`/`NUMBER`/
// `INTEGER`/`bigint` son todos un número, y `timestamptz`/`DATE`/`datetime2`
// son todos un instante. La traducción vive acá y no en el frontend para que
// haya un solo lugar donde agregar un tipo nuevo.
func columnKind(dataType string) string {
	t := strings.ToLower(strings.TrimSpace(dataType))
	switch {
	case strings.Contains(t, "bool"), t == "bit":
		return "bool"
	case strings.Contains(t, "json"):
		return "json"
	case strings.Contains(t, "timestamp"), strings.Contains(t, "datetime"):
		return "datetime"
	case t == "date":
		return "date"
	case strings.Contains(t, "time"):
		// TIME sin fecha se edita como texto: un selector de fecha para una
		// hora sola confunde más de lo que ayuda.
		return "text"
	case strings.Contains(t, "int"), strings.Contains(t, "numeric"), strings.Contains(t, "decimal"),
		strings.Contains(t, "number"), strings.Contains(t, "float"), strings.Contains(t, "double"),
		strings.Contains(t, "real"), strings.Contains(t, "money"):
		return "number"
	default:
		return "text"
	}
}
