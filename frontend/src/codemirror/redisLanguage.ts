import {StreamLanguage, LanguageSupport, type StreamParser} from '@codemirror/language'
import {snippetCompletion, type CompletionSource, type CompletionResult} from '@codemirror/autocomplete'
import {hoverTooltip} from '@codemirror/view'
import {getActiveRedisKeys} from './redisKeysStore'

// Direct port of the retired frontend/src/monaco/redisLanguage.ts — same
// command list, same firstArgIsKey completion logic, same doc comment
// reasoning for what's excluded (MULTI/EXEC/WATCH/DISCARD/SUBSCRIBE/
// PSUBSCRIBE, see .claude/skills/mini-tools-patterns/SKILL.md's Redis
// section). Only the API surface changes: CodeMirror has no
// basic-languages/redis contribution either, so this hand-writes a
// StreamLanguage tokenizer, a CompletionSource, and a hoverTooltip in
// place of Monaco's Monarch tokenizer + registerCompletionItemProvider +
// registerHoverProvider.

interface RedisCommand {
    label: string
    detail: string
    insertText: string
    // True for commands whose FIRST argument is a key name — GET/SET/DEL/
    // etc. Drives the second-token completion branch below. False (or
    // omitted) for commands with no key argument at all (PING, SELECT,
    // FLUSHDB/FLUSHALL) or whose first argument isn't a key.
    firstArgIsKey?: boolean
}

