import type {MouseEvent, PointerEvent} from 'react'

// Cerrar una pestaña con el CLIC CENTRAL de la rueda, como en VS Code, los
// navegadores y cualquier editor con pestañas.
//
// Es el gesto que ya tiene aprendido quien cierra pestañas todo el día: apuntar
// y apretar la rueda, sin buscar la ✕ de 12px. La ✕ se queda donde está — esto
// es un atajo, no un reemplazo.
//
// Devuelve los dos manejadores que hacen falta, no uno:
//
//   - `onAuxClick` es el que cierra. `onClick` no sirve: en un `<div>`/`<span>`
//     el botón del medio no dispara `click`, solo `auxclick`.
//   - `onPointerDown` cancela el evento del botón central antes de que el
//     navegador entre en modo desplazamiento automático (el cursor de flechas
//     que queda pegado y desplaza la lista sola). Sin esto, cerrar una pestaña
//     dejaba la barra desplazándose.
//
// Se usa con spread sobre el elemento de la pestaña. Cuando ese elemento ya
// tiene un `onPointerDown` propio —el de arrastrar para reordenar de dnd-kit,
// por ejemplo— hay que encadenarlos a mano: ver `SortableTab` en
// `components/editor/EditorTabs.tsx`.
export function closeOnMiddleClick(close: () => void) {
    return {
        onAuxClick: (e: MouseEvent) => {
            if (e.button !== 1) return
            e.preventDefault()
            e.stopPropagation()
            close()
        },
        onPointerDown: (e: PointerEvent) => {
            if (e.button === 1) e.preventDefault()
        },
    }
}

// El texto que se agrega al tooltip de una pestaña que se puede cerrar así. Va
// en un solo lugar para que las tres barras de pestañas digan lo mismo: un
// atajo que no está escrito en ningún lado es un atajo que solo conoce quien lo
// programó.
export const MIDDLE_CLICK_HINT = ' · clic central de la rueda para cerrar'
