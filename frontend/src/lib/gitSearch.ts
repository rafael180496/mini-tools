// Parser for the commit graph's search bar.
//
// The bar takes "angelo", "author:angelo message:fix file:AGENTS.md
// since:2024-01-01" or any mix, and turns it into git log flags. Everything
// it produces is applied BY GIT, not by filtering the page on screen: the
// graph pages a few hundred commits at a time, so a client-side filter
// would only ever search what happens to be loaded — which reads as "the
// search is broken" the first time a match sits one page back.
//
// Bare words (no prefix) go to the message filter, because that is what
// people type when they type anything at all.

export interface GitSearch {
    author: string
    grep: string
    path: string
    since: string
    until: string
    // rev is a hash, tag or branch typed as "hash:abc123" or recognised as a
    // bare hex string — it narrows the walk to that commit's ancestry.
    rev: string
}

export const EMPTY_SEARCH: GitSearch = {author: '', grep: '', path: '', since: '', until: '', rev: ''}

// Prefixes accepted, with the Spanish aliases people actually reach for.
const FIELDS: Record<string, keyof GitSearch> = {
    author: 'author',
    autor: 'author',
    message: 'grep',
    mensaje: 'grep',
    msg: 'grep',
    file: 'path',
    archivo: 'path',
    path: 'path',
    since: 'since',
    desde: 'since',
    until: 'until',
    hasta: 'until',
    hash: 'rev',
    commit: 'rev',
    rev: 'rev',
}

// A bare token of 7-40 hex characters is a commit hash, not a word somebody
// meant to search messages for. Below 7 it is too likely to be a real word
// ("added", "deface"), which is also why git itself uses 7 as its short-hash
// floor.
const BARE_HASH = /^[0-9a-f]{7,40}$/i

export function parseGitSearch(raw: string): GitSearch {
    const out: GitSearch = {...EMPTY_SEARCH}
    const bare: string[] = []

    for (const token of tokenize(raw)) {
        const idx = token.indexOf(':')
        if (idx > 0) {
            const key = token.slice(0, idx).toLowerCase()
            const value = token.slice(idx + 1).trim()
            const field = FIELDS[key]
            if (field && value !== '') {
                // Repeating a prefix appends rather than replaces, so
                // "author:ana author:beto" is not silently just "beto" —
                // though git treats multiple --author as OR only with
                // --all-match off, which is its default and what we want.
                out[field] = out[field] ? `${out[field]} ${value}` : value
                continue
            }
        }
        bare.push(token)
    }

    const rest = bare.join(' ').trim()
    if (rest !== '') {
        if (!out.rev && BARE_HASH.test(rest)) out.rev = rest
        else out.grep = out.grep ? `${out.grep} ${rest}` : rest
    }

    return out
}

// tokenize splits on whitespace but keeps quoted runs together, so
// message:"fix login" works.
function tokenize(raw: string): string[] {
    const out: string[] = []
    let current = ''
    let quote: string | null = null

    for (const ch of raw) {
        if (quote) {
            if (ch === quote) quote = null
            else current += ch
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === ' ' || ch === '\t') {
            if (current !== '') out.push(current)
            current = ''
            continue
        }
        current += ch
    }
    if (current !== '') out.push(current)
    return out
}

export function isEmptySearch(s: GitSearch): boolean {
    return !s.author && !s.grep && !s.path && !s.since && !s.until && !s.rev
}

// describeSearch is the human summary shown under the bar, so it is obvious
// what the graph is actually filtered by — a search that silently narrows
// history is how people conclude a commit "disappeared".
export function describeSearch(s: GitSearch): string {
    const parts: string[] = []
    if (s.author) parts.push(`autor «${s.author}»`)
    if (s.grep) parts.push(`mensaje «${s.grep}»`)
    if (s.path) parts.push(`que tocan «${s.path}»`)
    if (s.rev) parts.push(`desde ${s.rev}`)
    if (s.since) parts.push(`después de ${s.since}`)
    if (s.until) parts.push(`antes de ${s.until}`)
    return parts.join(' · ')
}

export const GIT_SEARCH_HELP = [
    'autor:angelo — commits de ese autor (también author:)',
    'mensaje:feat — busca en el mensaje (también message:, msg:)',
    'archivo:AGENTS.md — solo los commits que tocaron ese archivo (también file:)',
    'desde:2024-01-01 · hasta:"2 weeks ago" — rango de fechas (también since:/until:)',
    'hash:a1b2c3d — la historia a partir de ese commit',
    'Sin prefijo busca en el mensaje; un hash suelto de 7+ caracteres se detecta solo.',
].join('\n')
