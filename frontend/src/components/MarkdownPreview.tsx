import {Fragment, type ReactNode} from 'react'

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
    const re = /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
    let last = 0
    let m: RegExpExecArray | null
    let i = 0

    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const token = m[0]
        const key = `${keyBase}-${i++}`

        if (token.startsWith('[[')) {
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

export default function MarkdownPreview({source, onWikiLink}: {source: string; onWikiLink?: WikiLinkHandler}) {
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
            blocks.push(
                <pre
                    key={`code-${blocks.length}`}
                    title={lang || undefined}
                    className="my-1 overflow-x-auto rounded bg-surface-container-highest px-2 py-1 font-mono text-[11px] text-on-surface"
                >
                    {buf.join('\n')}
                </pre>,
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
                <p key={`q-${blocks.length}`} className="my-1 border-l-2 border-outline-variant pl-2 text-on-surface-variant">
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

        flushList()
        blocks.push(
            <p key={`p-${blocks.length}`} className="my-1 whitespace-pre-wrap break-words text-on-surface-variant">
                {inline(line, `p-${blocks.length}`, onWikiLink)}
            </p>,
        )
        i++
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
