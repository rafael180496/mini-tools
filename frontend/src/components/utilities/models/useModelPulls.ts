import {useCallback, useEffect, useRef, useState} from 'react'
import {ModelServerCancelPull, ModelServerDismissPull, ModelServerPull, ModelServerPulls} from '../../../../wailsjs/go/main/App'
import type {main} from '../../../../wailsjs/go/models'
import {EventsOn} from '../../../../wailsjs/runtime'

// Las descargas de modelos en curso.
//
// Corren en el backend, no en la pestaña: cerrarla no las corta, y al volver a
// abrirla se retoman con `ModelServerPulls` (el último estado de cada una). El
// avance llega por el evento `model-pull:<id>`, uno por descarga.
//
// **Suscribirse antes de preguntar.** El evento de una descarga que falla al
// instante (un nombre que no existe) puede salir antes de que esta pestaña
// alcance a suscribirse; por eso, después de suscribirse, se pide el snapshot:
// lo que se perdió está ahí.

export type Pull = main.ModelPullEvent

// Una actualización vieja no pisa a una más nueva: el snapshot y el evento
// viajan por caminos distintos y pueden llegar cruzados. La descarga terminada
// siempre gana, y el porcentaje no retrocede (el backend ya lo garantiza).
function newer(cur: Pull | undefined, next: Pull): boolean {
    if (!cur) return true
    if (cur.done) return false
    return next.done || next.percent >= cur.percent
}

export function useModelPulls(enabled: boolean, onFinished: (pull: Pull) => void) {
    const [pulls, setPulls] = useState<Record<string, Pull>>({})
    const subs = useRef(new Map<string, () => void>())
    const finishedRef = useRef(onFinished)
    finishedRef.current = onFinished
    // Las que ya se avisaron como terminadas: el evento y el snapshot pueden
    // traer las dos el mismo final.
    const announced = useRef(new Set<string>())

    const apply = useCallback((ev: Pull) => {
        setPulls((prev) => (newer(prev[ev.pullId], ev) ? {...prev, [ev.pullId]: ev} : prev))
        if (ev.done && !announced.current.has(ev.pullId)) {
            announced.current.add(ev.pullId)
            finishedRef.current(ev)
        }
    }, [])

    const watch = useCallback(
        (id: string) => {
            if (subs.current.has(id)) return
            subs.current.set(id, EventsOn(`model-pull:${id}`, (ev: Pull) => apply(ev)))
        },
        [apply],
    )

    const sync = useCallback(async () => {
        const list = (await ModelServerPulls()) ?? []
        for (const ev of list) {
            // Las ya terminadas antes de abrir la pestaña no se vuelven a
            // anunciar: refrescar la tabla por algo que ya se vio es ruido.
            if (ev.done) announced.current.add(ev.pullId)
            else watch(ev.pullId)
            apply(ev)
        }
    }, [apply, watch])

    useEffect(() => {
        if (!enabled) return
        void sync().catch(() => {})
    }, [enabled, sync])

    useEffect(() => {
        const current = subs.current
        return () => {
            current.forEach((off) => off())
            current.clear()
        }
    }, [])

    // start devuelve el id; un fallo al iniciar (nombre inválido, ya en curso,
    // servidor que no descarga) se propaga para que la pantalla lo muestre.
    const start = useCallback(
        async (serverId: string, model: string) => {
            const id = await ModelServerPull(serverId, model)
            watch(id)
            await sync()
            return id
        },
        [watch, sync],
    )

    const cancel = useCallback((id: string) => ModelServerCancelPull(id), [])

    const dismiss = useCallback(async (id: string) => {
        const off = subs.current.get(id)
        if (off) {
            off()
            subs.current.delete(id)
        }
        await ModelServerDismissPull(id)
        setPulls((prev) => {
            const next = {...prev}
            delete next[id]
            return next
        })
    }, [])

    return {pulls: Object.values(pulls).sort((a, b) => a.startedAt - b.startedAt), start, cancel, dismiss}
}
