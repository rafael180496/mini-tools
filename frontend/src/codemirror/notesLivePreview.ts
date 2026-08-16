import {syntaxTree} from '@codemirror/language'
import {RangeSetBuilder, type Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate} from '@codemirror/view'
import {GetNoteImage} from '../../wailsjs/go/main/App'

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

// cache de imágenes ya descifradas, por id de asset. Sin esto, cada
// redibujado del editor pediría la imagen de nuevo — y descifrarla no es
// gratis.
const imageCache = new Map<string, string>()
// Ids que ya se pidieron, para no disparar la misma petición cinco veces
// mientras la primera está en vuelo.
const pending = new Set<string>()

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

        const cached = imageCache.get(this.assetId)
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

        if (!pending.has(this.assetId)) {
            pending.add(this.assetId)
            GetNoteImage(this.assetId)
                .then((asset) => {
                    imageCache.set(this.assetId, `data:${asset.mime};base64,${asset.data}`)
                    // Un cambio vacío obliga a recalcular las decoraciones, que
                    // es lo que hace que el widget se vuelva a dibujar ya con
                    // la imagen en el cache.
                    view.dispatch({})
                })
                .catch(() => {
                    ph.textContent = `${this.alt || 'imagen'} — no se pudo cargar`
                })
                .finally(() => pending.delete(this.assetId))
        }
        return wrap
    }

    // La imagen no acepta el cursor adentro: se navega por encima, como un
    // bloque.
    ignoreEvent() {
        return false
    }
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

    for (const {from, to} of view.visibleRanges) {
        syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
                const line = state.doc.lineAt(node.from).number
                if (activeLines.has(line)) return

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
    tagDecorations(view, add)

    found.sort((a, b) => a.from - b.from || a.to - b.to)
    const builder = new RangeSetBuilder<Decoration>()
    for (const f of found) builder.add(f.from, f.to, f.deco)
    return builder.finish()
}

// notesLivePreview es la extensión completa.
export function notesLivePreview(): Extension {
    return [
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
        EditorView.theme({
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
