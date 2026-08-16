import {Fragment, type ReactNode} from 'react'
import Icon from './Icon'

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
// Lo que NO cubre, a propósito: tablas, HTML embebido, imágenes, notas al pie
// y listas anidadas de más de un nivel. Lo que no reconoce se muestra como
// texto plano — que es exactamente el modo de fallo correcto para una vista
// previa: nunca se pierde contenido, a lo sumo se ve sin formato.

// inline resuelve el formato dentro de una línea: `código`, **negrita**,
// *itálica* y [texto](url).
//
// Se recorre con una sola expresión regular alternada en vez de encadenar
// reemplazos: encadenarlos haría que la negrita de adentro de un bloque de
// código se procese igual, que es el bug clásico de estos renderers.
function inline(text: string, keyBase: string, onWikiLink?: WikiLinkHandler): ReactNode[] {
    const out: ReactNode[] = []
    // El `[[WikiLink]]` va PRIMERO en la alternancia: si fuera después, el
    // patrón de enlace Markdown `[texto](url)` se comería el primer corchete y
    // partiría la referencia a la mitad.
    const re = /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|((?:^|(?<=\s))#[\p{L}\d][\p{L}\d_/-]*)/gu
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

export default function MarkdownPreview({
    source,
    onWikiLink,
    renderCodeBlock,
}: {
    source: string
    onWikiLink?: WikiLinkHandler
    renderCodeBlock?: CodeBlockRenderer
}) {
    const lines = source.split('\n')
    const blocks: ReactNode[] = []

    let i = 0
    let listItems: string[] = []

    function flushList() {
        if (listItems.length === 0) return
        const items = listItems
        listItems = []
        blocks.push(
            <ul key={`ul-${blocks.length}`} className="my-1 ml-4 list-disc space-y-0.5">
                {items.map((it, n) => (
                    <li key={n}>{inline(it, `li-${blocks.length}-${n}`, onWikiLink)}</li>
                ))}
            </ul>,
        )
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
            flushList()
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
            flushList()
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
                            <p key={n} className="text-on-surface">
                                {inline(p2.split('\n').map((l) => l.trim()).join(' '), `co-${blocks.length}-${n}`, onWikiLink)}
                            </p>
                        ))}
                </div>,
            )
            continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
            flushList()
            const level = heading[1].length
            const size = level === 1 ? 'text-base' : level === 2 ? 'text-sm' : 'text-xs'
            blocks.push(
                <p key={`h-${blocks.length}`} className={`mt-2 mb-1 font-semibold text-on-surface ${size}`}>
                    {inline(heading[2], `h-${blocks.length}`, onWikiLink)}
                </p>,
            )
            i++
            continue
        }

        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
        if (bullet) {
            listItems.push(bullet[1])
            i++
            continue
        }

        if (/^\s*>\s?/.test(line)) {
            flushList()
            blocks.push(
                <p
                    key={`q-${blocks.length}`}
                    className="my-3 border-l-[3px] border-primary/50 py-0.5 pl-4 italic text-on-surface-variant"
                >
                    {inline(line.replace(/^\s*>\s?/, ''), `q-${blocks.length}`, onWikiLink)}
                </p>,
            )
            i++
            continue
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushList()
            blocks.push(<hr key={`hr-${blocks.length}`} className="my-2 border-outline-variant" />)
            i++
            continue
        }

        if (line.trim() === '') {
            flushList()
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
        flushList()
        const para: string[] = []
        while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !lines[i].trimStart().startsWith('```') &&
            !/^\s*>/.test(lines[i]) &&
            !/^(#{1,6})\s+/.test(lines[i]) &&
            !/^\s*[-*+]\s+/.test(lines[i]) &&
            !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
        ) {
            para.push(lines[i])
            i++
        }
        // Un salto “duro” de Markdown son dos espacios al final de la línea:
        // eso sí separa renglones y se respeta.
        const text = para
            .map((l, n) => (l.endsWith('  ') && n < para.length - 1 ? l.trimEnd() + '\n' : l.trim()))
            .join(' ')
            .replace(/\n /g, '\n')
        blocks.push(
            <p key={`p-${blocks.length}`} className="my-1 whitespace-pre-wrap break-words text-on-surface-variant">
                {inline(text, `p-${blocks.length}`, onWikiLink)}
            </p>,
        )
    }
    flushList()

    return (
        <div className="h-full overflow-y-auto px-3 py-2 text-xs leading-relaxed">
            {blocks.map((b, n) => (
                <Fragment key={n}>{b}</Fragment>
            ))}
        </div>
    )
}
