import type {Messages} from '../../types'
import type es from '../../es/gitparts/commitMsg'

const en: Messages<typeof es> = {
    types: {
        feat: {label: 'feat — new feature', hint: 'Adds a capability that didn’t exist before'},
        fix: {label: 'fix — bug fix', hint: 'Fixes incorrect behavior'},
        docs: {label: 'docs — documentation', hint: 'Documentation only, no code changes'},
        refactor: {label: 'refactor — restructuring', hint: 'Changes how it’s written without changing what it does'},
        perf: {label: 'perf — performance', hint: 'Performance improvement'},
        test: {label: 'test — tests', hint: 'Adds or fixes tests'},
        build: {label: 'build — build/dependencies', hint: 'Build system or dependencies'},
        ci: {label: 'ci — continuous integration', hint: 'Pipeline configuration'},
        chore: {label: 'chore — maintenance', hint: 'Tasks that don’t touch production code'},
        revert: {label: 'revert — revert', hint: 'Undoes a previous commit'},
    },
}
export default en
