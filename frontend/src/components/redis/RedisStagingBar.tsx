import Icon from '../Icon'
import {useT} from '../../i18n'

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
    const t = useT()
    const total = editCount + deleteCount
    if (total === 0) return null

    return (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-tertiary/50 bg-tertiary/10 px-3 py-1.5 text-xs">
            <Icon name="pending_actions" size={15} className="shrink-0 text-tertiary" />
            <span className="text-on-surface">
                {t.redis.staging.pending({edits: editCount, deletes: deleteCount})}
            </span>
            <span className="text-on-surface-variant/70">{t.redis.staging.nothingWritten}</span>

            <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                    onClick={onDiscard}
                    disabled={saving}
                    title={t.redis.staging.discardHint}
                    className="rounded px-2 py-1 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    {t.redis.staging.discard}
                </button>
                <button
                    onClick={onSave}
                    disabled={saving}
                    title={t.redis.staging.saveHint}
                    className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                >
                    {saving && <Icon name="progress_activity" size={13} className="animate-spin" />}
                    {saving ? t.redis.staging.applying : t.redis.staging.save}
                </button>
            </div>
        </div>
    )
}
