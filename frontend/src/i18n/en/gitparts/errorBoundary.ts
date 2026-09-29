import type {Messages} from '../../types'
import type es from '../../es/gitparts/errorBoundary'

const en: Messages<typeof es> = {
    title: 'The Git module failed to render',
    body: (p) =>
        `This is a bug in the app, not in your repository (${p.label}). The rest of mini-tools keeps working: you can close this tab and carry on.`,
    retryTitle: 'Try rendering the module again — useful if the error was transient',
    retry: 'Retry',
}
export default en
