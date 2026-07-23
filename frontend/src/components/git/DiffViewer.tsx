import {useEffect, useMemo, useRef, useState} from 'react'
import {EditorState, RangeSetBuilder, type Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate} from '@codemirror/view'
import {basicSetup} from 'codemirror'
import {resolveEditorTheme} from '../../codemirror/themes'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'
import {parseSplitDiff, type SplitRow} from './splitDiff'

type ViewMode = 'unified' | 'split'

interface DiffViewerProps {
    patch: string
    isBinary: boolean
    // path is only used for the empty/binary placeholder text; the patch
    // itself already carries its file headers.
    path: string
    loading: boolean
    error: string | null
    editorThemeId: string
    appTheme: Theme
    // Display preferences, persisted by the parent. context is the number of
    // unchanged lines around each change; ignoreWs drops whitespace-only
    // changes; wrap toggles line wrapping.
    context: number
    ignoreWs: boolean
    wrap: boolean
    onChangePrefs: (context: number, ignoreWs: boolean, wrap: boolean) => void
}

const baseTheme = EditorView.theme({
    '&': {height: '100%', fontSize: '12px'},
    '.cm-scroller': {fontFamily: 'var(--font-mono, monospace)'},
    // The gutter is noise here: a unified patch already encodes position in
    // its @@ hunk headers, and CodeMirror's line numbers would count patch
    // lines, not file lines — actively misleading.
    '.cm-gutters': {display: 'none'},
})

// Line background colors for the three kinds of diff line, mapped onto the
// MD3 semantic tokens rather than raw green/red so they follow the app's
// light/dark themes (see .claude/specs/design-system.md). `secondary` is the
// success/commit role, `error` the destructive one — exactly the meaning
// additions and deletions carry.
//
// Backgrounds are translucent so the syntax-highlighted text underneath stays
// legible in both themes instead of being washed out by a solid fill.
const diffTheme = EditorView.theme({
    '.cm-diff-add': {backgroundColor: 'color-mix(in srgb, var(--color-secondary-container) 55%, transparent)'},
    '.cm-diff-del': {backgroundColor: 'color-mix(in srgb, var(--color-error-container) 45%, transparent)'},
    '.cm-diff-hunk': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary-container) 40%, transparent)',
        color: 'var(--color-on-primary-container)',
        fontWeight: '600',
    },
    '.cm-diff-meta': {color: 'var(--color-on-surface-variant)', opacity: '0.75'},
})

const addLine = Decoration.line({class: 'cm-diff-add'})
const delLine = Decoration.line({class: 'cm-diff-del'})
const hunkLine = Decoration.line({class: 'cm-diff-hunk'})
const metaLine = Decoration.line({class: 'cm-diff-meta'})

// classifyPatch decorates a unified diff by line prefix.
//
// This is why the module does not depend on @codemirror/merge: the backend
// already produces a unified patch (git's own output, authoritative on rename
// and binary detection), so rendering it needs decoration, not a second diff
// implementation. Adding a package to re-derive a diff the backend computed
// would cost bundle size for a worse answer.
//
// Order matters — "+++" and "---" are file headers, not an addition and a
// deletion, so they must be tested before the single-character prefixes.
function classifyPatch(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    for (const {from, to} of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
            const line = view.state.doc.lineAt(pos)
            const text = line.text
            if (text.startsWith('@@')) builder.add(line.from, line.from, hunkLine)
            else if (text.startsWith('+++') || text.startsWith('---')) builder.add(line.from, line.from, metaLine)
            else if (text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('new file') || text.startsWith('deleted file') || text.startsWith('rename ') || text.startsWith('similarity ')) {
                builder.add(line.from, line.from, metaLine)
            } else if (text.startsWith('+')) builder.add(line.from, line.from, addLine)
            else if (text.startsWith('-')) builder.add(line.from, line.from, delLine)
            pos = line.to + 1
        }
    }
    return builder.finish()
}

