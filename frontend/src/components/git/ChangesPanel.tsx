import {useEffect, useRef, useState} from 'react'
import {git, main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {applyPrefix, buildCommitPrefix, COMMIT_TYPES, currentPrefixOf, extractTicket} from '../../lib/gitCommitMessage'
import InlineDiff, {type InlineDiffState} from './InlineDiff'

// Panel de CAMBIOS: la columna de trabajo cuando se está armando un commit.
//
// Es la forma de «Source Control» de VS Code: arriba el mensaje y el botón de
// commit, debajo los archivos preparados y los que no. El diff del archivo
// elegido se ve en el área principal, no acá.
//
// El mensaje va ARRIBA de las listas, y no abajo como antes, por una razón de
// altura: con la columna estrecha y 40 archivos, un cuadro de commit pegado al
// pie se aleja de lo que se está mirando; arriba está siempre a la vista y la
// lista es lo que scrollea.

interface Props {
    staged: git.FileStatus[]
    unstaged: git.FileStatus[]
    selectedPath: string | null
    busy: boolean
    commitMessage: string
    // El mensaje del último commit de la rama, para precargar «Enmendar».
    lastCommitMessage: string
    // La rama actual, usada solo para leer el ticket de su nombre.
    branchName: string
    onSelectPath: (p: string) => void
    onStage: (paths: string[]) => void
    onStageAll: () => void
    onUnstage: (paths: string[]) => void
    onDiscard: (paths: string[]) => void
    onChangeMessage: (m: string) => void
    onCommit: (amend: boolean) => void
    // Diffs desplegados dentro de la lista, por ruta. Ausente = plegado.
    inlineDiffs: Record<string, InlineDiffState>
    onToggleDiff: (path: string, staged: boolean) => void
    // Ausente cuando no hay ningún agente con chat verificado: la acción no se
    // ofrece en vez de ofrecerla y fallar al tocarla.
    onDraftMessage?: () => void
    // Ausente con un solo agente instalado: un menú de una sola opción es ruido.
    onPickDraftAgent?: (e: {clientX: number; clientY: number}) => void
    drafting?: boolean
    // La última redacción del agente, mientras el campo siga siendo la suya.
    draft?: main.CommitDraft | null
}

export default function ChangesPanel({
    staged,
    unstaged,
    selectedPath,
    busy,
    commitMessage,
    lastCommitMessage,
    branchName,
    onSelectPath,
    onStage,
    onStageAll,
    onUnstage,
    onDiscard,
    onChangeMessage,
    onCommit,
    inlineDiffs,
    onToggleDiff,
    onDraftMessage,
    onPickDraftAgent,
    drafting,
    draft,
}: Props) {
    const t = useT()
    const c = t.git.tab.changes
    const w = t.git.workbench.changes
    const [amend, setAmend] = useState(false)
    const submitted = useRef(false)
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

    // Un commit hecho (mensaje vaciado por el padre) apaga «Enmendar»: dejarlo
    // prendido haría que el SIGUIENTE commit reescribiera el que se acaba de
    // crear, sin que nadie lo haya pedido.
    useEffect(() => {
        if (commitMessage === '' && submitted.current) {
            submitted.current = false
            setAmend(false)
        }
    }, [commitMessage])

    const ticket = extractTicket(branchName)
    const canCommit = !busy && !!commitMessage.trim() && (amend || staged.length > 0)
    const commitBlockedReason = busy
        ? ''
        : !commitMessage.trim()
          ? c.commitNeedsMessage
          : staged.length === 0 && !amend
            ? c.commitNeedsStaged
            : ''

    function submit() {
        if (!canCommit) return
        submitted.current = true
        onCommit(amend)
    }

    function toggleAmend() {
        const next = !amend
        setAmend(next)
        // Con el campo vacío se precarga el mensaje del commit que se va a
        // reescribir: enmendar casi siempre es «el mismo mensaje, más esto».
        if (next && !commitMessage.trim() && lastCommitMessage) onChangeMessage(lastCommitMessage)
    }

    const toggleGroup = (key: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })

    const clean = staged.length === 0 && unstaged.length === 0

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* --- caja de commit --------------------------------------------- */}
            <div className="shrink-0 space-y-1.5 border-b border-outline-variant p-2">
                <div className="relative rounded bg-surface-container-highest focus-within:ring-1 focus-within:ring-primary">
                    <textarea
                        value={commitMessage}
                        onChange={(e) => onChangeMessage(e.target.value)}
                        onKeyDown={(e) => {
                            // Cmd/Ctrl+Enter: el mismo atajo que usan VS Code y
                            // GitHub para enviar desde un campo multilínea.
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault()
                                submit()
                            }
                        }}
                        placeholder={amend ? w.amendPlaceholder : c.messagePlaceholder}
                        rows={3}
                        title={`${c.messageTitle}\n${w.submitShortcut}`}
                        className="block w-full resize-y rounded border-none bg-transparent px-2 py-1.5 pr-9 text-ui-12 leading-snug text-on-surface outline-none placeholder:text-on-surface-variant/50"
                        style={{minHeight: 56, maxHeight: 220}}
                    />
                    {onDraftMessage && (
                        <div className="absolute right-1 top-1 flex flex-col items-center rounded bg-surface-container-highest">
                            <button
                                onClick={onDraftMessage}
                                disabled={busy || staged.length === 0 || drafting}
                                title={drafting ? c.draftingTitle : staged.length === 0 ? c.draftNeedsStaged : c.draftTitle}
                                aria-label={drafting ? c.drafting : c.draft}
                                className="flex items-center justify-center rounded p-1 text-primary hover:bg-primary-container/50 disabled:opacity-40"
                            >
                                {drafting ? (
                                    <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                                ) : (
                                    <Icon name="auto_awesome" size={15} />
                                )}
                            </button>
                            {onPickDraftAgent && (
                                <button
                                    onClick={(e) => onPickDraftAgent({clientX: e.clientX, clientY: e.clientY})}
                                    disabled={busy || staged.length === 0 || drafting}
                                    title={c.draftOtherTitle}
                                    aria-label={c.draftOtherTitle}
                                    className="rounded px-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                                >
                                    <Icon name="expand_more" size={13} />
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Ayudante de Conventional Commits. La mitad del ticket es la
                    que ahorra tipeo: la rama ya dice a qué ticket pertenece el
                    trabajo, y volver a escribirlo en cada mensaje es lo que se
                    olvida — justo cuando se rompe la trazabilidad. */}
                <div className="flex items-center gap-1">
                    <select
                        value={currentPrefixOf(commitMessage).type}
                        onChange={(e) => {
                            const type = e.target.value
                            const scope = currentPrefixOf(commitMessage).scope || ticket
                            onChangeMessage(type ? applyPrefix(commitMessage, buildCommitPrefix(type, scope)) : commitMessage)
                        }}
                        title={c.typeTitle}
                        className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container px-1 py-0.5 text-ui-11 text-on-surface"
                    >
                        <option value="">{c.typePlaceholder}</option>
                        {COMMIT_TYPES.map((ct) => (
                            <option key={ct.value} value={ct.value} title={ct.hint}>
                                {ct.label}
                            </option>
                        ))}
                    </select>
                    {!!ticket && (
                        <button
                            onClick={() => {
                                const {type} = currentPrefixOf(commitMessage)
                                onChangeMessage(applyPrefix(commitMessage, buildCommitPrefix(type || 'feat', ticket)))
                            }}
                            title={c.ticketTitle({ticket, branch: branchName})}
                            className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 font-mono text-ui-10 text-on-surface-variant hover:text-on-surface"
                        >
                            {ticket}
                        </button>
                    )}
                </div>

                {/* Qué se le mandó al agente y quién contestó. «¿Qué le pasaste
                    de mi repositorio?» tiene que poder contestarse. */}
                {draft && (
                    <p
                        title={c.draftInfoTitle({count: draft.files.length, truncated: draft.diffTruncated})}
                        className="flex items-center gap-1 px-0.5 text-ui-10 text-on-surface-variant/70"
                    >
                        <Icon name="auto_awesome" size={11} className="shrink-0 text-primary" />
                        <span className="truncate">
                            {draft.agentLabel} · {t.git.tab.detail.fileCount(draft.files.length)} · +{draft.insertions}/−{draft.deletions}
                        </span>
                        {draft.diffTruncated && (
                            <span className="shrink-0 text-tertiary" title={c.truncatedTitle}>
                                · {c.truncated}
                            </span>
                        )}
                    </p>
                )}

                <div className="flex items-stretch gap-1">
                    <button
                        onClick={submit}
                        disabled={!canCommit}
                        title={
                            commitBlockedReason ||
                            (amend ? w.amendTitle : c.commitTitle({count: staged.length}))
                        }
                        className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded bg-secondary px-2 py-1.5 text-ui-12 font-medium text-on-secondary hover:opacity-90 disabled:opacity-40"
                    >
                        <Icon name={amend ? 'edit' : 'check'} size={15} />
                        <span className="truncate">{amend ? w.amendButton : c.commitButton(staged.length)}</span>
                    </button>
                    <button
                        onClick={toggleAmend}
                        disabled={busy}
                        aria-pressed={amend}
                        title={amend ? w.amendOffTitle : w.amendOnTitle}
                        aria-label={w.amend}
                        className={`flex shrink-0 items-center gap-1 rounded border px-2 text-ui-11 transition-colors disabled:opacity-40 ${
                            amend
                                ? 'border-transparent bg-tertiary-container text-on-tertiary-container'
                                : 'border-outline-variant text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="history_edu" size={14} />
                        {w.amend}
                    </button>
                </div>
            </div>

            {/* --- listas ------------------------------------------------------ */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {clean ? (
                    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                        <Icon name="task_alt" size={30} className="text-secondary/70" />
                        <p className="text-ui-12 font-medium text-on-surface">{w.cleanTitle}</p>
                        <p className="text-ui-11 text-on-surface-variant/80">{w.cleanBody}</p>
                    </div>
                ) : (
                    <>
                        <FileGroup
                            title={c.staged}
                            files={staged}
                            selectedPath={selectedPath}
                            onSelectPath={onSelectPath}
                            action={{icon: 'remove', title: c.unstage, onClick: (p) => onUnstage([p])}}
                            groupActions={[
                                {
                                    icon: 'remove',
                                    title: w.unstageAll({count: staged.length}),
                                    disabled: busy || staged.length === 0,
                                    onClick: () => onUnstage(staged.map((f) => f.path)),
                                },
                            ]}
                            empty={c.stagedEmpty}
                            inlineDiffs={inlineDiffs}
                            onToggleDiff={onToggleDiff}
                            open={!collapsed.has('staged')}
                            onToggleOpen={() => toggleGroup('staged')}
                            staged
                        />
                        <FileGroup
                            title={c.unstaged}
                            files={unstaged}
                            selectedPath={selectedPath}
                            onSelectPath={onSelectPath}
                            action={{icon: 'add', title: c.stage, onClick: (p) => onStage([p])}}
                            secondaryAction={{icon: 'undo', title: c.discardFile, danger: true, onClick: (p) => onDiscard([p])}}
                            groupActions={[
                                {
                                    icon: 'undo',
                                    title: w.discardAll({count: unstaged.length}),
                                    danger: true,
                                    disabled: busy || unstaged.length === 0,
                                    onClick: () => onDiscard(unstaged.map((f) => f.path)),
                                },
                                {
                                    icon: 'add',
                                    title: unstaged.length === 0 ? c.nothingToStage : c.stageAllTitle({count: unstaged.length}),
                                    disabled: busy || unstaged.length === 0,
                                    onClick: onStageAll,
                                },
                            ]}
                            empty={c.unstagedEmpty}
                            inlineDiffs={inlineDiffs}
                            onToggleDiff={onToggleDiff}
                            open={!collapsed.has('unstaged')}
                            onToggleOpen={() => toggleGroup('unstaged')}
                        />
                    </>
                )}
            </div>
        </div>
    )
}

interface GroupAction {
    icon: string
    title: string
    danger?: boolean
    disabled?: boolean
    onClick: () => void
}

function FileGroup({
    title,
    files,
    selectedPath,
    onSelectPath,
    action,
    secondaryAction,
    groupActions,
    empty,
    inlineDiffs,
    onToggleDiff,
    open,
    onToggleOpen,
    staged,
}: {
    title: string
    files: git.FileStatus[]
    selectedPath: string | null
    onSelectPath: (p: string) => void
    action: {icon: string; title: string; onClick: (path: string) => void}
    secondaryAction?: {icon: string; title: string; danger?: boolean; onClick: (path: string) => void}
    // Acciones de TODO el grupo, en su cabecera: preparar todo, quitar todo,
    // descartar todo.
    groupActions: GroupAction[]
    empty: string
    inlineDiffs: Record<string, InlineDiffState>
    onToggleDiff: (path: string, staged: boolean) => void
    open: boolean
    onToggleOpen: () => void
    // Si este es el grupo que entra en el próximo commit. Decide el punto del
    // encabezado y de qué lado se lee el diff de cada archivo: preparado contra
    // el índice, sin preparar contra el working tree.
    staged?: boolean
}) {
    const c = useT().git.tab.changes
    const w = useT().git.workbench.changes
    return (
        <div>
            <div className="sticky top-0 z-10 flex items-center gap-0.5 bg-surface-container-low pr-1">
                <button
                    onClick={onToggleOpen}
                    title={open ? w.collapseGroup({title}) : w.expandGroup({title})}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1 text-left text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/80 hover:text-on-surface"
                >
                    <Icon name={open ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0" />
                    {staged && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-secondary" />}
                    <span className="truncate">{title}</span>
                    {files.length > 0 && (
                        <span className="rounded-full bg-surface-variant px-1.5 py-px text-ui-9 font-semibold normal-case tracking-normal text-on-surface-variant">
                            {files.length}
                        </span>
                    )}
                </button>
                {groupActions.map((a) => (
                    <button
                        key={a.icon + a.title}
                        onClick={a.onClick}
                        disabled={a.disabled}
                        title={a.title}
                        aria-label={a.title}
                        className={`shrink-0 rounded p-0.5 disabled:opacity-30 ${
                            a.danger ? 'text-error hover:bg-error-container/40' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name={a.icon} size={15} />
                    </button>
                ))}
            </div>
            {open && files.length === 0 && <p className="px-3 py-1.5 text-ui-11 text-on-surface-variant/50">{empty}</p>}
            {open &&
                files.map((f) => {
                    // Nombre y carpeta separados: en un repo real la ruta entera
                    // no entra en la columna, y truncar a la izquierda deja ver
                    // justo la parte que no distingue un archivo de otro.
                    const slash = f.path.lastIndexOf('/')
                    const name = slash < 0 ? f.path : f.path.slice(slash + 1)
                    const dir = f.origPath ? `← ${f.origPath}` : slash < 0 ? '' : f.path.slice(0, slash)
                    const diff = inlineDiffs[f.path]
                    return (
                        <div key={f.path}>
                            <div
                                className={`group flex items-center gap-1 py-0.5 pl-1 pr-1.5 text-ui-12 ${
                                    selectedPath === f.path ? 'bg-primary-container/50' : 'hover:bg-surface-variant/50'
                                }`}
                            >
                                {/* Desplegar el diff acá mismo: repasar el
                                    commit entero de arriba hacia abajo antes de
                                    escribirlo, sin ir y volver. */}
                                <button
                                    onClick={() => onToggleDiff(f.path, !!staged)}
                                    title={diff ? c.hideFileChanges({name}) : c.showFileChanges({name})}
                                    aria-label={diff ? c.hideFileChanges({name}) : c.showFileChanges({name})}
                                    className="shrink-0 rounded p-0.5 text-on-surface-variant/70 hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name={diff ? 'expand_more' : 'chevron_right'} size={13} />
                                </button>
                                <StatusChip file={f} />
                                <button
                                    onClick={() => onSelectPath(f.path)}
                                    title={f.origPath ? c.viewDiffRenamed({path: f.path, from: f.origPath}) : c.viewDiff({path: f.path})}
                                    className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
                                >
                                    <span className="shrink-0 truncate text-on-surface">{name}</span>
                                    {!!dir && <span className="min-w-0 flex-1 truncate font-mono text-ui-10 text-on-surface-variant/60">{dir}</span>}
                                </button>
                                {/* Acciones por archivo: visibles al pasar el
                                    mouse o al enfocar con teclado. */}
                                <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                                    {secondaryAction && (
                                        <button
                                            onClick={() => secondaryAction.onClick(f.path)}
                                            title={secondaryAction.title}
                                            aria-label={secondaryAction.title}
                                            className={`rounded p-0.5 ${secondaryAction.danger ? 'text-error hover:bg-error-container/40' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                                        >
                                            <Icon name={secondaryAction.icon} size={14} />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => action.onClick(f.path)}
                                        title={action.title}
                                        aria-label={action.title}
                                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name={action.icon} size={14} />
                                    </button>
                                </span>
                            </div>
                            {diff && <InlineDiff state={diff} onOpenFull={() => onSelectPath(f.path)} />}
                        </div>
                    )
                })}
        </div>
    )
}

// StatusChip pinta el código porcelain de git con un color que lleva el
// significado. El caso «sin trackear» tiene su propia explicación porque «?» es
// el que un usuario nuevo más seguido lee como un error.
function StatusChip({file}: {file: git.FileStatus}) {
    const code = file.untracked ? '?' : file.staged ? file.indexStatus : file.workStatus
    const s = useT().git.tab.status
    const meaning: Record<string, {label: string; cls: string}> = {
        M: {label: s.modified, cls: 'text-tertiary'},
        A: {label: s.added, cls: 'text-secondary'},
        D: {label: s.deleted, cls: 'text-error'},
        R: {label: s.renamed, cls: 'text-primary'},
        C: {label: s.copied, cls: 'text-primary'},
        '?': {label: s.untracked, cls: 'text-on-surface-variant/60'},
    }
    const m = meaning[code] ?? {label: code, cls: 'text-on-surface-variant'}
    return (
        <span title={m.label} className={`w-3 shrink-0 text-center font-mono text-ui-11 font-semibold ${m.cls}`}>
            {code}
        </span>
    )
}
