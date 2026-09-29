import type {Messages} from '../types'
import type es from '../es/terminal'

const en: Messages<typeof es> = {
    theme: {
        autoFull: 'Automatic (follows the app theme)',
        auto: 'Automatic',
        menuTooltip: 'Change the terminals’ color palette. Applies instantly to every open terminal (local and SSH), and is remembered.',
        autoTooltip: 'Follows the app’s light/dark mode: the terminal gets lighter and darker along with the rest of the window',
        useInAll: (p) => `Use the ${p.name} palette in every terminal`,
        pickerTitle: 'Terminal theme',
        closePanel: 'Close this panel',
        useInThis: (p) => `Use the "${p.name}" theme in this terminal — applies to every open SSH session`,
        sampleUser: 'user@host',
    },
    local: {
        title: 'Local terminal',
        titleTooltip: 'Runs on THIS machine, not on a server: whatever you run here happens on your computer, with your permissions.',
        snippetsTooltip: 'Snippets — the SAME ones you use in SSH terminals. Run sends them to this local shell; Paste types them in so you can review them first.',
        historyTooltip: (p) => `Commands you already ran in ${p.shell}, stored encrypted in the vault. Recording can be turned off and the stored history cleared from the same panel.`,
        thisShell: 'this shell',
        themeTooltip: 'Terminal colors. This setting applies to ALL terminals in the app, not just this tab.',
        historyScope: 'the local terminal',
        historyKeepsNote: 'Your machine’s own shell history (~/.zsh_history, PowerShell’s and the like) is left alone: it lives outside the app and is cleared outside it.',
    },
    panel: {
        shellEnded: '[the shell exited — use Restart to open another one]',
        unknownError: 'unknown',
        running: 'The session is running',
        notRunning: 'No process is running in this session',
        yourShell: 'your shell',
        agentTooltip: (p) =>
            `${p.agent} session running inside ${p.shell}, at the repository root. The agent runs INSIDE the shell: if you stop it with Ctrl+C, the terminal stays alive in the same directory.`,
        shellTooltip: (p) =>
            `Shell in use: ${p.shell}. Change it in Settings → Terminal; changing it restarts this session, since a running process can’t switch shells.`,
        startTooltip: (p) =>
            `Start ${p.agent} in this session. It didn’t launch on its own because the session was restored from the saved layout, and an assistant uses quota: starting it is your call, not a side effect of reopening the app.`,
        start: 'Start',
        clearTooltip: 'Clears the screen and the scrollback. Doesn’t stop what’s running or close the session — use Ctrl+C for that.',
        restartTooltip: 'Close this session and open a new one at the repository root — you lose the directory you were in and anything still running',
        restartAgentTooltip: (p) =>
            `Close this session and open a new one at the repository root, with ${p.agent} again — you lose the directory you were in and anything still running`,
        reopenTooltip: 'Open a new session: the previous one ended (with exit, or because the process died)',
    },
}
export default en
