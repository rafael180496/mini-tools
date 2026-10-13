import {useSyncExternalStore} from 'react'
import {ListAgentSessions, ListPendingApprovals} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import type {ApprovalRequest} from '../components/agent/AgentApprovalDialog'

// Las sesiones del agente que siguen vivas en el backend, vistas desde la UI.
//
// **El problema que resuelve.** Antes, un turno solo existía mientras había un
// `AgentChat` montado mirándolo: cerrar la pestaña lo dejaba sin dónde
// mostrarse, y una petición de permiso que llegaba sin chat a la vista se
// perdía (el proceso del agente quedaba bloqueado hasta el plazo de 5 minutos).
// Ahora el backend mantiene las sesiones aunque nadie las mire y avisa de cada
// cambio con el evento `agent-sessions` (la lista completa). Este módulo es el
// único lugar de la UI que lo escucha: la barra lateral, las pestañas, el
// diálogo de aprobaciones y los avisos leen de acá en vez de suscribirse cada
// uno por su lado.
//
// Es un almacén de módulo y no un contexto por el mismo motivo que
// `modelServerHealth`: varias pantallas miran lo mismo a la vez y un contexto
// obligaría a montar un proveedor encima de todas.

export type AgentSessionStatus = 'running' | 'awaiting_approval' | 'idle' | 'error' | 'cancelled'

// Espeja el AgentSessionInfo del backend. Se tipa a mano y no desde
// wailsjs/go/models porque la lista también llega por un EVENTO, que el
// generador no tipa (mismo motivo que ChatEvent en AgentChat.tsx).
export interface AgentSessionInfo {
    sessionId: string
    chatId: string
    agentId: string
    agentLabel: string
    model: string
    mode: string
    module: string
    contextId: string
    title: string
    status: AgentSessionStatus
    startedAt: unknown
    lastEventAt: unknown
    turnStartedAt: unknown
    usage?: {input?: number; output?: number; total?: number} | null
    lastText: string
    pendingApprovalId: string
    unread: boolean
    // Mensaje del fallo cuando status es 'error'.
    error?: string
    // Alguna pestaña muestra la conversación ahora.
    attached?: boolean
    // Se cerró su pestaña y sigue abierta en segundo plano: se lista en «Activas»
    // aunque no trabaje ni esté sin leer, hasta que se la cierre de verdad.
    detached?: boolean
}

export interface SessionToast {
    id: number
    // `background`: se cerró la pestaña de un chat que sigue trabajando.
    kind: 'done' | 'error' | 'background'
    sessionId: string
    title: string
    text: string
}

// toMillis normaliza un instante del backend (ISO 8601, epoch en segundos o en
// milisegundos) a milisegundos. 0 = no hay instante: el cero de Go
// (0001-01-01) también cuenta como ausente.
export function toMillis(v: unknown): number {
    if (typeof v === 'number') return v <= 0 ? 0 : v < 1e12 ? v * 1000 : v
    if (typeof v === 'string' && v) {
        const ms = Date.parse(v)
        return Number.isNaN(ms) || ms < 86_400_000 ? 0 : ms
    }
    return 0
}

export function sessionTokens(s: AgentSessionInfo): number {
    const u = s.usage
    if (!u) return 0
    return u.total ?? (u.input ?? 0) + (u.output ?? 0)
}

export const isLive = (s: AgentSessionInfo) => s.status === 'running' || s.status === 'awaiting_approval'

// --- Almacenes --------------------------------------------------------------

function createStore<T>(initial: T) {
    let value = initial
    const subs = new Set<() => void>()
    return {
        get: () => value,
        set(next: T) {
            if (Object.is(next, value)) return
            value = next
            for (const s of subs) s()
        },
        subscribe(cb: () => void) {
            subs.add(cb)
            return () => {
                subs.delete(cb)
            }
        },
    }
}

