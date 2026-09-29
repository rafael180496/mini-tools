import type {Messages} from '../../types'
import type es from '../../es/gitparts/commandLog'

const en: Messages<typeof es> = {
    countTitle: 'How many git commands the app has run since it opened',
    count: (n) => (n === 1 ? '1 command' : `${n} commands`),
    failedTitle: 'Commands that ended with an error',
    failed: (n) => `${n} failed`,
    onlyFailedTitle: 'Show only the commands that failed',
    onlyFailed: 'errors only',
    reloadTitle: 'Read the log again',
    clearTitle: 'Empties the log. Doesn’t affect the repository.',
    clear: 'Clear',
    noneFailed: 'No command failed.',
    empty: 'No command has run in this session yet.',
    commandTitle: (p) => `${p.command}\n\nin ${p.dir}`,
    duration: (ms) => `${ms} ms`,
    askTitle: 'Hands this command and its error to the agent, in the chat, so it explains what happened and how to get out',
    copyTitle: 'Copy the command to paste it into a terminal exactly as it ran',
}
export default en
