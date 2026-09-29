import {sftpx} from '../../../wailsjs/go/models'
import {formatBytes} from '../../lib/formatBytes'
import Icon from '../Icon'
import {formatDateTime, useT} from '../../i18n'

// ConflictPolicy values must match the constants in backend/sftpx/conflict.go.
export type ConflictPolicy = 'overwrite' | 'newer' | 'skip' | 'rename'

interface SftpConflictDialogProps {
    conflicts: sftpx.Conflict[]
    destLabel: string
    onChoose: (policy: ConflictPolicy) => void
    onCancel: () => void
}

function fmtTime(unix: number): string {
    if (!unix) return '—'
    return formatDateTime(unix)
}

// Asked once, before a transfer starts, when destination names already exist.
//
// One decision for the whole batch rather than a prompt per file: a per-file
// dialog on a 200-file upload is not a safety feature, it is a reason to click
// "yes to all" without reading. The table below shows which side is newer so
// the single decision can be made with the facts in view.
export default function SftpConflictDialog({conflicts, destLabel, onChoose, onCancel}: SftpConflictDialogProps) {
    const t = useT()
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-4 py-3">
                    <Icon name="warning" size={18} className="text-tertiary" />
                    <h2 className="text-sm font-medium text-on-surface">
                        {t.sftp.conflict.title(conflicts.length)}
                    </h2>
                    <span className="ml-auto truncate text-ui-11 text-on-surface-variant" title={destLabel}>
                        {destLabel}
                    </span>
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-surface-container-low text-ui-11 text-on-surface-variant">
                            <tr>
                                <th className="px-3 py-1.5 text-left font-medium">{t.sftp.conflict.name}</th>
                                <th className="px-3 py-1.5 text-right font-medium">{t.sftp.conflict.source}</th>
                                <th className="px-3 py-1.5 text-right font-medium">{t.sftp.conflict.destination}</th>
                                <th className="px-3 py-1.5 text-left font-medium">{t.sftp.conflict.newer}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {conflicts.map((c) => {
                                const srcNewer = c.srcModTime > c.dstModTime
                                return (
                                    <tr key={c.name} className="border-t border-outline-variant/50">
                                        <td className="max-w-[16rem] truncate px-3 py-1.5 text-on-surface" title={c.name}>
                                            <span className="flex items-center gap-1.5">
                                                <Icon
                                                    name={c.isDir ? 'folder' : 'description'}
                                                    size={14}
                                                    className="shrink-0 text-on-surface-variant"
                                                />
                                                {c.name}
                                            </span>
                                        </td>
                                        <td className="px-3 py-1.5 text-right whitespace-nowrap text-on-surface-variant" title={fmtTime(c.srcModTime)}>
                                            {formatBytes(c.srcSize)}
                                        </td>
                                        <td className="px-3 py-1.5 text-right whitespace-nowrap text-on-surface-variant" title={fmtTime(c.dstModTime)}>
                                            {formatBytes(c.dstSize)}
                                        </td>
                                        <td className="px-3 py-1.5 whitespace-nowrap">
                                            {c.srcModTime === c.dstModTime ? (
                                                <span className="text-on-surface-variant">{t.sftp.conflict.same}</span>
                                            ) : (
                                                <span className={srcNewer ? 'text-secondary' : 'text-tertiary'}>
                                                    {srcNewer ? t.sftp.conflict.sourceNewer : t.sftp.conflict.destNewer}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-outline-variant px-4 py-3">
                    <button
                        onClick={() => onChoose('newer')}
                        title={t.sftp.conflict.newerTooltip}
                        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                    >
                        {t.sftp.conflict.newerButton}
                    </button>
                    <button
                        onClick={() => onChoose('rename')}
                        title={t.sftp.conflict.renameTooltip}
                        className="rounded border border-outline px-3 py-1.5 text-xs text-on-surface hover:bg-surface-variant"
                    >
                        {t.sftp.conflict.rename}
                    </button>
                    <button
                        onClick={() => onChoose('skip')}
                        title={t.sftp.conflict.skipTooltip}
                        className="rounded border border-outline px-3 py-1.5 text-xs text-on-surface hover:bg-surface-variant"
                    >
                        {t.sftp.conflict.skip}
                    </button>
                    <button
                        onClick={() => onChoose('overwrite')}
                        title={t.sftp.conflict.overwriteTooltip}
                        className="rounded border border-error/60 px-3 py-1.5 text-xs text-error hover:bg-error-container/30"
                    >
                        {t.sftp.conflict.overwrite}
                    </button>
                    <button
                        onClick={onCancel}
                        className="ml-auto rounded px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        {t.common.cancel}
                    </button>
                </div>
            </div>
        </div>
    )
}
