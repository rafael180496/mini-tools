// Hand-rolled, best-effort linter for Redis command scripts — same
// philosophy as linter.ts, but one command per line (see
// backend/redisquery/splitter.go) instead of semicolon-delimited SQL
// statements. Only FLUSHALL/FLUSHDB are blocking (irreversibly wipe data,
// same severity class as SQL's UPDATE/DELETE-without-WHERE) — Redis's
// command surface doesn't have an equivalent to "forgot a WHERE clause" to
// warn about otherwise.

import type {LintWarning} from './linter'
import {t} from '../i18n'

export function lintRedisCommands(text: string): LintWarning[] {
    const warnings: LintWarning[] = []

    text.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return

        const command = trimmed.split(/\s+/)[0]?.toUpperCase()
        if (command === 'FLUSHALL' || command === 'FLUSHDB') {
            const lint = t().redis.lint
            warnings.push({
                message: command === 'FLUSHALL' ? lint.flushAll : lint.flushDb,
                startLineNumber: i + 1,
                endLineNumber: i + 1,
                blocking: true,
            })
        }
    })

    return warnings
}
