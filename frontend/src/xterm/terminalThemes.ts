import type {ITheme} from '@xterm/xterm'
import xtermTheme from 'xterm-theme'
import type {Theme as AppTheme} from '../hooks/useTheme'

// "auto" is not a real xterm.js theme — it's resolved to OneHalfDark/
// OneHalfLight below based on the app's own dark/light toggle (see
// resolveTerminalTheme), same convention as the CodeMirror editor's
// EDITOR_THEME_IDS (frontend/src/codemirror/themes.ts). Every other id maps
// 1:1 to a named export from the `xterm-theme` package (a ~160-theme port
// of the iTerm2-Color-Schemes collection) — a curated subset, not the full
// list, picked for being both well-known and visually distinct.
export const TERMINAL_THEME_IDS = [
    'auto',
    'dracula',
    'nord',
    'solarizedDark',
    'solarizedLight',
    'gruvboxDark',
    'oneHalfDark',
    'oneHalfLight',
    'tomorrowNight',
    'github',
] as const

export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number]

export const TERMINAL_THEME_LABELS: Record<TerminalThemeId, string> = {
    auto: 'Automático (sigue el tema de la app)',
    dracula: 'Dracula',
    nord: 'Nord',
    solarizedDark: 'Solarized Dark',
    solarizedLight: 'Solarized Light',
    gruvboxDark: 'Gruvbox Dark',
    oneHalfDark: 'One Half Dark',
    oneHalfLight: 'One Half Light',
    tomorrowNight: 'Tomorrow Night',
    github: 'GitHub Light',
}

// `xterm-theme` has no exact "Nord" preset — Nord's real palette
// (nordtheme.com) is small/stable enough to hand-author directly instead of
// substituting a lookalike under a misleading name.
const NORD: ITheme = {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    black: '#3b4252',
    brightBlack: '#4c566a',
    red: '#bf616a',
    brightRed: '#bf616a',
    green: '#a3be8c',
    brightGreen: '#a3be8c',
    yellow: '#ebcb8b',
    brightYellow: '#ebcb8b',
    blue: '#81a1c1',
    brightBlue: '#81a1c1',
    magenta: '#b48ead',
    brightMagenta: '#b48ead',
    cyan: '#88c0d0',
    brightCyan: '#8fbcbb',
    white: '#e5e9f0',
    brightWhite: '#eceff4',
}

const EXPLICIT_THEMES: Record<Exclude<TerminalThemeId, 'auto'>, ITheme> = {
    dracula: xtermTheme.Dracula,
    nord: NORD,
    solarizedDark: xtermTheme.Solarized_Dark,
    solarizedLight: xtermTheme.Solarized_Light,
    gruvboxDark: xtermTheme.Gruvbox_Dark,
    oneHalfDark: xtermTheme.OneHalfDark,
    oneHalfLight: xtermTheme.OneHalfLight,
    tomorrowNight: xtermTheme.Tomorrow_Night,
    github: xtermTheme.Github,
}

function isExplicitThemeId(id: string): id is Exclude<TerminalThemeId, 'auto'> {
    return Object.prototype.hasOwnProperty.call(EXPLICIT_THEMES, id)
}

// Resolves the persisted ssh_terminal_theme setting (possibly "auto", or a
// stale id from a future/older build) to an actual xterm.js ITheme. Falls
// back to following the app's dark/light toggle for both "auto" and any
// unrecognized id — never renders with no theme at all, same contract as
// resolveEditorTheme.
export function resolveTerminalTheme(terminalThemeId: string, appTheme: AppTheme): ITheme {
    if (isExplicitThemeId(terminalThemeId)) {
        return EXPLICIT_THEMES[terminalThemeId]
    }
    return appTheme === 'dark' ? xtermTheme.OneHalfDark : xtermTheme.OneHalfLight
}
