import type {Messages} from '../../types'
import type es from '../../es/gitparts/clone'

const en: Messages<typeof es> = {
    title: 'Clone repository',
    closeWithoutCloning: 'Close without cloning',
    intro: 'If you saved a token for that server (in a repo’s settings → Tokens), it’s used automatically to clone private repos. Otherwise git resolves credentials as usual.',
    pickDestTitle: 'Choose where to clone the repository',
    missingUrl: 'The repository URL is missing.',
    missingDest: 'Choose a destination folder.',
    missingName: 'The repository folder name is missing.',
    urlLabel: 'Repository URL',
    urlPlaceholder: 'https://github.com/user/repo.git',
    urlTitle: 'HTTPS or SSH URL of the repository to clone',
    nameLabel: 'Folder name',
    namePlaceholder: 'repo',
    nameTitle: 'The repository is cloned into a subfolder with this name, inside the destination folder',
    destLabel: 'Destination folder',
    destPlaceholder: '/Users/you/Documents/projects',
    destTitle: 'Folder where the repository subfolder will be created',
    pickDest: 'Choose the destination folder',
    finalPathTitle: 'Final path of the repository',
    cloning: 'Cloning…',
    cloneTitle: 'Clone the repository and add it to the sidebar',
    clone: 'Clone',
}
export default en