const REDIS_COMMANDS: RedisCommand[] = [
    {label: 'GET', detail: 'Obtiene el valor de una key tipo string', insertText: 'GET ${1:key}', firstArgIsKey: true},
    {label: 'SET', detail: 'Asigna el valor de una key tipo string', insertText: 'SET ${1:key} ${2:value}', firstArgIsKey: true},
    {label: 'DEL', detail: 'Elimina una o más keys', insertText: 'DEL ${1:key}', firstArgIsKey: true},
    {label: 'EXISTS', detail: 'Chequea si una key existe', insertText: 'EXISTS ${1:key}', firstArgIsKey: true},
    {label: 'EXPIRE', detail: 'Setea un TTL (segundos) sobre una key', insertText: 'EXPIRE ${1:key} ${2:seconds}', firstArgIsKey: true},
    {
        label: 'TTL',
        detail: 'Tiempo de vida restante en segundos (-1 sin expirar, -2 no existe)',
        insertText: 'TTL ${1:key}',
        firstArgIsKey: true,
    },
    {label: 'PERSIST', detail: 'Quita el TTL de una key (la vuelve permanente)', insertText: 'PERSIST ${1:key}', firstArgIsKey: true},
    {
        label: 'TYPE',
        detail: 'Tipo de dato de una key (string/hash/list/set/zset/stream)',
        insertText: 'TYPE ${1:key}',
        firstArgIsKey: true,
    },
    {label: 'SCAN', detail: 'Recorre el keyspace de forma incremental (nunca usar KEYS *)', insertText: 'SCAN ${1:0} MATCH ${2:*}'},
    {label: 'HGET', detail: 'Obtiene un field de un hash', insertText: 'HGET ${1:key} ${2:field}', firstArgIsKey: true},
    {label: 'HSET', detail: 'Asigna un field de un hash', insertText: 'HSET ${1:key} ${2:field} ${3:value}', firstArgIsKey: true},
    {label: 'HGETALL', detail: 'Todos los field/value de un hash', insertText: 'HGETALL ${1:key}', firstArgIsKey: true},
    {label: 'HDEL', detail: 'Elimina un field de un hash', insertText: 'HDEL ${1:key} ${2:field}', firstArgIsKey: true},
    {label: 'HKEYS', detail: 'Todos los fields de un hash', insertText: 'HKEYS ${1:key}', firstArgIsKey: true},
    {label: 'HVALS', detail: 'Todos los values de un hash', insertText: 'HVALS ${1:key}', firstArgIsKey: true},
    {label: 'LPUSH', detail: 'Inserta un valor al principio de una list', insertText: 'LPUSH ${1:key} ${2:value}', firstArgIsKey: true},
    {label: 'RPUSH', detail: 'Inserta un valor al final de una list', insertText: 'RPUSH ${1:key} ${2:value}', firstArgIsKey: true},
    {label: 'LPOP', detail: 'Remueve y devuelve el primer elemento de una list', insertText: 'LPOP ${1:key}', firstArgIsKey: true},
    {label: 'RPOP', detail: 'Remueve y devuelve el último elemento de una list', insertText: 'RPOP ${1:key}', firstArgIsKey: true},
    {
        label: 'LRANGE',
        detail: 'Rango de elementos de una list (0 -1 = todos)',
        insertText: 'LRANGE ${1:key} ${2:0} ${3:-1}',
        firstArgIsKey: true,
    },
    {label: 'LLEN', detail: 'Cantidad de elementos de una list', insertText: 'LLEN ${1:key}', firstArgIsKey: true},
    {label: 'SADD', detail: 'Agrega un member a un set', insertText: 'SADD ${1:key} ${2:member}', firstArgIsKey: true},
    {label: 'SREM', detail: 'Quita un member de un set', insertText: 'SREM ${1:key} ${2:member}', firstArgIsKey: true},
    {label: 'SMEMBERS', detail: 'Todos los members de un set', insertText: 'SMEMBERS ${1:key}', firstArgIsKey: true},
    {
        label: 'SISMEMBER',
        detail: 'Chequea si un member pertenece a un set',
        insertText: 'SISMEMBER ${1:key} ${2:member}',
        firstArgIsKey: true,
    },
    {
        label: 'ZADD',
        detail: 'Agrega un member con score a un sorted set',
        insertText: 'ZADD ${1:key} ${2:score} ${3:member}',
        firstArgIsKey: true,
    },
    {
        label: 'ZRANGE',
        detail: 'Rango de members de un sorted set por posición',
        insertText: 'ZRANGE ${1:key} ${2:0} ${3:-1} WITHSCORES',
        firstArgIsKey: true,
    },
    {label: 'ZSCORE', detail: 'Score de un member en un sorted set', insertText: 'ZSCORE ${1:key} ${2:member}', firstArgIsKey: true},
    {label: 'ZREM', detail: 'Quita un member de un sorted set', insertText: 'ZREM ${1:key} ${2:member}', firstArgIsKey: true},
    {label: 'INCR', detail: 'Incrementa en 1 una key numérica', insertText: 'INCR ${1:key}', firstArgIsKey: true},
    {label: 'DECR', detail: 'Decrementa en 1 una key numérica', insertText: 'DECR ${1:key}', firstArgIsKey: true},
    {label: 'INCRBY', detail: 'Incrementa una key numérica en un monto', insertText: 'INCRBY ${1:key} ${2:amount}', firstArgIsKey: true},
    {label: 'APPEND', detail: 'Concatena texto al final de una key string', insertText: 'APPEND ${1:key} ${2:value}', firstArgIsKey: true},
    {label: 'STRLEN', detail: 'Largo del valor de una key string', insertText: 'STRLEN ${1:key}', firstArgIsKey: true},
    {label: 'RENAME', detail: 'Renombra una key', insertText: 'RENAME ${1:key} ${2:newkey}', firstArgIsKey: true},
    {label: 'PING', detail: 'Verifica que el servidor responde', insertText: 'PING'},
    {label: 'SELECT', detail: 'Cambia la base lógica (0-15) de la conexión actual', insertText: 'SELECT ${1:0}'},
    {
        label: 'FLUSHDB',
        detail: 'Destructivo: borra TODAS las keys de la base lógica actual, sin confirmación de Redis',
        insertText: 'FLUSHDB',
    },
    {
        label: 'FLUSHALL',
        detail: 'Destructivo: borra TODAS las keys de TODAS las bases lógicas, sin confirmación de Redis',
        insertText: 'FLUSHALL',
    },
    // RediSearch — first arg is an index name, not a key (firstArgIsKey
    // omitted on purpose for all of these).
    {label: 'FT.SEARCH', detail: 'Busca documentos en un índice de RediSearch', insertText: 'FT.SEARCH ${1:index} ${2:query}'},
    {
        label: 'FT.AGGREGATE',
        detail: 'Agrupa/transforma resultados de un índice de RediSearch',
        insertText: 'FT.AGGREGATE ${1:index} ${2:query}',
    },
    {
        label: 'FT.CREATE',
        detail: 'Crea un índice de RediSearch',
        insertText: 'FT.CREATE ${1:index} ON ${2:HASH} PREFIX 1 ${3:prefix:} SCHEMA ${4:field} ${5:TEXT}',
    },
    {label: 'FT.INFO', detail: 'Información y estadísticas de un índice', insertText: 'FT.INFO ${1:index}'},
    {label: 'FT.DROPINDEX', detail: 'Elimina un índice (no borra los documentos, salvo DD)', insertText: 'FT.DROPINDEX ${1:index}'},
    // RedisJSON — first arg is a key, like the core data-structure commands.
    {
        label: 'JSON.SET',
        detail: 'Asigna un valor JSON en una key (RedisJSON)',
        insertText: 'JSON.SET ${1:key} ${2:$} ${3:value}',
        firstArgIsKey: true,
    },
    {label: 'JSON.GET', detail: 'Obtiene el valor JSON de una key', insertText: 'JSON.GET ${1:key}', firstArgIsKey: true},
    {
        label: 'JSON.DEL',
        detail: 'Elimina una key, o un path dentro de un documento JSON',
        insertText: 'JSON.DEL ${1:key}',
        firstArgIsKey: true,
    },
    {label: 'JSON.TYPE', detail: 'Tipo del valor JSON en un path', insertText: 'JSON.TYPE ${1:key}', firstArgIsKey: true},
    {
        label: 'JSON.ARRAPPEND',
        detail: 'Agrega elementos al final de un array JSON',
        insertText: 'JSON.ARRAPPEND ${1:key} ${2:$} ${3:value}',
        firstArgIsKey: true,
    },
    {label: 'JSON.ARRLEN', detail: 'Cantidad de elementos de un array JSON', insertText: 'JSON.ARRLEN ${1:key}', firstArgIsKey: true},
    {label: 'JSON.OBJKEYS', detail: 'Nombres de los campos de un objeto JSON', insertText: 'JSON.OBJKEYS ${1:key}', firstArgIsKey: true},
    {
        label: 'JSON.STRLEN',
        detail: 'Largo de un valor string dentro de un documento JSON',
        insertText: 'JSON.STRLEN ${1:key}',
        firstArgIsKey: true,
    },
    {
        label: 'JSON.NUMINCRBY',
        detail: 'Incrementa un valor numérico dentro de un documento JSON',
        insertText: 'JSON.NUMINCRBY ${1:key} ${2:$} ${3:amount}',
        firstArgIsKey: true,
    },
    {
        label: 'JSON.MERGE',
        detail: 'Combina (RFC 7396 merge patch) un valor dentro de un documento JSON',
        insertText: 'JSON.MERGE ${1:key} ${2:$} ${3:value}',
        firstArgIsKey: true,
    },
    {
        label: 'JSON.CLEAR',
        detail: 'Vacía arrays/objetos, o pone en 0 valores numéricos, en un path',
        insertText: 'JSON.CLEAR ${1:key}',
        firstArgIsKey: true,
    },
]

