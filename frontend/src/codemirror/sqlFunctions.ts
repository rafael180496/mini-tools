import {snippetCompletion, type CompletionSource, type CompletionResult} from '@codemirror/autocomplete'
import {detectClause} from './sqlSchema'

// Per-dialect SQL function completions — the piece lang-sql's built-in
// completion never provided (it offers keywords only, not built-in functions).
// Registered as an additive autocomplete source in sqlSchema.ts, alongside the
// schema-aware table/column source and the statement snippets. Offered only in
// value positions (detectClause 'column'/'other'), never right after FROM/JOIN
// where a table name is expected — same gating philosophy as sqlSnippets.ts.

interface SqlFunc {
    label: string
    detail: string
}

// Functions valid across essentially every dialect (SQL standard-ish).
const COMMON_FUNCS: SqlFunc[] = [
    {label: 'COUNT', detail: 'Cuenta filas'},
    {label: 'SUM', detail: 'Suma'},
    {label: 'AVG', detail: 'Promedio'},
    {label: 'MIN', detail: 'Mínimo'},
    {label: 'MAX', detail: 'Máximo'},
    {label: 'UPPER', detail: 'A mayúsculas'},
    {label: 'LOWER', detail: 'A minúsculas'},
    {label: 'TRIM', detail: 'Quita espacios'},
    {label: 'COALESCE', detail: 'Primer valor no nulo'},
    {label: 'NULLIF', detail: 'NULL si son iguales'},
    {label: 'ABS', detail: 'Valor absoluto'},
    {label: 'ROUND', detail: 'Redondea'},
    {label: 'CAST', detail: 'Convierte de tipo'},
]

// Dialect-specific functions (merged on top of COMMON_FUNCS).
const DIALECT_FUNCS: Record<string, SqlFunc[]> = {
    postgres: [
        {label: 'NOW', detail: 'Timestamp actual'},
        {label: 'CURRENT_DATE', detail: 'Fecha actual'},
        {label: 'STRING_AGG', detail: 'Concatena con separador'},
        {label: 'ARRAY_AGG', detail: 'Agrega a un array'},
        {label: 'TO_CHAR', detail: 'Formatea a texto'},
        {label: 'DATE_TRUNC', detail: 'Trunca una fecha'},
        {label: 'EXTRACT', detail: 'Extrae parte de fecha'},
        {label: 'LENGTH', detail: 'Largo de texto'},
        {label: 'SUBSTRING', detail: 'Subcadena'},
    ],
    oracle: [
        {label: 'NVL', detail: 'Valor por defecto si NULL'},
        {label: 'NVL2', detail: 'Elige según NULL/no-NULL'},
        {label: 'DECODE', detail: 'CASE compacto'},
        {label: 'SYSDATE', detail: 'Fecha/hora actual'},
        {label: 'SYSTIMESTAMP', detail: 'Timestamp actual'},
        {label: 'TO_CHAR', detail: 'Formatea a texto'},
        {label: 'TO_DATE', detail: 'Texto a fecha'},
        {label: 'TO_NUMBER', detail: 'Texto a número'},
        {label: 'LISTAGG', detail: 'Concatena filas'},
        {label: 'TRUNC', detail: 'Trunca fecha/número'},
        {label: 'INSTR', detail: 'Posición de subcadena'},
        {label: 'SUBSTR', detail: 'Subcadena'},
        {label: 'NANVL', detail: 'Valor si NaN'},
    ],
    sqlserver: [
        {label: 'GETDATE', detail: 'Fecha/hora actual'},
        {label: 'ISNULL', detail: 'Valor por defecto si NULL'},
        {label: 'CONVERT', detail: 'Convierte de tipo'},
        {label: 'DATEADD', detail: 'Suma a una fecha'},
        {label: 'DATEDIFF', detail: 'Diferencia de fechas'},
        {label: 'LEN', detail: 'Largo de texto'},
        {label: 'CHARINDEX', detail: 'Posición de subcadena'},
        {label: 'FORMAT', detail: 'Formatea valor'},
        {label: 'IIF', detail: 'IF en línea'},
        {label: 'SUBSTRING', detail: 'Subcadena'},
    ],
    sqlite: [
        {label: 'IFNULL', detail: 'Valor por defecto si NULL'},
        {label: 'DATE', detail: 'Fecha'},
        {label: 'DATETIME', detail: 'Fecha y hora'},
        {label: 'STRFTIME', detail: 'Formatea fecha'},
        {label: 'TYPEOF', detail: 'Tipo dinámico del valor'},
        {label: 'GROUP_CONCAT', detail: 'Concatena filas'},
        {label: 'LENGTH', detail: 'Largo de texto'},
        {label: 'SUBSTR', detail: 'Subcadena'},
    ],
}

// A function that takes no argument list the user should complete (SYSDATE,
// CURRENT_DATE) — insert it bare; everything else gets NAME(${1}) with the
// cursor inside the parens.
const NO_ARGS = new Set(['SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'NOW', 'GETDATE'])

export function sqlFunctionCompletionSource(dbType: string | null | undefined): CompletionSource {
    const funcs = [...COMMON_FUNCS, ...(DIALECT_FUNCS[dbType ?? ''] ?? [])]
    return (context): CompletionResult | null => {
        const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/)
        if (!word || (word.from === word.to && !context.explicit)) return null

        // Value positions only — not right after FROM/JOIN (table expected).
        const clause = detectClause(context.state.sliceDoc(0, word.from))
        if (clause === 'from') return null

        return {
            from: word.from,
            options: funcs.map((f) =>
                NO_ARGS.has(f.label)
                    ? {label: f.label, type: 'function', detail: f.detail}
                    : snippetCompletion(`${f.label}(\${1})`, {label: f.label, type: 'function', detail: f.detail}),
            ),
            validFor: /^[A-Za-z0-9_]*$/,
        }
    }
}
