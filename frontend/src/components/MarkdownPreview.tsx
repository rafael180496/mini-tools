import {Fragment, type ReactNode} from 'react'
import Icon from './Icon'
// El lector de tablas es compartido con el editor en vivo de notas: la misma
// tabla tiene que verse igual escribiéndola que leyéndola. Ver lib/markdownTable.
import {isTableStart, parseTable} from '../lib/markdownTable'

// Vista previa de Markdown, hecha a mano y acotada.
//
// Por qué no una librería: la regla de dependencias mínimas
// (.claude/rules/technical.md punto 12) y el mismo criterio que ya se aplicó
// al no traer un parser de SQL ni uno de YAML. Lo que hay que mostrar acá son
// `CLAUDE.md`, `AGENTS.md` y `SKILL.md` —documentos de texto con títulos,
// listas, código y algún link—, no markdown arbitrario de internet.
//
// **Se renderiza a elementos de React, nunca con `dangerouslySetInnerHTML`.**
// Eso es lo que hace que un archivo del repositorio con HTML adentro se vea
// como el texto que es en vez de ejecutarse dentro de la app. Un renderer de
// markdown que arma HTML a mano y lo inyecta es una vía de XSS con pasos
// extra, y acá el contenido viene de archivos que pudo escribir cualquiera.
//
// Cubre lo que la barra de formato de una nota puede producir, que es el
// criterio con el que crece: **tablas** (con su fila de alineación), listas con
// viñetas, numeradas y de verificación —anidadas—, tachado, imágenes, citas,
// cajas al estilo Obsidian, bloques plegables (`<details>`) y bloques de
// código. Un botón de la barra que escriba algo que esto no sabe dibujar es un
// botón que miente, así que las dos cosas se mueven juntas.
//
// Lo que NO cubre, a propósito: HTML embebido arbitrario (solo `<details>`),
// notas al pie y tablas con celdas multilínea. Lo que no reconoce se muestra
// como texto plano — que es exactamente el modo de fallo correcto para una
// vista previa: nunca se pierde contenido, a lo sumo se ve sin formato.

