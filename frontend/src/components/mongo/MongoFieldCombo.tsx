import {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface MongoFieldComboProps {
    value: string
    onChange: (value: string) => void
    fields: db.MongoFieldInfo[]
    placeholder?: string
    title?: string
    className?: string
}

// Field input with real autocomplete, replacing the plain <datalist> the
// wizard used before.
//
// A datalist could only offer names. What actually prevents a wrong query is
// the two things beside the name: the BSON type the field holds, and how many
// of the sampled documents have it. A field present in 4% of documents is
// still worth offering — but the user should know before filtering on it and
// wondering why almost nothing came back. Both come from the Go-side sample
// (App.SampleMongoFields).
//
// Rendered in a portal for the same reason Select.tsx is: the wizard is a
// modal with its own scroll container, and an absolutely-positioned menu
// inside it gets clipped.
export default function MongoFieldCombo({value, onChange, fields, placeholder, title, className}: MongoFieldComboProps) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({top: 0, left: 0, width: 0})
    const inputRef = useRef<HTMLInputElement>(null)

    const matches = useMemo(() => {
        const q = value.trim().toLowerCase()
        const list = q === '' ? fields : fields.filter((f) => f.path.toLowerCase().includes(q))
        // Already ordered by frequency from Go; cap so a heterogeneous
        // collection cannot render hundreds of rows into a modal.
        return list.slice(0, 40)
    }, [fields, value])

    function place() {
        const r = inputRef.current?.getBoundingClientRect()
        if (r) setPos({top: r.bottom + 4, left: r.left, width: r.width})
    }

    useEffect(() => {
        if (!open) return
        place()
        function reposition() {
            place()
        }
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
            window.removeEventListener('resize', reposition)
            window.removeEventListener('scroll', reposition, true)
        }
    }, [open])

    return (
        <>
            <input
                ref={inputRef}
                value={value}
                onChange={(e) => {
                    onChange(e.target.value)
                    if (!open) {
                        place()
                        setOpen(true)
                    }
                }}
                onFocus={() => {
                    place()
                    setOpen(true)
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Escape' && open) {
                        e.stopPropagation()
                        setOpen(false)
                    }
                }}
                placeholder={placeholder}
                title={title ?? 'Nombre del campo. Se sugieren los campos reales encontrados al muestrear la colección, incluidos los anidados (usuario.direccion.ciudad).'}
                className={`min-w-0 rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface ${className ?? ''}`}
            />
            {open &&
                matches.length > 0 &&
                createPortal(
                    <>
                        <div className="fixed inset-0 z-[60]" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)} />
                        <div
                            role="listbox"
                            style={{position: 'fixed', top: pos.top, left: pos.left, minWidth: Math.max(pos.width, 240)}}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="z-[61] max-h-64 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-highest p-1 shadow-lg"
                        >
                            {matches.map((f) => (
                                <button
                                    key={f.path}
                                    type="button"
                                    onClick={() => {
                                        onChange(f.path)
                                        setOpen(false)
                                    }}
                                    title={`${f.path} — presente en ${Math.round((f.frequency ?? 0) * 100)}% de los documentos muestreados${
                                        (f.types ?? []).length > 1
                                            ? `. Ojo: aparece con más de un tipo (${(f.types ?? []).join(', ')}), así que un filtro con un solo tipo no va a alcanzar todos los documentos.`
                                            : ''
                                    }`}
                                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-variant"
                                >
                                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface">{f.path}</span>
                                    {(f.types ?? []).length > 0 && (
                                        <span
                                            className={`shrink-0 rounded px-1 font-mono text-[10px] ${
                                                (f.types ?? []).length > 1 ? 'bg-tertiary/15 text-tertiary' : 'bg-surface-variant text-on-surface-variant'
                                            }`}
                                        >
                                            {(f.types ?? []).join(' | ')}
                                        </span>
                                    )}
                                    <span className="w-9 shrink-0 text-right font-mono text-[10px] text-on-surface-variant/70">
                                        {Math.round((f.frequency ?? 0) * 100)}%
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}

// FieldSampleStatus is the one-line summary shown above a group of field
// inputs: whether the sample is running, what it found, or why it cannot run.
export function FieldSampleStatus({loading, count, ready}: {loading: boolean; count: number; ready: boolean}) {
    if (!ready) {
        return <span className="font-normal text-on-surface-variant/70">elegí una colección para sugerir sus campos</span>
    }
    if (loading) {
        return (
            <span className="flex items-center gap-1 font-normal text-on-surface-variant/70">
                <Icon name="progress_activity" size={12} className="animate-spin" />
                muestreando documentos…
            </span>
        )
    }
    if (count === 0) {
        return <span className="font-normal text-on-surface-variant/70">la muestra no devolvió campos (¿colección vacía?)</span>
    }
    return (
        <span
            className="font-normal text-on-surface-variant/70"
            title="Campos encontrados leyendo una muestra de documentos. MongoDB no tiene esquema que consultar, así que un campo presente solo en documentos viejos podría no aparecer acá."
        >
            {count} campos detectados en la muestra
        </span>
    )
}
