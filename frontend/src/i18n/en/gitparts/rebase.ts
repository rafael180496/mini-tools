import type {Messages} from '../../types'
import type es from '../../es/gitparts/rebase'

const en: Messages<typeof es> = {
    actions: {
        pick: {label: 'pick — keep as is', hint: 'Applies the commit unchanged'},
        reword: {label: 'reword — change the message', hint: 'Applies the commit and stops so you can edit its message'},
        edit: {label: 'edit — stop to edit it', hint: 'Applies the commit and stops the rebase so you can change its content'},
        squash: {label: 'squash — combine with the previous one', hint: 'Folds this commit into the one above, keeping both messages'},
        fixup: {label: 'fixup — combine and discard the message', hint: 'Like squash, but drops this commit’s message'},
        drop: {label: 'drop — remove it', hint: 'Discards the commit entirely'},
    },
    title: 'Reorder and combine commits',
    closeTitle: 'Close without changing anything',
    rewrite: {
        before: 'This ',
        strong: 'rewrites history',
        middle: ' from ',
        after: ' onward: every commit gets a new hash. If the branch is already published, you will need a force push afterwards.',
    },
    order: {
        before: 'The list goes from ',
        strong: 'oldest to newest',
        after: ', like git’s own todo file — the opposite of the graph. "Combine with the previous one" means the one above.',
    },
    loading: 'Loading commits…',
    empty: (p) => `No commits between ${p.base} and the current branch.`,
    moveUp: 'Move this commit up (older)',
    moveDown: 'Move this commit down (newer)',
    firstIsFold: 'The first one in the list can’t be combined with the previous one: there is none above it.',
    willStop: 'With "reword" or "edit" the rebase will stop at that commit so you can make the change and then continue.',
    kept: (p) => `${p.kept} of ${p.total} commits kept`,
    applyTitle: 'Applies the rebase with this list. If a conflict comes up, the resolver opens.',
    applying: 'Applying…',
    apply: 'Apply',
}
export default en
