import {useEffect, useMemo, useState} from 'react'
import {SetSshHistoryEnabled, SshHistoryEnabled} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'

interface SshHistoryPanelProps {
    // Qué historial se está mirando, ya resuelto por quien abre el panel.
    //
    // Es por ÁMBITO y no global porque un comando del servidor de facturación
    // no significa nada en el de correo —ni uno de PowerShell en zsh— y
    // mezclarlos convertiría la lista en ruido. Quién es ese ámbito lo decide
    // el llamador: una conexión SSH o el intérprete de una terminal local.
    //
    // `scope` es el identificador (sirve para recargar al cambiar de ámbito) y
    // `scopeLabel` es cómo se lo nombra en pantalla ("PRODMAIN", "PowerShell").
    scope: string
    scopeLabel: string
    // De dónde salen y cómo se borran. Inyectados porque el historial SSH y el
    // de las terminales locales viven en tablas distintas (una cuelga de la
    // conexión, la otra del intérprete) y el panel es el mismo.
    load: (limit: number) => Promise<vault.SshHistoryEntry[]>
    clear: () => Promise<number>
    // Qué NO borra el botón de limpiar, dicho en la propia advertencia: en un
    // servidor es su ~/.bash_history, en la máquina local el del shell de uno.
    keepsNote: string
    onClose: () => void
    // Escribe en la terminal sin ejecutar (queda en la línea, editable).
    onPaste: (command: string) => void
    // Escribe y manda Enter.
    onRun: (command: string) => void
}

