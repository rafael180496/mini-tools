import {useCallback, useEffect, useRef, useState} from 'react'
import {
    GitAbort,
    GitApplyPatch,
    GitBlame,
    GitBranches,
    GitCherryPick,
    GitCreateBranch,
    GitCreateTag,
    GitDeleteBranch,
    GitDeleteRemoteBranch,
    GitRenameBranch,
    GitInProgress,
    GitMerge,
    GitReset,
    GitRevert,
    GitSetUpstream,
    GitUnsetUpstream,
    GitChangedFiles,
    GitCheckout,
    GitCommit,
    GitContinue,
    GitDiff,
    GitDiscard,
    GitFetch,
    GitForgeInfo,
    GitOpenInBrowser,
    GitRemoveWorktree,
    GitWorktrees,
    GitListRepos,
    GitLog,
    GitPull,
    GitPush,
    GitStage,
    GitStashApply,
    GitStashDrop,
    GitStashes,
    GitStashPush,
    GitStageAll,
    GitSetDiffPrefs,
    GitSetPaneWidths,
    GitSetPinnedBranches,
    GitStatus,
    GitUnstage,
} from '../../../wailsjs/go/main/App'
import {GetSettings} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import type {Theme} from '../../hooks/useTheme'
import {
    applyPrefix,
    buildCommitPrefix,
    COMMIT_TYPES,
    currentPrefixOf,
    extractTicket,
} from '../../lib/gitCommitMessage'
import {
    describeSearch,
    EMPTY_SEARCH,
    GIT_SEARCH_HELP,
    isEmptySearch,
    parseGitSearch,
    type GitSearch,
} from '../../lib/gitSearch'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import CommitGraph from './CommitGraph'
import ContextMenu from './ContextMenu'
import DiffViewer from './DiffViewer'
import DropdownMenu, {type DropdownItem} from './DropdownMenu'
import GitSettingsDialog from './GitSettingsDialog'
import GitConflictResolver from './GitConflictResolver'
import GitCommandLogDrawer from './GitCommandLog'
import GitRebaseDialog from './GitRebaseDialog'
import GitStashPanel from './GitStashPanel'
import PromptDialog from './PromptDialog'

// Everything PromptDialog takes except onClose, which this component owns.
interface PromptSpec {
    title: string
    label: string
    initial?: string
    placeholder?: string
    confirmLabel?: string
    secondLabel?: string
    secondPlaceholder?: string
    description?: string
    onSubmit: (value: string, second: string) => void
}

// An action pending confirmation. Carrying the copy alongside the action
// keeps each ConfirmDialog's wording next to the operation it guards, instead
// of one dialog with a switch over an action enum. Defaults to danger since
// every existing use is destructive (delete branch, delete remote branch) —
// set it to false for a confirm that is merely "are you sure", like the
// missing-upstream push offer.
interface PendingConfirm {
    title: string
    description: string
    confirmLabel: string
    run: () => Promise<unknown>
    label: string
    danger?: boolean
}

interface GitRepoTabProps {
    repoId: string
    repoName: string
    editorThemeId: string
    appTheme: Theme
    // Bumped by Workspace after any Git mutation anywhere — including from the
    // sidebar module. This tab reloads off it rather than off its own actions,
    // so a checkout done in the sidebar shows up here immediately.
    syncToken: number
    // Called after this tab mutates the repository, so everything else reloads.
    onChanged: () => void
    // Whether this is the currently-focused tab. Only the active tab polls git
    // status live (see the polling effect) — polling every open-but-hidden Git
    // tab would run git on a timer for repositories the user isn't looking at.
    active: boolean
}

// Which of the two center views is showing. "commits" is the history graph;
// "changes" is the working tree — the same Commits/Files split the sidebar of
// a Sublime Merge tab has.
type CenterView = 'commits' | 'changes' | 'stash' | 'conflicts'

const LOG_PAGE = 200

