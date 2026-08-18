import {syntaxTree} from '@codemirror/language'
import {RangeSetBuilder, StateField, type EditorState, type Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate} from '@codemirror/view'
import {cachedNoteImage, loadNoteImage} from '../lib/noteImages'
import {isTableStart, parseTable} from '../lib/markdownTable'

// Vista en vivo del editor de notas: el documento se ve como documento.
//
// **El problema.** Guardar Markdown puro es lo correcto —es lo que hace que una
// nota se abra en Obsidian y no quede presa de esta app— pero *verlo* en crudo
// es una barrera para cualquiera que no programe: `## Diagnóstico` con las dos
// almohadillas a la vista, `**importante**` con cuatro asteriscos, y una imagen
// que es una línea de texto entre corchetes. Alternar a una vista previa aparte
// no lo resuelve: obliga a escribir a ciegas y mirar después.
//
// **Lo que hace esto.** Esconde las marcas de sintaxis y muestra las imágenes,
// **salvo en la línea donde está el cursor** — ahí vuelven a aparecer para
// poder editarlas. Es el mismo comportamiento que el "Live Preview" de
// Obsidian y por la misma razón: uno necesita ver la marca justo cuando la
// está tocando, y no el resto del tiempo.
//
// El texto del documento **no cambia**: esto son decoraciones de la vista. Lo
// que se guarda sigue siendo el Markdown que se escribió.

// Marcas que se esconden. `ListMark` y `QuoteMark` quedan afuera a propósito:
// el guion de una viñeta y el `>` de una cita son la única señal de que esa
// línea es una lista o una cita, y esconderlos dejaría un párrafo suelto.
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark'])

// ImageWidget dibuja la imagen en lugar del `![alt](nota:ID)`.
class ImageWidget extends WidgetType {
    constructor(
        readonly assetId: string,
        readonly alt: string,
    ) {
        super()
    }

    // Dos widgets del mismo asset son intercambiables: sin esto, CodeMirror
    // recrearía el <img> en cada actualización y la imagen parpadearía.
    eq(other: ImageWidget) {
        return other.assetId === this.assetId && other.alt === this.alt
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div')
        wrap.className = 'cm-note-image'

        const cached = cachedNoteImage(this.assetId)
        if (cached) {
            const img = document.createElement('img')
            img.src = cached
            img.alt = this.alt
            img.title = this.alt
            wrap.appendChild(img)
            return wrap
        }

        // Mientras carga se muestra un marco con el texto alternativo, no un
        // hueco: un salto de altura cuando la imagen llega mueve el texto que
        // se está leyendo.
        const ph = document.createElement('span')
        ph.className = 'cm-note-image-loading'
        ph.textContent = this.alt || 'imagen'
        wrap.appendChild(ph)

        // La caché y el "ya lo pedí" los maneja lib/noteImages, compartidos
        // con la vista de lectura: la misma imagen no se descifra dos veces por
        // mirarla en las dos vistas.
        loadNoteImage(this.assetId)
            .then(() => {
                // Un cambio vacío obliga a recalcular las decoraciones, que es
                // lo que hace que el widget se vuelva a dibujar ya con la
                // imagen en la caché.
                view.dispatch({})
            })
            .catch(() => {
                ph.textContent = `${this.alt || 'imagen'} — no se pudo cargar`
            })
        return wrap
    }

    // La imagen no acepta el cursor adentro: se navega por encima, como un
    // bloque.
    ignoreEvent() {
        return false
    }
}

// TableWidget dibuja una tabla de verdad en lugar de las barras verticales.
//
// **Por qué hace falta acá y no alcanza con la vista de lectura.** Una tabla es
// justo lo que no se puede escribir a ciegas: las columnas se alinean con
// barras y guiones, y en crudo son tres renglones de símbolos donde no se ve si
// una celda quedó corrida. Mientras el cursor está adentro se muestra el texto
// tal cual —hay que poder editarlo— y apenas se sale, se ve la tabla.
class TableWidget extends WidgetType {
    constructor(readonly source: string) {
        super()
    }

