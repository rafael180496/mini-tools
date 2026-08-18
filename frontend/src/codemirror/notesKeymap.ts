import {Prec, type Extension} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'

// Enter al final de un texto con formato: salta el cierre en vez de partirlo.
//
// **El bug que arregla.** Se escribe `` `código` `` —o la barra de formato lo
// envuelve, o el cierre lo pone el autocompletado de pares— y el cursor queda
// ANTES de la marca de cierre, que es texto real aunque la vista en vivo la
// esconda. Apretar Enter ahí parte el par: el contenido queda en una línea y la
// comilla de cierre sola en la siguiente. El formato desaparece —ya no hay par
// que cerrar— y encima queda un carácter suelto que nadie escribió.
//
// Es el momento en que más se aprieta Enter: recién terminado de escribir lo
// que estaba entre marcas.
//
// **Qué hace.** Si entre el cursor y el fin de línea SOLO quedan marcas de
// cierre, mueve el cursor detrás de ellas y deja que el Enter normal siga su
// curso. "Su curso" importa: así el salto de línea lo sigue insertando el
// comando de siempre, que es el que continúa una lista (`- `, `1. `) o una
// cita. Reimplementar el salto acá habría roto eso.
//
// Va en `Prec.highest` porque el lenguaje Markdown trae su propio Enter (el que
// continúa las listas) y se registra antes: sin la precedencia, esto no llegaría
// a ejecutarse nunca.

// CLOSERS son las marcas que cierran algo, con la marca que las abre.
//
// Se exige que la apertura esté ANTES en la misma línea: sin esa comprobación,
// una línea que termina en `***` —que es una regla horizontal, no un cierre— o
// un paréntesis de una oración normal harían saltar el cursor sin motivo.
const CLOSERS: Record<string, string> = {
    '`': '`',
    '*': '*',
    '_': '_',
    '~': '~',
    ']': '[',
    ')': '(',
}

// escapesClosingMarks decide si el resto de la línea es solo cierre.
function escapesClosingMarks(before: string, rest: string): boolean {
    if (rest === '') return false
    for (const ch of rest) {
        const opener = CLOSERS[ch]
        if (!opener) return false
        if (!before.includes(opener)) return false
    }
    return true
}

export function notesEnterEscapesMarks(): Extension {
    return Prec.highest(
        keymap.of([
            {
                key: 'Enter',
                run: (view: EditorView) => {
                    const {state} = view
                    const range = state.selection.main
                    // Con texto seleccionado, Enter reemplaza: no hay nada que
                    // saltar.
                    if (!range.empty) return false

                    const line = state.doc.lineAt(range.head)
                    const at = range.head - line.from
                    if (!escapesClosingMarks(line.text.slice(0, at), line.text.slice(at))) return false

                    // Solo se mueve el cursor. Se devuelve `false` a propósito:
                    // el siguiente Enter de la cadena —el de Markdown, que
                    // continúa listas— ya ve el cursor movido y hace el salto.
                    view.dispatch({selection: {anchor: line.to}, scrollIntoView: true})
                    return false
                },
            },
        ]),
    )
}
