import {StreamLanguage, LanguageSupport, type StreamParser} from '@codemirror/language'
import {snippetCompletion, type CompletionSource, type CompletionResult} from '@codemirror/autocomplete'
import {hoverTooltip} from '@codemirror/view'
import {getActiveRedisKeys} from './redisKeysStore'
import {t} from '../i18n'

// Direct port of the retired frontend/src/monaco/redisLanguage.ts — same
// command list, same firstArgIsKey completion logic, same doc comment
// reasoning for what's excluded (MULTI/EXEC/WATCH/DISCARD/SUBSCRIBE/
// PSUBSCRIBE, see .claude/skills/mini-tools-patterns/SKILL.md's Redis
// section). Only the API surface changes: CodeMirror has no
// basic-languages/redis contribution either, so this hand-writes a
// StreamLanguage tokenizer, a CompletionSource, and a hoverTooltip in
// place of Monaco's Monarch tokenizer + registerCompletionItemProvider +
// registerHoverProvider.

// The description of each command lives in the dictionary
// (t().redis.commands.<NAME>) and is read when the completion list or the
// tooltip is built, never frozen here: this table is module-level.
interface RedisCommand {
    name: string
    snippet: string
    // True for commands whose FIRST argument is a key name — GET/SET/DEL/
    // etc. Drives the second-token completion branch below. False (or
    // omitted) for commands with no key argument at all (PING, SELECT,
    // FLUSHDB/FLUSHALL) or whose first argument isn't a key.
    firstArgIsKey?: boolean
}

