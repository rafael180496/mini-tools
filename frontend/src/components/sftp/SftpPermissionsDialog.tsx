import {useEffect, useState} from 'react'
import {ChmodSftpPath, SftpPathPermissions} from '../../../wailsjs/go/main/App'
import {sftpx} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface SftpPermissionsDialogProps {
    sessionId: string
    // Los elementos a los que se les va a aplicar el modo. Es una lista y no un
    // path suelto porque seleccionar varios y pedirles permisos es el caso
    // normal en un panel de archivos: antes el diálogo recibía uno solo y el
    // chmod terminaba aplicándose a ese, dejando el resto de la selección
    // intacta sin decir nada.
    targets: sftpx.FileEntry[]
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

// Si los elegidos ya no comparten permisos hay que decirlo ANTES de guardar:
// el chmod es absoluto, así que aplicar un modo los deja a todos iguales y eso
// pisa diferencias que quizás eran a propósito.
//
// Se compara con lo que ya trajo el listado (`FileEntry.mode`, un
// `os.FileMode.String()` tipo "-rw-r--r--"), sin pedirle nada más al servidor:
// se descartan los primeros caracteres —el tipo de archivo, que hace que una
// carpeta y un archivo con los mismos permisos se vean distintos— y se comparan
// los nueve bits rwx del final.
function sameMode(targets: sftpx.FileEntry[]): boolean {
    const bits = (m: string) => m.slice(-9)
    return targets.every((t) => bits(t.mode) === bits(targets[0].mode))
}

export default function SftpPermissionsDialog({sessionId, targets, onClose, onSaved, onError}: SftpPermissionsDialogProps) {
    const [info, setInfo] = useState<sftpx.PermInfo | null>(null)
    const [grid, setGrid] = useState<Grid | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const single = targets.length === 1 ? targets[0] : null
    // El modo inicial sale del primero: con varios elegidos es un punto de
    // partida, no una lectura de todos (y cuando difieren, el aviso de abajo lo
    // dice). Pedir los permisos de cada uno serían N viajes al servidor para
    // llenar una grilla que se va a pisar entera igual.
    const seedPath = targets[0]?.path ?? ''

    useEffect(() => {
        if (!seedPath) return
        SftpPathPermissions(sessionId, seedPath)
            .then((res) => {
                setInfo(res)
                setGrid(gridFromMode(res.mode))
            })
            .catch((err) => setError(String(err)))
            .finally(() => setLoading(false))
    }, [sessionId, seedPath])

    function toggle(c: ClassKey, b: BitKey) {
        setGrid((prev) => (prev ? {...prev, [c]: {...prev[c], [b]: !prev[c][b]}} : prev))
    }

    function save() {
        if (!grid) return
        const mode = modeFromGrid(grid)
        setBusy(true)
        setError('')
        // allSettled y no all: con varios elegidos es normal poder cambiarle
        // los permisos a unos y no a otros (dueños distintos), y un `all` corta
        // en el primer rechazo dejando sin informar qué pasó con el resto —
        // aunque las llamadas ya hayan salido igual.
        Promise.allSettled(targets.map((t) => ChmodSftpPath(sessionId, t.path, mode)))
            .then((results) => {
                const failed = results
                    .map((r, i) => (r.status === 'rejected' ? `${targets[i].name}: ${String(r.reason)}` : ''))
                    .filter(Boolean)
                // Los que sí cambiaron ya cambiaron: se refresca el panel aunque
                // alguno haya fallado, o la lista seguiría mostrando permisos
                // viejos que ya no son los del servidor.
                onSaved()
                if (failed.length === 0) {
                    onClose()
                    return
                }
                // Se muestra el error crudo del backend (permiso denegado, FS de
                // solo lectura…) acá Y se burbujea al panel, para que no se
                // pierda si se cierra el diálogo. El diálogo queda abierto: es
                // lo que deja ver CUÁLES fallaron.
                const msg =
                    failed.length === targets.length
                        ? failed.join('\n')
                        : `${failed.length} de ${targets.length} no se pudieron cambiar:\n${failed.join('\n')}`
                setError(msg)
                onError(msg)
            })
            .finally(() => setBusy(false))
    }

    const mode = grid ? modeFromGrid(grid) : 0
    const mixed = targets.length > 1 && !sameMode(targets)
    const someDir = targets.some((t) => t.isDir)

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
                <p
                    className="truncate text-xs text-on-surface-variant"
                    title={single ? single.path : targets.map((t) => t.path).join('\n')}
                >
                    {single ? single.name : `${targets.length} elementos seleccionados`}
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
                            {targets.length > 1 && (
                                <span className="ml-auto font-sans not-italic">→ {targets.length} elementos</span>
                            )}
                        </div>

                        {mixed && (
                            <p className="text-xs text-on-surface-variant">
                                Los elementos elegidos <strong className="text-on-surface">no tienen los mismos permisos</strong>.
                                Se muestra el modo del primero; al guardar, todos quedan con el modo de arriba.
                            </p>
                        )}
                        {someDir && (
                            <p className="text-xs text-on-surface-variant">
                                Los permisos se aplican a las carpetas elegidas, <strong className="text-on-surface">no a su contenido</strong>.
                            </p>
                        )}

                        {single && (
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
                        )}
                    </>
                ) : null}

                {error && <p className="whitespace-pre-wrap text-xs text-error">{error}</p>}

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
                        title={
                            targets.length > 1
                                ? `Aplica los permisos (chmod) a los ${targets.length} elementos elegidos`
                                : 'Aplica los permisos (chmod) al archivo'
                        }
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? 'Guardando…' : targets.length > 1 ? `Guardar en ${targets.length}` : 'Guardar'}
                    </button>
                </div>
            </div>
        </div>
    )
}
