// Single source of truth for how a Redis key's TYPE renders — label, icon,
// and a colored badge — shared by RedisKeyTree.tsx (the key list) and
// RedisKeyDetailPanel.tsx (the detail panel), which used to each carry
// their own neutral, uncolored badge markup independently. Every color has
// a light/dark pair (never a dark-only class — see the project's dark
// mode rule), picked from Tailwind's stock palette the same way existing
// accent colors elsewhere in this app already are (not tied to the MD3
// semantic tokens, which don't have enough distinct hues for 7 types).
export interface RedisTypeStyle {
    label: string
    icon: string
    badgeClass: string
}

export const REDIS_TYPE_STYLES: Record<string, RedisTypeStyle> = {
    string: {
        label: 'string',
        icon: 'notes',
        badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    },
    hash: {
        label: 'hash',
        icon: 'table_rows',
        badgeClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    },
    list: {
        label: 'list',
        icon: 'reorder',
        badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    },
    set: {
        label: 'set',
        icon: 'scatter_plot',
        badgeClass: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
    },
    zset: {
        label: 'zset',
        icon: 'leaderboard',
        badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    },
    stream: {
        label: 'stream',
        icon: 'stream',
        badgeClass: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
    },
    'ReJSON-RL': {
        label: 'json',
        icon: 'data_object',
        badgeClass: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
    },
}

const FALLBACK_STYLE: RedisTypeStyle = {
    label: '',
    icon: 'help',
    badgeClass: 'bg-surface-container-highest text-on-surface-variant',
}

// Every Redis type this app understands, in a stable display order — drives
// both the type-filter dropdown (RedisKeyTree.tsx) and any place that needs
// to enumerate them.
export const REDIS_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'ReJSON-RL'] as const

export function redisTypeStyle(type: string): RedisTypeStyle {
    return REDIS_TYPE_STYLES[type] ?? {...FALLBACK_STYLE, label: type}
}
