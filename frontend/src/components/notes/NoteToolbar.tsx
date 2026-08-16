import type {EditorView} from '@codemirror/view'
import Icon from '../Icon'

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

interface Props {
    view: EditorView | null
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

export default function NoteToolbar({view, onPickImage, onToggleFold}: Props) {
    const btn = 'rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'

    return (
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-outline-variant bg-surface-container px-2 py-1">
            <button onClick={() => prefixLines(view, '# ')} title="Título de sección (# en Markdown)" className={btn}>
                <span className="px-0.5 text-[13px] font-bold">H1</span>
            </button>
            <button onClick={() => prefixLines(view, '## ')} title="Subtítulo (## en Markdown)" className={btn}>
                <span className="px-0.5 text-[12px] font-bold">H2</span>
            </button>
            <button onClick={() => prefixLines(view, '### ')} title="Sub-subtítulo (### en Markdown)" className={btn}>
                <span className="px-0.5 text-[11px] font-bold">H3</span>
            </button>

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            <button
                onClick={() => wrapSelection(view, '**')}
                title="Negrita — seleccioná el texto y apretá acá (Cmd/Ctrl+B)"
                className={btn}
            >
                <Icon name="format_bold" size={15} />
            </button>
            <button
                onClick={() => wrapSelection(view, '*')}
                title="Itálica — seleccioná el texto y apretá acá (Cmd/Ctrl+I)"
                className={btn}
            >
                <Icon name="format_italic" size={15} />
            </button>
            <button onClick={() => wrapSelection(view, '~~')} title="Tachado" className={btn}>
                <Icon name="format_strikethrough" size={15} />
            </button>
            <button onClick={() => wrapSelection(view, '`')} title="Código en línea" className={btn}>
                <Icon name="code" size={15} />
            </button>

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            <button onClick={() => prefixLines(view, '- ')} title="Lista con viñetas" className={btn}>
                <Icon name="format_list_bulleted" size={15} />
            </button>
            <button onClick={() => prefixLines(view, '1. ')} title="Lista numerada" className={btn}>
                <Icon name="format_list_numbered" size={15} />
            </button>
            <button onClick={() => prefixLines(view, '- [ ] ')} title="Lista de verificación" className={btn}>
                <Icon name="checklist" size={15} />
            </button>
            <button onClick={() => prefixLines(view, '> ')} title="Cita" className={btn}>
                <Icon name="format_quote" size={15} />
            </button>

            <span className="mx-1 h-4 w-px bg-outline-variant" />

            <button
                onClick={() => wrapSelection(view, '[', '](url)')}
                title="Enlace a una página web. Para enlazar OTRA NOTA, escribí [[ y elegila de la lista."
                className={btn}
            >
                <Icon name="link" size={15} />
            </button>
            <button
                onClick={() => wrapSelection(view, '[[', ']]')}
                title="Enlace a otra nota. También se abre escribiendo [[ en el texto."
                className={btn}
            >
                <Icon name="hub" size={15} />
            </button>
            <button
                onClick={onPickImage}
                title="Inserta una imagen PNG o JPG. Se guarda CIFRADA dentro del vault, igual que el texto de la nota, y los PNG se recomprimen sin perder un solo píxel. También podés pegarla con Cmd/Ctrl+V."
                className={btn}
            >
                <Icon name="image" size={15} />
            </button>
            <button
                onClick={() =>
                    wrapSelection(view, '\n| Campo | Valor |\n|---|---|\n| ', ' |  |\n')
                }
                title="Tabla de dos columnas"
                className={btn}
            >
                <Icon name="table" size={15} />
            </button>
            <button onClick={onToggleFold} title="Bloque plegable, para el detalle largo" className={btn}>
                <Icon name="unfold_more" size={15} />
            </button>

            <span
                className="ml-auto text-[10px] text-on-surface-variant/70"
                title="La nota se guarda como Markdown puro: exportada, se abre en Obsidian o en cualquier editor de texto sin perder nada."
            >
                Markdown
            </span>
        </div>
    )
}
