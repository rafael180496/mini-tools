// Commit message helper: Conventional Commits types plus the ticket id the
// branch name already carries.
//
// The ticket part is the one that actually saves typing. A branch called
// feature/TIGOCHAT-11332-login already states which ticket the work belongs
// to, and re-typing it into every commit message is both tedious and the
// thing people forget — which is exactly when the traceability the
// convention exists for breaks.

export interface CommitTypeDef {
    value: string
    label: string
    hint: string
}

// The Conventional Commits set, with what each one is actually for. Kept
// short on purpose: a list of twenty types is a list nobody reads.
export const COMMIT_TYPES: CommitTypeDef[] = [
    {value: 'feat', label: 'feat — funcionalidad nueva', hint: 'Agrega una capacidad que antes no existía'},
    {value: 'fix', label: 'fix — corrección', hint: 'Arregla un comportamiento incorrecto'},
    {value: 'docs', label: 'docs — documentación', hint: 'Solo documentación, sin cambios de código'},
    {value: 'refactor', label: 'refactor — reestructura', hint: 'Cambia cómo está escrito sin cambiar qué hace'},
    {value: 'perf', label: 'perf — rendimiento', hint: 'Mejora de performance'},
    {value: 'test', label: 'test — pruebas', hint: 'Agrega o corrige pruebas'},
    {value: 'build', label: 'build — build/dependencias', hint: 'Sistema de compilación o dependencias'},
    {value: 'ci', label: 'ci — integración continua', hint: 'Configuración de pipelines'},
    {value: 'chore', label: 'chore — mantenimiento', hint: 'Tareas que no tocan código de producción'},
    {value: 'revert', label: 'revert — revierte', hint: 'Deshace un commit anterior'},
]

// Ticket patterns, most specific first.
//
// The JIRA-style form (LETTERS-123) is matched before a bare number so that
// "feature/PROJ-42" yields "PROJ-42" and not "42". The bare-number form
// requires a separator around it precisely so a branch like "release/2024"
// or "v2" does not produce a nonsense ticket id.
const TICKET_PATTERNS = [
    /\b([A-Z][A-Z0-9]+-\d+)\b/,
    /(?:^|[/_-])#?(\d{2,})(?:[/_-]|$)/,
]

// extractTicket pulls the issue id out of a branch name, or "" when there is
// none. The branch is upper-cased for the JIRA pattern only — a lower-case
// "tigochat-11332" is the same ticket, and people type branches both ways.
export function extractTicket(branch: string): string {
    if (!branch) return ''

    const upper = branch.toUpperCase()
    const jira = TICKET_PATTERNS[0].exec(upper)
    if (jira) return jira[1]

    const numeric = TICKET_PATTERNS[1].exec(branch)
    if (numeric) return numeric[1]

    return ''
}

// buildCommitPrefix assembles "type(scope): ". Scope is omitted when empty
// rather than emitted as "type(): ", which is not valid Conventional Commits
// and looks like a bug in the tool.
export function buildCommitPrefix(type: string, scope: string): string {
    if (!type) return ''
    const s = scope.trim()
    return s ? `${type}(${s}): ` : `${type}: `
}

// applyPrefix replaces an existing conventional prefix instead of stacking a
// second one — picking "fix" after "feat" should correct the message, not
// produce "fix: feat: …".
export function applyPrefix(message: string, prefix: string): string {
    const withoutOld = message.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    return prefix + withoutOld
}

// currentPrefixOf reports the type/scope already present in a message, so
// the controls can show what is actually there instead of resetting to a
// default every time the panel re-renders.
export function currentPrefixOf(message: string): {type: string; scope: string} {
    const m = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*/i.exec(message)
    if (!m) return {type: '', scope: ''}
    return {type: m[1].toLowerCase(), scope: m[2] ?? ''}
}
