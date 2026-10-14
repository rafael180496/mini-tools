import {Prec} from '@codemirror/state'
import type {Extension} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {FormatSQL} from '../../wailsjs/go/main/App'
import {settled} from './sqlIntel'

// «Formatear SQL», el Reformat Code de DataGrip. Todo lo que decide cómo
// queda el texto vive en Go (backend/sqlformat); acá solo se elige QUÉ se
// formatea y se aplica la respuesta.
//
// Con una selección se formatea la selección; sin ella, el documento entero.
// En los dos casos el formateador deja intactos los bloques PL/SQL, el DDL y
// los comandos SQL*Plus, así que formatear un script de instalación entero no
// le toca los procedimientos.
//
// Es un solo cambio en el historial: un Ctrl+Z lo deshace completo.
export async function formatSqlInView(view: EditorView): Promise<boolean> {
    if (view.state.readOnly) return false
    const sel = view.state.selection.main
    const from = sel.empty ? 0 : sel.from
    const to = sel.empty ? view.state.doc.length : sel.to
    const doc = view.state.doc
    const text = view.state.sliceDoc(from, to)
    if (!text.trim()) return false

    const formatted = await settled(FormatSQL(text))
    if (formatted === null || formatted === text) return false
    // Si se escribió algo mientras Go contestaba, el rango ya no es el que se
    // mandó: aplicar la respuesta pisaría lo tecleado. Se descarta y listo.
    if (view.state.doc !== doc) return false

    view.dispatch({
        changes: {from, to, insert: formatted},
        selection: sel.empty ? {anchor: Math.min(sel.head, from + formatted.length)} : {anchor: from, head: from + formatted.length},
        userEvent: 'input.format',
        scrollIntoView: true,
    })
    return true
}

// ⌥⌘L / Ctrl+Alt+L como en DataGrip, y Shift+Alt+F como en VS Code: cada
// quien llega con los dedos de su editor. Precedencia alta para ganarle a
// cualquier binding del basicSetup sobre las mismas teclas.
export const sqlFormatKeymap: Extension = Prec.high(
    keymap.of([
        {key: 'Mod-Alt-l', run: (v) => (void formatSqlInView(v), true), preventDefault: true},
        {key: 'Shift-Alt-f', run: (v) => (void formatSqlInView(v), true), preventDefault: true},
    ]),
)