// Historial de comandos ejecutados en las terminales SSH de esta conexión.
//
// Existía solo en memoria y por sesión: cerrar la pestaña lo tiraba, así que el
// comando largo de ayer había que reconstruirlo de cabeza. Ahora se guarda
// cifrado en el vault (ver backend/vault/ssh_history_repo.go), y este panel es
// dónde se lo mira, se lo reusa y —lo que hace que guardarlo sea aceptable— se
// lo borra.
export default function SshHistoryPanel({scope, scopeLabel, load, clear, keepsNote, onClose, onPaste, onRun}: SshHistoryPanelProps) {
    const [entries, setEntries] = useState<vault.SshHistoryEntry[]>([])
    const [filter, setFilter] = useState('')
    const [enabled, setEnabled] = useState(true)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [confirmClear, setConfirmClear] = useState(false)

    function reload() {
        setLoading(true)
        Promise.all([load(500), SshHistoryEnabled()])
            .then(([list, on]) => {
                setEntries(list ?? [])
                setEnabled(on)
                setError('')
            })
            .catch((e) => setError(String(e)))
            .finally(() => setLoading(false))
    }

    // Se recarga al abrir el panel y al cambiar de conexión. No hay
    // suscripción a "se ejecutó un comando": el panel es algo que se abre a
    // buscar algo puntual, y refrescarlo con cada Enter costaría una consulta
    // al vault por tecla para mover una lista que nadie está mirando.
    useEffect(reload, [scope])

    const q = filter.trim().toLowerCase()
    const visible = useMemo(() => (q ? entries.filter((e) => e.command.toLowerCase().includes(q)) : entries), [entries, q])

    async function toggleEnabled() {
        const next = !enabled
        setEnabled(next)
        try {
            await SetSshHistoryEnabled(next)
        } catch (e) {
            setEnabled(!next)
            setError(String(e))
        }
    }

    async function doClear() {
        setConfirmClear(false)
        try {
            await clear()
            setEntries([])
        } catch (e) {
            setError(String(e))
        }
    }

    return (
        <div className="flex h-full w-80 shrink-0 flex-col border-l border-outline-variant bg-surface-container">
            <div className="flex items-center gap-1.5 border-b border-outline-variant px-2 py-1.5">
                <Icon name="history" size={16} className="text-on-surface-variant" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Historial</span>
                <button
                    onClick={reload}
                    title="Vuelve a leer el historial del vault — útil si ejecutaste comandos con el panel abierto, que no se refresca solo"
                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={15} />
                </button>
                <button
                    onClick={onClose}
                    title="Cierra este panel"
                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </div>

            <div className="shrink-0 border-b border-outline-variant p-2">
                <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Buscar en el historial…"
                        title="Filtra por texto dentro del comando — es lo que hace útil un historial largo, contra el Ctrl+R del propio shell que solo busca hacia atrás de a uno"
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {filter && (
                        <button onClick={() => setFilter('')} title="Limpiar la búsqueda" className="shrink-0 text-on-surface-variant/60 hover:text-on-surface">
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>
            </div>

            {error && <p className="shrink-0 border-b border-outline-variant bg-error-container/40 px-2 py-1.5 text-ui-11 text-on-error-container">{error}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {loading ? (
                    <p className="p-3 text-center text-ui-11 text-on-surface-variant/70">Cargando…</p>
                ) : visible.length === 0 ? (
                    <p className="p-3 text-ui-11 leading-relaxed text-on-surface-variant/70">
                        {q
                            ? `Ningún comando coincide con «${filter}».`
                            : enabled
                              ? `Todavía no hay comandos registrados para "${scopeLabel}". Se van guardando a medida que los ejecutás en su terminal.`
                              : 'El registro está apagado, así que no se está guardando nada nuevo.'}
                    </p>
                ) : (
                    visible.map((e) => (
                        <div
                            key={e.id}
                            className="group flex items-start gap-1 rounded px-1.5 py-1 hover:bg-surface-variant"
                        >
                            <button
                                onClick={() => onPaste(e.command)}
                                onDoubleClick={() => onRun(e.command)}
                                title={`${new Date(e.ranAt * 1000).toLocaleString()}\n\nClick: escribirlo en la terminal sin ejecutar, para poder editarlo. Doble click: ejecutarlo tal cual.`}
                                className="min-w-0 flex-1 text-left font-mono text-ui-11 leading-snug text-on-surface"
                            >
                                <span className="line-clamp-3 break-all">{e.command}</span>
                            </button>
                            <button
                                onClick={() => onRun(e.command)}
                                title="Ejecutar este comando tal cual en la terminal"
                                className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-container-highest hover:text-primary group-hover:opacity-100"
                            >
                                <Icon name="play_arrow" size={14} />
                            </button>
                            <button
                                onClick={() => void navigator.clipboard.writeText(e.command)}
                                title="Copiar el comando al portapapeles"
                                className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-container-highest hover:text-on-surface group-hover:opacity-100"
                            >
                                <Icon name="content_copy" size={13} />
                            </button>
                        </div>
                    ))
                )}
            </div>

            <div className="shrink-0 border-t border-outline-variant p-2">
                <label
                    className="flex cursor-pointer items-center gap-1.5 text-ui-11 text-on-surface-variant"
                    title="Mientras esté prendido, cada comando que ejecutes en una terminal SSH se guarda cifrado en el vault. Apagarlo corta el registro de inmediato y NO borra lo ya guardado — para eso está el botón de abajo."
                >
                    <input type="checkbox" checked={enabled} onChange={toggleEnabled} className="accent-primary" />
                    Registrar los comandos que ejecuto
                </label>
                <p className="mt-1 text-ui-10 leading-relaxed text-on-surface-variant/60">
                    Se guarda cifrado con la clave maestra. Las líneas que parecen traer una contraseña o un token{' '}
                    <span title="Reconoce formas como -pCLAVE, --password=…, sshpass, TOKEN=…, curl -u, export API_KEY=… y claves privadas pegadas. Es un filtro, no una garantía.">
                        (ver cuáles)
                    </span>{' '}
                    no se guardan nunca, ni siquiera cifradas.
                </p>
                <button
                    onClick={() => setConfirmClear(true)}
                    disabled={entries.length === 0}
                    title={
                        entries.length === 0
                            ? 'No hay nada que borrar en esta conexión'
                            : `Borra los ${entries.length} comandos guardados de "${scopeLabel}". ${keepsNote}`
                    }
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-outline-variant py-1.5 text-ui-11 text-error hover:bg-error-container/40 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                    <Icon name="delete_sweep" size={14} />
                    Limpiar el historial de esta conexión
                </button>
            </div>

            {confirmClear && (
                <ConfirmDialog
                    title="Limpiar el historial"
                    description={`Esto borra del vault los ${entries.length} comandos guardados de "${scopeLabel}". No se puede deshacer. ${keepsNote}`}
                    confirmLabel="Limpiar"
                    danger
                    onConfirm={doClear}
                    onClose={() => setConfirmClear(false)}
                />
            )}
        </div>
    )
}
