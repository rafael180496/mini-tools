import type {Messages} from '../../types'
import type es from '../../es/gitparts/remotes'

const en: Messages<typeof es> = {
    introBefore: 'A remote is where fetch, pull and push point to. Changing the URL here is the same as',
    introAfter: ": it doesn't touch anything on the server and doesn't download the repository again, it only changes the destination.",
    closeNote: 'Dismiss this notice',
    empty: "This repository has no remotes: it's local and there's nowhere to push until you add one.",
    editTitle: (p) => `View and change the URL of "${p.name}" — opens with the real URL, including the token if it has one`,
    copyTitle: (p) => `Copy the URL of "${p.name}" to the clipboard, exactly as configured`,
    removeTitle: (p) => `Remove the remote "${p.name}" from this repository — nothing is deleted on the server`,
    fetchUrlTitle: 'Fetch URL, exactly as in .git/config — with the token visible if it has one embedded',
    pushDiffersTitle: 'This remote pushes to a different URL than the one it uses for fetch',
    pushArrow: (p) => `push → ${p.url}`,
    addTitle: 'Add another remote to this repository (a fork, a mirror, a backup server)',
    add: 'Add remote',
    editHeading: (p) => `Edit "${p.name}"`,
    newHeading: 'New remote',
    nameLabel: 'Name',
    nameTitle:
        'What the remote is called in commands: `git push origin main`. Changing it renames the remote and the tracking branches under it',
    fetchLabel: 'URL (fetch)',
    fetchPlaceholder: 'https://github.com/user/repo.git',
    fetchTitle:
        "Where fetch and pull go, and push too if you don't fill in the push URL. Shown exactly as saved, with the token inside if it has one",
    pushLabel: 'Push URL (optional)',
    pushPlaceholder: 'Empty = pushes to the same URL as above',
    pushTitle:
        'Only needed when you read from one place and write to another (a read-only mirror, a fork). Clearing it removes the override and push goes back to the fetch URL',
    tokenHeading: 'This URL has a token inside',
    tokenBody1: 'It works, but it sits in plain text in',
    tokenBody2: 'and anyone who opens the folder or runs',
    tokenBody3: " can see it. You can leave it as is —what you type is respected— or move it to the vault: it's stored encrypted for",
    tokenBody4: "and the app still passes it to git, without it showing up anywhere.",
    moveTokenTitle: (p) =>
        `Store the token encrypted in the vault for ${p.host} and leave the URL without credentials (then save the remote)`,
    moveToken: 'Move the token to the vault',
    fillRequired: 'Fill in the name and the fetch URL',
    saveEditTitle: "Save the changes to the repository's local configuration",
    saveNewTitle: 'Add this remote to the repository',
    saving: 'Saving…',
    save: 'Save',
    cancelTitle: 'Discard the changes in this form — nothing is written',
    cancel: 'Cancel',
    deleteTitle: 'Delete remote',
    deleteDescription: (p) =>
        `This removes the remote "${p.name}" from the repository's local configuration. Nothing is deleted on the server, but the remote branches that tracked it stop being available until you add it again.`,
    deleteConfirm: 'Delete',
    saved: (p) => `Remote "${p.name}" saved.`,
    tokenSaved: (p) => `Token saved in the vault for ${p.host}. Save the remote so the URL no longer contains the token.`,
    copied: (p) => `URL of "${p.name}" copied.`,
}
export default en
