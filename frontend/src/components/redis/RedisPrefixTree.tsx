import {useEffect, useState} from 'react'
import {AnalyzeRedisPrefixes} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {formatBytes} from '../../lib/formatBytes'

interface RedisPrefixTreeProps {
    connId: string
    // Applying a prefix sets the key list's match pattern to "<prefix>*".
    onSelectPrefix: (pattern: string) => void
    activePattern: string
}

// Namespace explorer: what is actually in this keyspace, grouped by the
// prefix convention almost everyone uses (session:user:42, cache:product:9).
//
// A flat list of a million keys answers nothing; this answers "what is
// eating the key count and the memory". Built from a bounded SCAN sample —
// never KEYS * — and the header says so out loud, because a tree built from
// 10.000 of 4.000.000 keys is an estimate and presenting it as a census
// would be a lie the user acts on.
export default function RedisPrefixTree({connId, onSelectPrefix, activePattern}: RedisPrefixTreeProps) {
    const [report, setReport] = useState<db.RedisPrefixReport | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [withMemory, setWithMemory] = useState(false)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())

    async function analyze(memory: boolean) {
        setLoading(true)
        setError('')
        try {
            const res = await AnalyzeRedisPrefixes(connId, ':', 10000, memory)
            setReport(res)
        } catch (e) {
            setError(String(e))
        } finally {
            setLoading(false)
        }
    }

    // Not run on mount: it costs a SCAN sweep of up to 10.000 keys, and
    // opening a connection should not spend that unasked. The user presses
    // Analizar.
    useEffect(() => {
        setReport(null)
        setError('')
        setExpanded(new Set())
    }, [connId])

    function toggle(prefix: string) {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(prefix)) next.delete(prefix)
            else next.add(prefix)
            return next
        })
    }

    return (
        <div className="flex flex-col gap-1 border-b border-outline-variant px-2 py-1.5 text-xs">
            <div className="flex items-center gap-2">
                <span className="font-semibold uppercase tracking-wider text-on-surface-variant">Espacios de nombres</span>
                <label
                    className="flex items-center gap-1 text-on-surface-variant"
                    title="Además de contar claves, pide MEMORY USAGE de una muestra para estimar cuánta RAM ocupa cada prefijo. Es un viaje extra por clave, así que la muestra de memoria es más chica que la de claves."
                >
                    <input type="checkbox" checked={withMemory} onChange={(e) => setWithMemory(e.target.checked)} className="accent-primary" />
                    memoria
                </label>
                <button
                    onClick={() => void analyze(withMemory)}
                    disabled={loading}
                    title="Recorre una muestra acotada del keyspace con SCAN (nunca KEYS *) y agrupa las claves por prefijo. En una instancia grande es una estimación, no un censo."
                    className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-primary hover:bg-surface-variant disabled:opacity-50"
                >
                    <Icon name={loading ? 'progress_activity' : 'account_tree'} size={13} className={loading ? 'animate-spin' : ''} />
                    {loading ? 'Analizando…' : report ? 'Reanalizar' : 'Analizar'}
                </button>
            </div>

            {error && <p className="text-error">{error}</p>}

            {report && (
                <>
                    <p className="text-ui-10 text-on-surface-variant/70">
                        Muestra de {report.sampled.toLocaleString('es')}
                        {report.totalKeys > 0 && ` de ${report.totalKeys.toLocaleString('es')}`} claves
                        {report.truncated && ' — se cortó en el límite de muestreo, los conteos son estimaciones'}
                    </p>

                    <div className="max-h-56 overflow-y-auto">
                        {report.roots?.length ? (
                            report.roots.map((node) => (
                                <PrefixRow
                                    key={node.prefix}
                                    node={node}
                                    depth={0}
                                    expanded={expanded}
                                    onToggle={toggle}
                                    onSelect={onSelectPrefix}
                                    activePattern={activePattern}
                                    showBytes={!!report.memorySampled}
                                />
                            ))
                        ) : (
                            <p className="text-on-surface-variant">La muestra no encontró claves.</p>
                        )}
                    </div>
                </>
            )}
        </div>
    )
}

function PrefixRow({
    node,
    depth,
    expanded,
    onToggle,
    onSelect,
    activePattern,
    showBytes,
}: {
    node: db.RedisPrefixNode
    depth: number
    expanded: Set<string>
    onToggle: (prefix: string) => void
    onSelect: (pattern: string) => void
    activePattern: string
    showBytes: boolean
}) {
    const children = node.children ?? []
    const isOpen = expanded.has(node.prefix)
    const pattern = `${node.prefix}*`
    const active = activePattern === pattern

    return (
        <div>
            <div
                className={`flex items-center gap-1 rounded px-1 py-0.5 ${active ? 'bg-primary/15 text-primary' : 'hover:bg-surface-variant'}`}
                style={{paddingLeft: `${depth * 12 + 4}px`}}
            >
                <button
                    onClick={() => onToggle(node.prefix)}
                    disabled={children.length === 0}
                    title={children.length === 0 ? 'Sin subniveles' : isOpen ? 'Colapsa este nivel' : `Abre los ${children.length} subniveles`}
                    className="shrink-0 text-on-surface-variant hover:text-on-surface disabled:invisible"
                >
                    <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={13} />
                </button>

                <button
                    onClick={() => onSelect(pattern)}
                    title={`Filtra la lista de claves por ${pattern}`}
                    className="min-w-0 flex-1 truncate text-left font-mono"
                >
                    {node.segment}
                </button>

                {showBytes && !!node.bytes && (
                    <span className="shrink-0 font-mono text-ui-10 text-on-surface-variant/70" title="Memoria estimada de las claves muestreadas bajo este prefijo">
                        {formatBytes(node.bytes)}
                    </span>
                )}
                <span className="w-12 shrink-0 text-right font-mono text-ui-10 text-on-surface-variant" title="Claves muestreadas bajo este prefijo">
                    {node.keys.toLocaleString('es')}
                </span>
            </div>

            {isOpen &&
                children.map((child) => (
                    <PrefixRow
                        key={child.prefix}
                        node={child}
                        depth={depth + 1}
                        expanded={expanded}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        activePattern={activePattern}
                        showBytes={showBytes}
                    />
                ))}
        </div>
    )
}
