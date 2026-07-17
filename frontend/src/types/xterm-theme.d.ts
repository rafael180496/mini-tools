// xterm-theme ships no TypeScript types (plain UMD bundle, see its
// package.json — no "types"/"typings" field). It's a ~160-theme port of the
// iTerm2-Color-Schemes collection, one named export per theme, each object
// shaped exactly like xterm.js's ITheme (foreground/background/cursor +
// 16 ANSI colors) — see frontend/src/xterm/terminalThemes.ts for which ones
// this app actually uses.
declare module 'xterm-theme' {
    import type {ITheme} from '@xterm/xterm'

    const themes: Record<string, ITheme>
    export default themes
}
