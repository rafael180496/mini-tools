import {useCallback, useEffect, useMemo, useState} from 'react'
import {HttpClearAllHistory, HttpDeleteHistoryEntry, HttpHistoryAll} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import {methodColor, statusColor} from './httpShared'
import {formatElapsed} from '../../lib/formatElapsed'

// Historial de peticiones: todo lo que se mandó desde la aplicación, de lo
// más nuevo a lo más viejo, agrupado por día.
//
// El historial ya existía, pero era **por petición**: había que abrir la
// petición guardada para ver sus envíos. Eso deja fuera justo el caso en el
// que un historial sirve —«¿cuál era la URL que probé ayer?»—, porque quien
// pregunta eso no se acuerda de en qué colección estaba, y si la mandó como
// petición rápida no hay colección ninguna.
//
// # Qué guarda cada entrada, y qué no
//
// Método, URL ya resuelta (sin secretos), status, duración y tamaño. NO
// guarda headers ni cuerpo, que es una decisión vieja del módulo y sigue
// vigente: un historial con los `Authorization` de cada envío es un archivo
// de tokens que nadie pidió tener. La consecuencia se ve acá: una entrada de
// una petición GUARDADA abre esa petición —con todo lo suyo—, y una de una
// petición rápida solo puede prellenar método y URL en una pestaña nueva.

interface HistoryPanelProps {
    // Texto del buscador de la barra lateral: el mismo que filtra el árbol.
    filter: string
    // Abre la petición guardada que originó la entrada.
    onOpenItem: (itemId: string) => void
    // Abre una pestaña rápida con el método y la URL de la entrada, para las
    // que no tienen petición guardada detrás.
    onOpenScratch: (method: string, url: string) => void
    // Sube cuando se manda una petición, para que el panel no quede viejo.
    refreshToken: number
}

interface DayGroup {
    key: string
    label: string
    entries: vault.HTTPHistoryEntry[]
}

