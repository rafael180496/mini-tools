import {useEffect, useMemo, useRef, useState} from 'react'
import {ListNotes} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Elegir con qué nota fundir otra — el «Merge entire file with…» de Obsidian.
//
// Un buscador y no un submenú del menú contextual: con cientos de notas, un
// submenú sería una lista imposible de recorrer, y lo que uno tiene en la
// cabeza es el título, que se escribe más rápido de lo que se busca.
//
// La confirmación dice lo que va a pasar ANTES de hacerlo, porque no se
// deshace: el texto se agrega al final del destino con el título de origen
// como encabezado, la nota de origen desaparece, y si alguna de las dos era
// privada el resultado queda privado.

export default function MergeNoteDialog({
    source,
    onMerge,
    onClose,
}: {
    source: {id: string; title: string; isPrivate: boolean}
    onMerge: (targetId: string) => void
    onClose: () => void
}) {
    const [notes, setNotes] = useState<vault.NoteSummary[]>([])
    const [query, setQuery] = useState('')
    const [picked, setPicked] = useState<vault.NoteSummary | null>(null)
    const [focus, setFocus] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        void ListNotes()
            .then((list) => setNotes((list ?? []).filter((n) => n.id !== source.id)))
            .catch(() => setNotes([]))
        inputRef.current?.focus()
    }, [source.id])

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = q ? notes.filter((n) => n.title.toLowerCase().includes(q)) : notes
        return [...list].sort((a, b) => a.title.localeCompare(b.title, 'es', {sensitivity: 'base'})).slice(0, 200)
    }, [notes, query])

    useEffect(() => setFocus(0), [query])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                if (picked) setPicked(null)
                else onClose()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [picked, onClose])

    const willBePrivate = picked && (picked.isPrivate || source.isPrivate)
    const becomesPrivate = picked && !picked.isPrivate && source.isPrivate

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[12vh]" onClick={onClose}>
            <div
                className="flex max-h-[28rem] w-[34rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="call_merge" size={16} className="text-on-surface-variant" />
                    <p className="min-w-0 flex-1 truncate text-sm text-on-surface">
                        Fundir <span className="font-medium">«{source.title || 'Sin título'}»</span> con…
                    </p>
                    <button onClick={onClose} title="Cerrar" className="sidebar-icon !p-0.5">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {!picked ? (
                    <>
                        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-1.5">
                            <Icon name="search" size={15} className="text-on-surface-variant" />
                            <input
                                ref={inputRef}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'ArrowDown') {
                                        e.preventDefault()
                                        setFocus((f) => Math.min(f + 1, visible.length - 1))
                                    } else if (e.key === 'ArrowUp') {
                                        e.preventDefault()
                                        setFocus((f) => Math.max(f - 1, 0))
                                    } else if (e.key === 'Enter' && visible[focus]) {
                                        e.preventDefault()
                                        setPicked(visible[focus])
                                    }
                                }}
                                placeholder="Buscar la nota destino por título…"
                                className="min-w-0 flex-1 bg-transparent py-0.5 text-ui-12 text-on-surface outline-none placeholder:text-on-surface-variant/70"
                            />
                        </div>
                        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
                            {visible.map((n, i) => (
                                <li key={n.id}>
                                    <button
                                        onMouseEnter={() => setFocus(i)}
                                        onClick={() => setPicked(n)}
                                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-12 ${
                                            i === focus ? 'bg-surface-variant text-on-surface' : 'text-on-surface/90'
                                        }`}
                                    >
                                        <Icon name="description" size={16} className="shrink-0 text-on-surface-variant" />
                                        <span className="min-w-0 flex-1 truncate">{n.title || 'Sin título'}</span>
                                        {n.isPrivate && <Icon name="lock" size={12} className="shrink-0 text-on-surface-variant/60" />}
                                    </button>
                                </li>
                            ))}
                            {visible.length === 0 && (
                                <li className="px-2 py-3 text-ui-11 text-on-surface-variant">
                                    {notes.length === 0 ? 'No hay otra nota con la que fundirla.' : 'Ninguna nota coincide.'}
                                </li>
                            )}
                        </ul>
                    </>
                ) : (
                    <div className="flex flex-col gap-3 p-4 text-ui-12 text-on-surface-variant">
                        <p>
                            El texto de <span className="text-on-surface">«{source.title || 'Sin título'}»</span> se agrega al final
                            de <span className="text-on-surface">«{picked.title || 'Sin título'}»</span>, con su título como
                            encabezado, junto con sus imágenes. Después la nota de origen se borra: las que la enlazaban van a mostrar
                            el enlace como roto. No se puede deshacer.
                        </p>
                        {willBePrivate && (
                            <p className="flex items-start gap-2 rounded-md bg-surface-container-high p-2">
                                <Icon name="lock" size={14} className="mt-px shrink-0" />
                                {becomesPrivate
                                    ? `«${picked.title}» pasa a ser PRIVADA: tiene adentro el texto de una nota privada, y ningún agente va a poder leerla.`
                                    : 'El resultado queda privado: ningún agente va a poder leerlo.'}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setPicked(null)} className="rounded-md px-3 py-1.5 hover:bg-surface-variant hover:text-on-surface">
                                Elegir otra
                            </button>
                            <button
                                autoFocus
                                onClick={() => {
                                    onMerge(picked.id)
                                    onClose()
                                }}
                                className="rounded-md bg-primary px-3 py-1.5 text-on-primary hover:opacity-90"
                            >
                                Fundir
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