const diffHighlighter: Extension = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet
        constructor(view: EditorView) {
            this.decorations = classifyPatch(view)
        }
        update(update: ViewUpdate) {
            // Recompute on viewport changes too, not just doc changes —
            // visibleRanges is what bounds the work above, so scrolling a long
            // patch must re-run it or newly revealed lines render undecorated.
            if (update.docChanged || update.viewportChanged) this.decorations = classifyPatch(update.view)
        }
    },
    {decorations: (v) => v.decorations},
)

// Read-only unified-diff viewer.
//
// Follows DDLViewerModal's one-shot pattern rather than
// CodeMirrorTabbedEditor's shared-view/per-tab-state machinery: there is one
// document, it is never edited, and it is fully replaced whenever the user
// selects a different file. Recreating the view is simpler and cheap enough at
// this size.
export default function DiffViewer({patch, isBinary, path, loading, error, editorThemeId, appTheme, context, ignoreWs, wrap, onChangePrefs}: DiffViewerProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [mode, setMode] = useState<ViewMode>('unified')

    const rows = useMemo(() => (mode === 'split' && patch ? parseSplitDiff(patch) : []), [mode, patch])

    useEffect(() => {
        if (mode !== 'unified' || loading || error || isBinary || !patch || !containerRef.current) return
        const view = new EditorView({
            state: EditorState.create({
                doc: patch,
                extensions: [
                    basicSetup,
                    baseTheme,
                    diffTheme,
                    diffHighlighter,
                    resolveEditorTheme(editorThemeId, appTheme),
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                    ...(wrap ? [EditorView.lineWrapping] : []),
                ],
            }),
            parent: containerRef.current,
        })
        return () => view.destroy()
    }, [mode, patch, isBinary, loading, error, editorThemeId, appTheme, wrap])

    if (loading) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <span aria-hidden className="h-5 w-5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                <p className="text-xs text-primary">Cargando diff…</p>
            </div>
        )
    }
    if (error) {
        return <Placeholder icon="error" text={error} danger />
    }
    if (isBinary) {
        return <Placeholder icon="draft" text={`"${path}" es un archivo binario — no hay diff de texto para mostrar.`} />
    }
    if (!patch) {
        return <Placeholder icon="check_circle" text="Sin cambios para mostrar." />
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-outline-variant bg-surface-container-low px-2 py-1">
                <ModeTab active={mode === 'unified'} onClick={() => setMode('unified')} icon="notes" label="Unificado" title="Ver el diff como un parche unificado, con las líneas agregadas y borradas intercaladas" />
                <ModeTab active={mode === 'split'} onClick={() => setMode('split')} icon="vertical_split" label="Lado a lado" title="Ver el archivo antes y después en dos columnas alineadas" />

                <div className="mx-1 h-4 w-px bg-outline-variant" />

                <IconToggle
                    active={ignoreWs}
                    onClick={() => onChangePrefs(context, !ignoreWs, wrap)}
                    icon="format_align_justify"
                    title="Ignorar cambios que son solo de espacios/indentación — útil cuando un reformateo tapa el cambio real"
                />
                {mode === 'unified' && (
                    <IconToggle
                        active={wrap}
                        onClick={() => onChangePrefs(context, ignoreWs, !wrap)}
                        icon="wrap_text"
                        title="Ajustar las líneas largas al ancho del panel en vez de scrollear horizontalmente"
                    />
                )}

                <div className="mx-1 h-4 w-px bg-outline-variant" />

                <span className="text-[10px] text-on-surface-variant/70" title="Cuántas líneas sin cambios se muestran alrededor de cada cambio (git -U)">Contexto</span>
                <button
                    onClick={() => onChangePrefs(Math.max(1, context - 3), ignoreWs, wrap)}
                    disabled={context <= 1}
                    title="Mostrar menos líneas de contexto alrededor de cada cambio"
                    className="rounded px-1 text-on-surface-variant hover:bg-surface-variant disabled:opacity-40"
                >
                    <Icon name="remove" size={14} />
                </button>
                <span className="w-4 text-center font-mono text-[11px] text-on-surface">{context}</span>
                <button
                    onClick={() => onChangePrefs(Math.min(200, context + 3), ignoreWs, wrap)}
                    disabled={context >= 200}
                    title="Mostrar más líneas de contexto alrededor de cada cambio"
                    className="rounded px-1 text-on-surface-variant hover:bg-surface-variant disabled:opacity-40"
                >
                    <Icon name="add" size={14} />
                </button>
            </div>
            {mode === 'unified' ? (
                <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
            ) : (
                <SplitView rows={rows} wrap={wrap} />
            )}
        </div>
    )
}

