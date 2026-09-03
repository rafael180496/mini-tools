// Tokenizador mínimo de SQL/PL-SQL para PINTAR texto ya ejecutado — el eco de
// cada statement en la consola de ejecución (components/results/ExecutionConsole.tsx).
//
// **Por qué no CodeMirror.** El editor ya resalta lo que se está escribiendo, y
// ahí hace falta un parser de verdad: autocompletado, plegado, linter, esquema.
// La consola es lo contrario — texto muerto, de solo lectura, y hasta 500
// entradas a la vez. Montar una instancia de CodeMirror por statement para
// pintar palabras clave cuesta órdenes de magnitud más que esto y no aporta
// nada que se pueda usar.
//
// **Qué NO hace, a propósito**: no valida, no entiende dialectos y no sabe de
// esquemas. Si un identificador se llama `select`, lo pinta como palabra clave.
// Es un resaltador, no un analizador: equivocarse en un color no cambia nada de
// lo que ya corrió.

export type SqlTokenKind =
    | 'keyword'
    | 'type'
    | 'string'
    | 'number'
    | 'comment'
    | 'bind'
    | 'operator'
    | 'plain'

export interface SqlToken {
    kind: SqlTokenKind
    text: string
}

// Palabras reservadas y de PL/SQL. La lista es deliberadamente corta: cubre lo
// que se escribe todos los días en Oracle/PostgreSQL/SQLite, no el estándar
// entero. Una palabra que falte se ve como texto normal, que es exactamente
// como se veía todo antes de esto.
const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'DISTINCT',
    'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'USING', 'MATCHED',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'UNION', 'ALL',
    'INTERSECT', 'MINUS', 'EXCEPT', 'WITH', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'ELSIF',
    'END', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'ANY',
    'CREATE', 'REPLACE', 'ALTER', 'DROP', 'TRUNCATE', 'TABLE', 'VIEW', 'INDEX', 'SEQUENCE',
    'TRIGGER', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'BODY', 'GRANT', 'REVOKE', 'SYNONYM',
    'PUBLIC', 'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'KEY', 'REFERENCES', 'UNIQUE', 'CHECK',
    'DEFAULT', 'ADD', 'MODIFY', 'RENAME', 'COLUMN', 'CASCADE', 'COMMENT',
    'DECLARE', 'BEGIN', 'EXCEPTION', 'RAISE', 'RETURN', 'RETURNING', 'LOOP', 'WHILE',
    'FOR', 'IF', 'CURSOR', 'OPEN', 'FETCH', 'CLOSE', 'EXIT', 'CONTINUE', 'GOTO',
    'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'EXEC', 'EXECUTE', 'IMMEDIATE', 'PRAGMA',
    'OUT', 'INOUT', 'NOCOPY', 'TO', 'OF', 'INDICES', 'REVERSE', 'DUAL',
    'OVER', 'PARTITION', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT',
    'LIMIT', 'OFFSET', 'FETCH', 'NEXT', 'ONLY', 'CONNECT', 'START', 'PRIOR', 'LEVEL',
])

// Tipos de dato: mismo color que las palabras clave los volvería indistinguibles
// en un DDL, que es justo donde más se los lee.
const TYPES = new Set([
    'NUMBER', 'INTEGER', 'INT', 'SMALLINT', 'BIGINT', 'DECIMAL', 'NUMERIC', 'FLOAT',
    'REAL', 'DOUBLE', 'PRECISION', 'VARCHAR', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR',
    'TEXT', 'CLOB', 'NCLOB', 'BLOB', 'RAW', 'LONG', 'DATE', 'TIMESTAMP', 'INTERVAL',
    'BOOLEAN', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'ROWID', 'UROWID', 'XMLTYPE', 'JSON',
    'PLS_INTEGER', 'BINARY_INTEGER', 'RECORD', 'REF', 'ROWTYPE', 'TYPE', 'SERIAL', 'UUID',
])

