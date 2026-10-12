import {useEffect, useMemo, useRef, useState} from 'react'
import {EditorState, Prec, RangeSetBuilder, type Extension} from '@codemirror/state'
import {
    Decoration,
    drawSelection,
    EditorView,
    gutter,
    GutterMarker,
    keymap,
    ViewPlugin,
    WidgetType,
    type DecorationSet,
    type ViewUpdate,
} from '@codemirror/view'
import {defaultKeymap} from '@codemirror/commands'
import {highlightSelectionMatches, search, searchKeymap} from '@codemirror/search'
import {resolveEditorTheme} from '../../codemirror/themes'
import {DEFAULT_EDITOR_APPEARANCE, editorFontStack, type EditorAppearance} from '../../codemirror/editorAppearance'
import type {Theme} from '../../hooks/useTheme'
import {git} from '../../../wailsjs/go/models'
import {buildPatch, docLineMap, hunkSummary, parsePatch, selectionFromDocLines, type PatchSelection} from '../../lib/gitPatch'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {parseSplitDiff, type SplitRow} from './splitDiff'

type ViewMode = 'unified' | 'split'

interface DiffViewerProps {
    patch: string
    isBinary: boolean
    // path is shown in the file header and used for the empty/binary text; the
    // patch itself already carries its file headers.
    path: string
    loading: boolean
    error: string | null
    editorThemeId: string
    appTheme: Theme
    // Cuerpo y familia del editor de la app (Configuración → Editor): el diff se
    // lee con la misma letra que el código. Opcional: sin él, los valores por
    // defecto del editor.
    appearance?: EditorAppearance
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

// ---------------------------------------------------------------------------
// Modelo de líneas del parche
// ---------------------------------------------------------------------------

type LineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta'

interface PatchModel {
    // Lo que se dibuja: el parche SIN las cabeceras (diff --git, index, ---,
    // +++), que la cabecera del archivo ya resume. Si no hay ningún `@@` (un
    // cambio de modo, un renombrado puro) se dibuja entero, porque entonces las
    // cabeceras son todo lo que hay.
    text: string
    // Cuántas líneas del parche original se recortaron arriba. El stage por
    // líneas trabaja sobre el parche ENTERO, así que cada línea seleccionada se
    // corre este tanto antes de mapearse.
    offset: number
    kinds: LineKind[]
    oldNo: (number | null)[]
    newNo: (number | null)[]
    // Número de línea (1-based, del documento dibujado) de cada encabezado `@@`.
    hunkLines: number[]
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function buildModel(patch: string): PatchModel {
    const all = patch.split('\n')
    let first = all.findIndex((l) => l.startsWith('@@'))
    if (first < 0) first = 0
    const lines = all.slice(first)
    // El parche termina en \n: el último elemento vacío no es una línea.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    const kinds: LineKind[] = []
    const oldNo: (number | null)[] = []
    const newNo: (number | null)[] = []
    const hunkLines: number[] = []
    let o = 0
    let n = 0
    lines.forEach((raw, i) => {
        const m = HUNK_RE.exec(raw)
        if (m) {
            o = Number(m[1])
            n = Number(m[2])
            kinds.push('hunk')
            oldNo.push(null)
            newNo.push(null)
            hunkLines.push(i + 1)
        } else if (raw.startsWith('+')) {
            kinds.push('add')
            oldNo.push(null)
            newNo.push(n++)
        } else if (raw.startsWith('-')) {
            kinds.push('del')
            oldNo.push(o++)
            newNo.push(null)
        } else if (raw.startsWith(' ')) {
            kinds.push('ctx')
            oldNo.push(o++)
            newNo.push(n++)
        } else {
            kinds.push('meta')
            oldNo.push(null)
            newNo.push(null)
        }
    })
    return {text: lines.join('\n'), offset: first, kinds, oldNo, newNo, hunkLines}
}

// ---------------------------------------------------------------------------
// CodeMirror: tema, decoraciones, medianiles y acciones por bloque
// ---------------------------------------------------------------------------

// Los colores salen de los tokens MD3 (secondary = agregado, error = borrado)
// para seguir los temas claro/oscuro de la app, y son translúcidos para que el
// texto resaltado de abajo siga legible en los dos.
function diffTheme(a: EditorAppearance): Extension {
    // Alto de línea en px y no relativo: el medianil de blame y los números
    // tienen que alinearse con el texto al píxel, y un cuerpo escalado con
    // ratio fraccionario deja una deriva de media línea cada veinte.
    const lh = Math.round(a.fontSize * 1.5)
    return Prec.high(
        EditorView.theme({
            '&': {height: '100%', fontSize: `${a.fontSize}px`, backgroundColor: 'transparent'},
            '&.cm-focused': {outline: 'none'},
            '.cm-scroller': {fontFamily: editorFontStack(a.fontFamily), lineHeight: `${lh}px`, overflow: 'auto'},
            '.cm-content': {padding: '0'},
            '.cm-line': {padding: '0 10px 0 6px'},
            '.cm-diff-add': {backgroundColor: 'color-mix(in srgb, var(--color-secondary-container) 20%, transparent)'},
            '.cm-diff-del': {backgroundColor: 'color-mix(in srgb, var(--color-error-container) 20%, transparent)'},
            '.cm-diff-hunk': {
                position: 'relative',
                backgroundColor: 'color-mix(in srgb, var(--color-primary-container) 28%, transparent)',
                color: 'var(--color-on-surface-variant)',
                fontSize: '0.85em',
                borderTop: '1px solid color-mix(in srgb, var(--color-outline-variant) 70%, transparent)',
                paddingRight: '84px',
            },
            '.cm-diff-meta': {color: 'var(--color-on-surface-variant)', opacity: '0.7', fontSize: '0.9em'},
            '.cm-diff-sign': {opacity: '0.5'},
            '.cm-gutters': {
                backgroundColor: 'transparent',
                border: 'none',
                color: 'color-mix(in srgb, var(--color-on-surface-variant) 55%, transparent)',
                fontSize: '0.85em',
            },
            '.cm-gutterElement': {padding: '0 6px', textAlign: 'right'},
            '.cm-diffNo .cm-gutterElement': {minWidth: '3ch'},
            '.cm-gutterElement.cm-gutter-add': {
                backgroundColor: 'color-mix(in srgb, var(--color-secondary-container) 38%, transparent)',
                color: 'var(--color-on-surface-variant)',
            },
            '.cm-gutterElement.cm-gutter-del': {
                backgroundColor: 'color-mix(in srgb, var(--color-error-container) 38%, transparent)',
                color: 'var(--color-on-surface-variant)',
            },
            '.cm-gutterElement.cm-gutter-hunk': {
                backgroundColor: 'color-mix(in srgb, var(--color-primary-container) 28%, transparent)',
                borderTop: '1px solid color-mix(in srgb, var(--color-outline-variant) 70%, transparent)',
            },
            '.cm-diffBlame .cm-gutterElement': {
                textAlign: 'left',
                width: '176px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-sans)',
            },
            '.cm-hunk-actions': {
                position: 'absolute',
                right: '6px',
                top: '0',
                bottom: '0',
                display: 'flex',
                alignItems: 'center',
                gap: '2px',
                fontSize: '1rem',
                lineHeight: '1',
            },
            '.cm-hunk-btn': {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '22px',
                height: '18px',
                border: 'none',
                borderRadius: '3px',
                background: 'transparent',
                color: 'var(--color-on-surface-variant)',
                cursor: 'pointer',
                padding: '0',
            },
            '.cm-hunk-btn:hover': {backgroundColor: 'var(--color-surface-variant)', color: 'var(--color-on-surface)'},
            '.cm-hunk-btn.cm-hunk-danger:hover': {backgroundColor: 'var(--color-error-container)', color: 'var(--color-on-error-container)'},
            '.cm-hunk-btn .material-symbols-outlined': {fontSize: '16px'},
        }),
    )
}

const addLine = Decoration.line({class: 'cm-diff-add'})
const delLine = Decoration.line({class: 'cm-diff-del'})
const hunkLine = Decoration.line({class: 'cm-diff-hunk'})
const metaLine = Decoration.line({class: 'cm-diff-meta'})
const signMark = Decoration.mark({class: 'cm-diff-sign'})

// Acciones por bloque, colgadas del encabezado `@@` de cada uno.
//
// Antes eran una lista aparte arriba del diff, con un renglón por bloque; acá
// el botón está EN el bloque, que es donde uno está mirando cuando decide
// prepararlo. Los callbacks se leen de un ref: el plugin se crea una vez por
// documento, pero el estado (preparado / no preparado) puede cambiar.
interface HunkCtrl {
    canApply: boolean
    staged: boolean
    labels: {stage: string; unstage: string; discard: string}
    onStage: (hunk: number) => void
    onDiscard: (hunk: number) => void
}

class HunkActions extends WidgetType {
    constructor(
        readonly idx: number,
        readonly ctrl: {current: HunkCtrl},
        readonly staged: boolean,
    ) {
        super()
    }
    eq(other: HunkActions) {
        return other.idx === this.idx && other.staged === this.staged
    }
    toDOM() {
        const wrap = document.createElement('span')
        wrap.className = 'cm-hunk-actions'
        const make = (icon: string, title: string, danger: boolean, run: () => void) => {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = `cm-hunk-btn${danger ? ' cm-hunk-danger' : ''}`
            b.title = title
            b.setAttribute('aria-label', title)
            const i = document.createElement('span')
            i.className = 'material-symbols-outlined'
            i.textContent = icon
            b.appendChild(i)
            // mousedown no debe mover la selección del diff: es lo que usa el
            // stage por líneas.
            b.addEventListener('mousedown', (e) => e.preventDefault())
            b.addEventListener('click', (e) => {
                e.preventDefault()
                run()
            })
            wrap.appendChild(b)
        }
        const c = this.ctrl.current
        make(this.staged ? 'remove' : 'add', this.staged ? c.labels.unstage : c.labels.stage, false, () => this.ctrl.current.onStage(this.idx))
        if (!this.staged) make('undo', c.labels.discard, true, () => this.ctrl.current.onDiscard(this.idx))
        return wrap
    }
    ignoreEvent() {
        return true
    }
}

function decorate(view: EditorView, model: PatchModel, ctrl: {current: HunkCtrl}): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>()
    const showActions = ctrl.current.canApply
    for (const {from, to} of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
            const line = view.state.doc.lineAt(pos)
            const kind = model.kinds[line.number - 1]
            if (kind === 'hunk') {
                builder.add(line.from, line.from, hunkLine)
                if (showActions) {
                    const idx = model.hunkLines.indexOf(line.number)
                    builder.add(line.to, line.to, Decoration.widget({widget: new HunkActions(idx, ctrl, ctrl.current.staged), side: 1}))
                }
            } else if (kind === 'meta') builder.add(line.from, line.from, metaLine)
            else if (kind === 'add') {
                builder.add(line.from, line.from, addLine)
                if (line.length > 0) builder.add(line.from, line.from + 1, signMark)
            } else if (kind === 'del') {
                builder.add(line.from, line.from, delLine)
                if (line.length > 0) builder.add(line.from, line.from + 1, signMark)
            }
            pos = line.to + 1
        }
    }
    return builder.finish()
}

