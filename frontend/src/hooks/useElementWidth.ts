import {useEffect, useState} from 'react'
import type {RefObject} from 'react'

// Ancho actual de un elemento, medido con ResizeObserver.
//
// Es el ancho del CONTENEDOR y no el de la ventana (`window.innerWidth`, una
// media query): una pestaña puede estar angosta con la ventana enorme —la barra
// lateral abierta, el panel del agente acoplado a un costado— y la disposición
// tiene que responder a lo que la pestaña realmente tiene para dibujarse.
//
// Devuelve 0 hasta la primera medición; quien lo usa debe tratar 0 como «todavía
// no sé» y no como «angosto», o la pantalla parpadea en modo compacto al abrir.
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
    const [width, setWidth] = useState(0)
    useEffect(() => {
        const el = ref.current
        if (!el) return
        setWidth(Math.round(el.getBoundingClientRect().width))
        const ro = new ResizeObserver((entries) => {
            const w = Math.round(entries[0]?.contentRect.width ?? 0)
            // Una pestaña oculta (display:none) mide 0: se ignora para que al
            // volver no pase por un cuadro compacto.
            if (w > 0) setWidth(w)
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [ref])
    return width
}
