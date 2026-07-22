import {useState} from 'react'
import Icon from '../Icon'

// Syntax-colored, collapsible JSON/Extended-JSON viewer — the MongoDB result
// view's document renderer (the "sección de resultado nueva JSON con formato
// color"). It renders relaxed MongoDB Extended JSON: single-key wrapper objects
// like {"$oid": "..."} / {"$date": "..."} / {"$numberLong": "..."} are shown as
// typed atoms (ObjectId("..."), ISODate("..."), ...) the way Compass/mongosh do,
// instead of as raw nested objects. Theme-aware via Tailwind light/dark pairs.

interface JsonViewProps {
    // A relaxed-ExtJSON string (from the backend) or an already-parsed value.
    data: string | unknown
    className?: string
    // When set, top-level fields get a hover "filter by this field" affordance
    // (used by the Mongo browser — click a field to filter, like Redis's tree).
    onFilterField?: (key: string, value: unknown) => void
}

export default function JsonView({data, className, onFilterField}: JsonViewProps) {
    let value: unknown = data
    if (typeof data === 'string') {
        try {
            value = JSON.parse(data)
        } catch {
            // Not valid JSON — show the raw text rather than crashing.
            return <pre className={`whitespace-pre-wrap break-words font-mono text-xs text-neutral-700 dark:text-neutral-300 ${className ?? ''}`}>{data}</pre>
        }
    }
    return (
        <div className={`font-mono text-xs leading-relaxed ${className ?? ''}`}>
            <JsonNode value={value} depth={0} onFilterField={onFilterField} />
        </div>
    )
}

const punct = 'text-neutral-500 dark:text-neutral-400'

// ejsonAtom detects a MongoDB Extended-JSON typed wrapper and returns a
// human-readable atom string + a color class, or null if v isn't one.
function ejsonAtom(v: unknown): {text: string; cls: string} | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length !== 1) return null
    const obj = v as Record<string, unknown>
    const atomCls = 'text-rose-700 dark:text-rose-300'
    switch (keys[0]) {
        case '$oid':
            return {text: `ObjectId("${obj.$oid}")`, cls: atomCls}
        case '$date': {
            const d = obj.$date
            const inner = typeof d === 'object' && d !== null ? (d as Record<string, unknown>).$numberLong : d
            return {text: `ISODate("${inner}")`, cls: atomCls}
        }
        case '$numberLong':
            return {text: String(obj.$numberLong), cls: 'text-amber-700 dark:text-amber-300'}
        case '$numberDecimal':
            return {text: String(obj.$numberDecimal), cls: 'text-amber-700 dark:text-amber-300'}
        case '$numberInt':
            return {text: String(obj.$numberInt), cls: 'text-amber-700 dark:text-amber-300'}
        case '$uuid':
            return {text: `UUID("${obj.$uuid}")`, cls: atomCls}
        default:
            return null
    }
}

function JsonNode({value, depth, onFilterField}: {value: unknown; depth: number; onFilterField?: (key: string, value: unknown) => void}) {
    const [collapsed, setCollapsed] = useState(depth >= 3)

    const atom = ejsonAtom(value)
    if (atom) return <span className={atom.cls}>{atom.text}</span>

    if (value === null) return <span className="text-purple-700 dark:text-purple-300">null</span>
    if (typeof value === 'boolean') return <span className="text-purple-700 dark:text-purple-300">{String(value)}</span>
    if (typeof value === 'number') return <span className="text-amber-700 dark:text-amber-300">{value}</span>
    if (typeof value === 'string') return <span className="text-emerald-700 dark:text-emerald-300">"{value}"</span>

    if (Array.isArray(value)) {
        if (value.length === 0) return <span className={punct}>[]</span>
        return (
            <span>
                <button className={`${punct} hover:text-neutral-800 dark:hover:text-neutral-100`} onClick={() => setCollapsed((c) => !c)}>
                    [{collapsed ? `… ${value.length}` : ''}
                </button>
                {!collapsed && (
                    <div className="pl-4 border-l border-neutral-200 dark:border-neutral-700">
                        {value.map((v, i) => (
                            <div key={i}>
                                <JsonNode value={v} depth={depth + 1} onFilterField={onFilterField} />
                                {i < value.length - 1 && <span className={punct}>,</span>}
                            </div>
                        ))}
                    </div>
                )}
                <span className={punct}>]</span>
            </span>
        )
    }

    // object
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className={punct}>{'{}'}</span>
    return (
        <span>
            <button className={`${punct} hover:text-neutral-800 dark:hover:text-neutral-100`} onClick={() => setCollapsed((c) => !c)}>
                {'{'}
                {collapsed ? `… ${entries.length}` : ''}
            </button>
            {!collapsed && (
                <div className="pl-4 border-l border-neutral-200 dark:border-neutral-700">
                    {entries.map(([k, v], i) => {
                        const filterable = depth === 0 && !!onFilterField
                        return (
                            <div key={k} className="group/field flex flex-wrap items-start">
                                <span
                                    className={`text-sky-700 dark:text-sky-300 ${filterable ? 'cursor-pointer hover:underline' : ''}`}
                                    onDoubleClick={filterable ? () => onFilterField(k, v) : undefined}
                                    title={filterable ? `Doble-click para filtrar por ${k}` : undefined}
                                >
                                    "{k}"
                                </span>
                                {filterable && (
                                    <button
                                        onClick={() => onFilterField(k, v)}
                                        title={`Filtrar por ${k}`}
                                        className="mx-0.5 shrink-0 align-middle text-on-surface-variant opacity-0 transition-opacity hover:text-primary group-hover/field:opacity-70"
                                    >
                                        <Icon name="filter_alt" size={11} />
                                    </button>
                                )}
                                <span className={punct}>: </span>
                                <JsonNode value={v} depth={depth + 1} onFilterField={onFilterField} />
                                {i < entries.length - 1 && <span className={punct}>,</span>}
                            </div>
                        )
                    })}
                </div>
            )}
            <span className={punct}>{'}'}</span>
        </span>
    )
}