// inline resuelve el formato dentro de una línea: `código`, **negrita**,
// *itálica* y [texto](url).
//
// Se recorre con una sola expresión regular alternada en vez de encadenar
// reemplazos: encadenarlos haría que la negrita de adentro de un bloque de
// código se procese igual, que es el bug clásico de estos renderers.
function inline(
    text: string,
    keyBase: string,
    onWikiLink?: WikiLinkHandler,
    renderImage?: ImageRenderer,
): ReactNode[] {
    const out: ReactNode[] = []
    // El `[[WikiLink]]` va PRIMERO en la alternancia: si fuera después, el
    // patrón de enlace Markdown `[texto](url)` se comería el primer corchete y
    // partiría la referencia a la mitad.
    // La imagen (`![alt](src)`) va antes que el enlace: comparten forma y sin
    // esto el enlace se comería el corchete dejando el `!` suelto a la vista,
    // que es exactamente cómo se veía una imagen en esta vista.
    const re =
        /(\[\[[^\]]+\]\])|(`[^`]+`)|(!\[[^\]]*\]\([^)]+\))|(~~[^~]+~~)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|((?:^|(?<=\s))#[\p{L}\d][\p{L}\d_/-]*)/gu
    let last = 0
    let m: RegExpExecArray | null
    let i = 0

    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const token = m[0]
        const key = `${keyBase}-${i++}`

        if (token.startsWith('#')) {
            // Etiqueta al estilo Obsidian (`#produccion`). Es distinta de un
            // encabezado: `# Título` lleva espacio, una etiqueta no — y esa
            // diferencia de un carácter es la que hacía que pareciera que el
            // editor no formateaba nada.
            out.push(
                <span
                    key={key}
                    title="Etiqueta. Buscá «tag:…» en el buscador de notas para encontrar todas las que la tienen."
                    className="rounded-full bg-primary/15 px-2 py-0.5 text-[0.88em] font-medium text-primary"
                >
                    {token}
                </span>,
            )
        } else if (token.startsWith('[[')) {
            // Enlace entre notas. El alias (`[[Nota|texto]]`) es presentación:
            // se muestra el texto y se navega al título.
            const inner = token.slice(2, -2)
            const bar = inner.indexOf('|')
            const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
            const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
            out.push(
                onWikiLink ? (
                    <button
                        key={key}
                        onClick={() => onWikiLink(target)}
                        title={`Abrir la nota «${target}». Si no existe, se ofrece crearla.`}
                        className="rounded text-primary underline decoration-dotted underline-offset-2 hover:bg-primary/10"
                    >
                        {label}
                    </button>
                ) : (
                    // Sin manejador —por ejemplo en la respuesta de un agente—
                    // se muestra como texto marcado: no hay nada a donde
                    // navegar desde ahí.
                    <span key={key} className="text-primary" title={`Nota: ${target}`}>
                        {label}
                    </span>
                ),
            )
        } else if (token.startsWith('![')) {
            // Imagen. Quién sabe resolver el origen es quien usa la vista: en
            // una nota es un asset CIFRADO del vault (`nota:ID`), y esta capa
            // no tiene por qué saber descifrarlo. Sin resolvedor se muestra el
            // texto alternativo en un marco, nunca se sale a la red a buscar
            // una URL — la app es offline.
            const split = token.indexOf('](')
            const alt = token.slice(2, split)
            const src = token.slice(split + 2, -1)
            const custom = renderImage?.({alt, src, key})
            out.push(
                custom ?? (
                    <span
                        key={key}
                        title={src}
                        className="inline-block rounded border border-dashed border-outline-variant px-2 py-1 text-[11px] text-on-surface-variant"
                    >
                        {alt || 'imagen'}
                    </span>
                ),
            )
        } else if (token.startsWith('~~')) {
            out.push(
                <span key={key} className="line-through opacity-70">
                    {token.slice(2, -2)}
                </span>,
            )
        } else if (token.startsWith('`')) {
            out.push(
                <code key={key} className="rounded bg-surface-container-highest px-1 font-mono text-[11px]">
                    {token.slice(1, -1)}
                </code>,
            )
        } else if (token.startsWith('**')) {
            out.push(
                <strong key={key} className="font-semibold text-on-surface">
                    {token.slice(2, -2)}
                </strong>,
            )
        } else if (token.startsWith('*')) {
            out.push(
                <em key={key}>{token.slice(1, -1)}</em>,
            )
        } else {
            const split = token.indexOf('](')
            const label = token.slice(1, split)
            // El destino se muestra pero NO se hace clickeable: un link de un
            // archivo del repositorio puede apuntar a cualquier lado, y esta
            // vista es para leer el documento, no para navegar desde él.
            const href = token.slice(split + 2, -1)
            out.push(
                <span key={key} title={href} className="text-primary underline decoration-dotted underline-offset-2">
                    {label}
                </span>,
            )
        }
        last = m.index + token.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
}

// WikiLinkHandler navega a la nota que un `[[enlace]]` nombra. Opcional: la
// vista previa se usa también para la respuesta de un agente y para un `.md`
// del repositorio, donde no hay notas a las que ir.
export type WikiLinkHandler = (title: string) => void

// CodeBlockRenderer permite que quien usa la vista previa dibuje un bloque de
// código a su manera. Es lo que convierte un ``` ```sql connection="Prod" ``` `` de
// una nota en un bloque EJECUTABLE, sin que este componente —que también
// renderiza la respuesta de un agente y los `.md` de un repositorio— sepa nada
// de conexiones ni de ejecutar consultas.
//
// Devolver null significa "dibujalo como siempre".
export type CodeBlockRenderer = (info: {lang: string; code: string; key: string}) => ReactNode | null

