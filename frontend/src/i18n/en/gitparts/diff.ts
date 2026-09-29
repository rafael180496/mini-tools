import type {Messages} from '../../types'
import type es from '../../es/gitparts/diff'

const en: Messages<typeof es> = {
    loading: 'Loading diff…',
    binary: (p) => `"${p.path}" is a binary file — there's no text diff to show.`,
    noChanges: 'No changes to show.',
    noTextChanges: 'No text changes to show.',
    hunkCount: (n) => (n === 1 ? '1 hunk' : `${n} hunks`),
    selectLinesFirst: 'Select lines in the diff (with the mouse) to stage only those',
    unstageLinesTitle: 'Unstage only the selected lines. Context lines are ignored.',
    stageLinesTitle: 'Stage only the selected lines — so you get a clean single-task commit even if the file has several.',
    unstageLines: 'Unstage selected lines',
    stageLines: 'Stage selected lines',
    goToHunk: (p) => `Go to this hunk in the diff (${p.header})`,
    unstageHunkTitle: 'Unstage this hunk',
    stageHunkTitle: 'Stage this whole hunk for the commit',
    unstage: 'Unstage',
    stage: 'Stage',
    discardHunkTitle: 'Reverts ONLY this hunk in the working tree. This is destructive and cannot be undone.',
    discard: 'Discard',
    unified: 'Unified',
    unifiedTitle: 'View the diff as a unified patch, with added and removed lines interleaved',
    split: 'Side by side',
    splitTitle: 'View the file before and after in two aligned columns',
    blameTitle:
        "Show who last touched each line, with its commit and date. In a working-tree diff the added lines have no commit yet, so they show up empty.",
    editTitle:
        'Open this file in the editor, in the Files tab. The shortcut for the usual case: see the change, notice something is missing, and fix it without leaving the app.',
    edit: 'Edit',
    askTitle:
        "Hands this change to an agent session and leaves the prompt written for you to finish — review a diff before committing, or ask why something doesn't work. It isn't sent on its own.",
    ask: 'Ask',
    ignoreWsTitle: 'Ignore whitespace/indentation-only changes — useful when a reformat hides the real change',
    wrapTitle: 'Wrap long lines to the panel width instead of scrolling horizontally',
    contextTitle: 'How many unchanged lines are shown around each change (git -U)',
    context: 'Context',
    lessContext: 'Show fewer context lines around each change',
    moreContext: 'Show more context lines around each change',
    blameNoCommit: 'No commit: the line is not in the history yet',
    blameLocal: 'local',
    blameUncommitted: 'uncommitted',
    inline: {
        loading: 'Reading the diff…',
        binary: "Binary file: git doesn't produce a text diff for this.",
        noContent: 'No content changes — it may be just a permissions change or a rename.',
        openFullTitle: 'Open the file in the diff panel, where you see it whole and can stage by hunks or by lines',
        moreLines: (n) => `${n} more lines — view the whole file`,
    },
}
export default en
