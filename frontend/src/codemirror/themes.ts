import type {Extension} from '@codemirror/state'
import {githubLight, githubDark} from '@uiw/codemirror-theme-github'
import {dracula} from '@uiw/codemirror-theme-dracula'
import {nord} from '@uiw/codemirror-theme-nord'
import {material} from '@uiw/codemirror-theme-material'
import {solarizedLight, solarizedDark} from '@uiw/codemirror-theme-solarized'
import {vscodeDark} from '@uiw/codemirror-theme-vscode'
import {tokyoNight} from '@uiw/codemirror-theme-tokyo-night'
import type {Theme as AppTheme} from '../hooks/useTheme'

// "auto" is not a real CodeMirror extension — it's resolved to
// githubLight/githubDark below based on the app's own dark/light toggle
// (see resolveEditorTheme). Every other id maps 1:1 to a preset from the
// @uiw/codemirror-theme-* packages installed in package.json.
export const EDITOR_THEME_IDS = [
    'auto',
    'githubLight',
    'githubDark',
    'dracula',
    'nord',
    'material',
    'solarizedLight',
    'solarizedDark',
    'vscodeDark',
    'tokyoNight',
] as const

export type EditorThemeId = (typeof EDITOR_THEME_IDS)[number]

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
    auto: 'Automático (sigue el tema de la app)',
    githubLight: 'GitHub Light',
    githubDark: 'GitHub Dark',
    dracula: 'Dracula',
    nord: 'Nord',
    material: 'Material',
    solarizedLight: 'Solarized Light',
    solarizedDark: 'Solarized Dark',
    vscodeDark: 'VS Code Dark',
    tokyoNight: 'Tokyo Night',
}

const EXPLICIT_THEMES: Record<Exclude<EditorThemeId, 'auto'>, Extension> = {
    githubLight,
    githubDark,
    dracula,
    nord,
    material,
    solarizedLight,
    solarizedDark,
    vscodeDark,
    tokyoNight,
}

function isExplicitThemeId(id: string): id is Exclude<EditorThemeId, 'auto'> {
    return Object.prototype.hasOwnProperty.call(EXPLICIT_THEMES, id)
}

// Resolves the persisted editor_theme setting (possibly "auto", or a stale
// id from a future/older build) to an actual CodeMirror extension. Falls
// back to following the app's dark/light toggle for both "auto" and any
// unrecognized id — never renders with no theme at all.
export function resolveEditorTheme(editorThemeId: string, appTheme: AppTheme): Extension {
    if (isExplicitThemeId(editorThemeId)) {
        return EXPLICIT_THEMES[editorThemeId]
    }
    return appTheme === 'dark' ? githubDark : githubLight
}
