// Lets any search/filter box in the app accept either a plain substring
// (auto-wrapped for "contains" matching, the behavior every filter already
// had implicitly) or explicit SQL LIKE-style wildcards (% / _), translated
// to whatever the target actually needs: a case-insensitive RegExp for a
// client-side filter (ConnectionTree's table/schema search), or a Redis
// SCAN MATCH glob (* / ?) for RedisKeyTree's key search — which previously
// required typing the raw glob syntax by hand. Already-glob input (*, ?,
// [...]) is respected as-is, never double-translated.

const LIKE_WILDCARD_RE = /[%_]/
const GLOB_WILDCARD_RE = /[*?[\]]/

function escapeRegExp(s: string): string {
    return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

// For client-side substring filters (table/schema search). A plain term
// matches anywhere in the string (same "contains" behavior these filters
// already had); '%'/'_' follow SQL LIKE semantics (% = any run of
// characters, _ = exactly one); '*'/'?' are treated the same way, for
// anyone used to glob syntax instead.
export function likeToRegExp(term: string): RegExp {
    const trimmed = term.trim()
    if (!trimmed) return /.*/i

    if (LIKE_WILDCARD_RE.test(trimmed) || GLOB_WILDCARD_RE.test(trimmed)) {
        const pattern = escapeRegExp(trimmed).replace(/%|\*/g, '.*').replace(/_|\?/g, '.')
        return new RegExp(pattern, 'i')
    }
    return new RegExp(escapeRegExp(trimmed), 'i')
}

// For Redis SCAN MATCH (glob syntax: * ? [abc]). A plain term auto-wraps as
// "*term*" (substring-style, matching what LIKE users expect); '%'/'_' map
// to Redis's own '*'/'?'; already-glob input passes through unchanged.
export function likeToRedisGlob(term: string): string {
    const trimmed = term.trim()
    if (!trimmed) return '*'
    if (GLOB_WILDCARD_RE.test(trimmed)) return trimmed
    if (LIKE_WILDCARD_RE.test(trimmed)) return trimmed.replace(/%/g, '*').replace(/_/g, '?')
    return `*${trimmed}*`
}
