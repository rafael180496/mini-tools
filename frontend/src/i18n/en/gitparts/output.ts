import type {Messages} from '../../types'
import type es from '../../es/gitparts/output'

const en: Messages<typeof es> = {
    kind: {
        added: 'New',
        deleted: 'Deleted',
        renamed: 'Renamed',
        modified: 'Modified',
    },
    kindCount: {
        added: (n) => `${n} new`,
        deleted: (n) => `${n} deleted`,
        renamed: (n) => `${n} renamed`,
        modified: (n) => `${n} modified`,
    },
    copyTitle: 'Copy the full git output',
    closeTitle: 'Close this message',
    hideFiles: 'Hide the file list',
    showFiles: 'Show the files that changed',
    filesUpdated: (n) => (n === 1 ? `${n} file updated` : `${n} files updated`),
    fastForward: 'fast-forward',
    revealTitle: (p) => `Go to ${p.hash} in the graph`,
    filterPlaceholder: (n) => `Filter ${n} files…`,
    filterCount: (p) => `${p.visible} of ${p.total}`,
    noMatch: (p) => `No file matches "${p.filter}".`,
    hideRaw: 'Hide git output',
    showRaw: 'Show git output',
    openTitle: (p) => `Open ${p.path}`,
    binDetail: (p) => `bin ${p.detail}`,
    binary: 'binary',
}
export default en
