import {useEffect, useMemo, useRef, useState} from 'react'
import {EditorState, RangeSetBuilder, type Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate} from '@codemirror/view'
import {basicSetup} from 'codemirror'
import {resolveEditorTheme} from '../../codemirror/themes'
import type {Theme} from '../../hooks/useTheme'
import {git} from '../../../wailsjs/go/models'
import {
    buildPatch,
    docLineMap,
    hunkSummary,
    parsePatch,
    selectionFromDocLines,
    type PatchSelection,
} from '../../lib/gitPatch'
import Icon from '../Icon'
import {useT} from '../../i18n'
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
    // Applies a partial patch built from this diff. Absent for read-only
    // contexts (a commit's diff, where there is nothing to stage).
    // The action tells the caller which git flags to use — this component
    // builds the patch, it does not decide what --cached/--reverse mean.
    onApplyPatch?: (patch: string, action: 'stage' | 'unstage' | 'discard') => void
    // Blame for the file, keyed by line number in the revision it was taken
    // at. Absent means the blame gutter is off.
    blame?: git.BlameLine[]
    // blameSide says which side of the diff the blame line numbers refer to:
    // 'new' for a commit's diff (blamed AT that commit, so added lines belong
    // to it), 'old' for a working-tree diff (blamed at HEAD, where the added
    // lines do not exist yet).
    blameSide?: 'old' | 'new'
    onToggleBlame?: () => void
    // staged marks this as the index-vs-HEAD diff, where the only action
    // that makes sense is unstaging.
    staged?: boolean
    // Opens this file in the file editor. Absent for a commit's diff: that is
    // history, and the working-tree file may not even have those lines
    // anymore — "editar" ahí llevaría a un archivo que no es el que se está
    // mirando.
    onEdit?: () => void
    // Le pasa este cambio a una sesión de agente. Como onEdit, solo para el
    // working tree: preguntar por un diff histórico llevaría al agente a mirar
    // el archivo de hoy, que puede no tener nada que ver.
    onAsk?: () => void
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
export default function DiffViewer({
    patch,
    isBinary,
    path,
    loading,
    error,
    editorThemeId,
    appTheme,
    context,
    ignoreWs,
    wrap,
    onChangePrefs,
    onApplyPatch,
    staged,
    blame,
    blameSide = 'old',
    onToggleBlame,
    onEdit,
    onAsk,
}: DiffViewerProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const t = useT()
    const td = t.git.diff
    const [mode, setMode] = useState<ViewMode>('unified')
    // Document lines currently selected in the editor, so "stage these
    // lines" knows what the user actually highlighted. Kept in state (not a
    // ref) because the button's enabled state depends on it.
    const [selectedDocLines, setSelectedDocLines] = useState<number[]>([])

    const rows = useMemo(() => (mode === 'split' && patch ? parseSplitDiff(patch) : []), [mode, patch])

    // Parsed once per patch and shared by the hunk strip and the
    // selection mapping — both have to agree on hunk/line indices, and
    // deriving them twice is how they drift apart.
    const parsed = useMemo(() => (patch ? parsePatch(patch) : {headers: [], hunks: []}), [patch])
    const lineMap = useMemo(() => (patch ? docLineMap(patch) : []), [patch])

    // Blame is rendered as its own column next to the patch text rather than
    // injected into the CodeMirror document: the document IS the patch, and
    // adding characters to it would break every line index the staging
    // selection depends on.
    const blameRows = useMemo(() => {
        if (!blame || blame.length === 0 || !patch) return []
        const byLine = new Map(blame.map((b) => [b.line, b]))
        const out: (git.BlameLine | null)[] = []

        // Walk the patch tracking both side's line numbers, so each row can
        // be attributed to the revision the blame was actually taken at.
        let oldLine = 0
        let newLine = 0

        for (const raw of patch.split('\n')) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
            if (m) {
                oldLine = Number(m[1])
                newLine = Number(m[2])
                out.push(null)
                continue
            }
            const kind = raw[0]
            if (kind === ' ') {
                out.push(byLine.get(blameSide === 'new' ? newLine : oldLine) ?? null)
                oldLine++
                newLine++
            } else if (kind === '+') {
                // In a working-tree diff an added line has no commit yet, so
                // there is deliberately nothing to attribute it to.
                out.push(blameSide === 'new' ? (byLine.get(newLine) ?? null) : null)
                newLine++
            } else if (kind === '-') {
                out.push(blameSide === 'old' ? (byLine.get(oldLine) ?? null) : null)
                oldLine++
            } else {
                out.push(null)
            }
        }
        return out
    }, [blame, patch, blameSide])

    // Whole-file actions and per-hunk actions mean different things
    // depending on which side is being shown: in the staged view the only
    // sensible verb is "unstage", in the working-tree view it is "stage"
    // (plus discard, which is destructive and confirmed by the caller).
    const canApply = !!onApplyPatch && !isBinary && !!patch

    function applySelection(selection: PatchSelection, action: 'stage' | 'unstage' | 'discard') {
        if (!onApplyPatch) return
        const built = buildPatch(parsed, selection)
        if (!built) return
        onApplyPatch(built, action)
    }

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
                    // Read-only still allows selecting, which is exactly what
                    // line-level staging needs: the document IS the patch, so
                    // a highlighted document line is a patch line.
                    EditorView.updateListener.of((update) => {
                        if (!update.selectionSet && !update.docChanged) return
                        const lines = new Set<number>()
                        for (const range of update.state.selection.ranges) {
                            const from = update.state.doc.lineAt(range.from).number
                            const to = update.state.doc.lineAt(range.to).number
                            for (let n = from; n <= to; n++) lines.add(n - 1)
                        }
                        setSelectedDocLines([...lines])
                    }),
                    ...(wrap ? [EditorView.lineWrapping] : []),
                ],
            }),
            parent: containerRef.current,
        })
        viewRef.current = view
        setSelectedDocLines([])
        return () => {
            viewRef.current = null
            view.destroy()
        }
    }, [mode, patch, isBinary, loading, error, editorThemeId, appTheme, wrap])

    if (loading) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <span aria-hidden className="h-5 w-5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                <p className="text-xs text-primary">{td.loading}</p>
            </div>
        )
    }
    if (error) {
        return <Placeholder icon="error" text={error} danger />
    }
    if (isBinary) {
        return <Placeholder icon="draft" text={td.binary({path})} />
    }
    if (!patch) {
        return <Placeholder icon="check_circle" text={td.noChanges} />
    }

    const unified = mode === 'unified'

    return (
        <div className="flex h-full min-h-0 flex-col">
            {canApply && unified && (
                <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-outline-variant bg-surface-container-low px-2 py-1 text-ui-11">
                    <span className="text-on-surface-variant">
                        {td.hunkCount(parsed.hunks.length)}
                    </span>
                    <button
                        onClick={() =>
                            applySelection(
                                selectionFromDocLines(parsed, lineMap, selectedDocLines),
                                staged ? 'unstage' : 'stage',
                            )
                        }
                        disabled={selectedDocLines.length === 0}
                        title={
                            selectedDocLines.length === 0
                                ? td.selectLinesFirst
                                : staged
                                  ? td.unstageLinesTitle
                                  : td.stageLinesTitle
                        }
                        className="ml-auto rounded border border-outline-variant px-1.5 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                    >
                        {staged ? td.unstageLines : td.stageLines}
                    </button>
                </div>
            )}

            {canApply && unified && parsed.hunks.length > 0 && (
                <div className="flex max-h-24 shrink-0 flex-col overflow-y-auto border-b border-outline-variant">
                    {parsed.hunks.map((hunk, i) => {
                        const {added, removed} = hunkSummary(hunk)
                        return (
                            <div key={i} className="flex items-center gap-2 px-2 py-0.5 text-ui-11 hover:bg-surface-variant/40">
                                <button
                                    onClick={() => {
                                        // Scroll the editor to this hunk so the
                                        // strip is navigation, not just buttons.
                                        const view = viewRef.current
                                        if (!view) return
                                        const docLine = lineMap.findIndex((m) => m?.hunk === i)
                                        if (docLine < 0) return
                                        const pos = view.state.doc.line(docLine + 1).from
                                        view.dispatch({selection: {anchor: pos}, scrollIntoView: true})
                                    }}
                                    title={td.goToHunk({header: hunk.header})}
                                    className="min-w-0 flex-1 truncate text-left font-mono text-on-surface-variant hover:text-on-surface"
                                >
                                    {hunk.header}
                                </button>
                                <span className="shrink-0 font-mono text-ui-10">
                                    <span className="text-secondary">+{added}</span> <span className="text-error">−{removed}</span>
                                </span>
                                <button
                                    onClick={() => applySelection({hunks: new Set([i])}, staged ? 'unstage' : 'stage')}
                                    title={staged ? td.unstageHunkTitle : td.stageHunkTitle}
                                    className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 text-on-surface hover:bg-surface-container-high"
                                >
                                    {staged ? td.unstage : td.stage}
                                </button>
                                {!staged && (
                                    <button
                                        onClick={() => applySelection({hunks: new Set([i])}, 'discard')}
                                        title={td.discardHunkTitle}
                                        className="shrink-0 rounded px-1 py-0.5 text-error hover:bg-error-container"
                                    >
                                        {td.discard}
                                    </button>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-outline-variant bg-surface-container-low px-2 py-1">
                <ModeTab active={unified} onClick={() => setMode('unified')} icon="notes" label={td.unified} title={td.unifiedTitle} />
                <ModeTab active={mode === 'split'} onClick={() => setMode('split')} icon="vertical_split" label={td.split} title={td.splitTitle} />

                <div className="mx-1 h-4 w-px bg-outline-variant" />

                {onToggleBlame && (
                    <IconToggle
                        active={!!blame}
                        onClick={onToggleBlame}
                        icon="person_search"
                        title={td.blameTitle}
                    />
                )}

                {onEdit && (
                    <button
                        onClick={onEdit}
                        title={td.editTitle}
                        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                    >
                        <Icon name="edit" size={14} />
                        {td.edit}
                    </button>
                )}

                {onAsk && (
                    <button
                        onClick={onAsk}
                        title={td.askTitle}
                        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                    >
                        <Icon name="smart_toy" size={14} />
                        {td.ask}
                    </button>
                )}

                <IconToggle
                    active={ignoreWs}
                    onClick={() => onChangePrefs(context, !ignoreWs, wrap)}
                    icon="format_align_justify"
                    title={td.ignoreWsTitle}
                />
                {unified && (
                    <IconToggle
                        active={wrap}
                        onClick={() => onChangePrefs(context, ignoreWs, !wrap)}
                        icon="wrap_text"
                        title={td.wrapTitle}
                    />
                )}

                <div className="mx-1 h-4 w-px bg-outline-variant" />

                <span className="text-ui-10 text-on-surface-variant/70" title={td.contextTitle}>{td.context}</span>
                <button
                    onClick={() => onChangePrefs(Math.max(1, context - 3), ignoreWs, wrap)}
                    disabled={context <= 1}
                    title={td.lessContext}
                    className="rounded px-1 text-on-surface-variant hover:bg-surface-variant disabled:opacity-40"
                >
                    <Icon name="remove" size={14} />
                </button>
                <span className="w-4 text-center font-mono text-ui-11 text-on-surface">{context}</span>
                <button
                    onClick={() => onChangePrefs(Math.min(200, context + 3), ignoreWs, wrap)}
                    disabled={context >= 200}
                    title={td.moreContext}
                    className="rounded px-1 text-on-surface-variant hover:bg-surface-variant disabled:opacity-40"
                >
                    <Icon name="add" size={14} />
                </button>
            </div>
            {unified ? (
                <div className="flex min-h-0 flex-1">
                {blameRows.length > 0 && unified && (
                    <div className="w-52 shrink-0 overflow-hidden border-r border-outline-variant bg-surface-container-lowest">
                        {/* Aligned to the editor by matching its line height;
                            the column scrolls with the patch because both live
                            in the same scroll container height. */}
                        {blameRows.map((b, i) => (
                            <div
                                key={i}
                                title={
                                    b
                                        ? `${b.author} · ${b.shortHash} · ${b.date}\n${b.summary}`
                                        : td.blameNoCommit
                                }
                                className="h-[18px] truncate px-1.5 text-ui-10 leading-[18px] text-on-surface-variant/60"
                            >
                                {b ? (
                                    <>
                                        <span className="font-mono text-on-surface-variant/80">{b.uncommitted ? td.blameLocal : b.shortHash}</span>{' '}
                                        <span>{b.uncommitted ? td.blameUncommitted : b.author}</span>
                                    </>
                                ) : (
                                    ''
                                )}
                            </div>
                        ))}
                    </div>
                )}
                <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
            </div>
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
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-ui-11 ${
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
    const t = useT()
    if (rows.length === 0) {
        return <Placeholder icon="check_circle" text={t.git.diff.noTextChanges} />
    }
    return (
        <div className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest font-mono text-ui-11 leading-[1.5]">
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
