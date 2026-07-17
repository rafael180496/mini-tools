import {snippetCompletion, type CompletionSource, type CompletionResult} from '@codemirror/autocomplete'
import {detectClause} from './sqlSchema'

// Generic statement templates — "ins" fuzzy-matches "INSERT" and inserts the
// full skeleton with tab-stops (${1:...}), same snippetCompletion()
// mechanism already used for Redis commands (redisLanguage.ts) — CodeMirror
// tab-stop syntax is identical to Monaco's, ported unchanged. Engine-neutral
// on purpose (works the same for SQLite/Postgres/Oracle); dbType-specific
// ones (PL/SQL block, MERGE) are appended separately below, only for Oracle.
interface SqlSnippet {
    label: string
    detail: string
    insertText: string
}

const GENERIC_SNIPPETS: SqlSnippet[] = [
    {
        label: 'INSERT',
        detail: 'INSERT INTO tabla (columnas) VALUES (...)',
        insertText: 'INSERT INTO ${1:tabla} (${2:columnas})\nVALUES (${3:valores});',
    },
    {
        label: 'UPDATE',
        detail: 'UPDATE tabla SET ... WHERE ...',
        insertText: 'UPDATE ${1:tabla}\nSET ${2:columna} = ${3:valor}\nWHERE ${4:condición};',
    },
    {
        label: 'DELETE',
        detail: 'DELETE FROM tabla WHERE ...',
        insertText: 'DELETE FROM ${1:tabla}\nWHERE ${2:condición};',
    },
    {
        label: 'SELECT',
        detail: 'SELECT ... FROM tabla WHERE ...',
        insertText: 'SELECT ${1:*}\nFROM ${2:tabla}\nWHERE ${3:condición};',
    },
    {
        label: 'SELECT JOIN',
        detail: 'SELECT ... FROM a JOIN b ON ...',
        insertText: 'SELECT ${1:*}\nFROM ${2:tabla_a} a\nJOIN ${3:tabla_b} b ON a.${4:id} = b.${5:id_a}\nWHERE ${6:condición};',
    },
    {
        label: 'CREATE TABLE',
        detail: 'CREATE TABLE con una PK simple',
        insertText: 'CREATE TABLE ${1:tabla} (\n    ${2:id} ${3:INTEGER} NOT NULL,\n    ${4:columna} ${5:VARCHAR2(100)},\n    PRIMARY KEY (${2:id})\n);',
    },
    {
        label: 'CASE',
        detail: 'CASE WHEN ... THEN ... ELSE ... END',
        insertText: 'CASE\n    WHEN ${1:condición} THEN ${2:valor}\n    ELSE ${3:valor_default}\nEND',
    },
]

// Oracle-only — PL/SQL no existe en Postgres/SQLite, y MERGE (aunque
// también existe en Postgres 15+) se agrega acá porque el caso de uso real
// que motivó esto (scripts de refacturación con decenas de bloques
// DECLARE/BEGIN/END) es exclusivamente Oracle.
const ORACLE_SNIPPETS: SqlSnippet[] = [
    {
        label: 'DECLARE BEGIN END',
        detail: 'Bloque PL/SQL anónimo con manejo de excepción',
        insertText:
            'DECLARE\n    ${1:v_variable} ${2:NUMBER};\nBEGIN\n    ${3:-- código}\nEXCEPTION\n    WHEN OTHERS THEN\n        DBMS_OUTPUT.PUT_LINE(SQLERRM);\nEND;\n/',
    },
    {
        label: 'MERGE',
        detail: 'MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED',
        insertText:
            'MERGE INTO ${1:tabla_destino} d\nUSING ${2:tabla_origen} o\nON (d.${3:id} = o.${3:id})\nWHEN MATCHED THEN\n    UPDATE SET d.${4:columna} = o.${4:columna}\nWHEN NOT MATCHED THEN\n    INSERT (${3:id}, ${4:columna}) VALUES (o.${3:id}, o.${4:columna});',
    },
]

// Only offered at the start of a statement (detectClause === 'other') —
// same heuristic schemaAwareCompletionSource already uses to decide "this
// isn't inside a FROM/column list" — so "ins"/"up"/"sel" don't pop up mid-
// WHERE-clause where a full statement template would never make sense.
export function sqlSnippetCompletionSource(dbType: string | null | undefined): CompletionSource {
    const snippets = dbType === 'oracle' ? [...GENERIC_SNIPPETS, ...ORACLE_SNIPPETS] : GENERIC_SNIPPETS

    return (context): CompletionResult | null => {
        const word = context.matchBefore(/\w*/)
        if (!word) return null
        if (word.from === word.to && !context.explicit) return null

        if (detectClause(context.state.sliceDoc(0, word.from)) !== 'other') return null

        return {
            from: word.from,
            options: snippets.map((s) => snippetCompletion(s.insertText, {label: s.label, type: 'keyword', detail: s.detail})),
            validFor: /^\w*$/,
        }
    }
}