    // Dos widgets con el mismo texto son intercambiables: sin esto, CodeMirror
    // rearma la tabla en cada tecla y el scroll salta.
    eq(other: TableWidget) {
        return other.source === this.source
    }

    toDOM(): HTMLElement {
        const lines = this.source.split('\n')
        const {header, align, rows} = parseTable(lines, 0)

        const wrap = document.createElement('div')
        wrap.className = 'cm-note-table'
        const table = document.createElement('table')

        const thead = document.createElement('thead')
        const htr = document.createElement('tr')
        header.forEach((h, c) => {
            const th = document.createElement('th')
            th.textContent = h
            th.style.textAlign = align[c] ?? 'left'
            htr.appendChild(th)
        })
        thead.appendChild(htr)
        table.appendChild(thead)

        const tbody = document.createElement('tbody')
        for (const row of rows) {
            const tr = document.createElement('tr')
            // Se recorre por el ENCABEZADO y no por la fila: una fila a la que
            // le falta una celda tiene que dejar el hueco, no correr las
            // columnas siguientes un lugar a la izquierda.
            header.forEach((_, c) => {
                const td = document.createElement('td')
                td.textContent = row[c] ?? ''
                td.style.textAlign = align[c] ?? 'left'
                tr.appendChild(td)
            })
            tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        wrap.appendChild(table)
        return wrap
    }

    // Un clic en la tabla coloca el cursor en el Markdown de abajo, que es lo
    // que la vuelve a mostrar en crudo para editarla.
    ignoreEvent() {
        return false
    }
}

// tableBlocks encuentra los bloques de tabla del documento.
//
// Se recorre el documento entero y no solo lo visible: una tabla arranca dos
// renglones antes de donde uno mira, y detectarla por la mitad dibujaría media
// tabla. Una nota entra de sobra en memoria, así que el costo es irrelevante.
function tableBlocks(state: EditorState): {from: number; to: number; startLine: number; endLine: number}[] {
    const all = state.doc.toString().split('\n')
    const out: {from: number; to: number; startLine: number; endLine: number}[] = []
    for (let n = 0; n < all.length; n++) {
        if (!isTableStart(all, n)) continue
        const {end} = parseTable(all, n)
        out.push({
            from: state.doc.line(n + 1).from,
            to: state.doc.line(end).to,
            startLine: n + 1,
            endLine: end,
        })
        n = end - 1
    }
    return out
}

// tableField provee los widgets de tabla.
//
// **Va en un StateField y no en el ViewPlugin del resto de la vista en vivo**, y
// no es una preferencia de diseño: CodeMirror rechaza las decoraciones de
// bloque —y las que se comen un salto de línea— cuando vienen de un plugin
// ("Block decorations may not be specified via plugins"). Una tabla ocupa
// varias líneas enteras, así que es exactamente ese caso.
const tableField = StateField.define<DecorationSet>({
    create: (state) => buildTableDecorations(state),
    update: (deco, tr) => (tr.docChanged || tr.selection ? buildTableDecorations(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
})

function buildTableDecorations(state: EditorState): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    const all = state.doc.toString().split('\n')

    // Líneas que el cursor toca: ahí la tabla se deja en crudo para poder
    // editarla, igual que el resto de la vista en vivo.
    const activeLines = new Set<number>()
    for (const r of state.selection.ranges) {
        const from = state.doc.lineAt(r.from).number
        const to = state.doc.lineAt(r.to).number
        for (let n = from; n <= to; n++) activeLines.add(n)
    }

    for (const block of tableBlocks(state)) {
        let editing = false
        for (let l = block.startLine; l <= block.endLine; l++) if (activeLines.has(l)) editing = true
        if (editing) continue
        const source = all.slice(block.startLine - 1, block.endLine).join('\n')
        builder.add(block.from, block.to, Decoration.replace({widget: new TableWidget(source), block: true}))
    }
    return builder.finish()
}

// TAG_RE encuentra etiquetas al estilo Obsidian: `#produccion`, `#sgc/oracle`.
//
// **Es distinto de un encabezado y se confunde todo el tiempo.** `# Título`
// —con espacio— es un encabezado; `#titulo` —sin espacio— es una etiqueta.
// Markdown solo define el primero, así que sin esto una etiqueta se veía como
// texto plano y parecía que el editor no formateaba nada.
//
// Acepta letras con tilde y eñe, dígitos, guiones y barras (para etiquetas
// anidadas). Tiene que estar al principio de la línea o después de un espacio:
// un `#` en medio de una palabra (`C#`, un color `#fff`) no es una etiqueta.
const TAG_RE = /(^|\s)(#[\p{L}\d][\p{L}\d_/\-]*)/gu

// tagDecorations marca las etiquetas de las líneas visibles.
//
// Se hace por texto y no por el árbol de sintaxis a propósito: el parser de
// Markdown no conoce las etiquetas —no son parte del formato— así que no hay
// un nodo que consultar.
function tagDecorations(view: EditorView, add: (from: number, to: number, d: Decoration) => void) {
    const {state} = view
    for (const {from, to} of view.visibleRanges) {
        let pos = from
        while (pos <= to) {
            const line = state.doc.lineAt(pos)
            // Una línea de encabezado (`# `, `## `) no lleva etiquetas: ahí el
            // `#` ya significa otra cosa.
            if (!/^\s*#+\s/.test(line.text)) {
                TAG_RE.lastIndex = 0
                let m: RegExpExecArray | null
                while ((m = TAG_RE.exec(line.text)) !== null) {
                    const start = line.from + m.index + m[1].length
                    add(start, start + m[2].length, tagMark)
                }
            }
            pos = line.to + 1
        }
    }
}

const tagMark = Decoration.mark({class: 'cm-note-tag'})

// La pastilla del código en línea. Misma forma que la del modo lectura: que el
// mismo texto cambie de aspecto al pasar de escribir a leer haría dudar de si
// cambió algo del contenido.
const codeMark = Decoration.mark({class: 'cm-note-code'})

// WIKI_RE encuentra un enlace a otra nota: `[[Título]]` o `[[Título|alias]]`.
//
// **Por qué a mano y no por el árbol de sintaxis.** Markdown no tiene enlaces
// wiki: el parser ve `[[Título]]` como un enlace normal `[Título]` metido entre
// corchetes sueltos, así que escondía UNA marca de cada lado y dejaba a la
// vista el corchete que sobraba — el `[prueba 2]]` que se veía en pantalla. Con
// su propia regla, el enlace se ve como se tiene que ver: el título solo,
// subrayado, y los corchetes escondidos.
const WIKI_RE = /\[\[([^\[\]|\n]+)(\|([^\[\]\n]*))?\]\]/g

const hidden = Decoration.replace({})

// wikiDecorations dibuja los enlaces y devuelve sus rangos, para que las marcas
// del parser de Markdown no se metan adentro (dos decoraciones que esconden el
// mismo carácter se pisan).
function wikiDecorations(
    view: EditorView,
    activeLines: Set<number>,
    add: (from: number, to: number, d: Decoration) => void,
): {from: number; to: number}[] {
    const ranges: {from: number; to: number}[] = []
    const {state} = view
    for (const {from, to} of view.visibleRanges) {
        let pos = from
        while (pos <= to) {
            const line = state.doc.lineAt(pos)
            WIKI_RE.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = WIKI_RE.exec(line.text)) !== null) {
                const start = line.from + m.index
                const end = start + m[0].length
                ranges.push({from: start, to: end})

                const target = m[1].trim()
                const editing = activeLines.has(line.number)
                // En la línea del cursor el enlace se deja entero: hay que
                // poder corregir el título que uno está escribiendo. Ahí el
                // clic simple coloca el cursor y hace falta Cmd/Ctrl para
                // abrir — como en cualquier editor.
                const mark = Decoration.mark({
                    class: editing ? 'cm-note-wikilink cm-note-wikilink-editing' : 'cm-note-wikilink',
                    attributes: {
                        'data-wiki': target,
                        ...(editing ? {'data-wiki-mod': '1'} : {}),
                        title: editing
                            ? `Cmd/Ctrl + clic para abrir «${target}». Sin la tecla, el clic edita el enlace.`
                            : `Abrir «${target}». Si todavía no existe, se ofrece crearla.`,
                    },
                })

                if (editing) {
                    add(start, end, mark)
                } else {
                    // `[[` y, si hay alias, también el título de destino: lo
                    // que se muestra es el alias, igual que en Obsidian.
                    const labelFrom = start + 2 + (m[2] ? m[1].length + 1 : 0)
                    add(start, labelFrom, hidden)
                    if (labelFrom < end - 2) add(labelFrom, end - 2, mark)
                    add(end - 2, end, hidden)
                }
            }
            pos = line.to + 1
        }
    }
    return ranges
}

function buildDecorations(view: EditorView): DecorationSet {
    // Se juntan y se ordenan antes de construir: RangeSetBuilder exige orden
    // por posición, y las etiquetas y las marcas de sintaxis se descubren en
    // recorridos distintos.
    const found: {from: number; to: number; deco: Decoration}[] = []
    const add = (from: number, to: number, deco: Decoration) => found.push({from, to, deco})
    const {state} = view
    // Líneas que el cursor está tocando: ahí NO se esconde nada.
    const activeLines = new Set<number>()
    for (const r of state.selection.ranges) {
        const from = state.doc.lineAt(r.from).number
        const to = state.doc.lineAt(r.to).number
        for (let n = from; n <= to; n++) activeLines.add(n)
    }

    // Los enlaces a notas se resuelven primero: sus rangos quedan vedados para
    // el parser de Markdown, que si no les esconde un corchete de cada lado.
    const wikiRanges = wikiDecorations(view, activeLines, add)
    const insideWiki = (from: number, to: number) =>
        wikiRanges.some((r) => from >= r.from && to <= r.to)

    // Las tablas las dibuja tableField (ver por qué ahí). Acá solo se las
    // esquiva: lo que cae adentro de una tabla no lleva ninguna otra
    // decoración, porque el bloque entero ya se reemplazó.
    const tables = tableBlocks(state)
    const insideTable = (from: number, to: number) =>
        tables.some((r) => from >= r.from && to <= r.to)

    for (const {from, to} of view.visibleRanges) {
        syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
                const line = state.doc.lineAt(node.from).number
                if (insideTable(node.from, node.to)) return

                // El código en línea se dibuja como pastilla SIEMPRE, también
                // en la línea del cursor.
                //
                // Es lo que arregla el estado que se veía "roto": al pararse
                // encima, las comillas invertidas reaparecen —hacen falta para
                // poder borrarlas— y sin nada que las contenga el texto quedaba
                // suelto entre dos símbolos, como si el formato se hubiera
                // perdido. Con la pastilla, la línea del cursor y el resto se
                // ven igual: lo único que cambia es que las marcas asoman.
                if (node.name === 'InlineCode') {
                    add(node.from, node.to, codeMark)
                }

                if (activeLines.has(line)) return
                if (insideWiki(node.from, node.to)) return

                if (node.name === 'Image') {
                    // `![alt](nota:ID)` — solo las del vault. Una imagen con
                    // una URL externa se deja como texto: esta app no sale a
                    // internet a buscar nada.
                    const text = state.sliceDoc(node.from, node.to)
                    const m = /^!\[([^\]]*)\]\(nota:([a-f0-9]+)\)$/.exec(text)
                    if (!m) return
                    add(node.from, node.to, Decoration.replace({widget: new ImageWidget(m[2], m[1]), block: false}))
                    return
                }

                if (HIDDEN_MARKS.has(node.name) && node.to > node.from) {
                    add(node.from, node.to, Decoration.replace({}))
                }
            },
        })
    }

    // Las etiquetas se marcan SIEMPRE, también en la línea del cursor: a
    // diferencia de las marcas de sintaxis, acá no hay nada que esconder — la
    // etiqueta se sigue viendo entera, solo que con forma de etiqueta.
    tagDecorations(view, (from, to, deco) => {
        if (insideTable(from, to)) return
        add(from, to, deco)
    })

    found.sort((a, b) => a.from - b.from || a.to - b.to)
    const builder = new RangeSetBuilder<Decoration>()
    for (const f of found) builder.add(f.from, f.to, f.deco)
    return builder.finish()
}

