import {monaco} from './setup'
import {getActiveDbType} from './activeDbTypeStore'

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
// Filtered by the active connection's dbType (see getActiveDbType below) so
// a Postgres connection doesn't get DBMS_OUTPUT.PUT_LINE suggested, etc.
const ORACLE_FUNCTIONS = ['NVL', 'DECODE', 'TO_CHAR', 'TO_DATE', 'TO_NUMBER', 'SYSDATE', 'DUAL', 'ROWNUM', 'DBMS_OUTPUT.PUT_LINE']
const POSTGRES_FUNCTIONS = ['COALESCE', 'NOW', 'CURRENT_DATE', 'GENERATE_SERIES', 'ARRAY_AGG', 'STRING_AGG', 'JSONB_BUILD_OBJECT']

type Snippet = {label: string; detail: string; insertText: string}

// select/insert/update are engine-agnostic; everything engine-specific
// (PL/SQL, PL/pgSQL, MERGE vs. upsert, etc.) lives in its own list below and
// is only offered when the active connection matches, same filtering as
// the function lists above.
const GENERIC_SNIPPETS: Snippet[] = [
    {label: 'select', detail: 'SELECT ... FROM ... WHERE ...', insertText: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};'},
    {label: 'insert', detail: 'INSERT INTO ... VALUES ...', insertText: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});'},
    {label: 'update', detail: 'UPDATE ... SET ... WHERE ...', insertText: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};'},
]

const ORACLE_SNIPPETS: Snippet[] = [
    {label: 'plsql_block', detail: 'Bloque anónimo PL/SQL', insertText: 'DECLARE\n\t${1:v_var} ${2:NUMBER};\nBEGIN\n\t${0}\nEND;'},
    {label: 'plsql_proc', detail: 'CREATE OR REPLACE PROCEDURE', insertText: 'CREATE OR REPLACE PROCEDURE ${1:name} IS\nBEGIN\n\t${0}\nEND;'},
    {
        label: 'merge',
        detail: 'MERGE INTO ... USING ... WHEN MATCHED/NOT MATCHED',
        insertText:
            'MERGE INTO ${1:target} t\nUSING ${2:source} s\nON (t.${3:id} = s.${3:id})\nWHEN MATCHED THEN\n\tUPDATE SET t.${4:column} = s.${4:column}\nWHEN NOT MATCHED THEN\n\tINSERT (${3:id}, ${4:column})\n\tVALUES (s.${3:id}, s.${4:column});',
    },
    {
        label: 'create_table',
        detail: 'CREATE TABLE (estilo Oracle)',
        insertText: 'CREATE TABLE ${1:table} (\n\t${2:id} NUMBER PRIMARY KEY,\n\t${3:name} VARCHAR2(100) NOT NULL\n);',
    },
    {
        label: 'cursor_loop',
        detail: 'FOR ... IN (SELECT ...) LOOP',
        insertText: 'FOR ${1:rec} IN (SELECT ${2:*} FROM ${3:table}) LOOP\n\t${0}\nEND LOOP;',
    },
    {label: 'explain_plan', detail: 'EXPLAIN PLAN FOR ...', insertText: "EXPLAIN PLAN FOR\n${1:SELECT * FROM table};\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);"},
]

const POSTGRES_SNIPPETS: Snippet[] = [
    {
        label: 'upsert',
        detail: 'INSERT ... ON CONFLICT DO UPDATE',
        insertText:
            'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nON CONFLICT (${4:key_column}) DO UPDATE\nSET ${5:column} = EXCLUDED.${5:column};',
    },
    {
        label: 'create_table',
        detail: 'CREATE TABLE (estilo Postgres)',
        insertText: 'CREATE TABLE ${1:table} (\n\t${2:id} SERIAL PRIMARY KEY,\n\t${3:name} TEXT NOT NULL\n);',
    },
    {
        label: 'cte',
        detail: 'WITH cte AS (...) SELECT ...',
        insertText: 'WITH ${1:cte} AS (\n\tSELECT ${2:*}\n\tFROM ${3:table}\n)\nSELECT * FROM ${1:cte};',
    },
    {
        label: 'plpgsql_function',
        detail: 'CREATE OR REPLACE FUNCTION ... LANGUAGE plpgsql',
        insertText:
            'CREATE OR REPLACE FUNCTION ${1:function_name}(${2:args})\nRETURNS ${3:void} AS $$\nBEGIN\n\t${0}\nEND;\n$$ LANGUAGE plpgsql;',
    },
    {
        label: 'window',
        detail: 'Función de ventana (ROW_NUMBER OVER ...)',
        insertText:
            'SELECT ${1:*},\n\tROW_NUMBER() OVER (PARTITION BY ${2:column} ORDER BY ${3:other_column}) AS ${4:row_num}\nFROM ${5:table};',
    },
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

            // No active connection yet (or sqlite, which has no engine-
            // specific list of its own) falls back to showing everything —
            // never suggest less than the pre-per-engine-filtering behavior.
            const dbType = getActiveDbType()
            const showOracle = dbType === 'oracle' || dbType == null || dbType === 'sqlite'
            const showPostgres = dbType === 'postgres' || dbType == null || dbType === 'sqlite'

            const functions = [
                ...(showOracle ? ORACLE_FUNCTIONS : []),
                ...(showPostgres ? POSTGRES_FUNCTIONS : []),
            ]
            const keywordItems = [...SQL_KEYWORDS, ...functions].map((kw) => ({
                label: kw,
                kind: monaco.languages.CompletionItemKind.Keyword,
                insertText: kw,
                range,
            }))

            const snippets = [
                ...GENERIC_SNIPPETS,
                ...(showOracle ? ORACLE_SNIPPETS : []),
                ...(showPostgres ? POSTGRES_SNIPPETS : []),
            ]
            const snippetItems = snippets.map((s) => ({
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
