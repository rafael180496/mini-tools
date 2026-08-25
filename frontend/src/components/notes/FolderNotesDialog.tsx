import {useCallback, useEffect, useMemo, useState} from 'react'
import {CreateNoteInFolder, ListNotes, SetNoteFolder} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Las notas de una carpeta, en tabla.
//
// **Por qué una ventana y no más árbol.** La barra lateral está hecha para
// navegar: títulos cortos, jerarquía, poco ancho. Cuando lo que se quiere es
// *revisar* una carpeta —cuántas notas hay, cuál se tocó la última vez, cuál
// quedó sin actualizar desde hace un año— hace falta lo contrario: una tabla,
// con fechas, ordenable, y con su propio buscador que no toca el filtro global
// de la barra.
//
// La numeración es posicional, del orden que se está viendo. No es un
// identificador de la nota: el id de verdad es opaco y no le sirve a nadie de
// memoria. Sirve para lo que sirve un número de fila — decir "la 7" mirando la
// misma pantalla, y saber cuántas hay sin contarlas.

type SortKey = 'orden' | 'titulo' | 'creada' | 'actualizada'

// Fecha corta y en 24 horas. El `a. m./p. m.` de algunas configuraciones
// regionales agrega cuatro caracteres que parten la celda en dos líneas, y en
// una tabla que se lee de un vistazo eso cuesta más de lo que aclara.
function fecha(unix: number): string {
    if (!unix) return '—'
    const d = new Date(unix * 1000)
    return (
        d.toLocaleDateString(undefined, {year: 'numeric', month: '2-digit', day: '2-digit'}) +
        ' ' +
        d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit', hour12: false})
    )
}

interface Props {
    folder: vault.Folder
    // Notas de las subcarpetas incluidas, para poder contar la carpeta entera.
    descendantIds: string[]
    activeNoteId: string | null
    onOpenNote: (id: string) => void
    onChanged: () => void
    onClose: () => void
}

