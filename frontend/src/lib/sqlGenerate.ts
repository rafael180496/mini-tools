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
