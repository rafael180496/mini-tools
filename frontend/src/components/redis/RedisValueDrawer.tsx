import {useEffect, useState} from 'react'
import Icon from '../Icon'
import JsonEditor from '../mongo/JsonEditor'
import {formatValue, isProbablyJSON, REDIS_FORMATS, type RedisFormat} from '../../lib/redisFormat'

interface RedisValueDrawerProps {
    title: string
    value: string
    // readOnly is used for the types whose "value" is its own identity (a set
    // member), where editing means remove-plus-add rather than an update.
    readOnly?: boolean
    onSave: (value: string) => void
    onClose: () => void
}

// Side drawer for editing one long value.
//
// A serialized document does not fit in a table cell, and editing it there
// means scrolling a one-line input sideways through a few kilobytes of JSON.
// This gives it the full height of the panel, a real editor with syntax
// highlighting and validation for JSON, and a formatted read-only view for
// everything else.
//
// It slides over the panel rather than replacing it so the surrounding
// context — which key, which field — stays visible while editing.
export default function RedisValueDrawer({title, value, readOnly, onSave, onClose}: RedisValueDrawerProps) {
    const [draft, setDraft] = useState(value)
    const [valid, setValid] = useState(true)
    const [format, setFormat] = useState<RedisFormat>('auto')

    // JSON gets the real editor (highlighting + live validation); anything
    // else gets a plain textarea, because running non-JSON through a JSON
    // linter would mark every line of a serialized blob as an error.
    const asJSON = isProbablyJSON(value)

    useEffect(() => {
        setDraft(value)
        setValid(true)
    }, [value, title])

    const dirty = draft !== value

    return (
        <div className="absolute inset-0 z-20 flex justify-end bg-black/30" onClick={onClose}>
            <div
                className="flex h-full w-full max-w-2xl flex-col border-l border-outline-variant bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="data_object" size={16} className="shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface" title={title}>
                        {title}
                    </span>
                    {!asJSON && (
                        <select
                            value={format}
                            onChange={(e) => setFormat(e.target.value as RedisFormat)}
                            title="Cómo mostrar el valor mientras lo revisás. No cambia lo que se guarda."
                            className="shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-xs text-on-surface"
                        >
                            {REDIS_FORMATS.map((f) => (
                                <option key={f.value} value={f.value} title={f.hint}>
                                    {f.label}
                                </option>
                            ))}
                        </select>
                    )}
                    <button onClick={onClose} title="Cierra el panel lateral" className="shrink-0 text-on-surface-variant hover:text-on-surface">
                        <Icon name="close" size={18} />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-2">
                    {readOnly ? (
                        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-on-surface">{formatValue(value, format)}</pre>
                    ) : asJSON ? (
                        <JsonEditor value={draft} onChange={setDraft} onValidityChange={setValid} />
                    ) : (
                        <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            spellCheck={false}
                            className="h-full min-h-64 w-full resize-none rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        />
                    )}
                </div>

                {!readOnly && (
                    <div className="flex items-center gap-2 border-t border-outline-variant px-3 py-2 text-xs">
                        {!valid && <span className="text-error">El JSON tiene errores de sintaxis</span>}
                        {valid && dirty && <span className="text-tertiary">Sin aplicar — queda pendiente hasta que guardes los cambios</span>}
                        <div className="ml-auto flex items-center gap-2">
                            <button onClick={onClose} title="Cierra sin tomar el cambio" className="rounded px-2 py-1 text-on-surface-variant hover:text-on-surface">
                                Cancelar
                            </button>
                            <button
                                onClick={() => onSave(draft)}
                                disabled={!valid || !dirty}
                                title={
                                    !valid
                                        ? 'Corregí el JSON antes de tomar el cambio'
                                        : !dirty
                                          ? 'No cambiaste nada'
                                          : 'Toma el cambio como pendiente. Se escribe en Redis recién al guardar desde la barra de cambios.'
                                }
                                className="rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                            >
                                Tomar cambio
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
