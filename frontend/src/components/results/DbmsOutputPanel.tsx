import {useMemo, useState} from 'react'
import Icon from '../Icon'

interface DbmsOutputPanelProps {
    lines: string[]
}

// Salida de DBMS_OUTPUT.PUT_LINE de los bloques PL/SQL del último script.
//
// Antes era un cajón al pie de "Resultados": un <pre> con la altura clavada en
// 128px, sin acciones y sin contador. El problema de fondo era el lugar, no el
// estilo — un bloque PL/SQL de proceso (el caso en que DBMS_OUTPUT importa) no
// devuelve resultset, así que su log quedaba apretado en esos 128px debajo de
// una grilla vacía que ocupaba toda la pantalla diciendo "Sin resultados
// todavía". Como pestaña propia, al lado de Consola, recibe el panel entero.
//
// Lo que se le pide a un log de proceso es siempre lo mismo: cuánto hay, dónde
// dice ERROR, y poder llevárselo. De ahí el contador, el filtro y el copiado.
export default function DbmsOutputPanel({lines}: DbmsOutputPanelProps) {
    const [filter, setFilter] = useState('')
    // Ajustar líneas viene prendido, pero se puede apagar: buena parte de estas
    // salidas son columnas alineadas con espacios, y ahí cortar una línea
    // arruina justamente la alineación que le da sentido.
    const [wrap, setWrap] = useState(true)
    const [copied, setCopied] = useState(false)

    const q = filter.trim().toLowerCase()
    const visible = useMemo(() => (q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines), [lines, q])

    async function copyAll() {
        await navigator.clipboard.writeText(visible.join('\n'))
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col bg-surface">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-2 py-1">
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-on-surface-variant">
                    {q ? `${visible.length} de ${lines.length} líneas` : `${lines.length} ${lines.length === 1 ? 'línea' : 'líneas'}`}
                </span>

                <div className="flex-1" />

                <div className="flex items-center gap-1 rounded bg-surface-container px-1.5 py-0.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={13} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filtrar líneas…"
                        title="Deja solo las líneas que contienen ese texto — para encontrar el ERROR en un log de trescientas líneas sin leerlo entero"
                        className="w-40 min-w-0 bg-transparent text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/50"
                    />
                    {filter && (
                        <button onClick={() => setFilter('')} title="Quitar el filtro y volver a ver todo el log" className="shrink-0 text-on-surface-variant/60 hover:text-on-surface">
                            <Icon name="close" size={13} />
                        </button>
                    )}
                </div>

                <button
                    onClick={() => setWrap((v) => !v)}
                    title={
                        wrap
                            ? 'Las líneas largas se ajustan al ancho del panel. Desactivalo para que no se corten y aparezca scroll horizontal — necesario cuando la salida son columnas alineadas con espacios.'
                            : 'Las líneas largas se salen a la derecha y hay scroll horizontal. Activalo para ajustarlas al ancho del panel.'
                    }
                    className={`shrink-0 rounded p-1 ${wrap ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                >
                    <Icon name="wrap_text" size={15} />
                </button>
                <button
                    onClick={copyAll}
                    title={q ? 'Copiar solo las líneas que muestra el filtro' : 'Copiar toda la salida al portapapeles'}
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                    {copied ? 'Copiado' : 'Copiar'}
                </button>
            </div>

            <pre
                className={`m-0 min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-on-surface ${
                    wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
                }`}
            >
                {visible.length === 0 ? (
                    <span className="text-on-surface-variant/60">Ninguna línea contiene «{filter}».</span>
                ) : (
                    visible.join('\n')
                )}
            </pre>
        </div>
    )
}
