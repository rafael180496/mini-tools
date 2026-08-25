// "Copiar como INSERT" stays frontend-only (pure string formatting +
// clipboard, no file I/O) rather than a Go binding — see
// .claude/specs/go-react-contract.md for the deviation from the original
// plan's backend/export/sqlgen.go.

// SqlTarget es contra QUÉ se generan las sentencias: la tabla, el motor y el
// tipo de cada columna.
//
// La tabla no es un nombre suelto que se cite acá. Cuando el backend pudo
// resolver de dónde salieron las filas (ResultEditTarget en app_dbedit.go)
// viene ya calificada con su esquema y citada por él —`"SGCPRO"."ACTIONS"`—
// con la caja exacta que tiene en el catálogo, que en Oracle es la diferencia
// entre que la sentencia corra o no. Volver a citarla acá daría
// `"""SGCPRO"".""ACTIONS"""`; de ahí la bandera `qualified`.
export interface SqlTarget {
    // Referencia a la tabla tal cual va a ir escrita en el SQL.
    table: string
    // true cuando `table` ya viene calificada y citada por el backend.
    qualified?: boolean
    // Motor destino ("oracle" | "postgres" | "sqlserver" | "sqlite"). Decide
    // cómo se escribe una fecha; vacío = literal entre comillas.
    engine?: string
    // Clase de cada columna, por nombre en MINÚSCULA ("date" | "datetime" |
    // "number" | "bool" | "json" | "text"), tal como la deduce columnKind en
    // app_dbedit.go.
    //
    // Hace falta el tipo y no alcanza con mirar el valor: un VARCHAR que
    // guarda "2024-01-15" se lee igual que una fecha, y convertirlo a TO_DATE
    // cambiaría el dato que se inserta.
    kinds?: Record<string, string>
}

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

function tableRef(target: SqlTarget): string {
    return target.qualified ? target.table : quoteIdentifier(target.table)
}

function kindOf(target: SqlTarget, column: string): string {
    return target.kinds?.[column.toLowerCase()] ?? ''
}

// Un instante tal como llega del backend: `time.Time` se serializa a JSON en
// RFC3339 ("2024-01-15T13:45:00Z", "2024-01-15T13:45:00-06:00"), y una fecha
// sin hora llega como "2024-01-15".
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/

interface DateParts {
    date: string
    // Vacío cuando el valor no traía hora.
    time: string
    // Fracción de segundo con su punto (".123456"), o vacío.
    frac: string
}

function splitInstant(v: unknown): DateParts | null {
    const m = ISO_INSTANT.exec(String(v).trim())
    if (!m) return null
    // La zona se descarta a propósito: lo que se escribe es la hora de pared
    // que la grilla está mostrando, para que la sentencia reproduzca lo que se
    // ve. Reinterpretarla en otra zona haría que copiar una fila y volver a
    // insertarla cambiara el dato.
    return {date: m[1], time: m[2] ?? '', frac: (m[3] ?? '').slice(0, 7)}
}

// formatDate escribe la fecha con la conversión EXPLÍCITA que pide cada motor.
//
// Sin esto salía como `'2024-01-15T13:45:00Z'`, un string pelado: Oracle lo
// rechaza con ORA-01861 salvo que el NLS_DATE_FORMAT de quien la corra
// coincida por casualidad, que es exactamente lo que una sentencia generada no
// puede dar por sentado.
function formatDate(p: DateParts, engine: string): string {
    const full = p.time ? `${p.date} ${p.time}${p.frac}` : p.date
    switch (engine) {
        case 'oracle':
            if (!p.time) return `TO_DATE('${p.date}', 'YYYY-MM-DD')`
            // Con fracción de segundo es un TIMESTAMP y no un DATE: TO_DATE la
            // truncaría sin avisar, y perder milisegundos en un INSERT que uno
            // cree fiel es la clase de diferencia que aparece meses después.
            if (p.frac) return `TO_TIMESTAMP('${full}', 'YYYY-MM-DD HH24:MI:SS.FF')`
            return `TO_DATE('${full}', 'YYYY-MM-DD HH24:MI:SS')`
        case 'postgres':
            return p.time ? `TIMESTAMP '${full}'` : `DATE '${p.date}'`
        case 'sqlserver':
            return p.time ? `CAST('${full}' AS datetime2)` : `CAST('${p.date}' AS date)`
        default:
            // SQLite no tiene tipo fecha —guarda el texto ISO tal cual—, y un
            // motor desconocido no tiene sintaxis que suponerle.
            return `'${full}'`
    }
}