// ImageRenderer resuelve de dónde sale una imagen. Mismo mecanismo que
// CodeBlockRenderer y por el mismo motivo: en una nota la imagen es un asset
// CIFRADO del vault (`![alt](nota:ID)`) y descifrarlo no es tarea de esta capa,
// que también dibuja la respuesta de un agente y los `.md` de un repositorio.
//
// Devolver null —o no pasar nada— muestra el texto alternativo en un marco. Lo
// que NUNCA hace esta vista es pedir una URL externa: la app es offline y una
// imagen remota en un `.md` cualquiera sería una baliza de rastreo.
export type ImageRenderer = (info: {alt: string; src: string; key: string}) => ReactNode | null

// CALLOUT_STYLES son las cajas resaltadas al estilo Obsidian (`> [!INFO]`).
// Se dibujan con los tokens semánticos de MD3, nunca con colores crudos.
const CALLOUT_STYLES: Record<string, {icon: string; border: string; bg: string; text: string; label: string}> = {
    INFO: {icon: 'info', border: 'border-l-primary', bg: 'bg-primary/8', text: 'text-primary', label: 'Info'},
    TIP: {icon: 'lightbulb', border: 'border-l-tertiary', bg: 'bg-tertiary/8', text: 'text-tertiary', label: 'Tip'},
    WARNING: {
        icon: 'warning',
        border: 'border-l-tertiary',
        bg: 'bg-tertiary/10',
        text: 'text-tertiary',
        label: 'Atención',
    },
    SECURITY: {icon: 'shield', border: 'border-l-error', bg: 'bg-error-container/25', text: 'text-error', label: 'Seguridad'},
    DANGER: {icon: 'dangerous', border: 'border-l-error', bg: 'bg-error-container/25', text: 'text-error', label: 'Peligro'},
    NOTE: {icon: 'sticky_note_2', border: 'border-l-outline-variant', bg: 'bg-surface-container', text: 'text-on-surface-variant', label: 'Nota'},
}

// --- Listas y tablas -------------------------------------------------------

// LIST_RE reconoce los tres tipos de ítem que escribe la barra de formato:
// viñeta (`- `), numerada (`1. `) y de verificación (`- [ ] `). La sangría se
// captura porque es lo único que dice el nivel de anidado.
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

interface ListItem {
    indent: number
    ordered: boolean
    // Marcador de verificación: undefined si el ítem no es una tarea.
    done?: boolean
    text: string
}

function parseListItem(line: string): ListItem | null {
    const m = LIST_RE.exec(line)
    if (!m) return null
    const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3])
    return {
        indent: m[1].replace(/\t/g, '  ').length,
        ordered: /\d/.test(m[2]),
        done: task ? task[1].toLowerCase() === 'x' : undefined,
        text: task ? task[2] : m[3],
    }
}

