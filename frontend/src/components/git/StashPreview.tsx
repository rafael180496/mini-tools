import {useEffect, useMemo, useState} from 'react'
import {GitStashDiff} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import {editorFontStack, type EditorAppearance} from '../../codemirror/editorAppearance'
import Icon from '../Icon'
import {useT} from '../../i18n'

// Vista previa del stash seleccionado, en el área principal.
//
// La vista previa es la razón de que esto sea un panel y no un menú:
// `git stash pop` no se revierte de forma obvia si termina en conflicto, y la
// entrada de la que salió ya no está. Elegir entre `stash@{0}` y `stash@{3}`
// por un mensaje de una línea es adivinar; ver el parche lo vuelve una decisión.

// Cuántas líneas se dibujan por archivo antes de cortar. Un stash con un
// archivo generado de diez mil líneas no se repasa acá: se aplica y se mira.
const MAX_LINES_PER_FILE = 1500

interface FileBlock {
    path: string
    added: number
    removed: number
    lines: string[]
}

// El parche de un stash junta varios archivos; se parte en bloques por
// `diff --git` para poder darle a cada uno su cabecera con ruta y totales.
function splitFiles(patch: string): FileBlock[] {
    const out: FileBlock[] = []
    let cur: FileBlock | null = null
    let inHunk = false
    for (const line of patch.split('\n')) {
        if (line.startsWith('diff --git ')) {
            const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
            cur = {path: m ? m[2] : line.slice(11), added: 0, removed: 0, lines: []}
            out.push(cur)
            inHunk = false
            continue
        }
        if (!cur) continue
        if (line.startsWith('@@')) inHunk = true
        // Hasta el primer `@@` son cabeceras (index, ---, +++): ruido que la
        // cabecera del archivo ya resume.
        if (!inHunk) continue
        if (line.startsWith('+')) cur.added++
        else if (line.startsWith('-')) cur.removed++
        cur.lines.push(line)
    }
    return out
}

interface Props {
    repoId: string
    stash: git.Stash | null
    busy: boolean
    appearance: EditorAppearance
    onApply: (ref: string, drop: boolean) => void
    onDrop: (ref: string) => void
}

export default function StashPreview({repoId, stash, busy, appearance, onApply, onDrop}: Props) {
    const t = useT()
    const ts = t.git.stash
    const w = t.git.workbench.stash
    const ref = stash?.ref ?? null
    const [patch, setPatch] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        if (!ref) {
            setPatch('')
            return
        }
        let cancelled = false
        setLoading(true)
        setError('')
        GitStashDiff(repoId, ref)
            .then((p) => !cancelled && setPatch(p ?? ''))
            .catch((e) => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
        }
    }, [repoId, ref])

    const files = useMemo(() => splitFiles(patch), [patch])
    const totals = useMemo(() => files.reduce((n, f) => ({a: n.a + f.added, r: n.r + f.removed}), {a: 0, r: 0}), [files])

    if (!stash) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <Icon name="inventory_2" size={32} className="text-on-surface-variant/40" />
                <p className="text-ui-12 text-on-surface-variant/80">{w.pickStash}</p>
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container-low px-3 py-1.5">
                <Icon name="inventory_2" size={16} className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-ui-12 font-medium text-on-surface" title={stash.message}>
                        {stash.message || w.noMessage}
                    </p>
                    <p className="flex items-center gap-1.5 text-ui-10 text-on-surface-variant/80">
                        <span className="font-mono">{stash.ref}</span>
                        <span>·</span>
                        <span className="truncate">{stash.branch}</span>
                        <span>·</span>
                        <span>{stash.date}</span>
                        {files.length > 0 && (
                            <>
                                <span>·</span>
                                <span className="font-mono">
                                    {t.git.tab.detail.fileCount(files.length)} <span className="text-secondary">+{totals.a}</span>{' '}
                                    <span className="text-error">−{totals.r}</span>
                                </span>
                            </>
                        )}
                    </p>
                </div>
                <button
                    onClick={() => onApply(stash.ref, false)}
                    disabled={busy}
                    title={ts.applyTitle}
                    className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-2 py-1 text-ui-11 text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                >
                    <Icon name="content_paste" size={14} />
                    {ts.apply}
                </button>
                <button
                    onClick={() => onApply(stash.ref, true)}
                    disabled={busy}
                    title={ts.popTitle}
                    className="flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                >
                    <Icon name="content_paste_go" size={14} />
                    {ts.pop}
                </button>
                <button
                    onClick={() => onDrop(stash.ref)}
                    disabled={busy}
                    title={ts.dropTitle}
                    aria-label={ts.drop}
                    className="shrink-0 rounded p-1 text-error hover:bg-error-container/40 disabled:opacity-40"
                >
                    <Icon name="delete" size={16} />
                </button>
            </div>

            <div
                className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest"
                style={{fontFamily: editorFontStack(appearance.fontFamily), fontSize: appearance.fontSize}}
            >
                {loading && <p className="p-3 text-ui-12 text-on-surface-variant">{ts.loading}</p>}
                {error && <p className="p-3 text-ui-12 text-error">{error}</p>}
                {!loading && !error && files.length === 0 && <p className="p-3 text-ui-12 text-on-surface-variant">{ts.noChanges}</p>}
                {!loading &&
                    !error &&
                    files.map((f) => (
                        <section key={f.path} className="border-b border-outline-variant/60">
                            <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-outline-variant/60 bg-surface-container px-3 py-1 font-sans text-ui-11">
                                <Icon name="description" size={13} className="shrink-0 text-on-surface-variant" />
                                <span className="min-w-0 flex-1 truncate font-medium text-on-surface" title={f.path}>
                                    {f.path}
                                </span>
                                <span className="shrink-0 font-mono text-ui-10">
                                    <span className="text-secondary">+{f.added}</span> <span className="text-error">−{f.removed}</span>
                                </span>
                            </header>
                            <pre className="m-0 whitespace-pre-wrap break-all" style={{lineHeight: 1.45}}>
                                {f.lines.slice(0, MAX_LINES_PER_FILE).map((line, i) => (
                                    <div
                                        key={i}
                                        className={
                                            line.startsWith('@@')
                                                ? 'bg-surface-container px-3 py-px font-sans text-ui-10 text-on-surface-variant'
                                                : line.startsWith('+')
                                                  ? 'bg-secondary-container/20 px-3 text-on-surface'
                                                  : line.startsWith('-')
                                                    ? 'bg-error-container/20 px-3 text-on-surface'
                                                    : 'px-3 text-on-surface-variant'
                                        }
                                    >
                                        {line || ' '}
                                    </div>
                                ))}
                                {f.lines.length > MAX_LINES_PER_FILE && (
                                    <div className="px-3 py-1 font-sans text-ui-11 text-on-surface-variant/70">
                                        {w.moreLines({n: f.lines.length - MAX_LINES_PER_FILE})}
                                    </div>
                                )}
                            </pre>
                        </section>
                    ))}
            </div>
        </div>
    )
}