const sessionsStore = createStore<AgentSessionInfo[]>([])
const approvalsStore = createStore<ApprovalRequest[]>([])
const toastsStore = createStore<SessionToast[]>([])
// Lo que el usuario sacó de la vista: sessionId → estado en el que lo hizo.
// Una entrada oculta reaparece sola cuando el estado cambia (terminó, pide
// permiso…): «dejar terminar» silencia el estado actual, no la sesión.
const hiddenStore = createStore<Record<string, string>>({})
// El permiso que el usuario pidió revisar aunque su conversación no esté a la
// vista (desde «Aprobar…» de la barra lateral o desde un aviso).
const reviewStore = createStore<string | null>(null)

let toastSeq = 0
let started = 0
let stops: Array<() => void> = []

// --- Qué chats están a la vista ----------------------------------------------
//
// Un `AgentChat` montado y visible se registra acá. Sirve para dos decisiones:
// no avisar con un toast de lo que el usuario está mirando, y presentar una
// aprobación «en contexto» (sin el rótulo de otra conversación) cuando su chat
// es el que tiene delante.

const visibleChats = new Map<string, number>()

export function registerVisibleChat(sessionId: string): () => void {
    visibleChats.set(sessionId, (visibleChats.get(sessionId) ?? 0) + 1)
    notifyVisible()
    return () => {
        const n = (visibleChats.get(sessionId) ?? 1) - 1
        if (n <= 0) visibleChats.delete(sessionId)
        else visibleChats.set(sessionId, n)
        notifyVisible()
    }
}

const visibleStore = createStore<ReadonlySet<string>>(new Set())
function notifyVisible() {
    visibleStore.set(new Set(visibleChats.keys()))
}

// ¿El usuario tiene delante este chat ahora mismo? Con la ventana oculta no.
export function isChatSeen(sessionId: string): boolean {
    return visibleChats.has(sessionId) && document.visibilityState === 'visible'
}

// --- Arranque ------------------------------------------------------------------

// El backend manda la lista completa en cada cambio, y mientras un turno
// escribe eso puede ser muchas veces por segundo. Un cambio de ESTADO (empezó,
// pide permiso, terminó, se leyó) se aplica al instante; los demás (texto
// nuevo, tokens) se juntan en uno cada SESSIONS_COALESCE_MS, que alcanza para
// la vista previa y el contador sin redibujar la barra a cada fragmento.
const SESSIONS_COALESCE_MS = 400
let lastShape = ''
let trailing: number | null = null
let trailingList: AgentSessionInfo[] | null = null

const shapeOf = (list: AgentSessionInfo[]) => list.map((s) => `${s.sessionId}:${s.status}:${s.unread}:${s.attached ? 1 : 0}${s.detached ? 1 : 0}:${s.title}`).join('|')

function onSessionsEvent(list: AgentSessionInfo[]) {
    if (shapeOf(list) !== lastShape) {
        if (trailing !== null) window.clearTimeout(trailing)
        trailing = null
        trailingList = null
        applySessions(list, true)
        return
    }
    trailingList = list
    if (trailing === null) {
        trailing = window.setTimeout(() => {
            trailing = null
            const l = trailingList
            trailingList = null
            if (l) applySessions(l, true)
        }, SESSIONS_COALESCE_MS)
    }
}

function applySessions(next: AgentSessionInfo[], announce: boolean) {
    lastShape = shapeOf(next)
    const prev = new Map(sessionsStore.get().map((s) => [s.sessionId, s]))
    if (announce) {
        for (const s of next) {
            const before = prev.get(s.sessionId)
            if (!before || isChatSeen(s.sessionId)) continue
            if (isLive(before) && s.status === 'idle') pushToast('done', s)
            else if (before.status !== 'error' && s.status === 'error') pushToast('error', s)
        }
    }
    sessionsStore.set(next)
}

function pushToast(kind: SessionToast['kind'], s: AgentSessionInfo) {
    const toast: SessionToast = {id: ++toastSeq, kind, sessionId: s.sessionId, title: s.title, text: s.lastText}
    toastsStore.set([...toastsStore.get().filter((x) => x.sessionId !== s.sessionId), toast].slice(-4))
}

