// "Copiar como INSERT" stays frontend-only (pure string formatting +
// clipboard, no file I/O) rather than a Go binding — see
// .claude/specs/go-react-contract.md for the deviation from the original
// plan's backend/export/sqlgen.go.

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

function formatValue(v: unknown): string {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return `'${String(v).replace(/'/g, "''")}'`
}

export function generateInsertStatements(table: string, columns: string[], rows: unknown[][]): string {
    const colList = columns.map(quoteIdentifier).join(', ')
    return rows
        .map((row) => `INSERT INTO ${quoteIdentifier(table)} (${colList}) VALUES (${row.map(formatValue).join(', ')});`)
        .join('\n')
}

function formatCondition(col: string, v: unknown): string {
    return v === null || v === undefined ? `${quoteIdentifier(col)} IS NULL` : `${quoteIdentifier(col)} = ${formatValue(v)}`
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
export function generateUpdateStatement(table: string, columns: string[], row: unknown[]): string {
    const setClause = columns.map((c, i) => `${quoteIdentifier(c)} = ${formatValue(row[i])}`).join(',\n    ')
    const whereClause = columns.map((c, i) => formatCondition(c, row[i])).join(' AND ')
    return (
        `-- Revisá el WHERE antes de ejecutar: por defecto matchea todas las columnas de la fila,\n` +
        `-- ajustalo a la primary key real de "${table}" si la tiene.\n` +
        `UPDATE ${quoteIdentifier(table)}\nSET ${setClause}\nWHERE ${whereClause};`
    )
}
