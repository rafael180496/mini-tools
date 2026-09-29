import type {Messages} from '../../types'
import type es from '../../es/gitparts/fileEditor'

const en: Messages<typeof es> = {
    status: {
        added: 'Added',
        untracked: 'Untracked — not in git yet',
        modified: 'Modified',
        renamed: 'Renamed',
        deleted: 'Deleted',
        conflicted: 'Conflicted',
    },
    title: 'Files',
    saving: 'Saving…',
    reloadTitle: 'List the repository files again — useful after an agent or a checkout creates new files',
    closeTitle: 'Close the file editor',
    filterPlaceholder: 'Filter files',
    filterTitle: 'Matches any part of the path',
    noFiles: 'No editable files in this repository.',
    noMatch: 'No file matches the filter.',
    dirChanges: (p) => (p.n === 1 ? '1 changed file in here' : `${p.n} changed files in here`),
    unsaved: 'Not saved to disk',
    moreFiles: (p) => (p.n === 1 ? '1 more file. Refine the filter to see it.' : `${p.n} more files. Refine the filter to see them.`),
    truncated: 'The repository exceeds the listing limit; some files may be missing.',
    closeDirty: 'Close (unsaved changes are lost)',
    close: 'Close',
    languageTitle: (p) => `Syntax highlighting. ${p.language} was picked from the file name; change it if this file is something else.`,
    mdView: {
        code: 'Edit the text',
        split: 'Text and result side by side',
        preview: 'Formatted document only',
    },
    askPrompt: (p) => `Look at ${p.about} in this repository and `,
    askTitle:
        'Hands this file (or the selected lines) to an agent session and leaves the prompt written for you to finish. It doesn’t send it: sending is up to you, same as in the terminal history.',
    ask: 'Ask',
    saveTitle: 'Save the file to disk (Cmd/Ctrl+S). If it changed underneath while you were editing, you are warned before overwriting it.',
    save: 'Save',
    pickFile: 'Pick a file from the list to open and edit it.',
    binary: 'This file is binary and can’t be edited as text.',
    tooLarge: 'This file exceeds the maximum editable size (4 MiB).',
    conflict: {
        title: 'The file changed on disk',
        description: (p) =>
            `"${p.path}" was modified outside the editor since you opened it — maybe by an agent, a checkout or another program. If you save anyway, that change is lost.`,
        confirm: 'Save anyway',
    },
}
export default en
