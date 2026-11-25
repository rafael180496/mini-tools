import {useCallback, useEffect, useState} from 'react'

// Estado de layout del shell ADE (ver .claude/specs/ux-ade-redesign.md).
//
// Guarda solo lo que la interfaz usa de verdad:
//   1. El modo de trabajo ADE: 'work' | 'pair' | 'chat' | 'terminals'.
//   2. Qué drawer rápido está abierto en el mosaico de terminales (Archivos o
//      Cambios, nunca los dos).
//
// Los tamaños de los paneles no viven acá: cada panel ya persiste el suyo en
// vault.db (sidebar_width, agent_size, git_*_width…).
//
// Se persiste en localStorage y no en vault.db porque es estado de la ventana
// y tiene que funcionar también en el banco de capturas (`uishot.tsx`), que no
// tiene runtime Wails. Un valor roto o de una versión anterior cae al default.

export type AdeMode = 'work' | 'pair' | 'chat' | 'terminals'

export interface AdeLayoutState {
    mode: AdeMode
    gridFilesOpen: boolean
    gridChangesOpen: boolean
}

const STORAGE_KEY = 'mini-tools:ade-layout:v1'
const VALID_MODES: readonly AdeMode[] = ['work', 'pair', 'chat', 'terminals']

export const DEFAULT_ADE_LAYOUT: AdeLayoutState = {
    mode: 'work',
    gridFilesOpen: false,
    gridChangesOpen: false,
}

// Orden de los modos: es el del selector de la Top Bar y el del dígito del atajo.
export const ADE_MODE_ORDER: readonly AdeMode[] = VALID_MODES

function isMacPlatform(): boolean {
    return typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
}

// El atajo para cambiar de modo, escrito como lo muestra cada sistema.
// macOS usa ⌃⌘1–4 y no ⇧⌘1–4: ⇧⌘3 y ⇧⌘4 son las capturas de pantalla del
// sistema y nunca llegan a la app. En Windows/Linux, Ctrl+Mayús+1–4.
export function adeModeShortcut(mode: AdeMode): string {
    const n = ADE_MODE_ORDER.indexOf(mode) + 1
    return isMacPlatform() ? `⌃⌘${n}` : `Ctrl+Shift+${n}`
}

// El modo que pide una tecla, o null. Se mira `e.code` (la tecla física) y no
// `e.key`: con Mayús apretada `e.key` es el símbolo (`!`, `@`, `"`…), que
// depende de la distribución del teclado.
export function adeModeFromKeyEvent(e: KeyboardEvent): AdeMode | null {
    const mac = isMacPlatform()
    const mods = mac
        ? e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
    if (!mods) return null
    const m = /^Digit([1-4])$/.exec(e.code)
    return m ? ADE_MODE_ORDER[Number(m[1]) - 1] : null
}

function loadLayout(): AdeLayoutState {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return DEFAULT_ADE_LAYOUT
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object') return DEFAULT_ADE_LAYOUT
        const mode = VALID_MODES.includes(parsed.mode as AdeMode) ? (parsed.mode as AdeMode) : DEFAULT_ADE_LAYOUT.mode
        const gridFilesOpen = parsed.gridFilesOpen === true
        // Nunca los dos drawers a la vez, aunque el valor guardado lo diga.
        const gridChangesOpen = !gridFilesOpen && parsed.gridChangesOpen === true
        return {mode, gridFilesOpen, gridChangesOpen}
    } catch {
        return DEFAULT_ADE_LAYOUT
    }
}

function saveLayout(state: AdeLayoutState) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
        // Ignorar en entornos sin storage disponible o con cuota agotada.
    }
}

export function useLayoutMode() {
    const [layout, setLayout] = useState<AdeLayoutState>(loadLayout)

    useEffect(() => {
        saveLayout(layout)
    }, [layout])

    const setMode = useCallback((mode: AdeMode) => {
        setLayout((prev) => (prev.mode === mode ? prev : {...prev, mode}))
    }, [])

    const toggleGridFiles = useCallback(() => {
        setLayout((prev) => ({
            ...prev,
            gridFilesOpen: !prev.gridFilesOpen,
            gridChangesOpen: !prev.gridFilesOpen ? false : prev.gridChangesOpen,
        }))
    }, [])

    const toggleGridChanges = useCallback(() => {
        setLayout((prev) => ({
            ...prev,
            gridChangesOpen: !prev.gridChangesOpen,
            gridFilesOpen: !prev.gridChangesOpen ? false : prev.gridFilesOpen,
        }))
    }, [])

    return {layout, setMode, toggleGridFiles, toggleGridChanges}
}
