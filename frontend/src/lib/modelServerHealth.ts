import {useCallback, useEffect, useState, useSyncExternalStore} from 'react'
import {ListModelServers, ModelServerHealth, TestModelServer} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import {errorText, t} from '../i18n'
import {isModelServerAgent, MODEL_SERVER_PREFIX, STORED_HEADERS} from './modelServers'

// Salud de los servidores de modelos: ¿contesta ahora mismo?
//
// **Por qué es un almacén compartido y no un estado por componente.** El
// mismo servidor se mira desde tres lugares a la vez —el punto del selector de
// proveedor, el aviso sobre la caja del chat y la lista de Configuración— y
// cada uno hacía su propia consulta y su propio reloj. Con un almacén por
// servidor hay UN sondeo por servidor sin importar cuántos lo miran, y el
// resultado de una consulta (incluido el de un «Probar» manual) lo ven todos.
//
// **Cuándo se consulta.** Al elegir el agente y cada 60 s mientras el chat está
// a la vista; al volver a la ventana si la última lectura ya tiene más de 60 s.
// Con la ventana oculta o sin foco no se sondea: un remoto caído no tiene por
// qué recibir una consulta por minuto de una app que nadie está mirando. A un
// CLI no se lo sondea nunca (no tiene servidor).
//
// El backend cachea 30 s cada respuesta, así que consultar de más no cuesta un
// viaje a la red. «Reintentar» es la excepción: tiene que saltarse esa caché
// (la respuesta cacheada es justo la que dice que está caído), y por eso
// pasa por `TestModelServer` con la configuración guardada.

export const HEALTH_POLL_MS = 60_000

export type HealthStatus = 'unknown' | 'checking' | 'ok' | 'error'

export interface Health {
    status: HealthStatus
    latencyMs: number
    // Epoch en milisegundos de la última lectura terminada; 0 si no hubo.
    checkedAt: number
    error: string
    version: string
}

const UNKNOWN: Health = {status: 'unknown', latencyMs: 0, checkedAt: 0, error: '', version: ''}

interface Entry {
    health: Health
    subs: Set<() => void>
    pollers: number
    timer: number | null
    inflight: Promise<void> | null
}

const entries = new Map<string, Entry>()

function entryOf(id: string): Entry {
    let e = entries.get(id)
    if (!e) {
        e = {health: UNKNOWN, subs: new Set(), pollers: 0, timer: null, inflight: null}
        entries.set(id, e)
    }
    return e
}

function publish(id: string, health: Health) {
    const e = entryOf(id)
    e.health = health
    e.subs.forEach((fn) => fn())
}

function fromProbe(p: main.ModelServerProbe): Health {
    return {
        status: p.ok ? 'ok' : 'error',
        latencyMs: p.latencyMs ?? 0,
        // Un servidor viejo o una prueba sin marca: se usa la hora de ahora.
        checkedAt: p.checkedAt || Date.now(),
        error: p.ok ? '' : p.error,
        version: p.version ?? '',
    }
}

// serverIdOf devuelve el id del servidor detrás de un agente `llm:<id>`, o ''
// si el agente es un CLI.
export function serverIdOf(agentId: string): string {
    return isModelServerAgent(agentId) ? agentId.slice(MODEL_SERVER_PREFIX.length) : ''
}

// Consulta (con la caché de 30 s del backend). `force` la salta.
function check(id: string, force: boolean): Promise<void> {
    const e = entryOf(id)
    if (e.inflight && !force) return e.inflight
    // Con una lectura previa se la deja a la vista mientras llega la nueva: un
    // punto que parpadea en gris cada minuto se lee como inestabilidad. Solo la
    // primera lectura, o un reintento pedido a mano, muestran «comprobando».
    if (e.health.status === 'unknown' || force) publish(id, {...e.health, status: 'checking'})
    let run: Promise<void> | undefined
    run = (async () => {
        try {
            let probe: main.ModelServerProbe
            if (force) {
                const list = await ListModelServers()
                const srv = (list ?? []).find((s) => s.id === id)
                if (!srv) throw new Error(t().agent.health.serverGone)
                // serverId + token vacío + cabeceras null: el backend usa el
                // token y las cabeceras guardados, que esta capa nunca tiene.
                probe = await TestModelServer(srv.kind, srv.baseUrl, '', srv.id, srv.insecureTls, STORED_HEADERS)
            } else {
                probe = await ModelServerHealth(id)
            }
            publish(id, fromProbe(probe))
        } catch (err) {
            publish(id, {status: 'error', latencyMs: 0, checkedAt: Date.now(), error: errorText(err), version: ''})
        } finally {
            const cur = entryOf(id)
            if (cur.inflight === run) cur.inflight = null
        }
    })()
    e.inflight = run
    return run
}

