import type {EditorView} from '@codemirror/view'
import Icon from '../Icon'
import {useT} from '../../i18n'

// Barra de formato de una nota.
//
// **Por qué existe.** El editor guarda Markdown, y eso no se negocia: es lo que
// hace que una nota se abra en Obsidian y no quede presa de esta app. Pero
// *escribir* Markdown a mano —acordarse de que son dos asteriscos para negrita,
// tres almohadillas para un subtítulo, un guion y un espacio para una viñeta—
// es una barrera para cualquiera que no programe. Esta barra hace lo mismo que
// haría esa persona en Word: seleccionar y apretar un botón.
//
// El formato se aplica **envolviendo la selección**, no reemplazándola, así que
// nada de lo escrito se pierde. Y si no hay nada seleccionado, se inserta la
// marca con el cursor adentro, listo para escribir.

// Alineaciones posibles del documento.
//
// **No se escriben en el Markdown.** Markdown no tiene alineación: para tenerla
// habría que meter `<div align="center">` en el texto, y eso deja el documento
// lleno de HTML que en cualquier otro editor se ve como basura. Se guarda como
// metadato de la nota y se aplica a la vista — el texto sigue siendo texto.
export type NoteAlign = 'left' | 'center' | 'right' | 'justify'

const ALIGNS: {value: NoteAlign; icon: string; key: 'alignLeft' | 'alignCenter' | 'alignRight' | 'alignJustify'}[] = [
    {value: 'left', icon: 'format_align_left', key: 'alignLeft'},
    {value: 'center', icon: 'format_align_center', key: 'alignCenter'},
    {value: 'right', icon: 'format_align_right', key: 'alignRight'},
    {value: 'justify', icon: 'format_align_justify', key: 'alignJustify'},
]

interface Props {
    view: EditorView | null
    align: NoteAlign
    onAlign: (a: NoteAlign) => void
    // Pega una imagen desde el disco. La sube el contenedor, que es quien
    // sabe a qué nota pertenece.
    onPickImage: () => void
    onToggleFold: () => void
}

// wrapSelection envuelve lo seleccionado con un prefijo y un sufijo.
//
// Si ya estaba envuelto, lo desenvuelve: apretar "negrita" dos veces tiene que
// dejar el texto como estaba, no acumular asteriscos.
function wrapSelection(view: EditorView | null, before: string, after = before) {
    if (!view) return
    const {from, to} = view.state.selection.main
    const selected = view.state.sliceDoc(from, to)

    const alreadyWrapped =
        selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length
    const insert = alreadyWrapped
        ? selected.slice(before.length, selected.length - after.length)
        : before + selected + after

    view.dispatch({
        changes: {from, to, insert},
        // Sin selección previa, el cursor queda ENTRE las marcas para poder
        // escribir de una: dejarlo al final obligaría a moverse a mano.
        selection: selected
            ? {anchor: from, head: from + insert.length}
            : {anchor: from + (alreadyWrapped ? 0 : before.length)},
    })
    view.focus()
}

// prefixLines antepone algo a cada línea de la selección (encabezados, listas,
// citas). Vuelve a apretar y lo saca, por el mismo motivo que wrapSelection.
function prefixLines(view: EditorView | null, prefix: string) {
    if (!view) return
    const {from, to} = view.state.selection.main
    const first = view.state.doc.lineAt(from)
    const last = view.state.doc.lineAt(to)

    const lines: string[] = []
    for (let n = first.number; n <= last.number; n++) lines.push(view.state.doc.line(n).text)

    const allPrefixed = lines.every((l) => l.startsWith(prefix))
    const next = lines.map((l) => (allPrefixed ? l.slice(prefix.length) : prefix + l))

    view.dispatch({
        changes: {from: first.from, to: last.to, insert: next.join('\n')},
        selection: {anchor: first.from + next.join('\n').length},
    })
    view.focus()
}

export default function NoteToolbar({view, align, onAlign, onPickImage, onToggleFold}: Props) {
    const t = useT()
    const tb = t.notes.toolbar
    const btn = 'rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'

    return (
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-outline-variant bg-surface-container px-2 py-1">
            <button onClick={() => prefixLines(view, '# ')} title={tb.h1} className={btn}>
                <span className="px-0.5 text-ui-13 font-bold">H1</span>
            </button>
            <button onClick={() => prefixLines(view, '## ')} title={tb.h2} className={btn}>
                <span className="px-0.5 text-ui-12 font-bold">H2</span>
            </button>
            <button onClick={() => prefixLines(view, '### ')} title={tb.h3} className={btn}>
                <span className="px-0.5 text-ui-11 font-bold">H3</span>
            </button>

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            <button
                onClick={() => wrapSelection(view, '**')}
                title={tb.bold}
                className={btn}
            >
                <Icon name="format_bold" size={15} />
            </button>
            <button
                onClick={() => wrapSelection(view, '*')}
                title={tb.italic}
                className={btn}
            >
                <Icon name="format_italic" size={15} />
            </button>
            <button onClick={() => wrapSelection(view, '~~')} title={tb.strike} className={btn}>
                <Icon name="format_strikethrough" size={15} />
            </button>
            <button onClick={() => wrapSelection(view, '`')} title={tb.inlineCode} className={btn}>
                <Icon name="code" size={15} />
            </button>

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            <button onClick={() => prefixLines(view, '- ')} title={tb.bullets} className={btn}>
                <Icon name="format_list_bulleted" size={15} />
            </button>
            <button onClick={() => prefixLines(view, '1. ')} title={tb.numbered} className={btn}>
                <Icon name="format_list_numbered" size={15} />
            </button>
            <button onClick={() => prefixLines(view, '- [ ] ')} title={tb.checklist} className={btn}>
                <Icon name="checklist" size={15} />
            </button>
            <button onClick={() => prefixLines(view, '> ')} title={tb.quote} className={btn}>
                <Icon name="format_quote" size={15} />
            </button>

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            {/* Alineación del documento. Se guarda con la nota, no en el
                Markdown: ver NoteAlign. */}
            {ALIGNS.map((a) => (
                <button
                    key={a.value}
                    onClick={() => onAlign(a.value)}
                    title={tb.alignTitle({label: tb[a.key]})}
                    className={
                        align === a.value
                            ? 'rounded bg-primary/20 p-1 text-primary'
                            : btn
                    }
                >
                    <Icon name={a.icon} size={15} />
                </button>
            ))}

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            <button
                onClick={() => wrapSelection(view, '[', '](url)')}
                title={tb.webLink}
                className={btn}
            >
                <Icon name="link" size={15} />
            </button>
            <button
                onClick={() => wrapSelection(view, '[[', ']]')}
                title={tb.noteLink}
                className={btn}
            >
                <Icon name="hub" size={15} />
            </button>
            <button
                onClick={onPickImage}
                title={tb.image}
                className={btn}
            >
                <Icon name="image" size={15} />
            </button>
            <button
                onClick={() =>
                    wrapSelection(view, `\n| ${tb.tableField} | ${tb.tableValue} |\n|---|---|\n| `, ' |  |\n')
                }
                title={tb.table}
                className={btn}
            >
                <Icon name="table" size={15} />
            </button>
            <button onClick={onToggleFold} title={tb.fold} className={btn}>
                <Icon name="unfold_more" size={15} />
            </button>

            <span
                className="ml-auto text-ui-10 text-on-surface-variant/70"
                title={tb.markdownTitle}
            >
                Markdown
            </span>
        </div>
    )
}