function patchDecorations(model: PatchModel, ctrl: {current: HunkCtrl}): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            constructor(view: EditorView) {
                this.decorations = decorate(view, model, ctrl)
            }
            update(update: ViewUpdate) {
                // Recalcular también al mover el viewport, no solo al cambiar el
                // documento: visibleRanges acota el trabajo, y scrollear un
                // parche largo debe volver a correrlo o las líneas que aparecen
                // se dibujan sin decorar.
                if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view, model, ctrl)
            }
        },
        {decorations: (v) => v.decorations},
    )
}

class CellMarker extends GutterMarker {
    constructor(
        readonly text: string,
        readonly cls: string,
        readonly tip: string,
    ) {
        super()
        this.elementClass = cls
    }
    eq(other: CellMarker) {
        return other.text === this.text && other.cls === this.cls && other.tip === this.tip
    }
    toDOM() {
        const span = document.createElement('span')
        span.textContent = this.text
        if (this.tip) span.title = this.tip
        return span
    }
}

// Un medianil con un valor por línea del documento. Devuelve SIEMPRE un
// marcador, aunque el texto esté vacío, porque la clase de color del medianil
// (verde / rojo) tiene que pintar también las celdas sin número.
function cellGutter(name: string, cell: (i: number) => CellMarker, spacer: string): Extension {
    return gutter({
        class: name,
        lineMarker(view, line) {
            return cell(view.state.doc.lineAt(line.from).number - 1)
        },
        lineMarkerChange: () => false,
        initialSpacer: () => new CellMarker(spacer, '', ''),
    })
}

