// Hand-rolled, best-effort SQL linter (spec: "linter básico: SELECT *,
// falta WHERE en UPDATE/DELETE, warning antes de ejecutar"). Statement
// splitting here is a naive split-on-`;` — unlike backend/query/splitter.go
// it doesn't need to be exact, since a false positive/negative just means a
// warning shows up (or doesn't) one line off; the stakes are low enough
// that duplicating the real splitter in TypeScript isn't worth it.

export interface LintWarning {
    message: string
    startLineNumber: number
    endLineNumber: number
    // blocking warnings pop the confirm-before-execute dialog (Workspace.tsx
    // confirmAndRun); non-blocking ones only show as an editor marker
    // (MonacoSQLEditor.tsx applyLintMarkers, always runs both). SELECT * is
    // a style nit, not a safety issue — it shouldn't stop a quick read
    // query. UPDATE/DELETE without WHERE can destroy data, so that one
    // blocks.
    blocking: boolean
}

interface StatementSpan {
    text: string
    startLine: number
    endLine: number
}

function splitStatementsNaive(text: string): StatementSpan[] {
    const lines = text.split('\n')
    const spans: StatementSpan[] = []
    let buffer: string[] = []
    let startLine = 1

    lines.forEach((line, i) => {
        if (buffer.length === 0) startLine = i + 1
        buffer.push(line)
        if (line.includes(';')) {
            spans.push({text: buffer.join('\n'), startLine, endLine: i + 1})
            buffer = []
        }
    })
    if (buffer.length > 0) {
        spans.push({text: buffer.join('\n'), startLine, endLine: lines.length})
    }
    return spans
}

export function lintSQL(text: string): LintWarning[] {
    const warnings: LintWarning[] = []

    for (const stmt of splitStatementsNaive(text)) {
        if (!stmt.text.trim()) continue
        const upper = stmt.text.toUpperCase()
        const trimmedUpper = upper.trimStart()

        if (/SELECT\s+\*/i.test(stmt.text)) {
            warnings.push({
                message: 'SELECT * puede traer columnas innecesarias — preferí listar las columnas que necesitás.',
                startLineNumber: stmt.startLine,
                endLineNumber: stmt.endLine,
                blocking: false,
            })
        }

        if ((trimmedUpper.startsWith('UPDATE') || trimmedUpper.startsWith('DELETE')) && !upper.includes('WHERE')) {
            warnings.push({
                message: 'UPDATE/DELETE sin WHERE afecta todas las filas de la tabla.',
                startLineNumber: stmt.startLine,
                endLineNumber: stmt.endLine,
                blocking: true,
            })
        }
    }

    return warnings
}
