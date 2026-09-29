import type {Messages} from '../../types'
import type es from '../../es/gitparts/reflog'

const en: Messages<typeof es> = {
    filterPlaceholder: 'Filter by message, action or hash',
    reloadTitle: 'Read the reflog again',
    loading: 'Reading…',
    empty: 'This repository has no HEAD movements yet.',
    noMatch: 'No movement matches the filter.',
    openCommit: (p) => `View commit ${p.hash}`,
    destructiveTitle: 'This action rewrote history: it’s the kind that leaves unreferenced commits behind',
    branchTitle:
        'Create a branch at this position. It’s the safe way to recover: it doesn’t move anything you have now and gives the lost commit a name of its own.',
    resetTitle: 'Move the current branch to this position with reset --hard. Recovers this, but discards anything uncommitted.',
    footer: {
        before: 'The reflog is ',
        strong: 'local and temporary',
        after: ': it isn’t cloned or pushed, and git prunes it on its own (90 days for reachable entries, 30 for the rest). It’s for recovering yesterday’s work, not a history.',
    },
    branchDialog: {
        title: 'Create a branch here',
        label: 'Branch name',
        initial: (p) => `recovered-${p.hash}`,
        confirm: 'Create',
    },
    resetDialog: {
        title: 'Move the current branch here',
        description: (p) =>
            `The current branch will point to ${p.hash} ("${p.subject}"). Anything uncommitted is lost, and commits left ahead will only be reachable from this same reflog. If all you want is to recover that commit, create a branch instead.`,
        confirm: 'Reset --hard',
    },
}
export default en
