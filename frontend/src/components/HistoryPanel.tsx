import {useState} from 'react'
import {vault} from '../../wailsjs/go/models'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'

interface HistoryPanelProps {
    entries: vault.HistoryEntry[]
    loading: boolean
    error: string
    onRefresh: () => void
    onClear: () => void
    onDeleteEntry: (id: string) => void
}

const STATUS_STYLE: Record<string, {icon: string; className: string}> = {
    done: {icon: 'check_circle', className: 'text-tertiary'},
    error: {icon: 'error', className: 'text-error'},
    cancelled: {icon: 'block', className: 'text-on-surface-variant'},
}

function formatTimestamp(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleString()
}

// Spec-driven by a real debugging session: with no execution log in the
// UI, tracking down why a PL/SQL block failed against a real Oracle
// instance meant reading backend/vault's query_history table directly with
// sqlite3 — the data was already being persisted (RecordQueryHistory /
// ListQueryHistory), just never surfaced. This is that surface: the exact
// SQL text and error message for each past execution, without needing to
// reproduce the failure to see what actually got sent to the database.
export default function HistoryPanel({entries, loading, error, onRefresh, onClear, onDeleteEntry}: HistoryPanelProps) {
    const [filter, setFilter] = useState('')
    const [expandedId, setExpandedId] = useState<string | null>(null)
    // Confirmation is an in-app modal (ConfirmDialog), not window.confirm() —
    // a native confirm() inside the Wails webview isn't obviously a dialog,
    // the same failure mode already documented for the SELECT * linter
    // warning ("no me deja borrar" was really "no noté el diálogo").
    const [confirmClearAll, setConfirmClearAll] = useState(false)
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

    const q = filter.trim().toLowerCase()
    const visible = q
        ? entries.filter((e) => e.sqlText.toLowerCase().includes(q) || (e.errorMessage ?? '').toLowerCase().includes(q))
        : entries

    return (
        <div className="flex flex-1 flex-col overflow-hidden bg-surface-container-low">
            <div className="flex items-center justify-between gap-2 border-b border-outline-variant px-3 py-1">
                <span className="text-xs font-semibold text-on-surface-variant">
                    {entries.length} {entries.length === 1 ? 'ejecución registrada' : 'ejecuciones registradas'}
                </span>
                <div className="flex items-center gap-1">
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filtrar por SQL o error..."
                        className="w-56 rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                    />
                    <button
                        onClick={onRefresh}
                        title="Vuelve a leer el historial de esta conexión"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="refresh" size={16} />
                    </button>
                    <button
                        onClick={() => setConfirmClearAll(true)}
                        disabled={entries.length === 0}
                        title="Borra permanentemente todo el historial de ejecuciones de esta conexión"
                        className="rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-on-error-container disabled:opacity-40"
                    >
                        <Icon name="delete_sweep" size={16} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {loading && <p className="p-2 text-xs text-on-surface-variant">Cargando historial…</p>}
                {error && <p className="p-2 text-xs text-error">{error}</p>}
                {!loading && !error && visible.length === 0 && (
                    <p className="p-2 text-xs text-on-surface-variant">
                        {entries.length === 0 ? 'Sin ejecuciones registradas todavía.' : `Sin coincidencias para "${filter}".`}
                    </p>
                )}
                {!loading &&
                    !error &&
                    visible.map((e) => {
                        const style = STATUS_STYLE[e.status] ?? STATUS_STYLE.cancelled
                        const expanded = expandedId === e.id
                        return (
                            <div key={e.id} className="group border-b border-outline-variant/50">
                                <div className="flex items-center">
                                    <button
                                        onClick={() => setExpandedId(expanded ? null : e.id)}
                                        title="Click para ver el statement completo y, si falló, el mensaje de error completo"
                                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left hover:bg-surface-variant"
                                    >
                                        <Icon name={style.icon} size={14} className={`shrink-0 ${style.className}`} filled />
                                        <span className="w-36 shrink-0 whitespace-nowrap text-[11px] text-on-surface-variant">
                                            {formatTimestamp(e.executedAt)}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface">
                                            {e.sqlText.replace(/\s+/g, ' ')}
                                        </span>
                                        <span className="shrink-0 whitespace-nowrap text-[11px] text-on-surface-variant">
                                            {e.status === 'done' ? `${e.rowsAffected} filas · ${e.durationMs}ms` : e.status}
                                        </span>
                                    </button>
                                    <button
                                        onClick={(ev) => {
                                            ev.stopPropagation()
                                            setConfirmDeleteId(e.id)
                                        }}
                                        title="Borra esta entrada del historial — no se puede deshacer"
                                        className="hidden shrink-0 rounded p-1 text-on-surface-variant opacity-70 hover:bg-error-container hover:text-on-error-container hover:opacity-100 group-hover:block"
                                    >
                                        <Icon name="delete" size={14} />
                                    </button>
                                </div>
                                {expanded && (
                                    <div className="space-y-1 bg-surface-container-lowest px-3 py-2">
                                        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-on-surface-variant">
                                            {e.sqlText}
                                        </pre>
                                        {e.errorMessage && (
                                            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-error">
                                                {e.errorMessage}
                                            </pre>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
            </div>

            {confirmClearAll && (
                <ConfirmDialog
                    title="Borrar todo el historial"
                    description={`¿Borrar las ${entries.length} ejecuciones registradas de esta conexión? No se puede deshacer.`}
                    confirmLabel="Borrar todo"
                    danger
                    onConfirm={onClear}
                    onClose={() => setConfirmClearAll(false)}
                />
            )}
            {confirmDeleteId && (
                <ConfirmDialog
                    title="Borrar entrada del historial"
                    description="¿Borrar esta ejecución del historial? No se puede deshacer."
                    confirmLabel="Borrar"
                    danger
                    onConfirm={() => onDeleteEntry(confirmDeleteId)}
                    onClose={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    )
}
