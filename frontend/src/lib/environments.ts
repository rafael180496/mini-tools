// Environment marking of a connection, and the colours that go with it.
//
// Values must match backend/vault/connections_repo.go's EnvProd/EnvStaging/
// EnvDev. Anything unrecognised (including "") reads as unmarked.

import {t} from '../i18n'

export type EnvironmentId = 'prod' | 'staging' | 'dev'

export interface EnvironmentStyle {
    id: EnvironmentId
    // label y description se leen del diccionario en el momento de acceder
    // (getters), no al cargar el módulo: así siguen el idioma activo.
    readonly label: string
    // short is what fits in a badge next to a connection name.
    short: string
    // Tailwind classes, always with a dark: pair (project rule).
    border: string
    badge: string
    banner: string
    dot: string
    readonly description: string
}

export const ENVIRONMENTS: Record<EnvironmentId, EnvironmentStyle> = {
    prod: {
        id: 'prod',
        get label() {
            return t().shell.environments.prod.label
        },
        short: 'PROD',
        border: 'border-l-4 border-l-red-500 dark:border-l-red-400',
        badge: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
        banner: 'border-red-500/60 bg-red-50 text-red-800 dark:border-red-400/50 dark:bg-red-950/50 dark:text-red-200',
        dot: 'bg-red-500 dark:bg-red-400',
        get description() {
            return t().shell.environments.prod.description
        },
    },
    staging: {
        id: 'staging',
        get label() {
            return t().shell.environments.staging.label
        },
        short: 'STG',
        border: 'border-l-4 border-l-amber-500 dark:border-l-amber-400',
        badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
        banner: 'border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-400/50 dark:bg-amber-950/50 dark:text-amber-200',
        dot: 'bg-amber-500 dark:bg-amber-400',
        get description() {
            return t().shell.environments.staging.description
        },
    },
    dev: {
        id: 'dev',
        get label() {
            return t().shell.environments.dev.label
        },
        short: 'DEV',
        border: 'border-l-4 border-l-emerald-500 dark:border-l-emerald-400',
        badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
        banner: 'border-emerald-500/60 bg-emerald-50 text-emerald-900 dark:border-emerald-400/50 dark:bg-emerald-950/50 dark:text-emerald-200',
        dot: 'bg-emerald-500 dark:bg-emerald-400',
        get description() {
            return t().shell.environments.dev.description
        },
    },
}

// environmentStyle returns the style for a stored value, or null when the
// connection is unmarked or carries a value this build does not know.
export function environmentStyle(env: string | undefined): EnvironmentStyle | null {
    if (!env) return null
    return ENVIRONMENTS[env as EnvironmentId] ?? null
}
