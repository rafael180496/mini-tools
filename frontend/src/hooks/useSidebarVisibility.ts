import {useEffect, useSyncExternalStore} from 'react'
import {GetSettings, SetHiddenSidebarModules} from '../../wailsjs/go/main/App'
import type {SidebarModuleId} from '../components/sidebar/ActivityRail'

export const ALL_SIDEBAR_MODULES: readonly SidebarModuleId[] = [
    'connections',
    'ssh',
    'git',
    'notes',
    'http',
    'utilities',
]

let cachedHidden: SidebarModuleId[] = []
// Error del último guardado en vault.db, o null. Global como `cachedHidden`:
// lo muestra Configuración, que no es quien necesariamente pidió el cambio.
let saveError: string | null = null
let hydrated = false
const listeners = new Set<() => void>()
const EMPTY: SidebarModuleId[] = []

function sanitize(raw: unknown): SidebarModuleId[] {
    if (!Array.isArray(raw)) return []
    const valid = Array.from(
        new Set(raw.filter((id): id is SidebarModuleId => ALL_SIDEBAR_MODULES.includes(id as SidebarModuleId))),
    )
    return valid.length >= ALL_SIDEBAR_MODULES.length ? [] : valid
}

function notify() {
    for (const l of listeners) l()
}

function setHiddenLocal(next: SidebarModuleId[]) {
    cachedHidden = next
    notify()
}

// Muestra el cambio al instante y lo guarda en vault.db. Si el guardado falla,
// vuelve atrás: dejarlo aplicado haría creer que quedó guardado y al reiniciar
// la app la barra aparecería distinta, sin explicación.
function applyAndSave(next: SidebarModuleId[]) {
    const prev = cachedHidden
    saveError = null
    setHiddenLocal(next)
    SetHiddenSidebarModules(next).catch((err: unknown) => {
        saveError = err instanceof Error ? err.message : String(err)
        setHiddenLocal(prev)
    })
}

function hydrateFromVault() {
    if (hydrated) return
    hydrated = true
    GetSettings()
        .then((s) => {
            const fromDb = sanitize(s?.hiddenSidebarModules)
            setHiddenLocal(fromDb)
        })
        .catch(() => {
            // En uishot o sin runtime Wails se queda en [].
        })
}

function subscribe(cb: () => void) {
    listeners.add(cb)
    return () => {
        listeners.delete(cb)
    }
}

export function useHiddenSidebarModules() {
    useEffect(() => {
        hydrateFromVault()
    }, [])

    const hidden = useSyncExternalStore(subscribe, () => cachedHidden, () => EMPTY)
    const error = useSyncExternalStore(subscribe, () => saveError, () => null)

    const isVisible = (id: SidebarModuleId) => !hidden.includes(id)
    const visibleCount = ALL_SIDEBAR_MODULES.length - hidden.length

    const toggleModule = (id: SidebarModuleId) => {
        let next: SidebarModuleId[]
        if (hidden.includes(id)) {
            next = hidden.filter((m) => m !== id)
        } else {
            if (visibleCount <= 1) return
            next = [...hidden, id]
        }
        applyAndSave(next)
    }

    const resetAll = () => applyAndSave([])

    return {hidden, isVisible, visibleCount, toggleModule, resetAll, saveError: error}
}