// FT.SEARCH/FT.AGGREGATE's query modifier clauses — suggested as plain
// keyword completions once the index+query arguments look complete (see
// redisCompletionSource below), not exhaustive (matches this file's
// existing "core commands, not every flag" scope for the base command
// list too).
const FT_SEARCH_MODIFIERS = [
    'SORTBY',
    'LIMIT',
    'RETURN',
    'FILTER',
    'GEOFILTER',
    'INFIELDS',
    'INKEYS',
    'INORDER',
    'LANGUAGE',
    'EXPANDER',
    'SCORER',
    'EXPLAINSCORE',
    'DIALECT',
    'HIGHLIGHT',
    'ASC',
    'DESC',
]

const COMMAND_NAMES = new Set(REDIS_COMMANDS.map((c) => c.label))

// "SET ${1:key} ${2:value}" → "SET key value" — a clean one-line syntax
// reminder for the hover tooltip, reusing the same snippet text instead of
// maintaining a second copy of each command's syntax.
function stripSnippetPlaceholders(insertText: string): string {
    return insertText.replace(/\$\{\d+:([^}]*)\}/g, '$1')
}

const redisStreamParser: StreamParser<null> = {
    token(stream) {
        if (stream.sol() && stream.match(/^\s*#.*$/)) return 'comment'
        if (stream.eatSpace()) return null
        if (stream.match(/^"([^"\\]|\\.)*"/) || stream.match(/^'([^'\\]|\\.)*'/)) return 'string'
        if (stream.match(/^-?\d+(\.\d+)?/)) return 'number'
        if (stream.match(/^[A-Za-z_][A-Za-z0-9_.]*/)) {
            return COMMAND_NAMES.has(stream.current().toUpperCase()) ? 'keyword' : 'variableName'
        }
        stream.next()
        return null
    },
}

export const redisCliLanguage = StreamLanguage.define(redisStreamParser)

// Mirrors Monaco's provideCompletionItems: still typing the first token
// (the command name) suggests every command as a snippet (CodeMirror's
// `${1:key}`/`${2:value}` snippet placeholder syntax is identical to
// Monaco's, so the same insertText templates work unchanged via
// snippetCompletion). Past the first space, only commands whose first
// argument is a key (firstArgIsKey) get a second-token suggestion list,
// filtered against whatever RedisKeyTree.tsx has already scanned for the
// active tab's connection (redisKeysStore.ts, read live on every
// keystroke — same as Monaco's provider did, never cached at
// registration time).
const redisCompletionSource: CompletionSource = (context): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const beforeCursor = line.text.slice(0, context.pos - line.from)
    const trimmedBefore = beforeCursor.replace(/^\s+/, '')

    if (!/\s/.test(trimmedBefore)) {
        const wordMatch = context.matchBefore(/[A-Za-z_][A-Za-z0-9_.]*/)
        return {
            from: wordMatch ? wordMatch.from : context.pos,
            options: REDIS_COMMANDS.map((c) => snippetCompletion(c.insertText, {label: c.label, type: 'function', detail: c.detail})),
            validFor: /^[A-Za-z_][A-Za-z0-9_.]*$/,
        }
    }

    const firstSpace = trimmedBefore.search(/\s/)
    const commandName = trimmedBefore.slice(0, firstSpace).toUpperCase()
    const restAfterCommand = trimmedBefore.slice(firstSpace).replace(/^\s+/, '')

    // FT.SEARCH/FT.AGGREGATE: once the index + query arguments look
    // complete, suggest the query's modifier clauses as plain-text keyword
    // completions — not the checkbox-grid widget RedisInsight's own UI
    // shows (a custom widget outside CodeMirror's completion model), but
    // the same practical result. Best-effort, whitespace-only tokenization
    // here (no quote-awareness) — a quoted multi-word query can trigger
    // this a little early, same tolerance this app's other hand-rolled
    // parsers already accept (see lib/linter.ts).
    if (commandName === 'FT.SEARCH' || commandName === 'FT.AGGREGATE') {
        if (/^\S+\s+\S+\s/.test(restAfterCommand)) {
            const wordMatch = context.matchBefore(/[A-Za-z_]*/)
            return {
                from: wordMatch ? wordMatch.from : context.pos,
                options: FT_SEARCH_MODIFIERS.map((m) => ({label: m, type: 'keyword'})),
                validFor: /^[A-Za-z_]*$/,
            }
        }
    }

    if (/\s/.test(restAfterCommand)) return null

    const command = REDIS_COMMANDS.find((c) => c.label === commandName)
    if (!command?.firstArgIsKey) return null

    const typed = restAfterCommand.toLowerCase()
    const keys = getActiveRedisKeys().filter((k) => !typed || k.toLowerCase().includes(typed))
    if (keys.length === 0) return null

    return {
        from: context.pos - restAfterCommand.length,
        options: keys.map((k) => ({label: k, type: 'text'})),
        validFor: /^\S*$/,
    }
}

const redisHover = hoverTooltip((view, pos) => {
    const {from, to, text} = view.state.doc.lineAt(pos)
    let start = pos
    let end = pos
    while (start > from && /\w/.test(text[start - from - 1])) start--
    while (end < to && /\w/.test(text[end - from])) end++
    if (start === end) return null

    const command = REDIS_COMMANDS.find((c) => c.label === text.slice(start - from, end - from).toUpperCase())
    if (!command) return null

    return {
        pos: start,
        end,
        above: true,
        create() {
            const dom = document.createElement('div')
            dom.style.padding = '6px 8px'
            dom.style.font = '12px var(--font-mono)'
            dom.style.background = 'var(--color-surface-container-high)'
            dom.style.color = 'var(--color-on-surface)'
            dom.style.border = '1px solid var(--color-outline-variant)'
            dom.style.borderRadius = '6px'
            dom.style.maxWidth = '360px'
            dom.style.whiteSpace = 'pre-wrap'
            dom.textContent = `${stripSnippetPlaceholders(command.insertText)}\n${command.detail}`
            return {dom}
        },
    }
})

export function redisCli(): LanguageSupport {
    return new LanguageSupport(redisCliLanguage, [redisCliLanguage.data.of({autocomplete: redisCompletionSource}), redisHover])
}