const IDENT_START = /[A-Za-z_$#]/
const IDENT_PART = /[A-Za-z0-9_$#]/
const OPERATOR = /[+\-*/%<>=!|,;().[\]:]/

// Techo de tamaño: un script pegado de un dump puede traer un statement de
// megabytes, y tokenizarlo para pintarlo sería gastar el hilo principal en algo
// que nadie lee entero. Por encima de esto se devuelve el texto tal cual, que
// es lo que se mostraba antes.
const MAX_HIGHLIGHT_CHARS = 20000

export function highlightSql(text: string): SqlToken[] {
    if (!text) return []
    if (text.length > MAX_HIGHLIGHT_CHARS) return [{kind: 'plain', text}]

    const out: SqlToken[] = []
    // Los tokens contiguos del mismo tipo se juntan en uno: pintar palabra por
    // palabra generaría miles de <span> por entrada.
    const push = (kind: SqlTokenKind, value: string) => {
        const last = out[out.length - 1]
        if (last && last.kind === kind) last.text += value
        else out.push({kind, text: value})
    }

    let i = 0
    while (i < text.length) {
        const c = text[i]

        // Comentario de línea.
        if (c === '-' && text[i + 1] === '-') {
            const end = text.indexOf('\n', i)
            const stop = end === -1 ? text.length : end
            push('comment', text.slice(i, stop))
            i = stop
            continue
        }

        // Comentario de bloque. Uno sin cerrar se pinta hasta el final en vez
        // de descartarse: el texto se muestra completo siempre.
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2)
            const stop = end === -1 ? text.length : end + 2
            push('comment', text.slice(i, stop))
            i = stop
            continue
        }

        // Literal de texto. La comilla doblada ('') es escape en SQL, no fin de
        // cadena — tratarla como cierre desalinearía el resto de la línea.
        if (c === "'") {
            let j = i + 1
            while (j < text.length) {
                if (text[j] === "'") {
                    if (text[j + 1] === "'") j += 2
                    else {
                        j += 1
                        break
                    }
                } else j += 1
            }
            push('string', text.slice(i, j))
            i = j
            continue
        }

        // Identificador entrecomillado ("MI_TABLA"): es un nombre, no un
        // literal, así que va como texto normal y no como cadena.
        if (c === '"') {
            const end = text.indexOf('"', i + 1)
            const stop = end === -1 ? text.length : end + 1
            push('plain', text.slice(i, stop))
            i = stop
            continue
        }

        // Parámetro bind: `:1`, `:p_fecha`, `?`. Se pinta distinto porque es lo
        // único del statement que NO es literal — saber qué se mandó por bind
        // es media explicación de un ORA-01843.
        if ((c === ':' && IDENT_START.test(text[i + 1] ?? '')) || (c === ':' && /[0-9]/.test(text[i + 1] ?? ''))) {
            let j = i + 1
            while (j < text.length && IDENT_PART.test(text[j])) j += 1
            push('bind', text.slice(i, j))
            i = j
            continue
        }
        if (c === '?') {
            push('bind', c)
            i += 1
            continue
        }

        if (/[0-9]/.test(c)) {
            let j = i
            while (j < text.length && /[0-9.]/.test(text[j])) j += 1
            push('number', text.slice(i, j))
            i = j
            continue
        }

        if (IDENT_START.test(c)) {
            let j = i
            while (j < text.length && IDENT_PART.test(text[j])) j += 1
            const word = text.slice(i, j)
            const upper = word.toUpperCase()
            push(KEYWORDS.has(upper) ? 'keyword' : TYPES.has(upper) ? 'type' : 'plain', word)
            i = j
            continue
        }

        if (OPERATOR.test(c)) {
            push('operator', c)
            i += 1
            continue
        }

        push('plain', c)
        i += 1
    }

    return out
}

// Clases del sistema de diseño por tipo de token (ver .claude/specs/design-system.md):
// solo tokens semánticos, así que el resaltado sigue el tema claro/oscuro sin
// una segunda paleta.
export const SQL_TOKEN_CLASS: Record<SqlTokenKind, string> = {
    keyword: 'text-primary font-semibold',
    type: 'text-secondary',
    string: 'text-tertiary',
    number: 'text-tertiary',
    comment: 'text-on-surface-variant/70 italic',
    bind: 'text-secondary font-semibold',
    operator: 'text-on-surface-variant',
    plain: 'text-on-surface',
}