export default function GitRepoTab({repoId, repoName, editorThemeId, appTheme, syncToken, onChanged, active}: GitRepoTabProps) {
    const [view, setView] = useState<CenterView>('commits')
    const [commits, setCommits] = useState<git.CommitInfo[]>([])
    const [branches, setBranches] = useState<git.Branch[]>([])
    const [status, setStatus] = useState<git.RepoStatus | null>(null)
    const [loadingLog, setLoadingLog] = useState(true)

    const [selectedCommit, setSelectedCommit] = useState<git.CommitInfo | null>(null)
    const [changedFiles, setChangedFiles] = useState<git.FileDiff[]>([])
    const [selectedPath, setSelectedPath] = useState<string | null>(null)
    // Branch the user last clicked in the sidebar, highlighted there so it is
    // clear which one the graph was scrolled to. Purely a selection — it is not
    // the checked-out branch, which is branch.isCurrent.
    const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
    // Commit the graph should scroll to, with a token so clicking the same
    // branch twice scrolls again after the user has scrolled away.
    const [reveal, setReveal] = useState<{hash: string; token: number} | null>(null)
    const revealSeq = useRef(0)
    const [branchFilter, setBranchFilter] = useState('')
    // Commit search. Parsed into real git log filters (author/grep/path/
    // date/rev) rather than filtering the loaded page: the graph pages a few
    // hundred commits at a time, so a client-side filter would only ever
    // search what happens to be on screen.
    const [searchText, setSearchText] = useState('')
    const [search, setSearch] = useState<GitSearch>(EMPTY_SEARCH)
    const [showSearchHelp, setShowSearchHelp] = useState(false)
    // Focus mode walks only the current branch plus the trunks, instead of
    // every ref. On a repository with 350 remote branches that is the
    // difference between a readable graph and a wall of lanes.
    const [focusMode, setFocusMode] = useState(false)
    const [pinned, setPinned] = useState<string[]>([])
    // A hunk-level discard is destructive and irreversible, so it goes
    // through the same confirmation as discarding a whole file — the patch
    // is held here until the user confirms.
    const [confirmDiscardPatch, setConfirmDiscardPatch] = useState<string | null>(null)
    const [rebaseBase, setRebaseBase] = useState<{hash: string; label: string} | null>(null)
    const [showCommandLog, setShowCommandLog] = useState(false)
    const [logToken, setLogToken] = useState(0)
    const [worktrees, setWorktrees] = useState<git.Worktree[]>([])
    const [showWorktrees, setShowWorktrees] = useState(false)
    const [forge, setForge] = useState<git.ForgeInfo | null>(null)

    // The forge link depends on the checked-out branch, so it is resolved
    // whenever the branch changes rather than on every render.
    useEffect(() => {
        const branch = status?.branch
        if (!branch) {
            setForge(null)
            return
        }
        let cancelled = false
        GitForgeInfo(repoId, 'origin', branch, '')
            .then((f) => {
                if (!cancelled) setForge(f)
            })
            .catch(() => {
                if (!cancelled) setForge(null)
            })
        return () => {
            cancelled = true
        }
    }, [repoId, status?.branch])

    useEffect(() => {
        if (!showWorktrees) return
        GitWorktrees(repoId)
            .then((w) => setWorktrees(w ?? []))
            .catch(() => setWorktrees([]))
    }, [repoId, showWorktrees, logToken])
    // Blame is opt-in: it is a full-file walk per file, and nobody wants it
    // running on every diff they click through.
    const [blame, setBlame] = useState<git.BlameLine[] | null>(null)
    useEffect(() => {
        // Blame belongs to one file at one revision — keeping it across a
        // selection change would attribute the wrong lines to the wrong
        // people, which is worse than showing nothing.
        setBlame(null)
    }, [selectedPath, view])
    // Loaded by reload() below rather than by an effect of its own: every
    // mutating action already funnels through reload, so the tab badge stays
    // right without a second refresh path to keep in sync.
    const [stashes, setStashes] = useState<git.Stash[]>([])

    // Pinned branches come from the repository record (vault), not from
    // component state: they have to survive closing the tab, and they are
    // per repository — "develop" is the trunk in one project and does not
    // exist in another.
    useEffect(() => {
        let cancelled = false
        GitListRepos()
            .then((repos) => {
                if (cancelled) return
                const repo = (repos ?? []).find((r) => r.id === repoId)
                setPinned(repo?.pinnedBranches ?? [])
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [repoId])

    async function togglePinned(name: string) {
        const next = pinned.includes(name) ? pinned.filter((p) => p !== name) : [...pinned, name]
        setPinned(next)
        try {
            await GitSetPinnedBranches(repoId, next)
        } catch (e) {
            // Roll the optimistic update back rather than leaving the star
            // showing a state the vault does not have.
            setPinned(pinned)
            setError(String(e))
        }
    }

    const [diff, setDiff] = useState<git.FileDiff | null>(null)
    const [loadingDiff, setLoadingDiff] = useState(false)
    const [diffError, setDiffError] = useState<string | null>(null)

    const [commitMessage, setCommitMessage] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [confirmDiscard, setConfirmDiscard] = useState<string[] | null>(null)
    const [menu, setMenu] = useState<{x: number; y: number; items: (DropdownItem | 'separator')[]} | null>(null)
    const [prompt, setPrompt] = useState<PromptSpec | null>(null)
    const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
    // "merge" | "cherry-pick" | "revert" | "rebase" | "" — drives the abort
    // banner. Without it a user who hits a conflict has no way out of the app.
    const [inProgress, setInProgress] = useState('')
    const [showSettings, setShowSettings] = useState(false)
    // Branch names hidden from the graph via the commit menu. When non-empty
    // the log walks every OTHER ref instead of --all, so hiding a busy release
    // branch declutters the graph without deleting anything.
    const [hidden, setHidden] = useState<Set<string>>(new Set())
    // Pane widths, restored from the vault and written back on drag end.
    // Seeded with the same defaults migration 20 uses so the first paint
    // matches the stored layout instead of jumping when settings arrive.
    const [sideWidth, setSideWidth] = useState(224)
    const [diffWidth, setDiffWidth] = useState(520)
    const [dragging, setDragging] = useState<'side' | 'diff' | null>(null)
    const [diffContext, setDiffContext] = useState(3)
    const [diffIgnoreWs, setDiffIgnoreWs] = useState(false)
    const [diffWrap, setDiffWrap] = useState(true)
    const layoutRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        GetSettings()
            .then((st) => {
                if (st.gitSideWidth) setSideWidth(st.gitSideWidth)
                if (st.gitDiffWidth) setDiffWidth(st.gitDiffWidth)
                if (st.gitDiffContext) setDiffContext(st.gitDiffContext)
                setDiffIgnoreWs(st.gitDiffIgnoreWs)
                setDiffWrap(st.gitDiffWrap)
            })
            .catch(() => {
                // A settings read failure is not worth an error banner — the
                // panes just keep their defaults.
            })
    }, [])

    // Drag handling lives on window, not on the handle, so the pointer can
    // leave the 4px strip mid-drag without the resize stopping — the usual
    // reason a splitter feels like it "slips".
    useEffect(() => {
        if (!dragging) return
        const onMove = (e: MouseEvent) => {
            const box = layoutRef.current?.getBoundingClientRect()
            if (!box) return
            if (dragging === 'side') {
                setSideWidth(clampPane(e.clientX - box.left))
            } else {
                // The diff pane is anchored to the right edge, so its width
                // grows as the pointer moves left.
                setDiffWidth(clampPane(box.right - e.clientX))
            }
        }
        const onUp = () => {
            setDragging(null)
            // Persist only on release: writing on every mousemove would hit
            // SQLite hundreds of times per drag for one final value.
            void GitSetPaneWidths(sideWidth, diffWidth).catch(() => {})
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        // Suppress text selection and keep the resize cursor while dragging,
        // even over children that set their own cursor.
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'
        return () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
    }, [dragging, sideWidth, diffWidth])

    // reload refetches everything the toolbar can invalidate. Every mutating
    // action funnels through run() below, which calls this on success, so the
    // three panels never drift out of sync with the repository.
    const reload = useCallback(async () => {
        setLoadingLog(true)
        try {
            // When branches are hidden, walk every visible ref explicitly
            // instead of --all — that is the only way git can exclude a ref
            // from the graph. Branches are listed first so the full set is
            // known before choosing the walk.
            const brs = await GitBranches(repoId, true)
            const visibleRefs = (brs ?? []).map((b) => b.name).filter((n) => !hidden.has(n))

            // Focus mode narrows the walk to the current branch plus whatever
            // trunks exist, and takes precedence over hidden branches: both
            // are ways of saying "show me less", and the narrower one wins.
            const focusRefs = focusMode ? focusRefsOf(brs ?? [], pinned) : []

            const base = {maxCount: LOG_PAGE, withStats: false, ...searchToLogOptions(search)}
            // Precedence matters and is not obvious: GetCommitLog checks
            // Revs, then All, then Rev — so setting `all` alongside a hash
            // search would silently ignore the hash. A hash is the narrowest
            // thing the user can ask for, so it wins outright.
            const logOpts = search.rev
                ? new git.LogOptions({...base, all: false})
                : focusRefs.length > 0
                  ? new git.LogOptions({...base, revs: focusRefs})
                  : hidden.size > 0
                    ? new git.LogOptions({...base, revs: visibleRefs})
                    : new git.LogOptions({...base, all: true})
            const [log, st, prog, stash] = await Promise.all([
                GitLog(repoId, logOpts),
                GitStatus(repoId),
                GitInProgress(repoId),
                GitStashes(repoId),
            ])
            setStashes(stash ?? [])
            setCommits(log ?? [])
            setBranches(brs ?? [])
            setStatus(st)
            setInProgress(prog ?? '')
            setError(null)
        } catch (e) {
            setError(String(e))
        } finally {
            setLoadingLog(false)
        }
    }, [repoId, hidden, focusMode, search, pinned])

    useEffect(() => {
        void reload()
    }, [reload])

    // run wraps every mutating operation: single-flight (busy gates the
    // toolbar), errors surfaced in the banner instead of thrown into the void,
    // and a reload afterwards so the UI reflects what actually happened rather
    // than what was requested. Returns whether fn succeeded, so a caller that
    // needs to chain a follow-up only on success (e.g. re-selecting the branch
    // just checked out) doesn't have to duplicate the try/catch.
    // onError lets a specific caller intercept a failure it knows how to
    // recover from (see the plain "push" item's missing-upstream offer)
    // instead of the default error banner — return true once handled.
    const run = useCallback(
        async (label: string, fn: () => Promise<unknown>, onError?: (e: unknown) => boolean) => {
            setBusy(label)
            setError(null)
            setNotice(null)
            try {
                const out = await fn()
                if (typeof out === 'string' && out.trim()) setNotice(out.trim())
                // Deliberately does NOT call reload() here. Bumping the shared
                // token makes this tab AND the sidebar reload from one place;
                // reloading here as well would run every git command twice per
                // action and flash the loading state.
                onChanged()
                // The command drawer reads off this token, so it shows what
                // just ran without polling.
                setLogToken((n) => n + 1)
                return true
            } catch (e) {
                if (!onError?.(e)) setError(String(e))
                // A failed command is exactly the one worth seeing in the log.
                setLogToken((n) => n + 1)
                return false
            } finally {
                setBusy(null)
            }
        },
        [onChanged],
    )

    // Reload whenever anything Git-related changed, here or elsewhere. The
    // mount-time load is handled by the reload effect above (keyed on repoId),
    // so the first run of this one is skipped to avoid a duplicate.
    const firstSyncRef = useRef(true)
    useEffect(() => {
        if (firstSyncRef.current) {
            firstSyncRef.current = false
            return
        }
        void reload()
    }, [syncToken, reload])

    // Live working-tree polling.
    //
    // While this is the active tab and the app window is focused, re-read `git
    // status` on a timer so the "Cambios (N)" badge and the changes panel
    // reflect edits made OUTSIDE the app — saving a file in the IDE, a script
    // touching the tree — without the user hitting refresh.
    //
    // Status-only on purpose: it never touches the commit graph, so nothing
    // flickers and the selected commit / scroll position are untouched. The
    // commit log only changes on an actual git operation, which already routes
    // through run() → onChanged, so there is nothing to poll there.
    //
    // busy is read through a ref rather than a dependency so a mutation
    // starting or finishing does not tear down and recreate the interval; the
    // poll simply skips a tick while a git command is in flight, to avoid
    // racing it.
    const busyRef = useRef(false)
    busyRef.current = busy !== null
    useEffect(() => {
        if (!active) return
        let cancelled = false

        const tick = async () => {
            if (cancelled || busyRef.current || document.visibilityState !== 'visible') return
            try {
                const [st, prog] = await Promise.all([GitStatus(repoId), GitInProgress(repoId)])
                if (cancelled) return
                setStatus(st)
                setInProgress(prog ?? '')
            } catch {
                // A transient status read failure is not worth a banner — the
                // next tick retries. (git can briefly hold an index lock mid
                // external operation, which surfaces here as an error.)
            }
        }

        const interval = setInterval(tick, 3000)
        // An immediate refresh when the window regains focus, so coming back
        // from the editor updates the badge at once instead of waiting up to
        // one full interval.
        const onFocus = () => void tick()
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onFocus)

        return () => {
            cancelled = true
            clearInterval(interval)
            window.removeEventListener('focus', onFocus)
            document.removeEventListener('visibilitychange', onFocus)
        }
    }, [active, repoId])

    const copy = (text: string) => void navigator.clipboard.writeText(text)

    // Single click on a branch: jump the graph to that branch's tip commit and
    // select it, which is what clicking a branch is expected to do — checkout
    // stays on double click and the context menu. The tip is Branch.Hash, so no
    // extra git call is needed while the commit is in the loaded window.
    const selectBranch = useCallback(
        async (b: git.Branch) => {
            setSelectedBranch(b.name)
            setView('commits')
            setSelectedPath(null)

            const tip = commits.find((c) => c.hash === b.hash)
            if (tip) {
                setSelectedCommit(tip)
                setReveal({hash: tip.hash, token: ++revealSeq.current})
                return
            }

            // The tip is older than the LOG_PAGE commits currently graphed — the
            // normal case for a long-lived branch thousands of commits behind.
            // There is no row to scroll to, so load the commit itself and show
            // it in the detail pane instead of silently doing nothing.
            try {
                const [outside] = (await GitLog(repoId, new git.LogOptions({maxCount: 1, rev: b.name, withStats: false}))) ?? []
                if (!outside) return
                setSelectedCommit(outside)
                setNotice(
                    `El último commit de "${b.name}" (${outside.shortHash}) queda fuera de los ${LOG_PAGE} commits cargados en el grafo, así que no hay fila a la que saltar. Lo tenés a la derecha.`,
                )
            } catch (e) {
                setError(String(e))
            }
        },
        [commits, repoId],
    )

    // Right-click menu for a branch row. Local and remote branches get
    // different entries because they support genuinely different operations —
    // a remote branch has no upstream to set and cannot be renamed locally.
    function branchMenuItems(b: git.Branch): (DropdownItem | 'separator')[] {
        if (b.isRemote) {
            // "origin/feature/x" → local branch name "feature/x": strip only
            // the remote prefix (first path segment), keep any nested name.
            const localName = b.name.slice(b.name.indexOf('/') + 1)
            return [
                {
                    label: `Checkout ${b.name}`,
                    icon: 'check',
                    hint: 'Crea una rama local que la sigue',
                    onSelect: () => void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => { if (ok) void selectBranch(b) }),
                },
                {
                    label: `Crear rama local '${localName}'`,
                    icon: 'account_tree',
                    disabled: branches.some((x) => !x.isRemote && x.name === localName),
                    hint: branches.some((x) => !x.isRemote && x.name === localName) ? 'Ya existe una rama local con ese nombre' : undefined,
                    onSelect: () => run(`checkout -b ${localName}`, () => GitCreateBranch(repoId, localName, b.name, true)),
                },
                {
                    label: `Merge ${b.name} en ${current?.name ?? 'la actual'}`,
                    icon: 'merge',
                    onSelect: () => run(`merge ${b.name}`, () => GitMerge(repoId, b.name, false)),
                },
                {label: `Copiar '${b.name}'`, icon: 'content_copy', onSelect: () => copy(b.name)},
                'separator',
                {
                    label: `Borrar ${b.name}`,
                    icon: 'delete',
                    danger: true,
                    hint: 'Borra la rama en el servidor',
                    onSelect: () =>
                        setConfirm({
                            title: 'Borrar rama remota',
                            description: `Esto borra la rama "${b.name}" en el servidor, no solo tu copia local. Cualquiera que la estuviera usando la pierde. Si tenés una rama local con los mismos commits, esos commits siguen existiendo en tu máquina.`,
                            confirmLabel: 'Borrar del remoto',
                            label: 'push --delete',
                            run: () => GitDeleteRemoteBranch(repoId, b.name, new git.AuthConfig({})),
                        }),
                },
            ]
        }

        const remoteCandidates = branches.filter((x) => x.isRemote).map((x) => x.name)
        return [
            {
                label: `Checkout ${b.name}`,
                icon: 'check',
                disabled: b.isCurrent,
                hint: b.isCurrent ? 'Ya estás en esta rama' : undefined,
                onSelect: () => void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => { if (ok) void selectBranch(b) }),
            },
            {
                label: `Merge ${b.name} en ${current?.name ?? 'la rama actual'}`,
                icon: 'merge',
                disabled: b.isCurrent,
                onSelect: () => run(`merge ${b.name}`, () => GitMerge(repoId, b.name, false)),
            },
            'separator',
            {
                label: `Renombrar ${b.name}…`,
                icon: 'edit',
                onSelect: () =>
                    setPrompt({
                        title: `Renombrar la rama "${b.name}"`,
                        label: 'Nuevo nombre',
                        initial: b.name,
                        description: 'Renombrar solo afecta tu repositorio local. Si la rama ya está publicada, el nombre viejo sigue existiendo en el remoto hasta que lo borres.',
                        onSubmit: (v) => run(`branch -m ${v}`, () => GitRenameBranch(repoId, b.name, v)),
                    }),
            },
            {
                label: 'Set upstream…',
                icon: 'link',
                disabled: remoteCandidates.length === 0,
                hint: b.upstream ? `Ahora: ${b.upstream}` : 'Sin upstream',
                onSelect: () =>
                    setPrompt({
                        title: `Upstream de "${b.name}"`,
                        label: 'Rama remota',
                        initial: b.upstream || remoteCandidates[0] || '',
                        placeholder: 'origin/main',
                        description: `Vincular la rama hace que pull y push sepan a dónde ir, y que los contadores de adelante/atrás tengan sentido. Remotas disponibles: ${remoteCandidates.join(', ') || 'ninguna'}.`,
                        onSubmit: (v) => run('branch --set-upstream-to', () => GitSetUpstream(repoId, b.name, v)),
                    }),
            },
            {
                label: 'Unset upstream',
                icon: 'link_off',
                disabled: !b.upstream,
                hint: 'No borra nada, solo desvincula',
                onSelect: () => run('branch --unset-upstream', () => GitUnsetUpstream(repoId, b.name)),
            },
            {label: `Copiar '${b.name}'`, icon: 'content_copy', onSelect: () => copy(b.name)},
            'separator',
            {
                label: `Borrar ${b.name}`,
                icon: 'delete',
                danger: true,
                disabled: b.isCurrent,
                hint: b.isCurrent ? 'No podés borrar la rama en la que estás' : undefined,
                onSelect: () =>
                    setConfirm({
                        title: 'Borrar rama local',
                        description: `Esto borra la rama "${b.name}" de tu repositorio local. Si tiene commits que no están en ninguna otra rama, quedan accesibles solo por el reflog hasta que expire. La copia en el remoto (si la hay) no se toca.`,
                        confirmLabel: 'Borrar',
                        label: 'branch -D',
                        run: () => GitDeleteBranch(repoId, b.name, true),
                    }),
            },
        ]
    }

    // Right-click menu for a commit row.
    function commitMenuItems(c: git.CommitInfo): (DropdownItem | 'separator')[] {
        const short = c.shortHash
        return [
            {
                label: 'Reordenar y combinar desde acá…',
                icon: 'low_priority',
                // Rebases onto this commit, so THIS one is the base and
                // everything after it is what gets rewritten — which is what
                // "desde acá" has to mean for the action to be predictable.
                onSelect: () => setRebaseBase({hash: c.hash, label: short}),
            },
            'separator',
            {
                label: 'Crear rama acá…',
                icon: 'account_tree',
                onSelect: () =>
                    setPrompt({
                        title: `Crear rama en ${short}`,
                        label: 'Nombre de la rama',
                        placeholder: 'mi-rama',
                        confirmLabel: 'Crear y cambiar',
                        description: `La rama nueva arranca en "${c.subject}".`,
                        onSubmit: (v) => run(`checkout -b ${v}`, () => GitCreateBranch(repoId, v, c.hash, true)),
                    }),
            },
            {
                label: 'Crear tag acá…',
                icon: 'sell',
                onSelect: () =>
                    setPrompt({
                        title: `Crear tag en ${short}`,
                        label: 'Nombre del tag',
                        placeholder: 'v1.0.0',
                        secondLabel: 'Mensaje (opcional)',
                        secondPlaceholder: 'Con mensaje crea un tag anotado; sin mensaje, uno liviano.',
                        confirmLabel: 'Crear tag',
                        description: 'El tag se crea solo local. Para publicarlo, usá "Push" desde el menú del tag en el sidebar.',
                        onSubmit: (v, msg) => run(`tag ${v}`, () => GitCreateTag(repoId, v, c.hash, msg)),
                    }),
            },
            {label: 'Checkout este commit', icon: 'check', hint: 'Deja HEAD desacoplado', onSelect: () => run(`checkout ${short}`, () => GitCheckout(repoId, c.hash))},
            'separator',
            {
                label: `Revert ${short}`,
                icon: 'undo',
                hint: 'Crea un commit que lo deshace',
                onSelect: () => run(`revert ${short}`, () => GitRevert(repoId, c.hash, false)),
            },
            {
                label: `Cherry pick ${short}`,
                icon: 'content_paste',
                hint: 'Copia este commit a la rama actual',
                onSelect: () => run(`cherry-pick ${short}`, () => GitCherryPick(repoId, c.hash, false)),
            },
            {label: `Copiar '${c.hash}'`, icon: 'content_copy', onSelect: () => copy(c.hash)},
            ...(c.branches.length > 0
                ? ([
                      'separator',
                      {
                          label: `Ocultar ${c.branches.length === 1 ? `la rama ${c.branches[0]}` : `${c.branches.length} ramas`}`,
                          icon: 'visibility_off',
                          hint: 'Quita estas ramas del grafo (no las borra)',
                          onSelect: () => setHidden((prev) => new Set([...prev, ...c.branches])),
                      },
                  ] as (DropdownItem | 'separator')[])
                : []),
            'separator',
            // The three resets are listed separately, worst-last, because they
            // differ enormously in what they destroy — a single "Reset" entry
            // with a mode picker buries that distinction behind another click.
            {
                label: 'Reset --soft acá',
                icon: 'restart_alt',
                hint: 'Conserva todo staged',
                onSelect: () => run('reset --soft', () => GitReset(repoId, c.hash, 'soft')),
            },
            {
                label: 'Reset --mixed acá',
                icon: 'restart_alt',
                hint: 'Conserva los cambios sin stagear',
                onSelect: () => run('reset --mixed', () => GitReset(repoId, c.hash, 'mixed')),
            },
            {
                label: 'Reset --hard acá',
                icon: 'restart_alt',
                danger: true,
                hint: 'Destruye lo no commiteado',
                onSelect: () =>
                    setConfirm({
                        title: 'Reset --hard',
                        description: `Esto mueve "${current?.name ?? 'la rama actual'}" a ${short} y sobrescribe el índice Y el working tree. Todo cambio sin commitear se destruye sin quedar en el reflog: no hay forma de recuperarlo. Los commits que queden atrás solo van a ser accesibles por el reflog hasta que expire.`,
                        confirmLabel: 'Reset --hard',
                        label: 'reset --hard',
                        run: () => GitReset(repoId, c.hash, 'hard'),
                    }),
            },
        ]
    }

    // Selecting a commit loads its file list. The diff for a specific file is
    // a separate fetch, made only once a file is picked — a commit touching
    // hundreds of files must not pull hundreds of patches.
    useEffect(() => {
        if (!selectedCommit) {
            setChangedFiles([])
            return
        }
        let cancelled = false
        GitChangedFiles(repoId, selectedCommit.hash)
            .then((files) => {
                if (cancelled) return
                const list = files ?? []
                setChangedFiles(list)
                // Auto-select the first file so the diff appears on commit
                // click instead of leaving a blank "elegí un archivo" panel —
                // the first file is almost always the one being looked for.
                setSelectedPath(list.length > 0 ? list[0].path : null)
            })
            .catch((e) => !cancelled && setError(String(e)))
        return () => {
            cancelled = true
        }
    }, [repoId, selectedCommit])

    // Fetch the diff for whatever is selected — a file inside a commit, or a
    // working-tree/staged file when the changes view is active.
    useEffect(() => {
        if (!selectedPath) {
            setDiff(null)
            return
        }
        const base = {path: selectedPath, contextLines: diffContext, ignoreWhitespace: diffIgnoreWs}
        const target =
            view === 'commits' && selectedCommit
                ? new git.DiffTarget({mode: 'commit', commit: selectedCommit.hash, ...base})
                : new git.DiffTarget({mode: stagedPaths(status).includes(selectedPath) ? 'staged' : 'worktree', ...base})

        let cancelled = false
        setLoadingDiff(true)
        setDiffError(null)
        GitDiff(repoId, target)
            .then((d) => !cancelled && setDiff(d))
            .catch((e) => !cancelled && setDiffError(String(e)))
            .finally(() => !cancelled && setLoadingDiff(false))
        return () => {
            cancelled = true
        }
        // status is intentionally excluded here: this effect owns the
        // spinner-showing fetch on an explicit selection/pref change. The
        // status-driven refresh below keeps the changes view in sync silently.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repoId, selectedPath, view, selectedCommit, diffContext, diffIgnoreWs])

    // Keep the changes-view diff in sync with the working tree as it changes —
    // whether from a discard/rollback here or an external edit picked up by the
    // status poll.
    //
    // This is the fix for the stale-diff-after-rollback bug: when a file is
    // discarded, `status` updates (the file drops out of the list) but
    // selectedPath does not, so the spinner-fetch effect above never re-runs
    // and the pane keeps showing the now-gone patch. Here:
    //   - if the selected file no longer has changes, clear the selection so
    //     the pane shows the "sin cambios" placeholder instead of a stale diff;
    //   - otherwise silently refetch its diff (no spinner — this is a
    //     background refresh, not a new selection), so a live external edit to
    //     the open file appears. An identical patch string leaves DiffViewer's
    //     editor untouched (it keys on the patch text), so there is no flicker.
    useEffect(() => {
        if (view !== 'changes' || !selectedPath) return
        const entry = status?.files.find((f) => f.path === selectedPath)
        if (!entry) {
            setSelectedPath(null)
            return
        }
        let cancelled = false
        GitDiff(
            repoId,
            new git.DiffTarget({
                mode: entry.staged ? 'staged' : 'worktree',
                path: selectedPath,
                contextLines: diffContext,
                ignoreWhitespace: diffIgnoreWs,
            }),
        )
            .then((d) => !cancelled && setDiff(d))
            .catch(() => {
                // A transient diff read failure (e.g. index locked mid external
                // op) is not worth a banner; the next status tick retries.
            })
        return () => {
            cancelled = true
        }
    }, [status, view, selectedPath, repoId, diffContext, diffIgnoreWs])

    const persistDiffPrefs = useCallback((context: number, ignoreWs: boolean, wrap: boolean) => {
        setDiffContext(context)
        setDiffIgnoreWs(ignoreWs)
        setDiffWrap(wrap)
        void GitSetDiffPrefs(context, ignoreWs, wrap).catch(() => {})
    }, [])

    const current = branches.find((b) => b.isCurrent)
    const upstream = current?.upstream ?? ''

    const fetchItems: DropdownItem[] = [
        {label: 'fetch', hint: 'Trae los cambios del remoto', icon: 'cloud_download', onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({}), new git.AuthConfig({})))},
        {label: 'fetch --all', hint: 'De todos los remotos', onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({all: true}), new git.AuthConfig({})))},
        {label: 'fetch --tags', hint: 'Incluye los tags', onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({tags: true}), new git.AuthConfig({})))},
        {label: 'fetch --prune', hint: 'Borra ramas remotas ya eliminadas', onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({prune: true}), new git.AuthConfig({})))},
    ]

    const pullItems: DropdownItem[] = [
        {label: 'pull', hint: 'Trae e integra', icon: 'download', onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({}), new git.AuthConfig({})))},
        {label: 'pull --ff-only', hint: 'Falla en vez de crear un merge', onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({ffOnly: true}), new git.AuthConfig({})))},
        {label: 'pull --rebase', hint: 'Reaplica tus commits encima', onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({rebase: true}), new git.AuthConfig({})))},
        {label: 'pull --rebase --autostash', hint: 'Guarda y restaura cambios sin commitear', onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({rebase: true, autostash: true}), new git.AuthConfig({})))},
    ]

    const pushItems: (DropdownItem | 'separator')[] = [
        {
            label: 'push',
            hint: 'Publica tus commits',
            icon: 'upload',
            // The common failure the first time a branch is published: git
            // refuses a plain push with no upstream to compare against
            // instead of guessing a remote. Offer the fix inline via confirm
            // rather than making the user find "push --set-upstream" in this
            // same menu after reading the error banner.
            onSelect: () =>
                void run(
                    'push',
                    () => GitPush(repoId, new git.PushOptions({}), new git.AuthConfig({})),
                    (e) => {
                        if (!current?.name || !String(e).includes('no upstream branch')) return false
                        setConfirm({
                            title: 'Publicar y vincular la rama',
                            description: `"${current.name}" todavía no tiene upstream configurado, así que un push simple no sabe a dónde publicarla. ¿Publicarla en "origin" y vincularla (--set-upstream)?`,
                            confirmLabel: 'Publicar y vincular',
                            label: 'push --set-upstream',
                            danger: false,
                            run: () => GitPush(repoId, new git.PushOptions({setUpstream: true, remote: 'origin', branch: current.name}), new git.AuthConfig({})),
                        })
                        return true
                    },
                ),
        },
        {
            label: 'push --set-upstream',
            hint: 'Publica y vincula la rama',
            disabled: !!upstream,
            onSelect: () => run('push', () => GitPush(repoId, new git.PushOptions({setUpstream: true, remote: 'origin', branch: current?.name ?? ''}), new git.AuthConfig({}))),
        },
        {label: 'push --tags', hint: 'Incluye los tags', onSelect: () => run('push', () => GitPush(repoId, new git.PushOptions({tags: true}), new git.AuthConfig({})))},
        'separator',
        {
            label: 'push --force-with-lease',
            hint: 'Reescribe, pero aborta si alguien subió algo',
            danger: true,
            onSelect: () => run('push', () => GitPush(repoId, new git.PushOptions({forceWithLease: true}), new git.AuthConfig({}))),
        },
        {
            label: 'push --force',
            hint: 'Reescribe el remoto y descarta commits ajenos',
            danger: true,
            onSelect: () => run('push', () => GitPush(repoId, new git.PushOptions({force: true}), new git.AuthConfig({}))),
        },
        {label: 'push --no-verify', hint: 'Saltea los hooks de pre-push', danger: true, onSelect: () => run('push', () => GitPush(repoId, new git.PushOptions({noVerify: true}), new git.AuthConfig({})))},
    ]

    const staged = status?.files?.filter((f) => f.staged) ?? []
    const unstaged = status?.files?.filter((f) => !f.staged) ?? []

    // Case-insensitive substring — a branch filter is for finding "9595" or
    // "hotfix" in a list of a hundred, not for pattern matching.
    const branchQuery = branchFilter.trim().toLowerCase()
    const matchesFilter = (b: git.Branch) => !branchQuery || b.name.toLowerCase().includes(branchQuery)
    // Pinned branches float to the top of their section. Sorting rather than
    // a separate list keeps one place to look for a branch — a pinned
    // "develop" moving out of "Ramas" into a third section is exactly the
    // kind of thing that makes people scroll looking for it.
    const pinnedFirst = (list: git.Branch[]) =>
        [...list].sort((a, b) => Number(pinned.includes(b.name)) - Number(pinned.includes(a.name)))

    const localBranches = pinnedFirst(branches.filter((b) => !b.isRemote && matchesFilter(b)))
    const remoteBranches = pinnedFirst(branches.filter((b) => b.isRemote && matchesFilter(b)))

    return (
        // min-w-0 is load-bearing, not cosmetic: without it this root's
        // min-width defaults to its content (min-content), which includes the
        // fixed-width right diff pane that cannot shrink. The root then refuses
        // to shrink below ~1700px, overflows the tab's overflow-hidden wrapper,
        // and the diff pane is clipped off the right edge — the "no se ve el
        // diff" bug. Every level of a nested flex chain that must shrink needs
        // this; the layout row below carries it for the same reason.
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-surface">
            {/* Toolbar */}
            <div className="flex shrink-0 items-center gap-1 border-b border-outline-variant bg-surface-container-low px-2 py-1.5">
                <span className="flex items-center gap-1 pr-2 text-xs font-medium text-on-surface">
                    <Icon name="folder_open" size={16} className="opacity-70" />
                    {repoName}
                </span>
                <span className="flex items-center gap-1 rounded bg-primary-container px-2 py-0.5 text-[11px] text-on-primary-container" title={upstream ? `Rama actual, siguiendo a ${upstream}` : 'Rama actual — sin upstream configurado'}>
                    <Icon name="account_tree" size={13} />
                    {status?.detached ? 'HEAD desacoplado' : (current?.name ?? status?.branch ?? '—')}
                </span>
                {!!current && (current.ahead > 0 || current.behind > 0) && (
                    <span className="flex items-center gap-1 text-[11px] text-on-surface-variant" title={`${current.ahead} commits tuyos sin publicar, ${current.behind} commits del remoto sin traer`}>
                        {current.ahead > 0 && <span className="flex items-center"><Icon name="arrow_upward" size={12} />{current.ahead}</span>}
                        {current.behind > 0 && <span className="flex items-center"><Icon name="arrow_downward" size={12} />{current.behind}</span>}
                    </span>
                )}

                {hidden.size > 0 && (
                    <button
                        onClick={() => setHidden(new Set())}
                        title={`Volver a mostrar en el grafo: ${[...hidden].join(', ')}`}
                        className="ml-2 flex items-center gap-1 rounded bg-tertiary-container px-2 py-0.5 text-[11px] text-on-tertiary-container hover:opacity-90"
                    >
                        <Icon name="visibility_off" size={13} />
                        {hidden.size} oculta{hidden.size > 1 ? 's' : ''}
                    </button>
                )}

                <div className="ml-auto flex items-center gap-0.5">
                    <DropdownMenu label="Fetch" icon="cloud_download" title="Traer cambios del remoto sin integrarlos a tu rama" items={fetchItems} disabled={!!busy} />
                    <DropdownMenu label="Pull" icon="download" title="Traer los cambios del remoto e integrarlos a tu rama actual" items={pullItems} disabled={!!busy} />
                    <DropdownMenu label="Push" icon="upload" title="Publicar tus commits locales en el remoto" items={pushItems} disabled={!!busy} />
                    <button
                        onClick={() => void reload()}
                        disabled={!!busy}
                        title="Volver a leer el repositorio desde disco — útil si cambiaste algo por fuera de la app"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="refresh" size={16} />
                    </button>
                    <button
                        onClick={() => setShowSettings(true)}
                        title="Configurar el nombre y email con el que se firman tus commits, y los tokens de acceso para push y pull"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="settings" size={16} />
                    </button>
                </div>
            </div>

            {busy && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-primary-container px-3 py-1.5 text-[11px] font-medium text-on-primary-container">
                    <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-t-transparent border-on-primary-container" />
                    Ejecutando <span className="font-mono">git {busy}</span>…
                </div>
            )}
            {inProgress && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-error-container/50 px-3 py-1.5 text-[11px] text-on-error-container">
                    <Icon name="warning" size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1">
                        Hay un <span className="font-mono">{inProgress}</span> en curso, probablemente con conflictos. Resolvé los archivos en conflicto y commiteá, o abortá para volver al estado anterior.
                    </span>
                    <button
                        onClick={() => setView('conflicts')}
                        title="Abre el resolutor de conflictos: muestra las dos versiones lado a lado y permite elegir bloque por bloque, sin editar los marcadores a mano"
                        className="shrink-0 rounded bg-primary px-2 py-0.5 text-on-primary hover:opacity-90"
                    >
                        Resolver conflictos
                    </button>
                    {inProgress !== 'rebase' && (
                        <button
                            onClick={() => run(`${inProgress} --abort`, () => GitAbort(repoId, inProgress))}
                            disabled={!!busy}
                            title={`Cancelar el ${inProgress} y volver al estado que tenía el repositorio antes de empezarlo`}
                            className="shrink-0 rounded bg-error px-2 py-0.5 text-on-error hover:opacity-90 disabled:opacity-40"
                        >
                            Abortar
                        </button>
                    )}
                </div>
            )}
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-outline-variant bg-surface-container-lowest px-2 py-0.5 text-[11px]">
                {forge?.compareUrl && (
                    <button
                        onClick={() => void GitOpenInBrowser(forge.compareUrl)}
                        title={`Abre en el navegador la página de ${forge.provider} para crear el pull request de "${status?.branch}". No usa ningún token: se apoya en la sesión que ya tenés abierta.`}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-primary hover:bg-surface-variant"
                    >
                        <Icon name="call_merge" size={13} />
                        Crear pull request
                    </button>
                )}
                <button
                    onClick={() => setShowWorktrees((v) => !v)}
                    title="Worktrees: tener varias ramas revisadas a la vez, en carpetas distintas, sin stashear ni cambiar de contexto"
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${showWorktrees ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                >
                    <Icon name="dashboard" size={13} />
                    Worktrees
                </button>
                <button
                    onClick={() => setShowCommandLog((v) => !v)}
                    title="Muestra el comando git exacto que se ejecutó por debajo y su salida — para entender un fallo sin tener que reproducirlo en una terminal"
                    className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 ${showCommandLog ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                >
                    <Icon name="terminal" size={13} />
                    Comandos
                </button>
            </div>

            {showWorktrees && (
                <div className="shrink-0 border-b border-outline-variant bg-surface-container-low px-2 py-1 text-[11px]">
                    {worktrees.length === 0 ? (
                        <p className="text-on-surface-variant">Solo hay un checkout de este repositorio.</p>
                    ) : (
                        worktrees.map((w) => (
                            <div key={w.path} className="flex items-center gap-2 py-0.5">
                                <Icon name={w.isMain ? 'home' : 'dashboard'} size={12} className="shrink-0 text-on-surface-variant" />
                                <span className="shrink-0 font-mono text-on-surface">{w.branch || w.head.slice(0, 7)}</span>
                                <span className="min-w-0 flex-1 truncate text-on-surface-variant/70" title={w.path}>
                                    {w.path}
                                </span>
                                {w.prunable && (
                                    <span className="shrink-0 text-tertiary" title={w.reason || 'La carpeta ya no existe'}>
                                        carpeta ausente
                                    </span>
                                )}
                                {w.isMain ? (
                                    <span className="shrink-0 text-on-surface-variant/60">principal</span>
                                ) : (
                                    <button
                                        onClick={() => void run('worktree remove', () => GitRemoveWorktree(repoId, w.path, false))}
                                        title="Elimina este worktree. Si tiene cambios sin commitear, git se niega — es el comportamiento correcto."
                                        className="shrink-0 rounded px-1 text-error hover:bg-error-container"
                                    >
                                        Quitar
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            )}

            {error && <Banner kind="error" text={error} onClose={() => setError(null)} />}
            {notice && <Banner kind="info" text={notice} onClose={() => setNotice(null)} />}

            <div ref={layoutRef} className="flex min-h-0 min-w-0 flex-1">
                {/* Left: view switch + branches */}
                <div style={{width: sideWidth}} className="flex shrink-0 flex-col border-r border-outline-variant bg-surface-container-lowest">
                    <div className="flex shrink-0 gap-0.5 border-b border-outline-variant p-1">
                        <ViewTab active={view === 'commits'} onClick={() => setView('commits')} icon="history" label="Commits" title="Ver el historial de commits del repositorio" />
                        <ViewTab
                            active={view === 'changes'}
                            onClick={() => setView('changes')}
                            icon="edit_note"
                            label="Cambios"
                            // Live count, updated by the status poll — this is
                            // what makes uncommitted changes made outside the app
                            // visible without leaving the Commits view.
                            badge={status?.files.length ?? 0}
                            title="Ver los archivos modificados en el working tree y armar un commit"
                        />
                        <ViewTab
                            active={view === 'stash'}
                            onClick={() => setView('stash')}
                            icon="inventory_2"
                            label="Stash"
                            badge={stashes.length}
                            title="Ver los cambios apartados en stashes, con su contenido, antes de aplicarlos"
                        />
                    </div>
                    {/* Commit search. Distinct from the branch filter below:
                        this one goes to git and narrows the HISTORY, that one
                        narrows the branch list on screen. Keeping them apart
                        matters — confusing the two means concluding a commit
                        does not exist when it simply is not on this page. */}
                    <div className="shrink-0 border-b border-outline-variant p-1">
                        <div className="flex items-center gap-1 rounded bg-surface-container px-1.5 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <Icon name="manage_search" size={13} className="shrink-0 text-on-surface-variant/60" />
                            <input
                                value={searchText}
                                onChange={(e) => setSearchText(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') setSearch(parseGitSearch(searchText))
                                    if (e.key === 'Escape') {
                                        setSearchText('')
                                        setSearch(EMPTY_SEARCH)
                                    }
                                }}
                                onBlur={() => setSearch(parseGitSearch(searchText))}
                                placeholder="Buscar commits: autor: mensaje: archivo:…"
                                title={`Busca en TODO el historial, no solo en lo cargado — el filtro lo aplica git.\n\n${GIT_SEARCH_HELP}`}
                                className="min-w-0 flex-1 bg-transparent text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/50"
                            />
                            <button
                                onClick={() => setShowSearchHelp((v) => !v)}
                                title="Ver los prefijos de búsqueda disponibles"
                                className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface"
                            >
                                <Icon name="help" size={13} />
                            </button>
                            {searchText && (
                                <button
                                    onClick={() => {
                                        setSearchText('')
                                        setSearch(EMPTY_SEARCH)
                                    }}
                                    title="Limpiar la búsqueda"
                                    className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface"
                                >
                                    <Icon name="close" size={13} />
                                </button>
                            )}
                        </div>

                        {showSearchHelp && (
                            <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-container px-1.5 py-1 text-[10px] leading-relaxed text-on-surface-variant">
                                {GIT_SEARCH_HELP}
                            </pre>
                        )}

                        {/* The active filter, spelled out. A search that
                            silently narrows history is how people conclude a
                            commit disappeared. */}
                        {!isEmptySearch(search) && (
                            <p className="mt-1 px-0.5 text-[10px] text-tertiary">Filtrado por {describeSearch(search)}</p>
                        )}

                        <label
                            className="mt-1 flex items-center gap-1 px-0.5 text-[10px] text-on-surface-variant"
                            title="Muestra solo la rama actual, los troncos (main/master/develop) y las ramas que ancles. En un repo con cientos de ramas remotas es la diferencia entre un grafo legible y una pared de carriles."
                        >
                            <input type="checkbox" checked={focusMode} onChange={(e) => setFocusMode(e.target.checked)} className="accent-primary" />
                            Solo mi trabajo
                        </label>
                    </div>

                    {/* A repository with a hundred remote branches (the normal
                        case on a shared repo) makes the list unusable without a
                        filter — and finding a branch is now the entry point to
                        jumping around the graph, not just to checkout. */}
                    <div className="shrink-0 border-b border-outline-variant p-1">
                        <div className="flex items-center gap-1 rounded bg-surface-container px-1.5 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <Icon name="search" size={13} className="shrink-0 text-on-surface-variant/60" />
                            <input
                                value={branchFilter}
                                onChange={(e) => setBranchFilter(e.target.value)}
                                placeholder="Filtrar ramas…"
                                title="Filtra por nombre, en las ramas locales y remotas a la vez"
                                className="min-w-0 flex-1 bg-transparent text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/50"
                            />
                            {branchFilter && (
                                <button onClick={() => setBranchFilter('')} title="Limpiar el filtro" className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface">
                                    <Icon name="close" size={13} />
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-1">
                        <SectionLabel count={localBranches.length}>Ramas</SectionLabel>
                        {localBranches.map((b) => (
                            <BranchRow
                                isPinned={pinned.includes(b.name)}
                                onTogglePin={() => void togglePinned(b.name)}
                                key={b.name}
                                branch={b}
                                selected={selectedBranch === b.name}
                                disabled={!!busy}
                                onSelect={() => void selectBranch(b)}
                                onCheckout={() => void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => { if (ok) void selectBranch(b) })}
                                onContextMenu={(e) => setMenu({x: e.clientX, y: e.clientY, items: branchMenuItems(b)})}
                            />
                        ))}
                        <SectionLabel count={remoteBranches.length}>Remotas</SectionLabel>
                        {remoteBranches.map((b) => (
                            <BranchRow
                                isPinned={pinned.includes(b.name)}
                                onTogglePin={() => void togglePinned(b.name)}
                                key={b.name}
                                branch={b}
                                selected={selectedBranch === b.name}
                                disabled={!!busy}
                                onSelect={() => void selectBranch(b)}
                                onCheckout={() => void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => { if (ok) void selectBranch(b) })}
                                onContextMenu={(e) => setMenu({x: e.clientX, y: e.clientY, items: branchMenuItems(b)})}
                            />
                        ))}
                        {branchFilter && localBranches.length === 0 && remoteBranches.length === 0 && (
                            <p className="px-2 py-3 text-[11px] text-on-surface-variant/70">Ninguna rama coincide con «{branchFilter}».</p>
                        )}
                    </div>
                </div>

                <PaneHandle onStart={() => setDragging('side')} title="Arrastrá para cambiar el ancho del panel de ramas — el tamaño se guarda" />

                {/* Center: graph or working-tree changes */}
                <div className="flex min-w-0 flex-1 flex-col">
                    {view === 'conflicts' ? (
                        <GitConflictResolver
                            repoId={repoId}
                            operation={inProgress || 'merge'}
                            busy={!!busy}
                            onContinue={() => void run(`${inProgress} --continue`, () => GitContinue(repoId, inProgress))}
                            onAbort={() => void run(`${inProgress} --abort`, () => GitAbort(repoId, inProgress))}
                            onResolved={() => void reload()}
                            onClose={() => setView('commits')}
                        />
                    ) : view === 'stash' ? (
                        <GitStashPanel
                            repoId={repoId}
                            stashes={stashes}
                            busy={!!busy}
                            onApply={(ref, drop) => void run(drop ? 'stash pop' : 'stash apply', () => GitStashApply(repoId, ref, drop))}
                            onDrop={(ref) => void run('stash drop', () => GitStashDrop(repoId, ref))}
                            onPush={() => void run('stash push', () => GitStashPush(repoId, '', true))}
                            onClose={() => setView('commits')}
                        />
                    ) : view === 'commits' ? (
                        <CommitGraph
                            commits={commits}
                            selectedHash={selectedCommit?.hash ?? null}
                            onSelect={(c) => {
                                setSelectedCommit(c)
                                setSelectedPath(null)
                                // Picking a commit by hand invalidates the
                                // sidebar highlight — the graph is no longer
                                // sitting on that branch's tip.
                                setSelectedBranch(null)
                            }}
                            reveal={reveal}
                            onContextMenu={(c, e) => {
                                e.preventDefault()
                                setMenu({x: e.clientX, y: e.clientY, items: commitMenuItems(c)})
                            }}
                            loading={loadingLog}
                        />
                    ) : (
                        <ChangesPanel
                            staged={staged}
                            unstaged={unstaged}
                            selectedPath={selectedPath}
                            busy={!!busy}
                            commitMessage={commitMessage}
                            branchName={status?.branch ?? ''}
                            onSelectPath={setSelectedPath}
                            onStage={(paths) => run('add', () => GitStage(repoId, paths))}
                            onStageAll={() => run('add --all', () => GitStageAll(repoId))}
                            onUnstage={(paths) => run('restore --staged', () => GitUnstage(repoId, paths))}
                            onDiscard={(paths) => setConfirmDiscard(paths)}
                            onChangeMessage={setCommitMessage}
                            onCommit={() =>
                                run('commit', async () => {
                                    await GitCommit(repoId, commitMessage, false)
                                    setCommitMessage('')
                                })
                            }
                        />
                    )}
                </div>

                <PaneHandle onStart={() => setDragging('diff')} title="Arrastrá para cambiar el ancho del panel de diff — el tamaño se guarda" />

                {/* Right: commit detail + file list + diff */}
                <div style={{width: diffWidth}} className="flex shrink-0 flex-col">
                    {view === 'commits' && selectedCommit && <CommitDetail commit={selectedCommit} files={changedFiles} selectedPath={selectedPath} onSelectPath={setSelectedPath} />}
                    <div className="min-h-0 flex-1 overflow-hidden border-t border-outline-variant">
                        {selectedPath ? (
                            <DiffViewer
                                patch={diff?.patch ?? ''}
                                isBinary={diff?.isBinary ?? false}
                                path={selectedPath}
                                loading={loadingDiff}
                                error={diffError}
                                editorThemeId={editorThemeId}
                                appTheme={appTheme}
                                context={diffContext}
                                ignoreWs={diffIgnoreWs}
                                wrap={diffWrap}
                                onChangePrefs={persistDiffPrefs}
                                // Only the working-tree/index views can be
                                // staged from. A commit's diff is history:
                                // there is nothing to prepare.
                                staged={view === 'changes' && stagedPaths(status).includes(selectedPath)}
                                blame={blame ?? undefined}
                                // A commit's diff is blamed AT that commit, so
                                // its added lines belong to it and map to the
                                // new side. A working-tree diff is blamed at
                                // HEAD, where the added lines do not exist yet.
                                blameSide={view === 'commits' ? 'new' : 'old'}
                                onToggleBlame={() => {
                                    if (blame) {
                                        setBlame(null)
                                        return
                                    }
                                    if (!selectedPath) return
                                    GitBlame(repoId, selectedPath, view === 'commits' ? (selectedCommit?.hash ?? '') : '')
                                        .then((b) => setBlame(b ?? []))
                                        .catch((e) => setError(String(e)))
                                }}
                                onApplyPatch={
                                    view === 'changes'
                                        ? (patch, action) => {
                                              if (action === 'discard') {
                                                  setConfirmDiscardPatch(patch)
                                                  return
                                              }
                                              // stage = apply to the index;
                                              // unstage = the same patch,
                                              // applied to the index in reverse.
                                              void run(action === 'stage' ? 'apply --cached' : 'apply --cached --reverse', () =>
                                                  GitApplyPatch(repoId, patch, true, action === 'unstage'),
                                              )
                                          }
                                        : undefined
                                }
                            />
                        ) : (
                            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                                <Icon name="difference" size={28} className="text-on-surface-variant/40" />
                                <p className="text-xs text-on-surface-variant/70">
                                    {view === 'commits' ? 'Elegí un commit y después un archivo para ver el diff.' : 'Elegí un archivo modificado para ver el diff.'}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {showSettings && (
                <GitSettingsDialog repoId={repoId} repoName={repoName} onClose={() => setShowSettings(false)} onChanged={() => void reload()} />
            )}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} width={280} />}
            {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} />}
            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    description={confirm.description}
                    confirmLabel={confirm.confirmLabel}
                    danger={confirm.danger ?? true}
                    onConfirm={() => run(confirm.label, confirm.run)}
                    onClose={() => setConfirm(null)}
                />
            )}

            {showCommandLog && <GitCommandLogDrawer reloadToken={logToken} onClose={() => setShowCommandLog(false)} />}

            {rebaseBase && (
                <GitRebaseDialog
                    repoId={repoId}
                    base={rebaseBase.hash}
                    baseLabel={rebaseBase.label}
                    onClose={() => setRebaseBase(null)}
                    onDone={() => void reload()}
                />
            )}

            {confirmDiscardPatch && (
                <ConfirmDialog
                    title="Descartar este bloque"
                    description="Esto revierte solo el bloque seleccionado en el working tree y lo devuelve al estado del último commit. A diferencia de un commit o un stash, NO queda en el reflog: no hay forma de recuperarlo después."
                    confirmLabel="Descartar bloque"
                    danger
                    onConfirm={() =>
                        run('apply --reverse', () => GitApplyPatch(repoId, confirmDiscardPatch, false, true))
                    }
                    onClose={() => setConfirmDiscardPatch(null)}
                />
            )}

            {confirmDiscard && (
                <ConfirmDialog
                    title="Descartar cambios"
                    description={`Esto descarta los cambios sin commitear de ${confirmDiscard.length === 1 ? `"${confirmDiscard[0]}"` : `${confirmDiscard.length} archivos`} y los vuelve al último commit. A diferencia de un commit o un stash, esto NO queda en el reflog: no hay forma de recuperarlo después.`}
                    confirmLabel="Descartar"
                    danger
                    onConfirm={() => run('restore', () => GitDiscard(repoId, confirmDiscard))}
                    onClose={() => setConfirmDiscard(null)}
                />
            )}
        </div>
    )
}

// Same bounds the backend clamps to (vault.MinGitPaneWidth/MaxGitPaneWidth).
// Enforced here too so the pane stops at the limit while dragging rather than
// snapping back only after release.
const MIN_PANE = 160
const MAX_PANE = 1200
function clampPane(w: number): number {
    return Math.max(MIN_PANE, Math.min(MAX_PANE, Math.round(w)))
}

// A 4px grab strip with a wider invisible hit area — a splitter exactly as
// wide as its visible line is genuinely hard to grab.
function PaneHandle({onStart, title}: {onStart: () => void; title: string}) {
    return (
        <div
            onMouseDown={(e) => {
                e.preventDefault()
                onStart()
            }}
            title={title}
            role="separator"
            aria-orientation="vertical"
            className="group relative w-1 shrink-0 cursor-col-resize bg-outline-variant/60 hover:bg-primary"
        >
            <div className="absolute -left-1 top-0 h-full w-3" />
        </div>
    )
}

function stagedPaths(status: git.RepoStatus | null): string[] {
    return status?.files?.filter((f) => f.staged).map((f) => f.path) ?? []
}

function Banner({kind, text, onClose}: {kind: 'error' | 'info'; text: string; onClose: () => void}) {
    return (
        <div
            className={`flex shrink-0 items-start gap-2 border-b border-outline-variant px-3 py-1.5 text-[11px] ${
                kind === 'error' ? 'bg-error-container/50 text-on-error-container' : 'bg-surface-container text-on-surface-variant'
            }`}
        >
            <Icon name={kind === 'error' ? 'error' : 'info'} size={14} className="mt-px shrink-0" />
            {/* Errors from git are multi-line and the useful part is often the
                last line — wrapped and shown whole rather than truncated. */}
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono">{text}</pre>
            <button onClick={onClose} title="Cerrar este mensaje" className="shrink-0 rounded p-0.5 hover:bg-surface-variant/50">
                <Icon name="close" size={14} />
            </button>
        </div>
    )
}

function ViewTab({active, onClick, icon, label, title, badge}: {active: boolean; onClick: () => void; icon: string; label: string; title: string; badge?: number}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] ${
                active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
            }`}
        >
            <Icon name={icon} size={14} />
            {label}
            {/* secondary is the commit/success role — a live count of pending
                changes reads as "there is work here", not as an error. */}
            {badge != null && badge > 0 && (
                <span className="rounded-full bg-secondary px-1.5 text-[10px] font-medium leading-4 text-on-secondary">{badge}</span>
            )}
        </button>
    )
}

function SectionLabel({children, count}: {children: React.ReactNode; count?: number}) {
    return (
        <p className="flex items-baseline gap-1.5 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">
            {children}
            {count != null && <span className="font-mono text-[9px] font-normal tabular-nums opacity-70">{count}</span>}
        </p>
    )
}

function BranchRow({
    branch,
    selected,
    disabled,
    onSelect,
    onCheckout,
    onContextMenu,
    isPinned,
    onTogglePin,
}: {
    branch: git.Branch
    selected: boolean
    disabled: boolean
    onSelect: () => void
    onCheckout: () => void
    onContextMenu: (e: React.MouseEvent) => void
    // Pinning keeps a branch at the top of its section and includes it in
    // Focus Mode. Optional so the row still renders in contexts that do not
    // offer pinning.
    isPinned?: boolean
    onTogglePin?: () => void
}) {
    return (
        <button
            onClick={onSelect}
            onDoubleClick={onCheckout}
            onContextMenu={(e) => {
                e.preventDefault()
                onContextMenu(e)
            }}
            disabled={disabled}
            title={`Click para ir al último commit de "${branch.name}". ${
                branch.isCurrent
                    ? 'Ya es la rama actual'
                    : `Doble click para hacer checkout${branch.isRemote ? ' (crea una rama local que la sigue)' : ''}`
            }. Click derecho para más acciones`}
            className={`group relative flex w-full items-center gap-1.5 rounded px-2 py-1 pl-2.5 text-left text-[11px] transition-colors disabled:opacity-40 ${
                // Three states that must stay distinguishable at a glance:
                // checked out (primary), pointed at by the graph (a secondary
                // tint + accent bar, quiet enough for a long list), and plain.
                // isCurrent wins the background so checking out a branch you
                // had just clicked (the common double-click path — the click
                // half fires first and sets `selected`) still visibly flips to
                // "you are here" instead of staying stuck on the selection
                // tint; the accent bar below still marks `selected` on its own.
                branch.isCurrent ? 'bg-primary-container/60 text-on-primary-container' : selected ? 'bg-secondary-container/25 text-on-surface' : 'text-on-surface hover:bg-surface-variant'
            }`}
        >
            {selected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-secondary" />}
            <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                    e.stopPropagation()
                    onTogglePin?.()
                }}
                title={
                    isPinned
                        ? `Desanclar "${branch.name}" — dejará de quedar arriba de la lista`
                        : `Anclar "${branch.name}" para que quede siempre arriba de la lista, y se incluya en "Solo mi trabajo"`
                }
                className={`shrink-0 ${isPinned ? 'text-tertiary' : 'text-on-surface-variant/30 opacity-0 group-hover:opacity-100'}`}
            >
                <Icon name="star" size={12} filled={isPinned} />
            </span>
            <Icon name={branch.isRemote ? 'cloud' : 'account_tree'} size={13} className="shrink-0 opacity-70" />
            <span className="truncate">{branch.name}</span>
            {/* The checked-out branch keeps a marker of its own even when
                another branch is the one selected in the graph — otherwise
                clicking around the sidebar loses track of where HEAD is. */}
            {branch.isCurrent && <Icon name="check" size={12} className="ml-auto shrink-0 opacity-80" />}
            {(branch.ahead > 0 || branch.behind > 0) && (
                <span className={`shrink-0 font-mono text-[9px] opacity-70 ${branch.isCurrent ? '' : 'ml-auto'}`}>
                    {branch.ahead > 0 && `↑${branch.ahead}`}
                    {branch.behind > 0 && `↓${branch.behind}`}
                </span>
            )}
        </button>
    )
}

function CommitDetail({commit, files, selectedPath, onSelectPath}: {commit: git.CommitInfo; files: git.FileDiff[]; selectedPath: string | null; onSelectPath: (p: string) => void}) {
    return (
        <div className="flex max-h-[55%] shrink-0 flex-col">
            <div className="shrink-0 space-y-1 border-b border-outline-variant bg-surface-container-lowest px-3 py-2">
                <p className="text-xs font-medium text-on-surface">{commit.subject}</p>
                {commit.body && <pre className="whitespace-pre-wrap break-words text-[11px] text-on-surface-variant">{commit.body}</pre>}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 text-[10px] text-on-surface-variant">
                    <dt className="text-on-surface-variant/60">Autor</dt>
                    <dd className="truncate">{commit.author} &lt;{commit.email}&gt;</dd>
                    <dt className="text-on-surface-variant/60">Fecha</dt>
                    <dd>{commit.date}</dd>
                    <dt className="text-on-surface-variant/60">Hash</dt>
                    <dd className="truncate font-mono">{commit.hash}</dd>
                    {(commit.parents?.length ?? 0) > 0 && (
                        <>
                            <dt className="text-on-surface-variant/60">{commit.parents.length > 1 ? 'Padres' : 'Padre'}</dt>
                            <dd className="truncate font-mono">{commit.parents.join(' ')}</dd>
                        </>
                    )}
                </dl>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {files.map((f) => (
                    <button
                        key={f.path}
                        onClick={() => onSelectPath(f.path)}
                        title={`Ver el diff de ${f.path}`}
                        className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] ${
                            selectedPath === f.path ? 'bg-primary-container/50 text-on-primary-container' : 'text-on-surface hover:bg-surface-variant/50'
                        }`}
                    >
                        <span className="min-w-0 flex-1 truncate font-mono">{f.origPath ? `${f.origPath} → ${f.path}` : f.path}</span>
                        {f.isBinary ? (
                            <span className="shrink-0 text-[9px] text-on-surface-variant/60">binario</span>
                        ) : (
                            <span className="shrink-0 font-mono text-[9px]">
                                <span className="text-secondary">+{f.stat.insertions}</span> <span className="text-error">−{f.stat.deletions}</span>
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    )
}

function ChangesPanel({
    staged,
    unstaged,
    selectedPath,
    busy,
    commitMessage,
    branchName,
    onSelectPath,
    onStage,
    onStageAll,
    onUnstage,
    onDiscard,
    onChangeMessage,
    onCommit,
}: {
    staged: git.FileStatus[]
    unstaged: git.FileStatus[]
    selectedPath: string | null
    busy: boolean
    commitMessage: string
    // The checked-out branch, used only to read the ticket id out of its
    // name for the commit helper.
    branchName: string
    onSelectPath: (p: string) => void
    onStage: (paths: string[]) => void
    onStageAll: () => void
    onUnstage: (paths: string[]) => void
    onDiscard: (paths: string[]) => void
    onChangeMessage: (m: string) => void
    onCommit: () => void
}) {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
                <FileGroup
                    title="Staged"
                    files={staged}
                    selectedPath={selectedPath}
                    onSelectPath={onSelectPath}
                    action={{icon: 'remove', title: 'Quitar del stage (el archivo no se toca)', onClick: (p) => onUnstage([p])}}
                    empty="Nada en el stage todavía."
                />
                <FileGroup
                    title="Sin stagear"
                    files={unstaged}
                    selectedPath={selectedPath}
                    onSelectPath={onSelectPath}
                    action={{icon: 'add', title: 'Agregar al stage', onClick: (p) => onStage([p])}}
                    secondaryAction={{icon: 'undo', title: 'Descartar los cambios de este archivo — no se puede deshacer', danger: true, onClick: (p) => onDiscard([p])}}
                    empty="Sin cambios en el working tree."
                />
            </div>

            <div className="shrink-0 space-y-1.5 border-t border-outline-variant bg-surface-container-lowest p-2">
                <button
                    onClick={onStageAll}
                    disabled={busy || unstaged.length === 0}
                    title={unstaged.length === 0 ? 'No hay cambios sin stagear' : `Agregar los ${unstaged.length} archivos modificados al stage`}
                    className="w-full rounded bg-surface-variant px-2 py-1 text-[11px] text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-40"
                >
                    Stagear todo
                </button>

                {/* Commit helper. The ticket half is what actually saves
                    typing: the branch already states which ticket the work
                    belongs to, and re-typing it into every message is both
                    tedious and the thing people forget — which is exactly
                    when the traceability the convention exists for breaks. */}
                <div className="flex items-center gap-1">
                    <select
                        value={currentPrefixOf(commitMessage).type}
                        onChange={(e) => {
                            const type = e.target.value
                            const scope = currentPrefixOf(commitMessage).scope || extractTicket(branchName)
                            onChangeMessage(type ? applyPrefix(commitMessage, buildCommitPrefix(type, scope)) : commitMessage)
                        }}
                        title="Prefijo de Conventional Commits. Cambiarlo reemplaza el que ya tenga el mensaje, no apila uno nuevo."
                        className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container px-1 py-0.5 text-[11px] text-on-surface"
                    >
                        <option value="">tipo…</option>
                        {COMMIT_TYPES.map((t) => (
                            <option key={t.value} value={t.value} title={t.hint}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                    {!!extractTicket(branchName) && (
                        <button
                            onClick={() => {
                                const {type} = currentPrefixOf(commitMessage)
                                onChangeMessage(applyPrefix(commitMessage, buildCommitPrefix(type || 'feat', extractTicket(branchName))))
                            }}
                            title={`Usa "${extractTicket(branchName)}" como scope, leído del nombre de la rama (${branchName})`}
                            className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant hover:text-on-surface"
                        >
                            {extractTicket(branchName)}
                        </button>
                    )}
                </div>

                <textarea
                    value={commitMessage}
                    onChange={(e) => onChangeMessage(e.target.value)}
                    placeholder="Mensaje del commit…"
                    rows={3}
                    title="Mensaje del commit — la primera línea es el resumen, dejá una línea en blanco antes del cuerpo"
                    className="w-full resize-none rounded border-none bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
                />
                <button
                    onClick={onCommit}
                    disabled={busy || staged.length === 0 || !commitMessage.trim()}
                    title={
                        staged.length === 0
                            ? 'Agregá al menos un archivo al stage antes de commitear'
                            : !commitMessage.trim()
                              ? 'Escribí un mensaje para el commit'
                              : `Commitear los ${staged.length} archivos en el stage`
                    }
                    className="w-full rounded bg-secondary px-2 py-1.5 text-xs font-medium text-on-secondary hover:opacity-90 disabled:opacity-40"
                >
                    Commit{staged.length > 0 ? ` (${staged.length})` : ''}
                </button>
            </div>
        </div>
    )
}

function FileGroup({
    title,
    files,
    selectedPath,
    onSelectPath,
    action,
    secondaryAction,
    empty,
}: {
    title: string
    files: git.FileStatus[]
    selectedPath: string | null
    onSelectPath: (p: string) => void
    action: {icon: string; title: string; onClick: (path: string) => void}
    secondaryAction?: {icon: string; title: string; danger?: boolean; onClick: (path: string) => void}
    empty: string
}) {
    return (
        <div>
            <p className="sticky top-0 bg-surface-container-low px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/70">
                {title} {files.length > 0 && `(${files.length})`}
            </p>
            {files.length === 0 && <p className="px-3 py-1.5 text-[11px] text-on-surface-variant/50">{empty}</p>}
            {files.map((f) => (
                <div
                    key={f.path}
                    className={`group flex items-center gap-1.5 px-3 py-1 text-[11px] ${
                        selectedPath === f.path ? 'bg-primary-container/50' : 'hover:bg-surface-variant/50'
                    }`}
                >
                    <StatusChip file={f} />
                    <button onClick={() => onSelectPath(f.path)} title={`Ver el diff de ${f.path}`} className="min-w-0 flex-1 truncate text-left font-mono text-on-surface">
                        {f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                    </button>
                    {secondaryAction && (
                        <button
                            onClick={() => secondaryAction.onClick(f.path)}
                            title={secondaryAction.title}
                            className={`shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 ${secondaryAction.danger ? 'text-error hover:bg-error-container/40' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name={secondaryAction.icon} size={13} />
                        </button>
                    )}
                    <button onClick={() => action.onClick(f.path)} title={action.title} className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-variant group-hover:opacity-100">
                        <Icon name={action.icon} size={13} />
                    </button>
                </div>
            ))}
        </div>
    )
}

// StatusChip renders git's porcelain code with a color carrying its meaning.
// The untracked case is called out separately because "?" is the one a new
// user most often misreads as an error.
function StatusChip({file}: {file: git.FileStatus}) {
    const code = file.untracked ? '?' : file.staged ? file.indexStatus : file.workStatus
    const meaning: Record<string, {label: string; cls: string}> = {
        M: {label: 'Modificado', cls: 'text-tertiary'},
        A: {label: 'Agregado', cls: 'text-secondary'},
        D: {label: 'Borrado', cls: 'text-error'},
        R: {label: 'Renombrado', cls: 'text-primary'},
        C: {label: 'Copiado', cls: 'text-primary'},
        '?': {label: 'Sin trackear — git todavía no lo conoce', cls: 'text-on-surface-variant/60'},
    }
    const m = meaning[code] ?? {label: code, cls: 'text-on-surface-variant'}
    return (
        <span title={m.label} className={`w-3 shrink-0 text-center font-mono ${m.cls}`}>
            {code}
        </span>
    )
}

// searchToLogOptions maps the parsed search onto git log flags. Everything
// here is applied by git, which is what makes the search cover the whole
// history instead of the page on screen.
function searchToLogOptions(s: GitSearch) {
    return {
        author: s.author,
        grep: s.grep,
        path: s.path,
        since: s.since,
        until: s.until,
        // A hash narrows the walk to that commit's ancestry, which is what
        // "show me from here back" means — and it has to override --all, so
        // it is returned as `rev` and the caller drops `all` when set.
        rev: s.rev,
    }
}

// focusRefsOf is the ref set Focus Mode walks: the current branch, the
// trunks that actually exist in this repository, and whatever the user
// pinned. Pinned branches are included because pinning already says "this
// one matters to me" — having to un-focus to see it would make the two
// features fight each other.
function focusRefsOf(branches: git.Branch[], pinned: string[]): string[] {
    const TRUNKS = ['main', 'master', 'develop', 'development']
    const names = new Set(branches.map((b) => b.name))
    const refs = new Set<string>()

    const current = branches.find((b) => b.isCurrent)
    if (current) refs.add(current.name)
    for (const t of TRUNKS) {
        if (names.has(t)) refs.add(t)
    }
    for (const p of pinned) {
        if (names.has(p)) refs.add(p)
    }

    // Never return an empty set: git would then walk HEAD only, which on a
    // detached HEAD is a single commit and looks like the graph broke.
    return refs.size > 0 ? [...refs] : []
}