function IconToggle({active, onClick, icon, title}: {active: boolean; onClick: () => void; icon: string; title: string}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={`rounded p-1 ${active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'}`}
        >
            <Icon name={icon} size={14} />
        </button>
    )
}

function ModeTab({active, onClick, icon, label, title}: {active: boolean; onClick: () => void; icon: string; label: string; title: string}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
            }`}
        >
            <Icon name={icon} size={13} />
            {label}
        </button>
    )
}

// Side-by-side rendering is plain DOM rather than two CodeMirror views.
//
// Two synced editors would buy syntax highlighting — except a diff has no
// language attached in either mode here, so there is none to lose — at the cost
// of scroll synchronisation between independent viewports and of injecting
// blank padding lines into both documents to keep the columns aligned. One
// scroll container holding both columns gets the alignment for free and cannot
// desynchronise, which is the property that actually matters for reading a diff.
function SplitView({rows, wrap}: {rows: SplitRow[]; wrap: boolean}) {
    if (rows.length === 0) {
        return <Placeholder icon="check_circle" text="Sin cambios de texto para mostrar." />
    }
    return (
        <div className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest font-mono text-[11px] leading-[1.5]">
            <table className="w-full border-collapse">
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i}>
                            <Cell no={r.leftNo} text={r.leftText} kind={r.leftKind} side="left" wrap={wrap} />
                            <Cell no={r.rightNo} text={r.rightText} kind={r.rightKind} side="right" wrap={wrap} />
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

const CELL_BG: Record<SplitRow['leftKind'], string> = {
    // Same semantic mapping as the unified view: secondary = added,
    // error = removed, primary = hunk boundary.
    add: 'bg-[color-mix(in_srgb,var(--color-secondary-container)_55%,transparent)]',
    del: 'bg-[color-mix(in_srgb,var(--color-error-container)_45%,transparent)]',
    hunk: 'bg-[color-mix(in_srgb,var(--color-primary-container)_40%,transparent)] text-on-primary-container',
    // A padding row is not "unchanged" — it is the absence of a line on that
    // side, so it reads as inert filler rather than as content.
    empty: 'bg-surface-container/40',
    context: '',
}

function Cell({no, text, kind, side, wrap}: {no: number | null; text: string | null; kind: SplitRow['leftKind']; side: 'left' | 'right'; wrap: boolean}) {
    return (
        <>
            <td
                className={`w-10 select-none border-r border-outline-variant/40 px-1 text-right align-top text-on-surface-variant/50 ${CELL_BG[kind]} ${
                    side === 'right' ? 'border-l' : ''
                }`}
            >
                {no ?? ''}
            </td>
            <td className={`w-1/2 px-2 align-top text-on-surface ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} ${CELL_BG[kind]}`}>
                {kind === 'hunk' ? text : (text ?? '')}
            </td>
        </>
    )
}

function Placeholder({icon, text, danger}: {icon: string; text: string; danger?: boolean}) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Icon name={icon} size={28} className={danger ? 'text-error' : 'text-on-surface-variant/50'} />
            <p className={`text-xs ${danger ? 'text-error' : 'text-on-surface-variant/70'}`}>{text}</p>
        </div>
    )
}
