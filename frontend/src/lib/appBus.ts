// Pedidos de un componente profundo a la ventana principal.
//
// El chat vive en tres lugares (panel lateral, pestaña Git, Chat de IA) y desde
// cualquiera necesita pedirle a `Workspace` dos cosas que solo él puede hacer:
// abrir Configuración en una sección y abrir una nota en una pestaña. Pasar un
// callback por los tres anfitriones y por `AgentChat` es una cadena de props que
// no aporta nada (ninguno de los intermedios hace algo con él), y un contexto
// nuevo sería mucho para dos verbos. Un evento de ventana, tipado acá, es lo
// justo.
//
// Si nadie escucha —una vista suelta del banco de capturas— el pedido se pierde
// sin error: es un atajo, no una operación.

import type {UtilityId} from '../components/utilities/utilities'

export type SettingsSectionRequest = 'general' | 'vault' | 'terminal' | 'ai'

export interface OpenNoteRequest {
    // Se prefiere el id; con solo el título, quien escucha lo resuelve.
    id?: string
    title?: string
}

const OPEN_SETTINGS = 'mini-tools:open-settings'
const OPEN_NOTE = 'mini-tools:open-note'
const OPEN_UTILITY = 'mini-tools:open-utility'

export function requestOpenSettings(section: SettingsSectionRequest): void {
    window.dispatchEvent(new CustomEvent<SettingsSectionRequest>(OPEN_SETTINGS, {detail: section}))
}

export function onOpenSettingsRequest(handler: (section: SettingsSectionRequest) => void): () => void {
    const listener = (e: Event) => handler((e as CustomEvent<SettingsSectionRequest>).detail)
    window.addEventListener(OPEN_SETTINGS, listener)
    return () => window.removeEventListener(OPEN_SETTINGS, listener)
}

// Abrir (o llevar al frente) la pestaña de una utilidad. Lo pide, por ejemplo,
// Configuración → IA para mandar a «Utilidades → Modelos», donde se administran
// los servidores de modelos. Quien escucha (Workspace) cierra Configuración.
export function requestOpenUtility(id: UtilityId): void {
    window.dispatchEvent(new CustomEvent<UtilityId>(OPEN_UTILITY, {detail: id}))
}

export function onOpenUtilityRequest(handler: (id: UtilityId) => void): () => void {
    const listener = (e: Event) => handler((e as CustomEvent<UtilityId>).detail)
    window.addEventListener(OPEN_UTILITY, listener)
    return () => window.removeEventListener(OPEN_UTILITY, listener)
}

export function requestOpenNote(req: OpenNoteRequest): void {
    window.dispatchEvent(new CustomEvent<OpenNoteRequest>(OPEN_NOTE, {detail: req}))
}

export function onOpenNoteRequest(handler: (req: OpenNoteRequest) => void): () => void {
    const listener = (e: Event) => handler((e as CustomEvent<OpenNoteRequest>).detail)
    window.addEventListener(OPEN_NOTE, listener)
    return () => window.removeEventListener(OPEN_NOTE, listener)
}

// La lista de servidores de modelos cambió (alta, edición o baja).
//
// Un servidor se puede agregar desde tres lugares —Configuración, el selector del
// Chat de IA y el del panel lateral— y los dos selectores leen `ListAgents` una
// sola vez al montarse. Sin este aviso, el servidor recién guardado no aparecería
// en el selector de al lado hasta reabrir la pestaña, que es justo el momento en
// que uno se pregunta si se guardó.
const MODEL_SERVERS_CHANGED = 'mini-tools:model-servers-changed'

export function notifyModelServersChanged(): void {
    window.dispatchEvent(new Event(MODEL_SERVERS_CHANGED))
}

export function onModelServersChanged(handler: () => void): () => void {
    window.addEventListener(MODEL_SERVERS_CHANGED, handler)
    return () => window.removeEventListener(MODEL_SERVERS_CHANGED, handler)
}