// notesLivePreview es la extensión completa.
//
// `onWikiLink` recibe el título enlazado al hacer clic. Resolverlo —abrir la
// nota o proponer crearla— es del contenedor: acá no se sabe qué notas existen.
export function notesLivePreview(onWikiLink: (title: string) => void): Extension {
    return [
        tableField,
        ViewPlugin.fromClass(
            class {
                decorations: DecorationSet

                constructor(view: EditorView) {
                    this.decorations = buildDecorations(view)
                }

                update(u: ViewUpdate) {
                    // También en `selectionSet`: mover el cursor a una línea
                    // tiene que devolverle sus marcas, que es todo el punto.
                    if (u.docChanged || u.viewportChanged || u.selectionSet) {
                        this.decorations = buildDecorations(u.view)
                    }
                }
            },
            {decorations: (v) => v.decorations},
        ),
        // Clic en un enlace a otra nota. Un enlace que se ve como enlace y no
        // lleva a ningún lado es peor que no formatearlo.
        EditorView.domEventHandlers({
            mousedown: (event) => {
                const el = (event.target as HTMLElement | null)?.closest?.('[data-wiki]') as HTMLElement | null
                if (!el) return false
                if (el.dataset.wikiMod === '1' && !event.metaKey && !event.ctrlKey) return false
                event.preventDefault()
                onWikiLink(el.dataset.wiki ?? '')
                return true
            },
        }),
        EditorView.theme({
            '.cm-note-wikilink': {
                color: 'var(--color-primary)',
                textDecoration: 'underline',
                textDecorationStyle: 'dotted',
                textUnderlineOffset: '3px',
                cursor: 'pointer',
            },
            '.cm-note-wikilink-editing': {
                textDecorationStyle: 'solid',
                opacity: '0.85',
            },
            '.cm-note-image': {
                display: 'block',
                margin: '0.75rem 0',
            },
            '.cm-note-image img': {
                maxWidth: '100%',
                borderRadius: '8px',
                border: '1px solid var(--color-outline-variant)',
                display: 'block',
            },
            // La etiqueta, con forma de etiqueta. Es lo que hace que
            // `#produccion` se vea como algo y no como texto suelto.
            '.cm-note-tag': {
                backgroundColor: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                color: 'var(--color-primary)',
                borderRadius: '9999px',
                padding: '1px 7px',
                fontSize: '0.88em',
                fontWeight: '500',
            },
            // La tabla del editor se ve como la de la vista de lectura: mismos
            // bordes, mismo encabezado. Que cambie de aspecto al pasar de
            // escribir a leer haría dudar de si cambió algo del contenido.
            '.cm-note-table': {
                margin: '0.75rem 0',
                overflowX: 'auto',
            },
            '.cm-note-table table': {
                borderCollapse: 'collapse',
                width: '100%',
                fontSize: '0.92em',
            },
            '.cm-note-table th, .cm-note-table td': {
                border: '1px solid var(--color-outline-variant)',
                padding: '4px 8px',
                verticalAlign: 'top',
            },
            '.cm-note-table th': {
                backgroundColor: 'var(--color-surface-container)',
                fontWeight: '600',
                color: 'var(--color-on-surface)',
            },
            '.cm-note-table td': {color: 'var(--color-on-surface-variant)'},
            '.cm-note-code': {
                backgroundColor: 'var(--color-surface-container-highest)',
                borderRadius: '4px',
                padding: '1px 4px',
            },
            '.cm-note-image-loading': {
                display: 'inline-block',
                padding: '1.5rem 2rem',
                borderRadius: '8px',
                border: '1px dashed var(--color-outline-variant)',
                color: 'var(--color-on-surface-variant)',
                fontSize: '12px',
            },
        }),
    ]
}
