import type {Messages} from '../types'
import type es from '../es/shell'

const en: Messages<typeof es> = {
    titleBar: {
        minimize: 'Minimize',
        minimizeTitle: 'Minimize the window',
        maximize: 'Maximize',
        maximizeTitle: 'Maximize the window',
        restore: 'Restore',
        restoreTitle: 'Restore the window to its previous size',
        quit: 'Close',
        quitTitle: 'Quit the application',
    },
    masterMenu: {
        title: (p) => `${p.label} — ${p.hint}`,
        activeTitle: (p) => `${p.label} — ${p.hint} (the module you are viewing)`,
        matchesTitle: (p) =>
            `${p.label} — ${p.hint}. ${
                p.count === 0 ? 'No matches for the current search' : `${p.count} ${p.count === 1 ? 'match' : 'matches'} for the current search`
            }`,
    },
    sidebar: {
        helpTitle: 'Open the documentation in the browser: what each module does, usage examples and end-to-end recipes',
        themeToLight: 'Switch to the light theme — it is remembered for next time',
        themeToDark: 'Switch to the dark theme — it is remembered for next time',
        settingsTitle: 'Settings: font size and editor theme, vault backup, terminal and AI agents',
        settingsUpdateTitle: (p) => `Settings: appearance, vault, terminal and agents — plus the link to get v${p.latest}, now available`,
        updateDownload: (p) => `You are on v${p.current} and v${p.latest} is available — click to download ${p.file}`,
        updatePage: (p) => `You are on v${p.current} and v${p.latest} is available — click to open its download page`,
        versionTitle: (p) => `mini-tools ${p.version} — the version installed on this machine`,
        markUpdateDownload: (p) => `mini-tools v${p.current} — v${p.latest} is available, click to download ${p.file}`,
        markUpdatePage: (p) => `mini-tools v${p.current} — v${p.latest} is available, click to open its download page`,
        expand: 'Show the sidebar with the tree of connections, servers, repositories and notes',
        collapse: 'Hide the sidebar and give the editor the full width — a column with the module icons stays to bring it back',
        searchPlaceholder: 'Search everything…',
        searchTitle:
            'Searches database connections, SSH servers, Git repositories and notes at once — by item name or by the folder that contains it. The icons above show how many matches each module has',
        clearSearch: 'Clear the search and see the whole module again',
        resize: 'Drag to change the sidebar width — the size is remembered',
    },
    environments: {
        prod: {
            label: 'Production',
            description: 'Marks the connection in red and asks for confirmation before running destructive commands in its terminal.',
        },
        staging: {
            label: 'Staging / QA',
            description: 'Marks the connection in amber. No extra confirmations.',
        },
        dev: {
            label: 'Development',
            description: 'Marks the connection in green. No extra confirmations.',
        },
    },
}
export default en
