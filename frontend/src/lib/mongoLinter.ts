// Hand-rolled, best-effort linter for mongosh command scripts — same
// philosophy as linter.ts/redisLinter.ts. Flags the genuinely destructive
// operations (deleteMany/updateMany with an empty filter, or a collection
// drop) as blocking, the MongoDB analogue of SQL's DELETE/UPDATE-without-WHERE.
// Line-based and best-effort: a filter split across lines can dodge the empty-
// filter check, same tolerance the other hand-rolled linters accept.

import type {LintWarning} from './linter'
import {t} from '../i18n'

export function lintMongoCommands(text: string): LintWarning[] {
    const warnings: LintWarning[] = []

    text.split('\n').forEach((line, i) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('//')) return

        if (/\.(deleteMany|updateMany)\s*\(\s*\{\s*\}/.test(trimmed)) {
            warnings.push({
                message: t().mongo.lint.emptyFilter,
                startLineNumber: i + 1,
                endLineNumber: i + 1,
                blocking: true,
            })
        }
        if (/\.drop(Database)?\s*\(/.test(trimmed)) {
            warnings.push({
                message: t().mongo.lint.drop,
                startLineNumber: i + 1,
                endLineNumber: i + 1,
                blocking: true,
            })
        }
    })

    return warnings
}
