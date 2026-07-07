import {monaco} from './setup'

const SQL_KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING',
    'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN',
    'DISTINCT', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS',
    'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'WITH', 'RECURSIVE',
    'BEGIN', 'DECLARE', 'LOOP', 'IF', 'ELSIF', 'RETURN', 'FUNCTION', 'PROCEDURE', 'TRIGGER',
]

// The generic basic-languages/sql contribution only knows ANSI keywords —
// these fill in a handful of the most common Oracle/Postgres-specific ones.
const ORACLE_FUNCTIONS = ['NVL', 'DECODE', 'TO_CHAR', 'TO_DATE', 'TO_NUMBER', 'SYSDATE', 'DUAL', 'ROWNUM', 'DBMS_OUTPUT.PUT_LINE']
const POSTGRES_FUNCTIONS = ['COALESCE', 'NOW', 'CURRENT_DATE', 'GENERATE_SERIES', 'ARRAY_AGG', 'STRING_AGG', 'JSONB_BUILD_OBJECT']

const SNIPPETS: {label: string; detail: string; insertText: string}[] = [
    {label: 'select', detail: 'SELECT ... FROM ... WHERE ...', insertText: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};'},
    {label: 'insert', detail: 'INSERT INTO ... VALUES ...', insertText: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});'},
    {label: 'update', detail: 'UPDATE ... SET ... WHERE ...', insertText: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};'},
    {label: 'plsql_block', detail: 'Bloque anónimo PL/SQL', insertText: 'DECLARE\n\t${1:v_var} ${2:NUMBER};\nBEGIN\n\t${0}\nEND;'},
    {label: 'plsql_proc', detail: 'CREATE OR REPLACE PROCEDURE', insertText: 'CREATE OR REPLACE PROCEDURE ${1:name} IS\nBEGIN\n\t${0}\nEND;'},
]

let registered = false

// Keywords + snippets — schema-aware table/column completion is a separate
// provider (completionProvider.ts) so it can be driven by the active
// connection's metadata independently.
export function registerSqlLanguageExtras() {
    if (registered) return
    registered = true

    monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: [' '],
        provideCompletionItems(model, position) {
            const word = model.getWordUntilPosition(position)
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            }

            const keywordItems = [...SQL_KEYWORDS, ...ORACLE_FUNCTIONS, ...POSTGRES_FUNCTIONS].map((kw) => ({
                label: kw,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: kw,
                range,
            }))

            const snippetItems = SNIPPETS.map((s) => ({
                label: s.label,
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: s.insertText,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: s.detail,
                range,
            }))

            return {suggestions: [...keywordItems, ...snippetItems]}
        },
    })
}
