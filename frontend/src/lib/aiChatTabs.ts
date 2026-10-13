import {useSyncExternalStore} from 'react'
import {AttachAgentSession, DetachAgentSession} from '../../wailsjs/go/main/App'

// Qué conversaciones tiene abierta cada panel del Chat de IA.
//
// Ahora puede haber varias pestañas de Chat de IA (y cada una, dividida en dos
// paneles), y una misma conversación no debe estar a la vista en dos lugares a
// la vez: dos cajas de texto para un turno que sólo admite un mensaje a la vez.
// Este registro es lo que permite que «abrir esta conversación» lleve a la
// pestaña que ya la tiene en vez de duplicarla, y que la barra de pestañas y la
// barra lateral sepan cuál de ellas está trabajando.
//
// Cada panel se identifica con un id de panel: el de su pestaña, o ese mismo con
// `#b` cuando es el segundo panel de una pestaña dividida.

const panes = new Map<string, string[]>()
// La conversación a la vista de cada panel: junto con la lista de arriba es lo
// que hace falta para reabrir la pestaña tal cual estaba al volver a abrir la app.
const currents = new Map<string, string>()
const subs = new Set<() => void>()
let snapshot: Record<string, string[]> = {}
let layoutSnapshot: Record<string, PaneLayout> = {}

export interface PaneLayout {
    chats: string[]
    current: string
}

function publish() {
    snapshot = Object.fromEntries(panes)
    layoutSnapshot = Object.fromEntries([...panes].map(([id, chats]) => [id, {chats, current: currents.get(id) ?? ''}]))
    for (const s of subs) s()
    syncAttached()
}

// --- Qué chats muestra alguna pestaña, y avisárselo al backend -----------------
//
// Cerrar una pestaña NO es cerrar el chat: la conversación sigue en el backend,
// trabajando si estaba en un turno, y queda «abierta en segundo plano» en IA →
// Activas hasta que alguien la cierre de verdad. Para que el backend sepa cuál
// es cuál, este registro —el único que sabe qué chats están a la vista— le avisa
// de cada cambio: un chat que entra a algún panel se ADJUNTA, uno que sale de
// todos (pestaña cerrada, panel cerrado, conversación borrada) se DESADJUNTA.
// Los avisos salen en orden, uno tras otro: un adjuntar y un desadjuntar del
// mismo chat que se cruzaran dejarían el estado al revés.
let shown = new Set<string>()
let sendChain: Promise<unknown> = Promise.resolve()

function syncAttached() {
    const now = new Set<string>()
    for (const ids of panes.values()) for (const id of ids) now.add(id)
    for (const id of now) if (!shown.has(id)) notify(AttachAgentSession, id)
    for (const id of shown) if (!now.has(id)) notify(DetachAgentSession, id)
    shown = now
}

function notify(call: (id: string) => Promise<void>, id: string) {
    // Con el vault bloqueado el backend rechaza el aviso: no hay nada que hacer.
    sendChain = sendChain.then(() => call(id)).catch(() => {})
}

// Los chats con mensajes que muestran los paneles de una pestaña (los dos, si
// está dividida; con `secondOnly`, solo el segundo).
export function chatsOfTab(tabId: string, secondOnly = false): string[] {
    const out: string[] = []
    for (const [paneId, ids] of panes) {
        if (tabOfPane(paneId) !== tabId) continue
        if (secondOnly && paneId !== secondPaneId(tabId)) continue
        out.push(...ids)
    }
    return out
}

// `current` es la conversación que el panel tiene a la vista ('' = ninguna).
export function setPaneChats(paneId: string, chatIds: string[], current = '') {
    const prev = panes.get(paneId)
    if (prev && prev.length === chatIds.length && prev.every((id, i) => id === chatIds[i]) && (currents.get(paneId) ?? '') === current) return
    panes.set(paneId, chatIds)
    currents.set(paneId, current)
    for (const [id, owner] of claims) if (owner === paneId && chatIds.includes(id)) claims.delete(id)
    publish()
}

export function clearPane(paneId: string) {
    currents.delete(paneId)
    for (const [id, owner] of claims) if (owner === paneId) claims.delete(id)
    if (panes.delete(paneId)) publish()
}

// Reserva una conversación para un panel ANTES de que la declare. Dos paneles
// que nacen a la vez (una pestaña nueva ya dividida) buscan al mismo tiempo un
// borrador sin dueño al que adoptar; sin la reserva los dos elegirían el mismo.
// false = ya la tiene otro panel (o la tiene reservada).
const claims = new Map<string, string>()
export function claimChat(chatId: string, paneId: string): boolean {
    if (paneOwningChat(chatId, paneId)) return false
    const owner = claims.get(chatId)
    if (owner && owner !== paneId) return false
    claims.set(chatId, paneId)
    return true
}

// El panel que tiene abierta la conversación, salvo `except`. null = ninguno.
export function paneOwningChat(chatId: string, except?: string): string | null {
    for (const [paneId, ids] of panes) {
        if (paneId !== except && ids.includes(chatId)) return paneId
    }
    return null
}

// La pestaña de un panel: el id sin el sufijo del segundo panel.
export const tabOfPane = (paneId: string) => paneId.split('#')[0]
export const secondPaneId = (tabId: string) => `${tabId}#b`

// Las conversaciones y la que está a la vista, por panel.
export function useAiChatLayout(): Record<string, PaneLayout> {
    return useSyncExternalStore(
        (cb) => {
            subs.add(cb)
            return () => {
                subs.delete(cb)
            }
        },
        () => layoutSnapshot,
    )
}

export function useAiChatPanes(): Record<string, string[]> {
    return useSyncExternalStore(
        (cb) => {
            subs.add(cb)
            return () => {
                subs.delete(cb)
            }
        },
        () => snapshot,
    )
}

// Los atajos del Chat de IA, escritos como los muestra cada sistema. Se leen al
// usarlos (no al cargar el módulo) por la misma razón que los textos: son parte
// de lo que ve el usuario. El atajo en sí lo atienden AiChatTab (nuevo chat en
// esta pestaña) y Workspace (otra pestaña); acá sólo se rotulan.
export function aiChatShortcuts(): {newChat: string; newTab: string} {
    const mac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
    return mac ? {newChat: '⌘N', newTab: '⇧⌘N'} : {newChat: 'Ctrl+N', newTab: 'Ctrl+Shift+N'}
}
