// Trimmed Monaco import: only the core editor + the SQL basic-language
// contribution, no CDN loader (no @monaco-editor/react), and a hand-wired
// Vite worker — see .claude/rules/technical.md point 6. Importing the full
// `monaco-editor` package (or using @monaco-editor/react's default loader)
// would pull in every bundled language and its worker.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
// eslint-disable-next-line import/no-unresolved
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

let configured = false

// Must run once before creating any editor instance.
export function configureMonacoEnvironment() {
    if (configured) return
    configured = true

    self.MonacoEnvironment = {
        getWorker() {
            return new EditorWorker()
        },
    }
}

export {monaco}
