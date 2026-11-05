import {linter, type Diagnostic} from '@codemirror/lint'
import {completionStatus} from '@codemirror/autocomplete'
import type {EditorState, Extension} from '@codemirror/state'
import {lintSQL} from '../lib/linter'
import {lintRedisCommands} from '../lib/redisLinter'
import {lintMongoCommands} from '../lib/mongoLinter'
import type {TabLanguage} from '../components/editor/EditorTabs'

// Adapts lib/linter.ts's lintSQL / lib/redisLinter.ts's lintRedisCommands
// (line-based LintWarning[], reused unchanged from the Monaco-era editor)
// into @codemirror/lint's Diagnostic[] (offset-based). Every diagnostic is
// severity "warning" regardless of LintWarning.blocking — same as the
// retired monaco/MonacoTabbedEditor.tsx's applyLintMarkers, which always
// used monaco.MarkerSeverity.Warning too. `blocking` only gates the
// separate confirm-before-execute dialog in Workspace.tsx's confirmAndRun
// (unchanged by this migration), it never changes the editor's own inline
// marker color.
function lintDiagnostics(state: EditorState, language: TabLanguage): Diagnostic[] {
    const text = state.doc.toString()
    const warnings =
        language === 'redis-cli' ? lintRedisCommands(text) : language === 'mongosh' ? lintMongoCommands(text) : lintSQL(text)

    return warnings.map((w) => {
        if (w.focus && w.focus.line >= 1 && w.focus.line <= state.doc.lines) {
            const line = state.doc.line(w.focus.line)
            const from = Math.min(line.from + w.focus.col, line.to)
            const to = Math.min(from + w.focus.length, line.to)
            if (to > from) return {from, to, severity: 'warning', message: w.message}
        }
        const startLine = state.doc.line(Math.min(Math.max(w.startLineNumber, 1), state.doc.lines))
        const endLine = state.doc.line(Math.min(Math.max(w.endLineNumber, 1), state.doc.lines))
        return {
            from: startLine.from,
            to: endLine.to,
            severity: 'warning',
            message: w.message,
        }
    })
}

// Per-tab lint extension — CodeMirrorTabbedEditor reconfigures its lint
// Compartment with a fresh call to this whenever the tab's language
// changes, same "rebuild instead of mutate a global" pattern as
// sqlSchema.ts/redisLanguage.ts.
//
// El aviso y el autocompletado se estorbaban: con el popup abierto, el
// tooltip del diagnóstico (que salía apenas el mouse descansaba sobre la
// consulta) se dibujaba encima o lo empujaba fuera de la vista, y se leía como
// "con avisos del linter el autocompletado no abre". Mientras haya un popup
// de autocompletado activo o pendiente, el tooltip del aviso no se muestra y
// el que estaba abierto se cierra; el subrayado sigue ahí.
export function lintExtension(language: TabLanguage): Extension {
    return linter((view) => lintDiagnostics(view.state, language), {
        tooltipFilter: (diagnostics, state) => (completionStatus(state) === null ? [...diagnostics] : []),
        hideOn: (tr) => (completionStatus(tr.state) !== null ? true : null),
    })
}