function formatValue(v: unknown, kind: string, engine: string): string {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (kind === 'date' || kind === 'datetime') {
        const parts = splitInstant(v)
        if (parts) return formatDate(parts, engine)
        // Un valor que la columna dice que es fecha pero no parsea se escribe
        // como texto: mejor una sentencia que el motor rechaza y se ve, que
        // una conversión inventada que pasa.
    }
    return `'${String(v).replace(/'/g, "''")}'`
}

export function generateInsertStatements(target: SqlTarget, columns: string[], rows: unknown[][]): string {
    const table = tableRef(target)
    const colList = columns.map(quoteIdentifier).join(', ')
    const engine = target.engine ?? ''
    const kinds = columns.map((c) => kindOf(target, c))
    return rows
        .map(
            (row) =>
                `INSERT INTO ${table} (${colList}) VALUES (${row.map((v, i) => formatValue(v, kinds[i], engine)).join(', ')});`,
        )
        .join('\n')
}

function formatCondition(col: string, v: unknown, kind: string, engine: string): string {
    return v === null || v === undefined
        ? `${quoteIdentifier(col)} IS NULL`
        : `${quoteIdentifier(col)} = ${formatValue(v, kind, engine)}`
}

// "Editar" a row from the results grid means generating its UPDATE
// statement, not an inline-editable cell that writes to the DB on its own
// — same philosophy as generateInsertStatements: produce SQL the user
// reviews and runs explicitly (via Ejecutar), never a silent write. The
// grid doesn't know which columns are the real primary key, so the WHERE
// clause matches every column from the row as a conservative default —
// flagged with a comment so the user edits it down to the real key before
// running, especially if the table has no natural uniqueness across all
// columns (duplicate rows would otherwise all match).
export function generateUpdateStatement(target: SqlTarget, columns: string[], row: unknown[]): string {
    const table = tableRef(target)
    const engine = target.engine ?? ''
    const kinds = columns.map((c) => kindOf(target, c))
    const setClause = columns
        .map((c, i) => `${quoteIdentifier(c)} = ${formatValue(row[i], kinds[i], engine)}`)
        .join(',\n    ')
    const whereClause = columns.map((c, i) => formatCondition(c, row[i], kinds[i], engine)).join(' AND ')
    return (
        `-- Revisá el WHERE antes de ejecutar: por defecto matchea todas las columnas de la fila,\n` +
        `-- ajustalo a la primary key real de ${table} si la tiene.\n` +
        `UPDATE ${table}\nSET ${setClause}\nWHERE ${whereClause};`
    )
}

// Multi-row wrapper around generateUpdateStatement, same pattern as
// generateInsertStatements — one UPDATE per row, joined for pasting as a
// single script.
export function generateUpdateStatements(target: SqlTarget, columns: string[], rows: unknown[][]): string {
    return rows.map((row) => generateUpdateStatement(target, columns, row)).join('\n\n')
}

function csvField(v: unknown): string {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// CSV copy for pasting into a spreadsheet (Excel/Sheets/etc.) without going
// through the file-export dialog (ExportMenu) — same underlying shape as
// the CSV export, but a direct navigator.clipboard.writeText, matching the
// "copiar fila"/"copiar como INSERT" clipboard pattern in ResultGrid.
export function generateCSV(columns: string[], rows: unknown[][]): string {
    const header = columns.map(csvField).join(',')
    const body = rows.map((row) => row.map(csvField).join(',')).join('\r\n')
    return `${header}\r\n${body}`
}
