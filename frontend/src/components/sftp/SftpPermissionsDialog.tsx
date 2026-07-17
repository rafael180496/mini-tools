import {useEffect, useState} from 'react'
import {ChmodSftpPath, SftpPathPermissions} from '../../../wailsjs/go/main/App'
import {sftpx} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface SftpPermissionsDialogProps {
    sessionId: string
    path: string
    name: string
    onClose: () => void
    onSaved: () => void
    onError: (msg: string) => void
}

// The three POSIX permission classes and the three bits each, with their octal
// weights — the mode int is just the OR of every enabled bit.
type ClassKey = 'owner' | 'group' | 'other'
type BitKey = 'read' | 'write' | 'execute'

const CLASSES: {key: ClassKey; label: string; shift: number}[] = [
    {key: 'owner', label: 'Propietario', shift: 6},
    {key: 'group', label: 'Grupo', shift: 3},
    {key: 'other', label: 'Otros', shift: 0},
]
const BITS: {key: BitKey; label: string; weight: number}[] = [
    {key: 'read', label: 'Lectura', weight: 4},
    {key: 'write', label: 'Escritura', weight: 2},
    {key: 'execute', label: 'Ejecución', weight: 1},
]

type Grid = Record<ClassKey, Record<BitKey, boolean>>

function gridFromMode(mode: number): Grid {
    const grid = {} as Grid
    for (const c of CLASSES) {
        grid[c.key] = {} as Record<BitKey, boolean>
        for (const b of BITS) {
            grid[c.key][b.key] = (mode & (b.weight << c.shift)) !== 0
        }
    }
    return grid
}

function modeFromGrid(grid: Grid): number {
    let mode = 0
    for (const c of CLASSES) {
        for (const b of BITS) {
            if (grid[c.key][b.key]) mode |= b.weight << c.shift
        }
    }
    return mode
}

// Renders the classic "755" / "-rwxr-xr-x" preview so the user sees exactly
// what will be applied.
function octal(mode: number): string {
    return mode.toString(8).padStart(3, '0')
}
const SYM: Record<BitKey, string> = {read: 'r', write: 'w', execute: 'x'}
function symbolic(grid: Grid): string {
    return CLASSES.map((c) => BITS.map((b) => (grid[c.key][b.key] ? SYM[b.key] : '-')).join('')).join('')
}

export default function SftpPermissionsDialog({sessionId, path, name, onClose, onSaved, onError}: SftpPermissionsDialogProps) {
    const [info, setInfo] = useState<sftpx.PermInfo | null>(null)
    const [grid, setGrid] = useState<Grid | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        SftpPathPermissions(sessionId, path)
            .then((res) => {
                setInfo(res)
                setGrid(gridFromMode(res.mode))
            })
            .catch((err) => setError(String(err)))
            .finally(() => setLoading(false))
    }, [sessionId, path])

    function toggle(c: ClassKey, b: BitKey) {
        setGrid((prev) => (prev ? {...prev, [c]: {...prev[c], [b]: !prev[c][b]}} : prev))
    }

    function save() {
        if (!grid) return
        const mode = modeFromGrid(grid)
        setBusy(true)
        setError('')
        ChmodSftpPath(sessionId, path, mode)
            .then(() => {
                onSaved()
                onClose()
            })
            .catch((err) => {
                // Show the raw backend error here (permission denied, read-only
                // FS, etc.) AND bubble it to the pane banner so it's not lost if
                // the dialog is dismissed.
                setError(String(err))
                onError(String(err))
            })
            .finally(() => setBusy(false))
    }

    const mode = grid ? modeFromGrid(grid) : 0

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" onClick={onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                className="flex w-96 flex-col gap-4 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg"
            >
                <div className="flex items-center gap-2">
                    <Icon name="lock" size={18} className="text-primary" />
                    <h2 className="text-lg font-semibold">Editar permisos</h2>
                    <button onClick={onClose} title="Cerrar" className="ml-auto rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={18} />
                    </button>
                </div>
                <p className="truncate text-xs text-on-surface-variant" title={path}>
                    {name}
                </p>

                {loading ? (
                    <div className="py-6 text-center text-xs text-on-surface-variant">Cargando…</div>
                ) : grid ? (
                    <>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-on-surface-variant">
                                    <th className="py-1 text-left font-medium">Acceso</th>
                                    {BITS.map((b) => (
                                        <th key={b.key} className="py-1 text-center font-medium">
                                            {b.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {CLASSES.map((c) => (
                                    <tr key={c.key} className="border-t border-outline-variant">
                                        <td className="py-2 text-on-surface">{c.label}</td>
                                        {BITS.map((b) => (
                                            <td key={b.key} className="py-2 text-center">
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={grid[c.key][b.key]}
                                                    onClick={() => toggle(c.key, b.key)}
                                                    title={`${c.label} · ${b.label}`}
                                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                                                        grid[c.key][b.key] ? 'bg-primary' : 'bg-surface-container-highest'
                                                    }`}
                                                >
                                                    <span
                                                        className={`inline-block h-4 w-4 transform rounded-full bg-on-primary transition-transform ${
                                                            grid[c.key][b.key] ? 'translate-x-4' : 'translate-x-0.5'
                                                        } ${grid[c.key][b.key] ? '' : 'bg-outline'}`}
                                                    />
                                                </button>
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <div className="flex items-center gap-2 rounded-lg bg-surface-container-highest px-3 py-2 font-mono text-xs text-on-surface-variant">
                            <span>{octal(mode)}</span>
                            <span className="opacity-60">·</span>
                            <span>{symbolic(grid)}</span>
                        </div>

                        <div className="border-t border-outline-variant pt-3 text-xs">
                            <p className="mb-1 font-medium text-on-surface-variant">Propiedad (solo lectura)</p>
                            <div className="flex justify-between py-0.5">
                                <span className="text-on-surface-variant">Usuario</span>
                                <span className="text-on-surface">{info?.owner || '—'}</span>
                            </div>
                            <div className="flex justify-between py-0.5">
                                <span className="text-on-surface-variant">Grupo</span>
                                <span className="text-on-surface">{info?.group || '—'}</span>
                            </div>
                        </div>
                    </>
                ) : null}

                {error && <p className="text-xs text-error">{error}</p>}

                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface disabled:opacity-50"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        onClick={save}
                        disabled={busy || !grid}
                        title="Aplica los permisos (chmod) al archivo"
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </div>
        </div>
    )
}