export default function FolderNotesDialog({folder, descendantIds, activeNoteId, onOpenNote, onChanged, onClose}: Props) {
    const [all, setAll] = useState<vault.NoteSummary[]>([])
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState<SortKey>('titulo')
    const [asc, setAsc] = useState(true)
    const [error, setError] = useState('')

    const load = useCallback(async () => {
        try {
            setAll((await ListNotes()) ?? [])
        } catch (e) {
            setError(String(e))
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const dentro = useMemo(() => new Set([folder.id, ...descendantIds]), [folder.id, descendantIds])

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase()
        const filtradas = all.filter((n) => dentro.has(n.folderId) && (!q || n.title.toLowerCase().includes(q)))
        const dir = asc ? 1 : -1
        return [...filtradas].sort((a, b) => {
            switch (sort) {
                case 'creada':
                    return (a.createdAt - b.createdAt) * dir
                case 'actualizada':
                    return (a.updatedAt - b.updatedAt) * dir
                default:
                    return a.title.localeCompare(b.title, undefined, {sensitivity: 'base'}) * dir
            }
        })
    }, [all, dentro, query, sort, asc])

    const ordenar = (key: SortKey) => {
        if (key === sort) setAsc((v) => !v)
        else {
            setSort(key)
            // Las fechas arrancan de la más reciente: es lo que uno busca al
            // ordenar por fecha. El título, de la A a la Z.
            setAsc(key === 'titulo')
        }
    }

    const Encabezado = ({label, col, className}: {label: string; col: SortKey; className?: string}) => (
        <th className={`sticky top-0 z-10 bg-surface-container-low px-2 py-1.5 text-left font-medium ${className ?? ''}`}>
            <button onClick={() => ordenar(col)} title={`Ordenar por ${label.toLowerCase()}`} className="flex items-center gap-1 hover:text-on-surface">
                {label}
                {sort === col && <Icon name={asc ? 'arrow_upward' : 'arrow_downward'} size={11} />}
            </button>
        </th>
    )

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
            <div
                className="flex h-[32rem] w-[48rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="folder_open" size={16} className="text-on-surface-variant" />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">{folder.name}</p>
                    <span className="shrink-0 text-ui-11 text-on-surface-variant">
                        {rows.length} {rows.length === 1 ? 'nota' : 'notas'}
                        {descendantIds.length > 0 && ' (con subcarpetas)'}
                    </span>
                    <button
                        onClick={() =>
                            void CreateNoteInFolder(query.trim() || 'Nota sin título', folder.id)
                                .then((id) => {
                                    onChanged()
                                    onOpenNote(id)
                                    onClose()
                                })
                                .catch((e) => setError(String(e)))
                        }
                        title={`Crea una nota dentro de «${folder.name}». Si hay algo escrito en el buscador de acá arriba, lo usa como título.`}
                        className="shrink-0 rounded bg-primary px-2 py-0.5 text-ui-11 text-on-primary hover:opacity-90"
                    >
                        Nueva nota
                    </button>
                    <button onClick={onClose} title="Cerrar" className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-1.5">
                    <Icon name="search" size={14} className="text-on-surface-variant" />
                    <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Filtrar por título dentro de esta carpeta"
                        title="Busca solo entre las notas de esta carpeta y por título. El buscador de la barra lateral, en cambio, busca en el cuerpo de todas."
                        className="min-w-0 flex-1 bg-transparent text-ui-12 text-on-surface outline-none placeholder:text-on-surface-variant/50"
                    />
                    {query && (
                        <button onClick={() => setQuery('')} title="Limpiar" className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant">
                            <Icon name="close" size={13} />
                        </button>
                    )}
                </div>

                {error && <p className="shrink-0 bg-error-container px-3 py-1 text-ui-11 text-on-error-container">{error}</p>}

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {rows.length === 0 ? (
                        <p className="px-3 py-4 text-ui-11 leading-relaxed text-on-surface-variant">
                            {query ? 'Ninguna nota de esta carpeta coincide.' : 'La carpeta está vacía. «Nueva nota» crea una acá adentro.'}
                        </p>
                    ) : (
                        <table className="w-full border-collapse text-ui-11">
                            <thead className="text-on-surface-variant">
                                <tr>
                                    <th className="sticky top-0 z-10 w-10 bg-surface-container-low px-2 py-1.5 text-right font-medium">#</th>
                                    <Encabezado col="titulo" label="Título" />
                                    <Encabezado col="creada" label="Creada" className="w-36" />
                                    <Encabezado col="actualizada" label="Actualizada" className="w-36" />
                                    <th className="sticky top-0 z-10 w-8 bg-surface-container-low" />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((n, i) => (
                                    <tr
                                        key={n.id}
                                        onDoubleClick={() => {
                                            onOpenNote(n.id)
                                            onClose()
                                        }}
                                        className={`cursor-default border-b border-outline-variant/40 hover:bg-surface-variant/60 ${
                                            activeNoteId === n.id ? 'bg-surface-variant' : ''
                                        }`}
                                    >
                                        <td className="px-2 py-1 text-right font-mono tabular-nums text-on-surface-variant/60">{i + 1}</td>
                                        <td className="px-2 py-1">
                                            <button
                                                onClick={() => {
                                                    onOpenNote(n.id)
                                                    onClose()
                                                }}
                                                title={`Abrir «${n.title || 'Sin título'}»`}
                                                className="flex min-w-0 items-center gap-1.5 text-left text-on-surface hover:underline"
                                            >
                                                {n.isPrivate && <Icon name="lock" size={11} className="shrink-0 text-on-surface-variant/60" />}
                                                <span className="truncate">{n.title || 'Sin título'}</span>
                                            </button>
                                        </td>
                                        <td className="px-2 py-1 font-mono tabular-nums text-on-surface-variant">{fecha(n.createdAt)}</td>
                                        <td className="px-2 py-1 font-mono tabular-nums text-on-surface-variant">{fecha(n.updatedAt)}</td>
                                        <td className="px-1 py-1">
                                            <button
                                                onClick={() =>
                                                    void SetNoteFolder(n.id, '')
                                                        .then(() => {
                                                            onChanged()
                                                            return load()
                                                        })
                                                        .catch((e) => setError(String(e)))
                                                }
                                                title="Sacar la nota de esta carpeta y dejarla en la raíz"
                                                className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                            >
                                                <Icon name="output" size={13} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    )
}