const REDIS_COMMANDS: RedisCommand[] = [
    {name: 'GET', snippet: 'GET ${1:key}', firstArgIsKey: true},
    {name: 'SET', snippet: 'SET ${1:key} ${2:value}', firstArgIsKey: true},
    {name: 'DEL', snippet: 'DEL ${1:key}', firstArgIsKey: true},
    {name: 'EXISTS', snippet: 'EXISTS ${1:key}', firstArgIsKey: true},
    {name: 'EXPIRE', snippet: 'EXPIRE ${1:key} ${2:seconds}', firstArgIsKey: true},
    {name: 'TTL', snippet: 'TTL ${1:key}', firstArgIsKey: true},
    {name: 'PERSIST', snippet: 'PERSIST ${1:key}', firstArgIsKey: true},
    {name: 'TYPE', snippet: 'TYPE ${1:key}', firstArgIsKey: true},
    {name: 'SCAN', snippet: 'SCAN ${1:0} MATCH ${2:*}'},
    {name: 'HGET', snippet: 'HGET ${1:key} ${2:field}', firstArgIsKey: true},
    {name: 'HSET', snippet: 'HSET ${1:key} ${2:field} ${3:value}', firstArgIsKey: true},
    {name: 'HGETALL', snippet: 'HGETALL ${1:key}', firstArgIsKey: true},
    {name: 'HDEL', snippet: 'HDEL ${1:key} ${2:field}', firstArgIsKey: true},
    {name: 'HKEYS', snippet: 'HKEYS ${1:key}', firstArgIsKey: true},
    {name: 'HVALS', snippet: 'HVALS ${1:key}', firstArgIsKey: true},
    {name: 'LPUSH', snippet: 'LPUSH ${1:key} ${2:value}', firstArgIsKey: true},
    {name: 'RPUSH', snippet: 'RPUSH ${1:key} ${2:value}', firstArgIsKey: true},
    {name: 'LPOP', snippet: 'LPOP ${1:key}', firstArgIsKey: true},
    {name: 'RPOP', snippet: 'RPOP ${1:key}', firstArgIsKey: true},
    {name: 'LRANGE', snippet: 'LRANGE ${1:key} ${2:0} ${3:-1}', firstArgIsKey: true},
    {name: 'LLEN', snippet: 'LLEN ${1:key}', firstArgIsKey: true},
    {name: 'SADD', snippet: 'SADD ${1:key} ${2:member}', firstArgIsKey: true},
    {name: 'SREM', snippet: 'SREM ${1:key} ${2:member}', firstArgIsKey: true},
    {name: 'SMEMBERS', snippet: 'SMEMBERS ${1:key}', firstArgIsKey: true},
    {name: 'SISMEMBER', snippet: 'SISMEMBER ${1:key} ${2:member}', firstArgIsKey: true},
    {name: 'ZADD', snippet: 'ZADD ${1:key} ${2:score} ${3:member}', firstArgIsKey: true},
    {name: 'ZRANGE', snippet: 'ZRANGE ${1:key} ${2:0} ${3:-1} WITHSCORES', firstArgIsKey: true},
    {name: 'ZSCORE', snippet: 'ZSCORE ${1:key} ${2:member}', firstArgIsKey: true},
    {name: 'ZREM', snippet: 'ZREM ${1:key} ${2:member}', firstArgIsKey: true},
    {name: 'INCR', snippet: 'INCR ${1:key}', firstArgIsKey: true},
    {name: 'DECR', snippet: 'DECR ${1:key}', firstArgIsKey: true},
    {name: 'INCRBY', snippet: 'INCRBY ${1:key} ${2:amount}', firstArgIsKey: true},
    {name: 'APPEND', snippet: 'APPEND ${1:key} ${2:value}', firstArgIsKey: true},
    {name: 'STRLEN', snippet: 'STRLEN ${1:key}', firstArgIsKey: true},
    {name: 'RENAME', snippet: 'RENAME ${1:key} ${2:newkey}', firstArgIsKey: true},
    {name: 'PING', snippet: 'PING'},
    {name: 'SELECT', snippet: 'SELECT ${1:0}'},
    {name: 'FLUSHDB', snippet: 'FLUSHDB'},
    {name: 'FLUSHALL', snippet: 'FLUSHALL'},
    // RediSearch — first arg is an index name, not a key (firstArgIsKey
    // omitted on purpose for all of these).
    {name: 'FT.SEARCH', snippet: 'FT.SEARCH ${1:index} ${2:query}'},
    {name: 'FT.AGGREGATE', snippet: 'FT.AGGREGATE ${1:index} ${2:query}'},
    {name: 'FT.CREATE', snippet: 'FT.CREATE ${1:index} ON ${2:HASH} PREFIX 1 ${3:prefix:} SCHEMA ${4:field} ${5:TEXT}'},
    {name: 'FT.INFO', snippet: 'FT.INFO ${1:index}'},
    {name: 'FT.DROPINDEX', snippet: 'FT.DROPINDEX ${1:index}'},
    // RedisJSON — first arg is a key, like the core data-structure commands.
    {name: 'JSON.SET', snippet: 'JSON.SET ${1:key} ${2:$} ${3:value}', firstArgIsKey: true},
    {name: 'JSON.GET', snippet: 'JSON.GET ${1:key}', firstArgIsKey: true},
    {name: 'JSON.DEL', snippet: 'JSON.DEL ${1:key}', firstArgIsKey: true},
    {name: 'JSON.TYPE', snippet: 'JSON.TYPE ${1:key}', firstArgIsKey: true},
    {name: 'JSON.ARRAPPEND', snippet: 'JSON.ARRAPPEND ${1:key} ${2:$} ${3:value}', firstArgIsKey: true},
    {name: 'JSON.ARRLEN', snippet: 'JSON.ARRLEN ${1:key}', firstArgIsKey: true},
    {name: 'JSON.OBJKEYS', snippet: 'JSON.OBJKEYS ${1:key}', firstArgIsKey: true},
    {name: 'JSON.STRLEN', snippet: 'JSON.STRLEN ${1:key}', firstArgIsKey: true},
    {name: 'JSON.NUMINCRBY', snippet: 'JSON.NUMINCRBY ${1:key} ${2:$} ${3:amount}', firstArgIsKey: true},
    {name: 'JSON.MERGE', snippet: 'JSON.MERGE ${1:key} ${2:$} ${3:value}', firstArgIsKey: true},
    {name: 'JSON.CLEAR', snippet: 'JSON.CLEAR ${1:key}', firstArgIsKey: true},
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

const COMMAND_NAMES = new Set(REDIS_COMMANDS.map((c) => c.name))

function commandDetail(name: string): string {
    return (t().redis.commands as Record<string, string>)[name] ?? ''
}

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
            options: REDIS_COMMANDS.map((c) => snippetCompletion(c.snippet, {label: c.name, type: 'function', detail: commandDetail(c.name)})),
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

    const command = REDIS_COMMANDS.find((c) => c.name === commandName)
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

    const command = REDIS_COMMANDS.find((c) => c.name === text.slice(start - from, end - from).toUpperCase())
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
            dom.textContent = `${stripSnippetPlaceholders(command.snippet)}\n${commandDetail(command.name)}`
            return {dom}
        },
    }
})

export function redisCli(): LanguageSupport {
    return new LanguageSupport(redisCliLanguage, [redisCliLanguage.data.of({autocomplete: redisCompletionSource}), redisHover])
}
