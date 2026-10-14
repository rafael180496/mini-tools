import {StateEffect, StateField, type EditorState, type TransactionSpec} from '@codemirror/state'
import {Decoration, EditorView, WidgetType, type DecorationSet} from '@codemirror/view'

// El tiempo de ejecución junto a cada sentencia, en el propio editor — lo que
// DataGrip 2026.2 empezó a mostrar al lado de la consulta.
//
// Hasta ahora el resultado de una sentencia vivía solo abajo, en la consola o
// en el pie de la grilla. Con un script de diez sentencias había que contar
// renglones de la consola para saber cuál tardó cuatro minutos; con la marca
// al final de su línea, se ve sobre el texto mismo.
//
// Las marcas son decoraciones, no texto: no se guardan, no se copian y no
// viajan a la base. Se mueven con las ediciones (se mapean por los cambios) y
// volver a ejecutar una línea reemplaza su marca en vez de apilar otra.

export type ExecMarkStatus = 'done' | 'error' | 'cancelled'

export interface ExecMark {
    status: ExecMarkStatus
    // Texto ya armado ("412 ms · 23 filas", "error", "cancelada") y el tooltip
    // con el detalle; los arma quien conoce el idioma y los formatos.
    label: string
    title: string
}

class ExecMarkWidget extends WidgetType {
    constructor(readonly mark: ExecMark) {
        super()
    }

    eq(other: ExecMarkWidget) {
        return other.mark.label === this.mark.label && other.mark.status === this.mark.status && other.mark.title === this.mark.title
    }

    toDOM() {
        const span = document.createElement('span')
        span.className = `cm-execmark cm-execmark-${this.mark.status}`
        span.title = this.mark.title
        const icon = document.createElement('span')
        icon.className = 'cm-execmark-icon'
        icon.textContent = this.mark.status === 'done' ? 'check' : this.mark.status === 'error' ? 'error' : 'block'
        span.append(icon, document.createTextNode(this.mark.label))
        return span
    }

    ignoreEvent() {
        return true
    }
}

const addMark = StateEffect.define<{pos: number; mark: ExecMark}>()
const clearMarks = StateEffect.define<null>()

// Tope de marcas por pestaña: un script de miles de sentencias no debería
// llenar el editor de widgets. Se descartan las más viejas.
const MAX_MARKS = 300

export const execTimeField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        deco = deco.map(tr.changes)
        for (const e of tr.effects) {
            if (e.is(clearMarks)) {
                deco = Decoration.none
            } else if (e.is(addMark)) {
                const line = tr.state.doc.lineAt(Math.min(e.value.pos, tr.state.doc.length))
                // Una marca por renglón: la nueva corrida reemplaza a la vieja.
                deco = deco.update({filterFrom: line.from, filterTo: line.to, filter: () => false})
                deco = deco.update({
                    add: [Decoration.widget({widget: new ExecMarkWidget(e.value.mark), side: 1}).range(line.to)],
                })
                if (deco.size > MAX_MARKS) {
                    let skip = deco.size - MAX_MARKS
                    deco = deco.update({filter: () => skip-- <= 0})
                }
            }
        }
        return deco
    },
    provide: (f) => EditorView.decorations.from(f),
})

export const execTimeTheme = EditorView.baseTheme({
    '.cm-execmark': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        marginLeft: '1.5em',
        padding: '0 6px',
        borderRadius: '9px',
        fontFamily: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
        fontSize: '0.78em',
        lineHeight: '1.5',
        verticalAlign: 'middle',
        userSelect: 'none',
        backgroundColor: 'color-mix(in srgb, var(--color-on-surface) 7%, transparent)',
        color: 'var(--color-on-surface-variant)',
    },
    '.cm-execmark-error': {
        backgroundColor: 'color-mix(in srgb, var(--color-error) 16%, transparent)',
        color: 'var(--color-error)',
    },
    '.cm-execmark-cancelled': {
        color: 'var(--color-tertiary)',
    },
    '.cm-execmark-icon': {
        fontFamily: "'Material Symbols Outlined'",
        fontSize: '1.15em',
        fontFeatureSettings: "'liga'",
        lineHeight: '1',
    },
    '.cm-execmark-done .cm-execmark-icon': {
        color: 'var(--color-primary)',
    },
})

// execMarkSpec ubica una sentencia ejecutada en el documento y arma la
// transacción que deja su marca. `sqlText` es el texto exacto que el backend
// devolvió para esa sentencia; se busca primero desde `origin` (dónde empezaba
// lo que se mandó a ejecutar), que es lo que desempata dos sentencias
// idénticas en el mismo archivo. Null si el texto ya no está — se editó
// mientras corría —, y entonces no se marca nada en vez de marcar otra línea.
export function execMarkSpec(state: EditorState, sqlText: string, origin: number, mark: ExecMark): TransactionSpec | null {
    const needle = sqlText.trim()
    if (!needle) return null
    const doc = state.doc.toString()
    let at = doc.indexOf(needle, Math.max(0, Math.min(origin, doc.length)))
    if (at < 0) at = doc.indexOf(needle)
    if (at < 0) return null
    return {effects: addMark.of({pos: at + needle.length, mark})}
}

export function clearExecMarksSpec(): TransactionSpec {
    return {effects: clearMarks.of(null)}
}
