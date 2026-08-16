import {useCallback, useEffect, useMemo, useState} from 'react'
import {CreateNote, SearchNotesSmart} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import SidebarModule from '../sidebar/SidebarModule'

// Módulo "Notas" del sidebar: el buscador y la lista de la base de
// conocimiento.
//
// Es un módulo hermano de Conexiones y de SSH, y no una pantalla aparte, por
// una razón concreta: buscar en la documentación propia pasa MIENTRAS se está
// haciendo otra cosa —depurando una consulta, mirando un log— y mandar al
// usuario a otra pantalla para eso rompe justo lo que vino a hacer.

interface Props {
    // Nota abierta, para marcarla en la lista.
    activeNoteId: string | null
    onOpenNote: (id: string) => void
    moduleCollapsed: boolean
    onToggleModuleCollapsed: () => void
    rail: boolean
    // Se dispara al crear una nota, para que el workspace la abra.
    onCreated: (id: string) => void
    // Token que fuerza recargar la lista desde afuera (al guardar una nota).
    reloadToken: number
}

export default function NotesTree({
    activeNoteId,
    onOpenNote,
    moduleCollapsed,
    onToggleModuleCollapsed,
    rail,
    onCreated,
    reloadToken,
}: Props) {
    const [query, setQuery] = useState('')
    const [hits, setHits] = useState<vault.NoteHit[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [showHelp, setShowHelp] = useState(false)

    // Con retardo: cada búsqueda descifra las notas en memoria (ver
    // backend/vault/notesearch.go), así que buscar por pulsación las
    // descifraría todas por cada letra.
    useEffect(() => {
        let cancelled = false
        const t = setTimeout(() => {
            setLoading(true)
            SearchNotesSmart(query, 60)
                .then((h) => !cancelled && setHits(h ?? []))
                .catch((e) => !cancelled && setError(String(e)))
                .finally(() => !cancelled && setLoading(false))
        }, query ? 180 : 0)
        return () => {
            cancelled = true
            clearTimeout(t)
        }
    }, [query, reloadToken])

    const createNote = useCallback(() => {
        // El título sale de lo que se venía buscando: quien busca "Runbook
        // SGC", no lo encuentra y aprieta "+", quiere crear justamente esa.
        const title = query.trim() || 'Nota sin título'
        CreateNote(title, '')
            .then((id) => {
                setQuery('')
                onCreated(id)
            })
            .catch((e) => setError(String(e)))
    }, [query, onCreated])

    const searching = query.trim().length > 0

    return (
        <SidebarModule
            title="Notas"
            collapsed={moduleCollapsed}
            onToggleCollapsed={onToggleModuleCollapsed}
            matchCount={searching ? hits.length : null}
            actions={
                <button
                    onClick={createNote}
                    title={
                        searching
                            ? `Crea una nota titulada «${query.trim()}» — el título es lo que la hace enlazable con [[…]]`
                            : 'Crea una nota nueva. Nace PRIVADA: ningún agente puede leerla hasta que lo permitas explícitamente.'
                    }
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="note_add" size={16} />
                </button>
            }
        >
            {!rail && (
                <div className="flex flex-col gap-1 px-2 pb-1">
                    <div className="flex items-center gap-1 rounded border border-outline-variant bg-surface px-1.5 py-0.5">
                        <Icon name="search" size={13} className="shrink-0 text-on-surface-variant" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Buscar en tus notas…"
                            title="Busca en títulos y cuerpos, sin importar tildes ni mayúsculas. Varias palabras: todas tienen que aparecer. Entre comillas: frase exacta."
                            className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/60"
                        />
                        {query && (
                            <button
                                onClick={() => setQuery('')}
                                title="Limpia la búsqueda"
                                className="shrink-0 rounded text-on-surface-variant hover:text-on-surface"
                            >
                                <Icon name="close" size={12} />
                            </button>
                        )}
                        <button
                            onClick={() => setShowHelp((v) => !v)}
                            title="Qué más se puede escribir en el buscador"
                            className={`shrink-0 rounded ${showHelp ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                        >
                            <Icon name="help" size={12} />
                        </button>
                    </div>

                    {showHelp && (
                        <div className="rounded border border-outline-variant bg-surface-container-low p-1.5 text-[10px] leading-4 text-on-surface-variant">
                            <p>
                                <span className="font-mono text-on-surface">oracle tablespace</span> — las dos palabras,
                                en cualquier orden
                            </p>
                            <p>
                                <span className="font-mono text-on-surface">"plan de contingencia"</span> — frase exacta
                            </p>
                            <p>
                                <span className="font-mono text-on-surface">tag:produccion</span> — por etiqueta del
                                frontmatter
                            </p>
                            <p>
                                <span className="font-mono text-on-surface">enlaza:Runbook SGC</span> — las que apuntan a
                                esa nota
                            </p>
                            <p>
                                <span className="font-mono text-on-surface">privado:no</span> — solo las que un agente
                                puede leer
                            </p>
                        </div>
                    )}
                </div>
            )}

            {error && <p className="px-2 pb-1 text-[10px] text-error">{error}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {hits.length === 0 && !loading && (
                    <p className="px-2 py-2 text-[11px] text-on-surface-variant">
                        {searching ? (
                            <>
                                Sin resultados para <span className="text-on-surface">{query}</span>. El botón{' '}
                                <Icon name="note_add" size={11} className="inline align-text-bottom" /> crea una nota con
                                ese título.
                            </>
                        ) : (
                            'Todavía no hay notas. Acá va tu documentación: runbooks, procedimientos, lo que hoy vive en un archivo suelto.'
                        )}
                    </p>
                )}

                {hits.map((h) => (
                    <button
                        key={h.id}
                        onClick={() => onOpenNote(h.id)}
                        title={
                            h.isPrivate
                                ? `${h.title} — privada: ningún agente puede leerla`
                                : `${h.title} — visible para los agentes`
                        }
                        className={`flex w-full flex-col gap-0.5 border-l-2 px-2 py-1 text-left ${
                            activeNoteId === h.id
                                ? 'border-l-primary bg-surface-variant'
                                : 'border-l-transparent hover:bg-surface-container-high'
                        }`}
                    >
                        <span className="flex min-w-0 items-center gap-1.5">
                            {/* El candado no es decoración: es la única señal
                                de un vistazo de qué puede leer un agente. */}
                            <Icon
                                name={h.isPrivate ? 'lock' : 'lock_open'}
                                size={11}
                                className={`shrink-0 ${h.isPrivate ? 'text-on-surface-variant/60' : 'text-tertiary'}`}
                            />
                            <span
                                className={`min-w-0 truncate text-[11px] ${
                                    h.matchedTitle ? 'font-medium text-on-surface' : 'text-on-surface'
                                }`}
                            >
                                {h.title || 'Sin título'}
                            </span>
                        </span>
                        {/* El fragmento es lo que evita abrir cinco notas para
                            ver cuál era. El resaltado viene marcado con «…»
                            desde el backend y se parte acá — nunca se inyecta
                            HTML, misma regla que la vista previa. */}
                        {h.snippet && (
                            <span className="line-clamp-2 pl-[18px] text-[10px] leading-4 text-on-surface-variant">
                                {h.snippet.split(/«|»/).map((part, i) =>
                                    i % 2 === 1 ? (
                                        <mark key={i} className="rounded bg-primary/25 text-on-surface">
                                            {part}
                                        </mark>
                                    ) : (
                                        <span key={i}>{part}</span>
                                    ),
                                )}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </SidebarModule>
    )
}
