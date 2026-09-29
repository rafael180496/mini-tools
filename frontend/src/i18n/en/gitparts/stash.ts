import type {Messages} from '../../types'
import type es from '../../es/gitparts/stash'

const en: Messages<typeof es> = {
    title: 'Stashes',
    pushTitle: 'Save uncommitted changes to a stash and leave the working tree clean',
    push: 'Stash changes',
    closeTitle: 'Close the stash panel',
    empty: 'No saved stashes. A stash sets uncommitted changes aside so you can pick them up later.',
    itemTitle: (p) => `${p.ref} — saved on "${p.branch}" on ${p.date}`,
    applyTitle: 'Applies the stash to the working tree and KEEPS it saved — if something goes wrong, the stash is still there',
    apply: 'Apply',
    popTitle:
        'Applies the stash and REMOVES it from the list (pop). If applying ends in a conflict, the stash is no longer there to retry: use Apply if you are not sure.',
    pop: 'Apply and remove',
    dropTitle: 'Deletes the stash without applying it. This can’t be undone.',
    drop: 'Delete',
    loading: 'Loading the stash contents…',
    noChanges: 'This stash has no changes to show.',
    confirmTitle: 'Delete stash',
    confirmBody: (p) =>
        `"${p.message}" is deleted without being applied. Unlike a commit, it doesn’t stay in the branch reflog: there is no way to recover it.`,
}
export default en