export default function MarkdownPreview({
    source,
    onWikiLink,
    renderCodeBlock,
    renderImage,
    softBreaks,
}: {
    source: string
    onWikiLink?: WikiLinkHandler
    renderCodeBlock?: CodeBlockRenderer
    renderImage?: ImageRenderer
    // Si un salto de línea simple se ve como salto de línea.
    //
    // **Markdown dice que no**: dentro de un párrafo, los renglones se juntan y
    // solo una línea en blanco lo corta. Esa es la regla correcta para un
    // documento escrito con márgenes de 80 columnas —un `CLAUDE.md`, un
    // `SKILL.md`, la respuesta de un agente— y es el default de acá.
    //
    // **Para una nota es al revés.** Su editor es un documento donde cada
    // renglón se ve donde se escribió, así que juntar dos líneas al leerlas
    // contradice lo que se acababa de ver escribiendo: se tipean dos renglones
    // y la lectura los muestra pegados en uno. Es además lo que hace Obsidian
    // por defecto ("strict line breaks" apagado), que es el editor con el que
    // estas notas tienen que seguir siendo compatibles.
    softBreaks?: boolean
}) {
    const lines = source.split('\n')
    const blocks: ReactNode[] = []

    let i = 0

    // renderList arma una lista y todo lo que cuelgue de ella. Devuelve el nodo
    // y en qué línea sigue el documento.
    //
    // Anida por SANGRÍA, que es como se escribe: un ítem con más espacios que
    // el anterior es hijo suyo. La versión anterior aplanaba todo a un nivel,
    // así que una lista con sub-ítems se veía como una sola tira de viñetas y
    // se perdía justo la jerarquía que alguien se tomó el trabajo de escribir.
    function renderList(start: number, indent: number, keyBase: string): [ReactNode, number] {
        const first = parseListItem(lines[start])!
        const ordered = first.ordered
        const items: ReactNode[] = []
        let n = start

        while (n < lines.length) {
            const item = parseListItem(lines[n])
            if (!item || item.indent < indent) break
            // Un tipo de lista distinto al mismo nivel abre una lista nueva:
            // numerada y con viñetas no se mezclan en la misma.
            if (item.indent === indent && item.ordered !== ordered) break

            if (item.indent > indent) {
                const [child, next] = renderList(n, item.indent, `${keyBase}-${items.length}`)
                // El anidado cuelga del último ítem, no queda suelto al lado.
                items.push(<Fragment key={`sub-${items.length}`}>{child}</Fragment>)
                n = next
                continue
            }

            items.push(
                <li key={items.length} className={item.done !== undefined ? 'list-none' : undefined}>
                    {item.done !== undefined && (
                        <input
                            type="checkbox"
                            checked={item.done}
                            readOnly
                            title="Se marca escribiendo en el editor: esta es la vista de lectura."
                            className="mr-1.5 -ml-4 align-middle accent-primary"
                        />
                    )}
                    <span className={item.done ? 'text-on-surface-variant line-through opacity-70' : undefined}>
                        {inline(item.text, `${keyBase}-${items.length}`, onWikiLink, renderImage)}
                    </span>
                </li>,
            )
            n++
        }

        const cls = `my-1 ml-4 space-y-0.5 ${ordered ? 'list-decimal' : 'list-disc'}`
        return [
            ordered ? (
                <ol key={keyBase} className={cls}>
                    {items}
                </ol>
            ) : (
                <ul key={keyBase} className={cls}>
                    {items}
                </ul>
            ),
            n,
        ]
    }

    while (i < lines.length) {
        const line = lines[i]

        // Frontmatter: se muestra tal cual y no se interpreta. En estos
        // archivos es contenido que importa —de él depende que el CLI cargue
        // el skill— y esconderlo sería ocultar justo lo que hay que revisar.
        if (i === 0 && line.trim() === '---') {
            const buf: string[] = []
            i++
            while (i < lines.length && lines[i].trim() !== '---') {
                buf.push(lines[i])
                i++
            }
            i++
            blocks.push(
                <pre
                    key={`fm-${blocks.length}`}
                    title="Frontmatter: de estos campos depende que el CLI cargue este archivo"
                    className="my-1 overflow-x-auto rounded border border-outline-variant bg-surface-container px-2 py-1 font-mono text-[10px] text-on-surface-variant"
                >
                    {buf.join('\n')}
                </pre>,
            )
            continue
        }

        // Bloque de código cercado.
        if (line.trimStart().startsWith('```')) {
            const lang = line.trim().slice(3).trim()
            const buf: string[] = []
            i++
            while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
                buf.push(lines[i])
                i++
            }
            i++
            const code = buf.join('\n')
            const custom = renderCodeBlock?.({lang, code, key: `code-${blocks.length}`})
            blocks.push(
                custom ?? (
                    <pre
                        key={`code-${blocks.length}`}
                        title={lang || undefined}
                        className="my-1 overflow-x-auto rounded bg-surface-container-highest px-2 py-1 font-mono text-[11px] text-on-surface"
                    >
                        {code}
                    </pre>
                ),
            )
            continue
        }

        // Caja resaltada al estilo Obsidian: una cita cuya primera línea es
        // `> [!TIPO]`. Va antes de la cita normal, que si no se la comería.
        const callout = /^\s*>\s*\[!([A-Za-zÁÉÍÓÚÑ]+)\]\s*(.*)$/.exec(line)
        if (callout) {
            const kind = callout[1].toUpperCase()
            const style = CALLOUT_STYLES[kind] ?? CALLOUT_STYLES.NOTE
            const buf: string[] = []
            if (callout[2].trim()) buf.push(callout[2])
            i++
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                buf.push(lines[i].replace(/^\s*>\s?/, ''))
                i++
            }
            blocks.push(
                <div
                    key={`callout-${blocks.length}`}
                    className={`my-1.5 rounded-r border-l-4 px-2 py-1.5 ${style.border} ${style.bg}`}
                >
                    <p className={`mb-0.5 flex items-center gap-1 text-[11px] font-medium ${style.text}`}>
                        <Icon name={style.icon} size={13} filled />
                        {callout[1].toUpperCase() === kind && CALLOUT_STYLES[kind] ? style.label : callout[1]}
                    </p>
                    {/* Mismo criterio que un párrafo normal: las líneas
                        seguidas son UN párrafo, y una línea en blanco los
                        separa. Renglón por renglón, una caja de tres líneas se
                        veía como tres párrafos sueltos. */}
                    {buf
                        .join('\n')
                        .split(/\n\s*\n/)
                        .filter((p2) => p2.trim())
                        .map((p2, n) => (
                            <p key={n} className="whitespace-pre-wrap text-on-surface">
                                {inline(
                                    p2
                                        .split('\n')
                                        .map((l) => l.trim())
                                        .join(softBreaks ? '\n' : ' '),
                                    `co-${blocks.length}-${n}`,
                                    onWikiLink,
                                    renderImage,
                                )}
                            </p>
                        ))}
                </div>,
            )
            continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
            const level = heading[1].length
            const size = level === 1 ? 'text-base' : level === 2 ? 'text-sm' : 'text-xs'
            blocks.push(
                <p key={`h-${blocks.length}`} className={`mt-2 mb-1 font-semibold text-on-surface ${size}`}>
                    {inline(heading[2], `h-${blocks.length}`, onWikiLink, renderImage)}
                </p>,
            )
            i++
            continue
        }

        // Listas: viñeta, numerada y de verificación, con anidado por sangría.
        const item = parseListItem(line)
        if (item) {
            const [node, next] = renderList(i, item.indent, `list-${blocks.length}`)
            blocks.push(node)
            i = next
            continue
        }

        // Tabla al estilo GitHub. Se dibuja como tabla de verdad —con su
        // encabezado, sus bordes y la alineación que pida la fila de
        // separadores— en vez del amasijo de barras verticales que se veía
        // antes, que además se juntaba en un solo renglón porque para el
        // renderer eran líneas sueltas de un mismo párrafo.
        if (isTableStart(lines, i)) {
            const {header, align, rows, end: n} = parseTable(lines, i)
            const cellAlign = (c: number) => align[c] ?? 'left'
            blocks.push(
                // El scroll horizontal es de la tabla y no de la página: una
                // tabla ancha no puede empujar el ancho del documento entero.
                <div key={`tbl-${blocks.length}`} className="my-2 overflow-x-auto">
                    <table className="w-full border-collapse text-left">
                        <thead>
                            <tr>
                                {header.map((h, c) => (
                                    <th
                                        key={c}
                                        style={{textAlign: cellAlign(c)}}
                                        className="border border-outline-variant bg-surface-container px-2 py-1 font-semibold text-on-surface"
                                    >
                                        {inline(h, `th-${blocks.length}-${c}`, onWikiLink, renderImage)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r, ri) => (
                                <tr key={ri}>
                                    {header.map((_, c) => (
                                        <td
                                            key={c}
                                            style={{textAlign: cellAlign(c)}}
                                            className="border border-outline-variant px-2 py-1 align-top text-on-surface-variant"
                                        >
                                            {inline(r[c] ?? '', `td-${blocks.length}-${ri}-${c}`, onWikiLink, renderImage)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>,
            )
            i = n
            continue
        }

        // Bloque plegable. Es lo que escribe el botón "Ver detalle" de la barra
        // de formato, y sin esto se veía como cuatro líneas de HTML crudo.
        if (line.trim().startsWith('<details')) {
            const buf: string[] = []
            i++
            while (i < lines.length && !lines[i].trim().startsWith('</details>')) {
                buf.push(lines[i])
                i++
            }
            i++
            const body = buf.join('\n')
            const sum = /<summary>([\s\S]*?)<\/summary>/.exec(body)
            blocks.push(
                <details key={`det-${blocks.length}`} className="my-2 rounded border border-outline-variant px-2 py-1">
                    <summary className="cursor-pointer text-on-surface">
                        {inline(sum ? sum[1].trim() : 'Ver detalle', `sum-${blocks.length}`, onWikiLink, renderImage)}
                    </summary>
                    {/* El contenido se dibuja con el mismo renderer: adentro de
                        un plegable vale todo lo que vale afuera. */}
                    <MarkdownPreview
                        source={body.replace(/<summary>[\s\S]*?<\/summary>/, '').trim()}
                        onWikiLink={onWikiLink}
                        renderCodeBlock={renderCodeBlock}
                        renderImage={renderImage}
                        softBreaks={softBreaks}
                    />
                </details>,
            )
            continue
        }

        if (/^\s*>\s?/.test(line)) {
            blocks.push(
                <p
                    key={`q-${blocks.length}`}
                    className="my-3 border-l-[3px] border-primary/50 py-0.5 pl-4 italic text-on-surface-variant"
                >
                    {inline(line.replace(/^\s*>\s?/, ''), `q-${blocks.length}`, onWikiLink, renderImage)}
                </p>,
            )
            i++
            continue
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push(<hr key={`hr-${blocks.length}`} className="my-2 border-outline-variant" />)
            i++
            continue
        }

        if (line.trim() === '') {
            i++
            continue
        }

        // Párrafo: se juntan las líneas seguidas en UNA.
        //
        // No es un detalle de estilo. En Markdown un salto de línea simple no
        // separa párrafos —hay que dejar una línea en blanco—, así que un
        // texto escrito con márgenes de 80 columnas se veía partido en cinco
        // bloques con aire entre medio. Peor: **el formato que cruzaba el
        // salto no se aplicaba**, porque cada línea se interpretaba sola, y
        // una negrita abierta en una línea y cerrada en la siguiente quedaba
        // con los asteriscos a la vista.
        const para: string[] = []
        while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !lines[i].trimStart().startsWith('```') &&
            !/^\s*>/.test(lines[i]) &&
            !/^(#{1,6})\s+/.test(lines[i]) &&
            !LIST_RE.test(lines[i]) &&
            !isTableStart(lines, i) &&
            !lines[i].trim().startsWith('<details') &&
            !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
        ) {
            para.push(lines[i])
            i++
        }
        // Con `softBreaks`, cada renglón es un renglón. Sin él, se juntan y solo
        // el salto “duro” de Markdown —dos espacios al final de la línea— los
        // separa.
        //
        // En los dos casos se unen en UN string y no en párrafos sueltos: el
        // formato que cruza el salto (una negrita abierta en un renglón y
        // cerrada en el siguiente) tiene que seguir aplicándose, y eso solo
        // pasa si el texto llega entero a `inline`.
        const text = softBreaks
            ? para.map((l) => l.trim()).join('\n')
            : para
                  .map((l, n) => (l.endsWith('  ') && n < para.length - 1 ? l.trimEnd() + '\n' : l.trim()))
                  .join(' ')
                  .replace(/\n /g, '\n')
        blocks.push(
            <p key={`p-${blocks.length}`} className="my-1 whitespace-pre-wrap break-words text-on-surface-variant">
                {inline(text, `p-${blocks.length}`, onWikiLink, renderImage)}
            </p>,
        )
    }

    return (
        <div className="h-full overflow-y-auto px-3 py-2 text-xs leading-relaxed">
            {blocks.map((b, n) => (
                <Fragment key={n}>{b}</Fragment>
            ))}
        </div>
    )
}