// Aviso de que cerrar la pestaña NO detuvo el chat: sigue trabajando y se lo
// encuentra en IA → Activas. No lleva la vista previa del texto: lo que dice es
// dónde quedó, no qué escribió.
export function announceBackground(sessionId: string, title: string) {
    const toast: SessionToast = {id: ++toastSeq, kind: 'background', sessionId, title, text: ''}
    toastsStore.set([...toastsStore.get().filter((x) => x.sessionId !== sessionId), toast].slice(-4))
}

// Avisa de cada chat de la lista que sigue trabajando (corriendo o esperando un
// permiso). Los quietos no avisan: cerrar su pestaña no cambia nada que se vea.
export function announceBackgroundChats(chatIds: string[]) {
    for (const s of sessionsStore.get()) {
        if (isLive(s) && (chatIds.includes(s.sessionId) || chatIds.includes(s.chatId))) announceBackground(s.sessionId, s.title)
    }
}

export function dismissToast(id: number) {
    const cur = toastsStore.get()
    if (cur.some((t) => t.id === id)) toastsStore.set(cur.filter((t) => t.id !== id))
}

// startAgentSessions engancha los eventos del backend. Cuenta referencias: lo
// llama el anfitrión que vive mientras el workspace está desbloqueado, y al
// bloquear el vault se suelta todo (no queda una lista de otra sesión de uso).
export function startAgentSessions(): () => void {
    if (started++ === 0) {
        let live = true
        stops = [
            () => {
                live = false
            },
            EventsOn('agent-sessions', (list: AgentSessionInfo[] | null) => onSessionsEvent(list ?? [])),
            EventsOn('agent-approval', (req: ApprovalRequest) => {
                const cur = approvalsStore.get()
                if (!cur.some((r) => r.id === req.id)) approvalsStore.set([...cur, req])
            }),
            EventsOn('agent-approval-dismiss', (id: string) => {
                const cur = approvalsStore.get()
                if (cur.some((r) => r.id === id)) approvalsStore.set(cur.filter((r) => r.id !== id))
            }),
        ]
        // La carga inicial no avisa: lo que ya estaba pasando no es una novedad.
        ListAgentSessions()
            .then((list) => live && applySessions((list ?? []) as AgentSessionInfo[], false))
            .catch(() => {})
        // Las pendientes de antes de montar: sin esto, un permiso pedido mientras
        // no había nada escuchando (vault recién desbloqueado) no se vería nunca.
        ListPendingApprovals()
            .then((list) => {
                if (!live) return
                const cur = approvalsStore.get()
                const extra = ((list ?? []) as ApprovalRequest[]).filter((r) => !cur.some((c) => c.id === r.id))
                if (extra.length) approvalsStore.set([...cur, ...extra])
            })
            .catch(() => {})
    }
    let released = false
    return () => {
        if (released) return
        released = true
        if (--started > 0) return
        for (const stop of stops) stop()
        stops = []
        if (trailing !== null) window.clearTimeout(trailing)
        trailing = null
        trailingList = null
        lastShape = ''
        sessionsStore.set([])
        approvalsStore.set([])
        toastsStore.set([])
        hiddenStore.set({})
        reviewStore.set(null)
    }
}

// --- Acciones sobre la vista ---------------------------------------------------

// statusKey identifica el estado visible de una sesión: lo que «dejar terminar»
// o «marcar leído» silencia.
const statusKey = (s: AgentSessionInfo) => s.status

export function hideSession(s: AgentSessionInfo) {
    hiddenStore.set({...hiddenStore.get(), [s.sessionId]: statusKey(s)})
}

export function removeApproval(id: string) {
    const cur = approvalsStore.get()
    if (cur.some((r) => r.id === id)) approvalsStore.set(cur.filter((r) => r.id !== id))
    if (reviewStore.get() === id) reviewStore.set(null)
}