const KIND_CLASS: Record<LineKind, string> = {
    add: 'cm-gutter-add',
    del: 'cm-gutter-del',
    hunk: 'cm-gutter-hunk',
    ctx: '',
    meta: '',
}

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
    appearance = DEFAULT_EDITOR_APPEARANCE,
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
    const tw = t.git.workbench.diff
    const [mode, setMode] = useState<ViewMode>('unified')
    // Document lines currently selected in the editor, so "stage these
    // lines" knows what the user actually highlighted. Kept in state (not a
    // ref) because the button's enabled state depends on it.
    const [selectedDocLines, setSelectedDocLines] = useState<number[]>([])

    const rows = useMemo(() => (mode === 'split' && patch ? parseSplitDiff(patch) : []), [mode, patch])

    // Parsed once per patch and shared by the hunk actions and the selection
    // mapping — both have to agree on hunk/line indices, and deriving them
    // twice is how they drift apart.
    const parsed = useMemo(() => (patch ? parsePatch(patch) : {headers: [], hunks: []}), [patch])
    const lineMap = useMemo(() => (patch ? docLineMap(patch) : []), [patch])
    const model = useMemo(() => buildModel(patch), [patch])

    const totals = useMemo(
        () => parsed.hunks.reduce((n, h) => ({a: n.a + hunkSummary(h).added, r: n.r + hunkSummary(h).removed}), {a: 0, r: 0}),
        [parsed],
    )
    const renamedFrom = useMemo(() => {
        const h = parsed.headers.find((l) => l.startsWith('rename from '))
        return h ? h.slice('rename from '.length) : ''
    }, [parsed])

    // Blame as a gutter: the document IS the patch, and injecting characters
    // would break every line index the staging selection depends on. As a
    // gutter it aligns with the text, scrolls with it and survives wrapping —
    // which the separate column it replaces did none of.
    const blameRows = useMemo(() => {
        if (!blame || blame.length === 0 || !patch) return []
        const byLine = new Map(blame.map((b) => [b.line, b]))
        return model.kinds.map((kind, i) => {
            if (kind === 'ctx') return byLine.get(blameSide === 'new' ? model.newNo[i]! : model.oldNo[i]!) ?? null
            // In a working-tree diff an added line has no commit yet, so there
            // is deliberately nothing to attribute it to.
            if (kind === 'add') return blameSide === 'new' ? (byLine.get(model.newNo[i]!) ?? null) : null
            if (kind === 'del') return blameSide === 'old' ? (byLine.get(model.oldNo[i]!) ?? null) : null
            return null
        })
    }, [blame, patch, blameSide, model])

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

    // Lo que leen los botones del encabezado `@@`, siempre al día.
    const ctrlRef = useRef<HunkCtrl>({
        canApply,
        staged: !!staged,
        labels: {stage: td.stageHunkTitle, unstage: td.unstageHunkTitle, discard: td.discardHunkTitle},
        onStage: () => {},
        onDiscard: () => {},
    })
    ctrlRef.current = {
        canApply,
        staged: !!staged,
        labels: {stage: td.stageHunkTitle, unstage: td.unstageHunkTitle, discard: td.discardHunkTitle},
        onStage: (i) => applySelection({hunks: new Set([i])}, staged ? 'unstage' : 'stage'),
        onDiscard: (i) => applySelection({hunks: new Set([i])}, 'discard'),
    }

    useEffect(() => {
        if (mode !== 'unified' || loading || error || isBinary || !patch || !containerRef.current) return
        const noGutters: Extension[] = [
            cellGutter(
                'cm-diffNo',
                (i) => new CellMarker(model.oldNo[i] != null ? String(model.oldNo[i]) : '', KIND_CLASS[model.kinds[i]] ?? '', ''),
                '0000',
            ),
            cellGutter(
                'cm-diffNo',
                (i) => new CellMarker(model.newNo[i] != null ? String(model.newNo[i]) : '', KIND_CLASS[model.kinds[i]] ?? '', ''),
                '0000',
            ),
        ]
        const blameGutter: Extension[] =
            blameRows.length > 0
                ? [
                      cellGutter(
                          'cm-diffBlame',
                          (i) => {
                              const b = blameRows[i]
                              if (!b) return new CellMarker('', '', td.blameNoCommit)
                              const who = b.uncommitted ? td.blameUncommitted : b.author
                              return new CellMarker(`${b.uncommitted ? td.blameLocal : b.shortHash} ${who}`, '', `${b.author} · ${b.shortHash} · ${b.date}\n${b.summary}`)
                          },
                          'xxxxxxx xxxxxxxxxxxxxxxxxx',
                      ),
                  ]
                : []

        const view = new EditorView({
            state: EditorState.create({
                doc: model.text,
                extensions: [
                    // Lo mínimo para leer y seleccionar: sin el medianil de
                    // números de línea de basicSetup (contaría líneas del
                    // PARCHE, no del archivo) ni sus atajos de edición.
                    drawSelection(),
                    highlightSelectionMatches(),
                    search({top: true}),
                    keymap.of([...defaultKeymap, ...searchKeymap]),
                    ...blameGutter,
                    ...noGutters,
                    diffTheme(appearance),
                    patchDecorations(model, ctrlRef),
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
                            if (range.empty) continue
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
        // td se omite a propósito: sus textos solo se leen al construir los
        // medianiles, y cambiar de idioma con un diff abierto no justifica
        // recrear el editor (se vuelve a leer al elegir otro archivo).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, model, isBinary, loading, error, editorThemeId, appTheme, wrap, appearance, blameRows, patch])

    function goToHunk(dir: 1 | -1) {
        const view = viewRef.current
        if (!view || model.hunkLines.length === 0) return
        // Se parte de lo que se VE (la línea en el borde superior del visor), no
        // de la selección: así «siguiente» siempre avanza desde donde se está
        // leyendo, aunque se haya scrolleado con la rueda.
        const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 2).from
        const topLine = view.state.doc.lineAt(topPos).number
        const target = dir === 1 ? model.hunkLines.find((n) => n > topLine) : [...model.hunkLines].reverse().find((n) => n < topLine)
        const line = target ?? (dir === 1 ? model.hunkLines[0] : model.hunkLines[model.hunkLines.length - 1])
        view.dispatch({effects: EditorView.scrollIntoView(view.state.doc.line(line).from, {y: 'start'})})
    }

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
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? '' : path.slice(0, slash + 1)
    const name = slash < 0 ? path : path.slice(slash + 1)
    const origin: 'staged' | 'unstaged' | 'commit' = staged ? 'staged' : onApplyPatch ? 'unstaged' : 'commit'
    const nSel = selectedDocLines.length
    const hasHunks = model.hunkLines.length > 0

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Cabecera del archivo: ruta, totales y acciones. Fija arriba — el
                cuerpo es lo que scrollea. Si no entran las acciones al lado de
                la ruta, bajan a una segunda línea en vez de apretarla. */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-outline-variant bg-surface-container-low px-2 py-1">
                <div className="flex min-w-40 flex-1 items-center gap-1.5">
                    <Icon name="description" size={14} className="shrink-0 text-on-surface-variant" />
                    <span className="min-w-0 truncate text-ui-12" title={renamedFrom ? `${renamedFrom} → ${path}` : path}>
                        {renamedFrom && <span className="text-on-surface-variant/70">{renamedFrom} → </span>}
                        <span className="text-on-surface-variant/70">{dir}</span>
                        <span className="font-semibold text-on-surface">{name}</span>
                    </span>
                    <span className="shrink-0 font-mono text-ui-11" title={td.hunkCount(parsed.hunks.length)}>
                        <span className="text-secondary">+{totals.a}</span> <span className="text-error">−{totals.r}</span>
                    </span>
                    <span
                        title={tw.originTitle[origin]}
                        className={`shrink-0 rounded-full px-1.5 py-px text-ui-9 font-medium ${
                            origin === 'staged'
                                ? 'bg-secondary-container text-on-secondary-container'
                                : origin === 'unstaged'
                                  ? 'bg-tertiary-container text-on-tertiary-container'
                                  : 'bg-surface-variant text-on-surface-variant'
                        }`}
                    >
                        {tw.origin[origin]}
                    </span>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-0.5">
                    {canApply && unified && (
                        <button
                            onClick={() =>
                                applySelection(
                                    selectionFromDocLines(
                                        parsed,
                                        lineMap,
                                        selectedDocLines.map((n) => n + model.offset),
                                    ),
                                    staged ? 'unstage' : 'stage',
                                )
                            }
                            disabled={nSel === 0}
                            title={nSel === 0 ? td.selectLinesFirst : staged ? td.unstageLinesTitle : td.stageLinesTitle}
                            aria-label={staged ? td.unstageLines : td.stageLines}
                            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-35"
                        >
                            <Icon name={staged ? 'playlist_remove' : 'playlist_add_check'} size={16} />
                            {nSel > 0 && <span className="font-mono text-ui-10">{nSel}</span>}
                        </button>
                    )}
                    {unified && hasHunks && (
                        <>
                            <IconBtn icon="keyboard_arrow_up" title={tw.prevHunk} onClick={() => goToHunk(-1)} />
                            <IconBtn icon="keyboard_arrow_down" title={tw.nextHunk} onClick={() => goToHunk(1)} />
                        </>
                    )}
                    {onEdit && <IconBtn icon="edit" title={td.editTitle} onClick={onEdit} />}
                    {onAsk && <IconBtn icon="smart_toy" title={td.askTitle} onClick={onAsk} />}
                    {onToggleBlame && <IconBtn icon="person_search" title={td.blameTitle} onClick={onToggleBlame} active={!!blame} />}

                    <span className="mx-1 h-4 w-px bg-outline-variant" />

                    <IconBtn icon="notes" title={td.unifiedTitle} onClick={() => setMode('unified')} active={unified} />
                    <IconBtn icon="vertical_split" title={td.splitTitle} onClick={() => setMode('split')} active={!unified} />
                    <IconBtn icon="format_align_justify" title={td.ignoreWsTitle} onClick={() => onChangePrefs(context, !ignoreWs, wrap)} active={ignoreWs} />
                    {unified && <IconBtn icon="wrap_text" title={td.wrapTitle} onClick={() => onChangePrefs(context, ignoreWs, !wrap)} active={wrap} />}

                    <span className="mx-1 h-4 w-px bg-outline-variant" />

                    <span className="flex items-center" title={td.contextTitle}>
                        <button
                            onClick={() => onChangePrefs(Math.max(1, context - 3), ignoreWs, wrap)}
                            disabled={context <= 1}
                            title={td.lessContext}
                            aria-label={td.lessContext}
                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant disabled:opacity-35"
                        >
                            <Icon name="remove" size={14} />
                        </button>
                        <span className="w-6 text-center font-mono text-ui-11 text-on-surface" aria-label={td.context}>
                            {context}
                        </span>
                        <button
                            onClick={() => onChangePrefs(Math.min(200, context + 3), ignoreWs, wrap)}
                            disabled={context >= 200}
                            title={td.moreContext}
                            aria-label={td.moreContext}
                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant disabled:opacity-35"
                        >
                            <Icon name="add" size={14} />
                        </button>
                    </span>
                </div>
            </div>

            {unified ? (
                <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-surface-container-lowest" />
            ) : (
                <SplitView rows={rows} wrap={wrap} appearance={appearance} />
            )}
        </div>
    )
}

function IconBtn({icon, title, onClick, active}: {icon: string; title: string; onClick: () => void; active?: boolean}) {
    return (
        <button
            onClick={onClick}
            title={title}
            aria-label={title}
            aria-pressed={active}
            className={`rounded p-0.5 ${active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'}`}
        >
            <Icon name={icon} size={16} />
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
function SplitView({rows, wrap, appearance}: {rows: SplitRow[]; wrap: boolean; appearance: EditorAppearance}) {
    const t = useT()
    if (rows.length === 0) {
        return <Placeholder icon="check_circle" text={t.git.diff.noTextChanges} />
    }
    return (
        <div
            className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest"
            style={{fontFamily: editorFontStack(appearance.fontFamily), fontSize: appearance.fontSize, lineHeight: 1.5}}
        >
            <table className={`border-collapse ${wrap ? 'w-full table-fixed' : 'min-w-full'}`}>
                <colgroup>
                    <col style={{width: '3.6ch'}} />
                    <col />
                    <col style={{width: '3.6ch'}} />
                    <col />
                </colgroup>
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
    add: 'bg-[color-mix(in_srgb,var(--color-secondary-container)_22%,transparent)]',
    del: 'bg-[color-mix(in_srgb,var(--color-error-container)_22%,transparent)]',
    hunk: 'bg-[color-mix(in_srgb,var(--color-primary-container)_28%,transparent)] text-on-surface-variant text-[0.85em]',
    // A padding row is not "unchanged" — it is the absence of a line on that
    // side, so it reads as inert filler rather than as content.
    empty: 'bg-surface-container/40',
    context: '',
}

function Cell({no, text, kind, side, wrap}: {no: number | null; text: string | null; kind: SplitRow['leftKind']; side: 'left' | 'right'; wrap: boolean}) {
    return (
        <>
            <td
                className={`select-none px-1.5 text-right align-top text-[0.85em] text-on-surface-variant/50 ${CELL_BG[kind]} ${
                    side === 'right' ? 'border-l border-outline-variant/40' : ''
                }`}
            >
                {no ?? ''}
            </td>
            <td className={`px-2 align-top text-on-surface ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} ${CELL_BG[kind]}`}>
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