export default function HistoryPanel({filter, onOpenItem, onOpenScratch, refreshToken}: HistoryPanelProps) {
    const [entries, setEntries] = useState<vault.HTTPHistoryEntry[]>([])
    const [error, setError] = useState('')
    const [confirmClear, setConfirmClear] = useState(false)
    const [loaded, setLoaded] = useState(false)

    const reload = useCallback(async () => {
        try {
            setEntries((await HttpHistoryAll(filter)) ?? [])
            setError('')
        } catch (e) {
            setError(String(e))
        } finally {
            setLoaded(true)
        }
    }, [filter])

    useEffect(() => {
        void reload()
    }, [reload, refreshToken])

    const groups = useMemo(() => groupByDay(entries), [entries])

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-1 pb-1 pl-2 pr-1 pt-2">
                <span className="flex-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                    Historial
                </span>
                {entries.length > 0 && (
                    <>
                        <span className="font-mono text-ui-9 tabular-nums text-on-surface-variant/50">{entries.length}</span>
                        <button
                            onClick={() => setConfirmClear(true)}
                            title="Borrar el historial completo, de todas las peticiones. No se puede deshacer."
                            className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="delete_sweep" size={14} />
                        </button>
                    </>
                )}
                <button
                    onClick={() => void reload()}
                    title="Volver a leer el historial"
                    className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={14} />
                </button>
            </div>

            {error && (
                <p className="mx-2 mb-1 rounded bg-error-container px-2 py-1 text-ui-10 text-on-error-container" title={error}>
                    {error}
                </p>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {loaded && entries.length === 0 && (
                    <p className="px-2 py-3 text-ui-11 leading-relaxed text-on-surface-variant/70">
                        {filter.trim()
                            ? 'Ninguna petición del historial coincide con la búsqueda.'
                            : 'Todavía no mandaste ninguna petición. Acá van quedando las que envíes, con su status y su duración.'}
                    </p>
                )}

                {groups.map((g) => (
                    <div key={g.key} className="mb-1">
                        {/* El fondo es el MISMO de la barra lateral
                            (surface-container-low): una cabecera pegajosa con
                            otro tono se lee como una franja que no pertenece
                            a la lista. */}
                        <p className="sticky top-0 z-10 bg-surface-container-low px-2 py-1 text-ui-9 font-semibold uppercase tracking-wider text-on-surface-variant/50">
                            {g.label}
                        </p>
                        {g.entries.map((e) => (
                            <HistoryRow
                                key={e.id}
                                entry={e}
                                onOpen={() => (e.itemId ? onOpenItem(e.itemId) : onOpenScratch(e.method, e.url))}
                                onDelete={() =>
                                    void HttpDeleteHistoryEntry(e.id)
                                        .then(reload)
                                        .catch((err) => setError(String(err)))
                                }
                            />
                        ))}
                    </div>
                ))}
            </div>

            {confirmClear && (
                <ConfirmDialog
                    title="Borrar el historial"
                    description="Se borran todas las ejecuciones registradas, de todas las peticiones. Las peticiones guardadas no se tocan."
                    confirmLabel="Borrar"
                    danger
                    onConfirm={() =>
                        void HttpClearAllHistory()
                            .then(reload)
                            .catch((err) => setError(String(err)))
                    }
                    onClose={() => setConfirmClear(false)}
                />
            )}
        </div>
    )
}

function HistoryRow({
    entry,
    onOpen,
    onDelete,
}: {
    entry: vault.HTTPHistoryEntry
    onOpen: () => void
    onDelete: () => void
}) {
    // El nombre de la petición gana sobre la URL cuando existe: es como la
    // llamó quien la guardó. Una rápida no tiene nombre y muestra su URL, que
    // es todo lo que la identifica.
    const label = entry.itemName || entry.url || '(sin URL)'
    const failed = !!entry.error
    const detail = [
        entry.collectionName,
        failed ? entry.error : `${entry.status} · ${formatElapsed(entry.durationMs)}`,
        new Date(entry.executedAt * 1000).toLocaleTimeString(undefined, {hour12: false}),
    ]
        .filter(Boolean)
        .join(' · ')

    return (
        <div className="group flex w-full items-center gap-1.5 rounded py-1 pl-2 pr-1 hover:bg-surface-variant">
            <button
                onClick={onOpen}
                title={`${entry.method} ${entry.url}\n${detail}\n\n${
                    entry.itemId ? 'Abre la petición guardada.' : 'Abre una pestaña rápida con este método y esta URL (los headers y el cuerpo no se guardan en el historial).'
                }`}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
                <span className={`w-10 shrink-0 font-mono text-ui-9 font-semibold ${methodColor(entry.method)}`}>
                    {entry.method.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-11 text-on-surface-variant">{label}</span>
                    {entry.itemName && <span className="block truncate text-ui-9 text-on-surface-variant/50">{entry.url}</span>}
                </span>
                {failed ? (
                    <Icon name="error" size={12} className="shrink-0 text-error" />
                ) : (
                    <span className={`shrink-0 font-mono text-ui-9 tabular-nums ${statusColor(entry.status)}`}>
                        {entry.status || '—'}
                    </span>
                )}
            </button>
            <button
                onClick={onDelete}
                title="Borrar esta entrada del historial"
                className="shrink-0 rounded p-0.5 text-on-surface-variant/0 hover:bg-surface-container hover:text-error group-hover:text-on-surface-variant/60"
            >
                <Icon name="close" size={12} />
            </button>
        </div>
    )
}

// Agrupa por día con las etiquetas que se usan al hablar: «Hoy» y «Ayer»
// antes que una fecha, porque es lo que uno tiene en la cabeza al buscar algo
// que probó hace un rato. Más atrás sí va la fecha, que es lo único que
// distingue un martes de otro.
function groupByDay(entries: vault.HTTPHistoryEntry[]): DayGroup[] {
    const out: DayGroup[] = []
    for (const e of entries) {
        const d = new Date(e.executedAt * 1000)
        const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
        const last = out[out.length - 1]
        if (last && last.key === key) {
            last.entries.push(e)
            continue
        }
        out.push({key, label: dayLabel(d), entries: [e]})
    }
    return out
}

function dayLabel(d: Date): string {
    const today = new Date()
    const sameDay = (a: Date, b: Date) =>
        a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    if (sameDay(d, today)) return 'Hoy'
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    if (sameDay(d, yesterday)) return 'Ayer'
    return d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    })
}