// Abre el diálogo del permiso pendiente de una sesión. Devuelve false si no hay
// ninguno (ya se contestó o venció mientras tanto).
export function reviewApprovalOf(sessionId: string): boolean {
    const req = approvalsStore.get().find((r) => r.sessionId === sessionId)
    if (!req) return false
    reviewStore.set(req.id)
    return true
}

export function reviewApproval(id: string) {
    reviewStore.set(id)
}

// --- Selectores ----------------------------------------------------------------

// Las entradas de «Activas»: lo que sigue trabajando, lo que pide permiso, lo
// que falló, lo que terminó sin que lo hayas visto y los chats que quedaron
// abiertos en segundo plano al cerrar su pestaña (en cualquier estado: solo
// «Cerrar chat» los saca). Una sesión leída, quieta y sin pestaña abierta no es
// «activa»: ya vive en «Recientes».
export function activeEntries(sessions: AgentSessionInfo[], hidden: Record<string, string>): AgentSessionInfo[] {
    const rank = (s: AgentSessionInfo) => (s.status === 'awaiting_approval' ? 0 : s.status === 'running' ? 1 : s.status === 'error' ? 2 : s.unread ? 3 : 4)
    return sessions
        .filter((s) => {
            if (hidden[s.sessionId] === statusKey(s)) return false
            if (s.detached) return true
            if (s.status === 'cancelled') return false
            if (s.status === 'idle') return s.unread
            return true
        })
        .sort((a, b) => rank(a) - rank(b) || toMillis(b.lastEventAt) - toMillis(a.lastEventAt))
}

// El número de la insignia del módulo: lo que requiere atención o sigue
// trabajando. Una sesión silenciada con «dejar terminar» no cuenta mientras
// siga igual, pero una que pide permiso reaparece (cambió de estado).
export function attentionCount(sessions: AgentSessionInfo[], hidden: Record<string, string>): {running: number; approval: number} {
    let running = 0
    let approval = 0
    for (const s of sessions) {
        if (hidden[s.sessionId] === statusKey(s)) continue
        if (s.status === 'running') running++
        else if (s.status === 'awaiting_approval') approval++
    }
    return {running, approval}
}

// --- Hooks ---------------------------------------------------------------------

export const useAgentSessions = () => useSyncExternalStore(sessionsStore.subscribe, sessionsStore.get)
export const usePendingApprovals = () => useSyncExternalStore(approvalsStore.subscribe, approvalsStore.get)
export const useSessionToasts = () => useSyncExternalStore(toastsStore.subscribe, toastsStore.get)
export const useHiddenSessions = () => useSyncExternalStore(hiddenStore.subscribe, hiddenStore.get)
export const useReviewingApproval = () => useSyncExternalStore(reviewStore.subscribe, reviewStore.get)
export const useVisibleChats = () => useSyncExternalStore(visibleStore.subscribe, visibleStore.get)

// Las sesiones que el backend conoce para esos ids (de sesión o de historial).
export function sessionsOfChats(ids: string[]): AgentSessionInfo[] {
    return sessionsStore.get().filter((s) => ids.includes(s.sessionId) || ids.includes(s.chatId))
}

// La sesión de un chat, si el backend la conoce.
export function useAgentSession(sessionId: string): AgentSessionInfo | undefined {
    const list = useAgentSessions()
    return list.find((s) => s.sessionId === sessionId)
}

// «estado:sin leer» de un chat como un texto: el componente que lo usa se
// redibuja sólo cuando eso cambia, no con cada actualización de la lista (que
// llega muchas veces por segundo mientras un turno escribe).
export function useSessionFlag(sessionId: string): string {
    return useSyncExternalStore(sessionsStore.subscribe, () => {
        const s = sessionsStore.get().find((x) => x.sessionId === sessionId)
        return s ? `${s.status}:${s.unread ? 'unread' : 'read'}` : ''
    })
}