// Registra el resultado de una prueba manual («Probar» en Configuración) para
// que el punto del selector y el aviso del chat se pongan al día sin esperar.
export function recordProbe(id: string, probe: main.ModelServerProbe) {
    publish(id, fromProbe(probe))
}

// Vuelve a preguntar saltándose la caché del backend: tras editar un servidor,
// la lectura anterior hablaba de otra configuración.
export function recheckHealth(id: string) {
    void check(id, true)
}

// --- Reloj de sondeo ---------------------------------------------------------

const attention = () => document.visibilityState === 'visible' && document.hasFocus()

function tick(id: string) {
    if (attention()) void check(id, false)
}

function catchUp() {
    if (!attention()) return
    const now = Date.now()
    entries.forEach((e, id) => {
        if (e.pollers > 0 && now - e.health.checkedAt >= HEALTH_POLL_MS) void check(id, false)
    })
}

let listening = false
function ensureListeners() {
    if (listening) return
    listening = true
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
}

function startPolling(id: string): () => void {
    const e = entryOf(id)
    e.pollers++
    ensureListeners()
    if (e.pollers === 1) e.timer = window.setInterval(() => tick(id), HEALTH_POLL_MS)
    // La lectura de arranque no espera al primer tic: al elegir el agente el
    // punto tiene que decir algo ya.
    if (attention() || e.health.status === 'unknown') void check(id, false)
    return () => {
        e.pollers--
        if (e.pollers <= 0 && e.timer !== null) {
            window.clearInterval(e.timer)
            e.timer = null
        }
    }
}

function subscribeTo(id: string, fn: () => void): () => void {
    const e = entryOf(id)
    e.subs.add(fn)
    return () => {
        e.subs.delete(fn)
    }
}

// --- Hooks -------------------------------------------------------------------

// Estado de salud del servidor detrás de `agentId`. Con `poll` (el chat está a
// la vista) consulta al montar y cada 60 s; sin él, solo lee lo que ya hay.
// Para un CLI devuelve `null` y no hace nada.
export function useModelServerHealth(agentId: string, poll: boolean): {health: Health; refresh: () => void} | null {
    const id = serverIdOf(agentId)
    const health = useSyncExternalStore(
        (fn) => (id ? subscribeTo(id, fn) : () => {}),
        () => (id ? entryOf(id).health : UNKNOWN),
    )
    useEffect(() => {
        if (!id || !poll) return
        return startPolling(id)
    }, [id, poll])
    const refresh = useCallback(() => {
        if (id) void check(id, true)
    }, [id])
    return id ? {health, refresh} : null
}

// Una lectura de cada servidor de `agentIds` si no la tienen o ya envejeció,
// SIN sondeo periódico: alimenta los puntos de las opciones de un selector
// (el servidor elegido se sondea aparte, con `useModelServerHealth`).
export function useModelServersHealth(agentIds: string[], enabled: boolean): Record<string, Health> {
    const ids = agentIds.map(serverIdOf).filter(Boolean)
    const key = ids.join('|')
    const [, bump] = useState(0)
    useEffect(() => {
        if (!enabled || !key) return
        const list = key.split('|')
        const offs = list.map((id) => subscribeTo(id, () => bump((n) => n + 1)))
        const now = Date.now()
        for (const id of list) {
            const h = entryOf(id).health
            if (h.status === 'unknown' || now - h.checkedAt >= HEALTH_POLL_MS) void check(id, false)
        }
        return () => offs.forEach((off) => off())
    }, [enabled, key])
    const out: Record<string, Health> = {}
    for (const id of ids) out[MODEL_SERVER_PREFIX + id] = entryOf(id).health
    return out
}
