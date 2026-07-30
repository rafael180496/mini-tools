import Icon from '../Icon'

interface RedisStagingBarProps {
    editCount: number
    deleteCount: number
    saving: boolean
    onSave: () => void
    onDiscard: () => void
}

// The pending-changes bar.
//
// The reason it exists: before this, every keystroke-sized edit wrote to
// Redis the moment you clicked the check mark. That makes an accidental
// change unrecoverable — Redis has no undo, no transaction the UI was
// holding open, and no confirmation step. Staging turns "I mistyped" from a
// data loss into a Discard click.
//
// It only renders when there is something staged, so the normal read-only
// browsing case keeps the full panel height.
export default function RedisStagingBar({editCount, deleteCount, saving, onSave, onDiscard}: RedisStagingBarProps) {
    const total = editCount + deleteCount
    if (total === 0) return null

    const parts: string[] = []
    if (editCount > 0) parts.push(`${editCount} ${editCount === 1 ? 'cambio' : 'cambios'}`)
    if (deleteCount > 0) parts.push(`${deleteCount} ${deleteCount === 1 ? 'baja' : 'bajas'}`)

    return (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-tertiary/50 bg-tertiary/10 px-3 py-1.5 text-xs">
            <Icon name="pending_actions" size={15} className="shrink-0 text-tertiary" />
            <span className="text-on-surface">
                {parts.join(' y ')} sin aplicar
            </span>
            <span className="text-on-surface-variant/70">— todavía no se escribió nada en Redis</span>

            <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                    onClick={onDiscard}
                    disabled={saving}
                    title="Descarta todos los cambios pendientes y vuelve a mostrar los valores como están en Redis"
                    className="rounded px-2 py-1 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    Descartar
                </button>
                <button
                    onClick={onSave}
                    disabled={saving}
                    title="Aplica los cambios pendientes en Redis. Cada uno es un comando propio: Redis no tiene deshacer, así que revisá antes."
                    className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                >
                    {saving && <Icon name="progress_activity" size={13} className="animate-spin" />}
                    {saving ? 'Aplicando…' : 'Guardar cambios'}
                </button>
            </div>
        </div>
    )
}
