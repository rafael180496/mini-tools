import {t} from '../i18n'
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
    // focus, cuando está, es el tramo exacto que motiva el aviso (el `*` de
    // SELECT *, la palabra UPDATE/DELETE): el editor subraya solo eso.
    // Subrayar la sentencia entera hacía que el tooltip del aviso apareciera
    // dondequiera que descansara el mouse sobre la consulta, encima del
    // popup de autocompletado. `line` es 1-based y `col` 0-based.
    focus?: {line: number; col: number; length: number}
}

// focusAt traduce un índice dentro del texto de la sentencia a línea/columna
// del documento.
function focusAt(stmt: StatementSpan, index: number, length: number): LintWarning['focus'] {
    const before = stmt.text.slice(0, index)
    const nl = before.lastIndexOf('\n')
    const line = stmt.startLine + (before.match(/\n/g)?.length ?? 0)
    return {line, col: index - (nl + 1), length}
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

        const star = /SELECT\s+(\*)/i.exec(stmt.text)
        if (star) {
            warnings.push({
                message: t().editor.lint.selectStar,
                startLineNumber: stmt.startLine,
                endLineNumber: stmt.endLine,
                blocking: false,
                focus: focusAt(stmt, star.index + star[0].length - 1, 1),
            })
        }

        if ((trimmedUpper.startsWith('UPDATE') || trimmedUpper.startsWith('DELETE')) && !upper.includes('WHERE')) {
            const kw = upper.length - trimmedUpper.length
            warnings.push({
                message: t().editor.lint.noWhere,
                startLineNumber: stmt.startLine,
                endLineNumber: stmt.endLine,
                blocking: true,
                focus: focusAt(stmt, kw, 6),
            })
        }
    }

    return warnings
}
