import type {Messages} from '../../types'
import type es from '../../es/gitparts/conflicts'

const en: Messages<typeof es> = {
    oursRebase: "The branch you're rebasing onto",
    oursMerge: 'Your branch (current)',
    theirsRebase: 'The commit being replayed',
    theirsMerge: 'The incoming branch',
    withConflicts: (p) => `${p.op} with conflicts`,
    unresolvedFiles: (n) => (n === 1 ? '1 unresolved file' : `${n} unresolved files`),
    continuePending: (p) =>
        `${p.n} file(s) still have conflicts. Resolve them and mark them to be able to continue.`,
    continueTitle: (p) => `Continue the ${p.op} with the resolutions already marked`,
    continueOp: (p) => `Continue ${p.op}`,
    askTitle:
        "Asks the agent to explain this conflict and suggest how to resolve it. It doesn't write the file: you choose and mark the resolution.",
    ask: 'Ask',
    abortTitle: (p) => `Cancel the ${p.op} and leave the repository as it was before it started`,
    abort: 'Abort',
    closeTitle: 'Close the resolver',
    noneLeft: (p) => `No files with conflicts left. You can continue the ${p.op} now.`,
    progressTitle: 'Conflict blocks resolved out of the total in this file',
    progress: (p) => `Conflict ${p.current} of ${p.total} · ${p.done} resolved`,
    prevTitle: 'Previous conflict (Alt+P)',
    nextTitle: 'Next conflict (Alt+N)',
    markResolvedTitle: 'Save the resolved file and mark it as resolved (stages it)',
    markResolvedPending:
        'Some blocks are still undecided. A file saved with markers is broken and git still sees it as conflicted.',
    markResolved: 'Mark as resolved',
    loadingFile: 'Loading the file…',
    unresolved: 'Unresolved',
    resolved: 'Resolved',
    keepMine: 'Keep mine',
    acceptIncoming: 'Accept incoming',
    applyOnly: (p) => `Apply only ${p.side}`,
    both: 'Both',
    bothTitle: 'Keep both blocks, yours first and then the incoming one',
    undo: 'Undo',
    undoTitle: 'Leave this block undecided again',
    base: 'Common ancestor',
    baseDetail: 'before both branches touched it',
    empty: '(empty)',
}
export default en
