import {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {onAgentChatsChanged} from '../../lib/appBus'
import type {EditorAppearance} from '../../codemirror/editorAppearance'
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
    GitDeleteRemoteTag,
    GitDeleteTag,
    GitPushTag,
    GitTags,
    GitRenameBranch,
    GitInProgress,
    GitMerge,
    GitRebase,
    GitFlowInit,
    GitFlowStart,
    GitFlowStatus,
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
    GitSubmodules,
    GitAddSubmodule,
    GitUpdateSubmodules,
    GitUpdateSubmodule,
    GitSyncSubmodules,
    GitRemoveSubmodule,
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
    GitReviewContext,
    GitStatus,
    GitRepoWorkspace,
    GitSetOpenFiles,
    GitSetDefaultAgent,
    AgentChatSupported,
    AgentCLIConversations,
    AgentDraftCommit,
    CreateAgentChat,
    GitAgentContext,
    ListAgentChats,
    RenameAgentChat,
    DeleteAgentChat,
    ResumeAgentChat,
    TouchAgentChat,
    WriteLocalTerminal,
    GitUnstage,
} from '../../../wailsjs/go/main/App'
import {GetSettings, ListAgents, SetGitLayout, SetGitPanelSessions} from '../../../wailsjs/go/main/App'
import {ExternalEditors, OpenRepoInEditor, OpenRepoInFileManager} from '../../../wailsjs/go/main/App'
import {osopen} from '../../../wailsjs/go/models'
import {agentchat, agents as agentsModel, git, main, vault} from '../../../wailsjs/go/models'
import type {Theme} from '../../hooks/useTheme'
import type {TerminalThemeId} from '../../xterm/terminalThemes'
import InlineDiff, {type InlineDiffState} from './InlineDiff'
import {applyPrefix, buildCommitPrefix, currentPrefixOf} from '../../lib/gitCommitMessage'
import {isModelServerAgent} from '../../lib/modelServers'
import {buildReviewBlocks} from '../../lib/gitReview'
import {EMPTY_SEARCH, parseGitSearch, type GitSearch} from '../../lib/gitSearch'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import CommitGraph from './CommitGraph'
import ContextMenu from './ContextMenu'
import DiffViewer from './DiffViewer'
import AgentChatHistory, {type ChatHistoryEntry} from '../agent/AgentChatHistory'
import DropdownMenu, {type DropdownHeader, type DropdownItem} from './DropdownMenu'
import GitSettingsDialog from './GitSettingsDialog'
import GitConflictResolver from './GitConflictResolver'
import GitCommandLogDrawer from './GitCommandLog'
import GitReflogPanel from './GitReflogPanel'
import GitRebaseDialog from './GitRebaseDialog'
import StashPanel from './StashPanel'
import StashPreview from './StashPreview'
import ChangesPanel from './ChangesPanel'
import HistoryPanel from './HistoryPanel'
import GitWorkPanel from './GitWorkPanel'
import GitToolbar from './GitToolbar'
import {onGitRequest, takePendingGit, type GitRequest} from '../../lib/gitBus'
import GitFileEditor from './GitFileEditor'
import GitAgentPanel from './GitAgentPanel'
import GitOutputNotice from './GitOutputNotice'
import AgentChat, {type ChatContextBlock, type ChatLastTurn} from '../agent/AgentChat'
import type {WorkContext} from '../agent/workContext'
import LocalTerminalPanel from '../terminal/LocalTerminalPanel'
import TerminalThemeMenu from '../terminal/TerminalThemeMenu'
import {TERMINAL_FONT_MAX, TERMINAL_FONT_MIN} from '../../xterm/terminalFont'
import PromptDialog from './PromptDialog'
import {t as i18n, useT} from '../../i18n'

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
    // El comando de git que corre (lo que muestra el indicador de ocupado).
    command: string
    danger?: boolean
    // Same escape hatch run() takes: a confirmed action that knows how to
    // recover from a specific failure handles it here instead of landing in
    // the generic error banner. It is what lets a confirmed force push still
    // offer the missing-upstream fix.
    onError?: (e: unknown) => boolean
}

interface GitRepoTabProps {
    repoId: string
    repoName: string
    editorThemeId: string
    // Apariencia compartida de los editores de código — se pasa tal cual al
    // editor de archivos (ver codemirror/editorAppearance.ts).
    appearance: EditorAppearance
    appTheme: Theme
    // Tema de colores de xterm.js — el MISMO prop global que reciben las
    // pestañas SSH (Workspace.tsx). La terminal de este panel es una
    // terminal más de la app, no un widget con su propia paleta.
    terminalThemeId: string
    onChangeTerminalTheme: (id: TerminalThemeId) => void
    // Cuerpo de fuente de las terminales (settings.terminalFontSize), también
    // global: se ajusta desde la barra de la terminal y desde Configuración,
    // y los dos lugares escriben el mismo valor.
    terminalFontSize: number
    onChangeTerminalFontSize: (px: number) => void
    // Shell elegido en Configuración → Terminal (settings.localShell). Se
    // pasa hacia abajo para que cambiarlo reinicie la sesión en el acto;
    // el backend lo relee del vault igual en cada apertura.
    localShellId: string
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
type CenterView = 'commits' | 'changes' | 'stash' | 'conflicts' | 'files'

// Preferencias de la columna de trabajo POR repositorio (solapa y ancho). Van
// al almacenamiento del navegador y no al vault: son comodidades de quien mira
// esta máquina, y un repo con un árbol enorme quiere una columna ancha sin que
// eso le cambie el ancho a los demás. Cualquier fallo (almacenamiento bloqueado,
// JSON roto) cae en los valores por defecto.
const WORK_KEY = 'mt.git.work.'
const WORK_VIEWS: CenterView[] = ['commits', 'changes', 'stash', 'files']
function loadWorkPrefs(repoId: string): {view?: CenterView; width?: number} {
    try {
        const raw = JSON.parse(localStorage.getItem(WORK_KEY + repoId) ?? '{}')
        return {
            view: WORK_VIEWS.includes(raw.view) ? raw.view : undefined,
            width: typeof raw.width === 'number' ? clampSide(raw.width) : undefined,
        }
    } catch {
        return {}
    }
}
function saveWorkPrefs(repoId: string, patch: {view?: CenterView; width?: number}) {
    try {
        const cur = JSON.parse(localStorage.getItem(WORK_KEY + repoId) ?? '{}')
        localStorage.setItem(WORK_KEY + repoId, JSON.stringify({...cur, ...patch}))
    } catch {
        // sin almacenamiento: se vuelve a los valores por defecto la próxima vez
    }
}

// Dónde va anclado el panel de la terminal, y qué solapa muestra. Espejan
// settings.git_term_dock/git_panel_tab (migración 27); null es la solapa
// vacía, que en la base es ''.
type Dock = 'bottom' | 'left' | 'right'
type PanelTab = 'terminal' | 'commands' | 'agents' | 'reflog' | null

// Una sesión abierta del panel. `id` es a la vez el id de sesión del backend
// y el nombre del evento de Wails por el que llegan sus bytes, así que tiene
// que ser único por proceso (ver LocalTerminalPanel).
//
// `autoStart` distingue una sesión de agente recién creada por un clic —el
// agente arranca solo— de una restaurada del layout guardado, que abre su
// shell y espera: relanzar un asistente que consume cuota porque la app se
// reinició no es algo que nadie haya pedido.
// `chat` es una sesión SIN PTY: corre el CLI en modo headless y dibuja la
// conversación (ver backend/agentchat). Convive con `agent`, que es el mismo
// CLI dentro de una terminal de verdad — no lo reemplaza, porque solo ahí el
// agente puede pedir permiso y editar archivos.
interface PanelSession {
    id: string
    kind: 'shell' | 'agent' | 'chat'
    agentId?: string
    title: string
    autoStart: boolean
}

// Topes del tamaño del panel. Por debajo de 140 no entra ni la barra con una
// línea de terminal; el tope superior se calcula contra la ventana en el
// arrastre, para no poder dejar el grafo reducido a nada.
const PANEL_MIN = 140

const LOG_PAGE = 200

// Nombres de git que se muestran tal cual en los dos idiomas (no son texto
// traducible: son el comando o la ref que el usuario reconoce).
const UPSTREAM_PLACEHOLDER = 'origin/main'
const GIT = 'git'
const RESET_HARD = 'Reset --hard'
const CMD = {
    fetch: 'fetch',
    fetchAll: 'fetch --all',
    fetchTags: 'fetch --tags',
    fetchPrune: 'fetch --prune',
    pull: 'pull',
    pullFfOnly: 'pull --ff-only',
    pullRebase: 'pull --rebase',
    pullRebaseAutostash: 'pull --rebase --autostash',
    push: 'push',
    pushSetUpstream: 'push --set-upstream',
    pushTags: 'push --tags',
    pushForceWithLease: 'push --force-with-lease',
    pushForce: 'push --force',
    pushNoVerify: 'push --no-verify',
}

// Contador de sesiones de terminal del proceso. Existe para que dos sesiones
// —de la misma pestaña o de dos pestañas del MISMO repositorio— nunca
// compartan id, que además es el nombre de su evento de Wails.
let terminalSeq = 0
function nextTerminalSeq() {
    terminalSeq += 1
    return terminalSeq
}

// Anclajes del panel. Tres botones y no un menú: son tres opciones
// excluyentes y el estado actual se ve de un vistazo.
const DOCK_BUTTONS = [
    {id: 'left' as const, icon: 'dock_to_right'},
    {id: 'bottom' as const, icon: 'dock_to_bottom'},
    {id: 'right' as const, icon: 'dock_to_left'},
]

// shortAbout recorta el asunto para el título de una solapa. Se queda con el
// final de la ruta, que es la parte que distingue: "src/components/git/" es
// idéntico en veinte archivos, "GitRepoTab.tsx:120-140" no.
function shortAbout(about: string): string {
    const tail = about.split('/').pop() ?? about
    return tail.length > 28 ? `…${tail.slice(-27)}` : tail
}

function newShellSession(repoId: string): PanelSession {
    return {id: `git-term-${repoId}-${nextTerminalSeq()}`, kind: 'shell', title: i18n().git.tab.session.terminal, autoStart: false}
}

export default function GitRepoTab({
    repoId,
    repoName,
    editorThemeId,
    appearance,
    appTheme,
    terminalThemeId,
    onChangeTerminalTheme,
    terminalFontSize,
    onChangeTerminalFontSize,
    localShellId,
    syncToken,
    onChanged,
    active,
}: GitRepoTabProps) {
    const t = useT()
    const g = t.git.tab
    // La solapa y el ancho de la columna de trabajo se recuerdan por repositorio.
    const storedWork = useMemo(() => loadWorkPrefs(repoId), [repoId])
    const [view, setViewState] = useState<CenterView>(storedWork.view ?? 'commits')
    const setView = useCallback(
        (v: CenterView | ((prev: CenterView) => CenterView)) => {
            setViewState((prev) => {
                const next = typeof v === 'function' ? v(prev) : v
                // 'conflicts' no es una solapa: no se recuerda.
                if (next !== 'conflicts') saveWorkPrefs(repoId, {view: next})
                return next
            })
        },
        [repoId],
    )
    const hasStoredWidth = useRef(storedWork.width != null)
    // Contexto de trabajo que esta pestaña le da al chat: el chat es uno solo
    // para toda la app (components/agent/) y lo que lo ancla a este
    // repositorio es esto, no un prop suelto. Memoizado porque va como prop a
    // un componente que se re-renderiza con cada evento del stream.
    const gitContext = useMemo<WorkContext>(() => ({kind: 'git', id: repoId, label: repoName}), [repoId, repoName])

    // Editores externos instalados. Se pide una vez y se guarda: la lista sale
    // de mirar el disco, y no cambia mientras la app está abierta. Si no hay
    // ninguno, no se dibuja el botón — ofrecer "Abrir en VS Code" en una
    // máquina sin VS Code termina siempre en el mismo error.
    const [editors, setEditors] = useState<osopen.Editor[]>([])
    useEffect(() => {
        ExternalEditors()
            .then((list) => setEditors(list ?? []))
            .catch(() => setEditors([]))
    }, [])
    // Archivo que el botón "Editar" del diff pide abrir en la vista Archivos.
    // El token acompaña a la ruta para que pedir el mismo archivo dos veces
    // vuelva a enfocarlo en vez de no hacer nada.
    const [editRequest, setEditRequest] = useState<{path: string; token: number} | null>(null)
    // Estado por repositorio del banco de trabajo (migración 30): pestañas
    // abiertas del editor y agente por defecto.
    const [openFiles, setOpenFiles] = useState<string[] | null>(null)
    const [defaultAgent, setDefaultAgent] = useState('')
    // Prompt armado para una sesión de agente que TODAVÍA no está lista. Ver
    // askAgent: a una sesión recién creada no se le puede escribir de una,
    // porque el CLI tarda en arrancar y el texto se lo comería la shell.
    const [pendingPrompt, setPendingPrompt] = useState<{sessionId: string; text: string; about: string} | null>(null)
    // Prompt para una sesión de CHAT. A diferencia de pendingPrompt no hay
    // nada que esperar: se llena la caja de texto y listo.
    const [chatSeed, setChatSeed] = useState<{sessionId: string; text: string; token: number; attachments?: ChatContextBlock[]} | null>(null)
    // Agentes con chat nativo verificado (backend/agentchat). Los que no
    // están siguen abriéndose como terminal, en vez de ofrecer un chat que se
    // quedaría mudo.
    const [chatCapable, setChatCapable] = useState<Set<string>>(new Set())
    // Historial de conversaciones guardadas de este repositorio (migración 31).
    const [chatHistory, setChatHistory] = useState<vault.AgentChat[]>([])
    // Lo que el propio CLI ya tiene guardado de este repositorio, aunque nunca
    // se haya abierto desde acá: es la misma conversación que ves en la
    // extensión de VS Code o en la terminal. Sin esto, un repositorio con
    // semanas de trabajo encima abre con el historial vacío y parece que la
    // app las perdió.
    const [cliChats, setCliChats] = useState<agentchat.Conversation[]>([])
    // Cuántas cosas agénticas tiene ESTE repositorio, para el contador de la
    // solapa. Se pide con el resto del contexto y no en cada render.
    const [agentBadge, setAgentBadge] = useState(0)
    const [commits, setCommits] = useState<git.CommitInfo[]>([])
    const [branches, setBranches] = useState<git.Branch[]>([])
    // Tags live in the same panel as branches because they answer the same
    // question — "which point in history do I want to look at?" — and until
    // now the only place to see them was the sidebar tree, which cannot
    // reveal a commit on this tab's graph.
    const [tags, setTags] = useState<git.Tag[]>([])
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
    // Commit search. Parsed into real git log filters (author/grep/path/
    // date/rev) rather than filtering the loaded page: the graph pages a few
    // hundred commits at a time, so a client-side filter would only ever
    // search what happens to be on screen.
    const [searchText, setSearchText] = useState('')
    // Para poder dejar el cursor adentro del buscador cuando la búsqueda se
    // dispara desde el menú de una rama: lo que se prellena es el ÁMBITO
    // ("en esta rama"), lo que falta escribir es el término.
    const searchInputRef = useRef<HTMLInputElement>(null)
    const [search, setSearch] = useState<GitSearch>(EMPTY_SEARCH)
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
    // Qué solapa del panel está a la vista, o null si está cerrado.
    // Son dos cosas distintas y complementarias: "commands" es la AUDITORÍA
    // (qué comando corrió la app por debajo y con qué salida), "terminal" es
    // una shell de verdad para hacer lo que la UI no cubre. Comparten un
    // panel en vez de tener uno cada una porque compiten por el mismo
    // espacio: nadie mira las dos a la vez.
    const [panelTab, setPanelTab] = useState<PanelTab>(null)
    // Sesiones del panel: terminales sueltas y sesiones de agente (Claude
    // Code, Codex, Gemini), cada una con su propio proceso. Una vez creada,
    // una sesión queda MONTADA aunque se cambie de solapa o se cierre el
    // panel: desmontarla mataría su proceso y con él el directorio al que
    // hayas entrado o la conversación con el agente. Por el mismo motivo el
    // panel se mueve entre anclajes con CSS y NO cambiando de lugar en el
    // árbol de React: React desmonta y vuelve a montar un subárbol que cambia
    // de padre, y eso mataría todas las sesiones en cada cambio de dock.
    const [sessions, setSessions] = useState<PanelSession[]>([])
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
    // Chat activo, aparte del de las terminales: desde que los chats viven en
    // la solapa Agentes y las terminales en Sesiones, un solo "activo"
    // compartido haría que cambiar de solapa te moviera la selección de la
    // otra.
    const [activeChatId, setActiveChatId] = useState<string | null>(null)
    // Qué muestra la solapa Agentes: la conversación abierta, el contexto del
    // repositorio (skills, MCP, consumo) o el historial completo.
    const [agentsView, setAgentsView] = useState<'chats' | 'context' | 'history'>('context')
    // Modo agente: archivos + conversación, sin ramas ni diff. Se recuerda lo
    // que estaba oculto ANTES de entrar, para devolverlo tal cual al salir —
    // salir dejando visible algo que el usuario tenía cerrado sería reordenarle
    // la pantalla por haber probado un modo.
    const [agentMode, setAgentMode] = useState(false)
    const beforeAgentMode = useRef<{side: boolean; diff: boolean; view: CenterView} | null>(null)
    // Catálogo de agentes de esta máquina, para el menú "+". Se pide una vez:
    // qué hay instalado no cambia mientras la pestaña está abierta.
    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    // Anclaje, tamaño y paneles ocultos. Todo esto se persiste en el vault
    // (migración 27) y se restaura al abrir: la pestaña tiene que volver
    // exactamente como se dejó, que es la razón de ser de esta configuración.
    const [dock, setDock] = useState<Dock>('bottom')
    const [panelSize, setPanelSize] = useState(300)
    const [sideHidden, setSideHidden] = useState(false)
    const [diffHidden, setDiffHidden] = useState(false)
    const [panelDragging, setPanelDragging] = useState(false)
    const bodyRef = useRef<HTMLDivElement>(null)
    const [logToken, setLogToken] = useState(0)
    const [worktrees, setWorktrees] = useState<git.Worktree[]>([])
    const [showWorktrees, setShowWorktrees] = useState(false)
    // Submódulos: repositorios anidados que el padre fija en UN commit.
    // Se cargan solo con el panel abierto, igual que los worktrees — la
    // enorme mayoría de los repos no tiene ninguno y no hay por qué pagar
    // una llamada por refresco para descubrirlo cada vez.
    const [submodules, setSubmodules] = useState<git.Submodule[]>([])
    const [showSubmodules, setShowSubmodules] = useState(false)
    // Convención Git Flow del repositorio. Se lee siempre (son lecturas de
    // config, baratas) porque de eso depende qué dice el menú: "Inicializar"
    // o "Nueva feature/release/hotfix".
    const [flow, setFlow] = useState<git.GitFlowConfig | null>(null)
    const [forge, setForge] = useState<git.ForgeInfo | null>(null)

    // Id de la sesión de terminal de ESTA pestaña. Un ref y no un valor
    // derivado de repoId: el mismo repositorio puede estar abierto en dos
    // pestañas, y compartir el id haría que las dos escriban en la misma
    // shell (el id es además el nombre del evento de Wails, ver
    // LocalTerminalPanel).
    const termSessionIdRef = useRef(`git-term-${repoId}-${nextTerminalSeq()}`)

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

    // logToken en las dependencias es lo que hace que la lista se refresque
    // después de cada comando: actualizar o quitar un submódulo cambia el
    // estado de la fila que acabás de tocar.
    useEffect(() => {
        GitFlowStatus(repoId)
            .then(setFlow)
            .catch(() => setFlow(null))
    }, [repoId, logToken])

    useEffect(() => {
        if (!showSubmodules) return
        GitSubmodules(repoId)
            .then((m) => setSubmodules(m ?? []))
            .catch(() => setSubmodules([]))
    }, [repoId, showSubmodules, logToken])
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
    // Pestaña con la que abre la configuración. La lista de ramas remotas la
    // abre directo en "Remotos": la pregunta "¿a dónde apunta esto?" se hace
    // justamente ahí, mirando que origin/algo no se actualiza.
    const [settingsTab, setSettingsTab] = useState<'identity' | 'remotes'>('identity')
    const openSettings = useCallback((tab: 'identity' | 'remotes') => {
        setSettingsTab(tab)
        setShowSettings(true)
    }, [])
    // Branch names hidden from the graph via the commit menu. When non-empty
    // the log walks every OTHER ref instead of --all, so hiding a busy release
    // branch declutters the graph without deleting anything.
    const [hidden, setHidden] = useState<Set<string>>(new Set())
    // Pane widths, restored from the vault and written back on drag end.
    // Seeded with the same defaults migration 20 uses so the first paint
    // matches the stored layout instead of jumping when settings arrive.
    const [sideWidth, setSideWidth] = useState(storedWork.width ?? 288)
    const [diffWidth, setDiffWidth] = useState(520)
    const [dragging, setDragging] = useState<'side' | 'diff' | null>(null)
    const [diffContext, setDiffContext] = useState(3)
    const [diffIgnoreWs, setDiffIgnoreWs] = useState(false)
    const [diffWrap, setDiffWrap] = useState(true)
    const layoutRef = useRef<HTMLDivElement>(null)
    // Ancho real del área de trabajo, para que el panel derecho ceda cuando la
    // pestaña es angosta en vez de dejar el grafo en una rendija.
    const [layoutW, setLayoutW] = useState(0)
    useEffect(() => {
        const el = layoutRef.current
        if (!el) return
        setLayoutW(el.clientWidth)
        const ro = new ResizeObserver(() => setLayoutW(el.clientWidth))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    useEffect(() => {
        GetSettings()
            .then((st) => {
                if (st.gitSideWidth && !hasStoredWidth.current) setSideWidth(clampSide(st.gitSideWidth))
                if (st.gitDiffWidth) setDiffWidth(st.gitDiffWidth)
                if (st.gitDiffContext) setDiffContext(st.gitDiffContext)
                setDiffIgnoreWs(st.gitDiffIgnoreWs)
                setDiffWrap(st.gitDiffWrap)

                if (st.gitTermDock === 'left' || st.gitTermDock === 'right' || st.gitTermDock === 'bottom') {
                    setDock(st.gitTermDock)
                }
                if (st.gitTermSize) setPanelSize(st.gitTermSize)
                setSideHidden(!!st.gitSideHidden)
                setDiffHidden(!!st.gitDiffHidden)
                // Las sesiones se restauran con autoStart en false: se
                // recrean sus shells, pero ningún agente arranca solo.
                const restored: PanelSession[] = (st.gitPanelSessions ?? []).map((p) => ({
                    id: `git-term-${repoId}-${nextTerminalSeq()}`,
                    kind: p.kind === 'agent' ? 'agent' : p.kind === 'chat' ? 'chat' : 'shell',
                    agentId: p.agentId || undefined,
                    title: p.title || (p.kind === 'agent' ? (p.agentId ?? i18n().git.tab.session.agent) : i18n().git.tab.session.terminal),
                    autoStart: false,
                }))
                // Restaurar la solapa de sesiones implica levantar sus
                // procesos: dejarla guardada y abrir la pestaña con el panel
                // vacío sería restaurar el layout a medias. Si quedó abierta
                // en esa solapa pero no hay sesiones anotadas (una instalación
                // que viene de la versión de una sola terminal), se abre una
                // terminal, que es exactamente lo que había antes.
                const openTab =
                    st.gitPanelTab === 'terminal' ||
                    st.gitPanelTab === 'commands' ||
                    st.gitPanelTab === 'agents' ||
                    st.gitPanelTab === 'reflog'
                        ? st.gitPanelTab
                        : null
                const initial =
                    openTab === 'terminal' && restored.length === 0 ? [newShellSession(repoId)] : restored
                if (openTab) setPanelTab(openTab)
                setSessions(initial)
                setActiveSessionId(initial[0]?.id ?? null)
            })
            .catch(() => {
                // A settings read failure is not worth an error banner — the
                // panes just keep their defaults.
            })
    }, [])

    // persistLayout guarda TODO el layout de una sola vez. Toma overrides
    // porque quien lo llama acaba de decidir un campo y los otros cuatro
    // siguen siendo los del estado: leerlos del closure evita tener que
    // encadenar setState y guardar en un efecto posterior.
    const persistLayout = useCallback(
        (patch: Partial<{dock: Dock; size: number; tab: PanelTab; sideHidden: boolean; diffHidden: boolean}>) => {
            const next = {dock, size: panelSize, tab: panelTab, sideHidden, diffHidden, ...patch}
            void SetGitLayout(next.dock, Math.round(next.size), next.tab ?? '', next.sideHidden, next.diffHidden).catch(
                () => {
                    // Un fallo al guardar el layout no merece un cartel de
                    // error: lo que se ve en pantalla ya cambió, y lo único
                    // que se pierde es que vuelva así la próxima vez.
                },
            )
        },
        [dock, panelSize, panelTab, sideHidden, diffHidden],
    )

    // Arrastre del borde del panel. El eje depende del anclaje: abajo se
    // arrastra en vertical, a los costados en horizontal. Se escucha en
    // window y no en el handle para que el puntero pueda salirse de la tira
    // de 6px sin cortar el arrastre.
    useEffect(() => {
        if (!panelDragging) return
        const onMove = (e: MouseEvent) => {
            const box = bodyRef.current?.getBoundingClientRect()
            if (!box) return
            const raw =
                dock === 'bottom' ? box.bottom - e.clientY : dock === 'left' ? e.clientX - box.left : box.right - e.clientX
            // El tope superior deja siempre un mínimo del área principal a la
            // vista: un panel que puede taparlo todo es una forma fácil de
            // perder el grafo sin entender por qué.
            const max = (dock === 'bottom' ? box.height : box.width) - 240
            setPanelSize(Math.max(PANEL_MIN, Math.min(raw, Math.max(PANEL_MIN, max))))
        }
        const onUp = () => setPanelDragging(false)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        document.body.style.userSelect = 'none'
        document.body.style.cursor = dock === 'bottom' ? 'row-resize' : 'col-resize'
        return () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
    }, [panelDragging, dock])

    // Persistir el tamaño solo al soltar: escribir en cada mousemove serían
    // cientos de UPDATE en SQLite por un único valor final. Mismo criterio
    // que el arrastre de los anchos de panel de arriba.
    const wasDraggingRef = useRef(false)
    useEffect(() => {
        if (wasDraggingRef.current && !panelDragging) persistLayout({})
        wasDraggingRef.current = panelDragging
    }, [panelDragging, persistLayout])

    // persistSessions guarda la lista de sesiones (la intención, no los
    // procesos — ver vault.GitPanelSession).
    const persistSessions = useCallback((list: PanelSession[]) => {
        void SetGitPanelSessions(
            list.map((s) => ({kind: s.kind, agentId: s.agentId ?? '', title: s.title})),
        ).catch(() => {
            // Igual que con el resto del layout: lo que se ve ya cambió, y lo
            // único que se pierde es que vuelva así la próxima vez.
        })
    }, [])

    const reloadChatHistory = useCallback(() => {
        ListAgentChats(repoId)
            .then((l) => setChatHistory(l ?? []))
            .catch(() => setChatHistory([]))
    }, [repoId])
    // Un renombrado hecho desde la barra lateral o el Chat de IA.
    useEffect(() => onAgentChatsChanged(reloadChatHistory), [reloadChatHistory])

    // Se piden por agente y en paralelo: cada uno lee un almacenamiento
    // distinto, y que uno no esté instalado no puede dejar sin lista a los
    // otros. Un fallo acá no rompe nada — es conveniencia, no navegación.
    const reloadCliChats = useCallback(() => {
        Promise.all(
            ['claude', 'codex', 'opencode'].map((id) => AgentCLIConversations(id, repoId).catch(() => [] as agentchat.Conversation[])),
        )
            .then((lists) => setCliChats(lists.flat()))
            .catch(() => setCliChats([]))
    }, [repoId])

    useEffect(() => {
        reloadCliChats()
    }, [reloadCliChats])

    useEffect(() => {
        reloadChatHistory()
    }, [reloadChatHistory])

    // Contador de la solapa Agentes: skills + subagentes + comandos del repo.
    // No incluye los archivos de instrucciones ausentes — un contador que
    // sube porque te FALTA algo se lee al revés de lo que significa.
    useEffect(() => {
        GitAgentContext(repoId)
            .then((c) => setAgentBadge((c.skills?.length ?? 0) + (c.agents?.length ?? 0) + (c.commands?.length ?? 0)))
            .catch(() => setAgentBadge(0))
    }, [repoId])

    // enterAgentMode deja la pestaña en "modo carpeta": archivos del proyecto
    // al centro, sin ramas, grafo ni diff.
    //
    // Los cambios de layout van ACÁ y no adentro de un updater de
    // setAgentMode: React puede invocar un updater más de una vez, y un
    // setState metido adentro no tiene garantía de aplicarse ni de aplicarse
    // una sola vez.
    //
    // Es idempotente a propósito: lo llama el botón, pero también abrir o
    // elegir un chat, y esas dos cosas se solapan todo el tiempo.
    const enterAgentMode = useCallback(() => {
        if (agentMode) return
        beforeAgentMode.current = {side: sideHidden, diff: diffHidden, view}
        setAgentMode(true)
        setSideHidden(true)
        setDiffHidden(true)
        setView('files')
        setPanelTab('agents')
        // Un panel colapsado al mínimo dejaría el modo agente sin su mitad: se
        // le da un ancho utilizable si estaba en nada.
        setPanelSize((sz) => (sz < 320 ? 420 : sz))
        persistLayout({tab: 'agents', sideHidden: true, diffHidden: true})
    }, [agentMode, sideHidden, diffHidden, view, persistLayout])

    // resumeChat retoma una conversación guardada.
    //
    // La sesión del panel reusa el ID DEL CHAT a propósito: es lo que hace que
    // seguir escribiendo actualice esa misma entrada del historial en vez de
    // crear una nueva cada vez que se retoma.
    const resumeChat = useCallback(
        (chat: vault.AgentChat) => {
            setPanelTab('agents')
            setAgentsView('chats')
            persistLayout({tab: 'agents'})
            enterAgentMode()

            const open = sessions.find((s) => s.id === chat.id)
            if (open) {
                setActiveChatId(chat.id)
                return
            }
            const session: PanelSession = {
                id: chat.id,
                kind: 'chat',
                agentId: chat.agentId,
                title: chat.title || i18n().git.tab.session.chatWith({agent: agentList.find((a) => a.id === chat.agentId)?.label ?? chat.agentId}),
                autoStart: false,
            }
            const next = [...sessions, session]
            setSessions(next)
            setActiveChatId(session.id)
            persistSessions(next)
            // Le dice al manager con qué conversación del CLI encadenar. Sin
            // esto la ventana mostraría el chat pero el agente empezaría de
            // cero, que es peor que no ofrecer retomar.
            void ResumeAgentChat(chat.id, chat.conversationId).catch(() => {})
        },
        [sessions, agentList, persistLayout, persistSessions, enterAgentMode],
    )

    // Estado por repositorio, una sola vez por pestaña.
    useEffect(() => {
        GitRepoWorkspace(repoId)
            .then((ws) => {
                setOpenFiles(ws.openFiles ?? [])
                setDefaultAgent(ws.defaultAgent ?? '')
            })
            .catch(() => setOpenFiles([]))
    }, [repoId])

    // askAgent le pasa una pregunta al agente elegido.
    //
    // **No se envía sola: el prompt se ESCRIBE en la sesión y enviar queda a
    // cargo del usuario.** Es la misma decisión que ya tomó el historial de
    // comandos SSH de esta app (click escribe, ejecutar es un gesto aparte), y
    // por el mismo motivo: casi siempre se quiere completar o corregir el
    // texto antes de mandarlo, y disparar solo lo que quedó escrito es un
    // atajo que en algún momento manda algo que no era.
    //
    // Si ya hay una sesión de ese agente corriendo, el texto entra ahí. Si hay
    // que crearla, el prompt queda PENDIENTE con un botón para insertarlo: a
    // una sesión recién abierta no se le puede escribir de inmediato porque el
    // CLI tarda en arrancar, y el texto se lo comería la shell que lo lanza —
    // que además terminaría ejecutándolo como un comando cuando el agente
    // arranque.
    const askAgent = useCallback(
        (agentId: string, prompt: string, about: string, attachments?: ChatContextBlock[]) => {
            // Con chat nativo el problema del arranque desaparece: no hay un
            // CLI que esté levantando y al que no se le pueda escribir, solo
            // una caja de texto que se llena. Por eso se prefiere el chat
            // cuando el agente lo soporta, y la terminal queda para el resto.
            if (chatCapable.has(agentId)) {
                setPanelTab('agents')
                setAgentsView('chats')
                persistLayout({tab: 'agents'})
                enterAgentMode()
                const existingChat = sessions.find((s) => s.kind === 'chat' && s.agentId === agentId)
                if (existingChat) {
                    setActiveChatId(existingChat.id)
                    setChatSeed({sessionId: existingChat.id, text: prompt, token: Date.now(), attachments})
                    return
                }
                const agent = agentList.find((a) => a.id === agentId)
                const session: PanelSession = {
                    id: `git-term-${repoId}-${nextTerminalSeq()}`,
                    kind: 'chat',
                    agentId,
                    title: i18n().git.tab.session.chatAbout({about: shortAbout(about)}),
                    autoStart: false,
                }
                const next = [...sessions, session]
                setSessions(next)
                setActiveChatId(session.id)
                persistSessions(next)
                // El chat entra al historial del repositorio con el asunto como
                // título: es lo que después permite reconocerlo en la lista y
                // retomarlo.
                void CreateAgentChat(session.id, repoId, agentId, about, 'git', repoId).catch(() => {})
                setChatSeed({sessionId: session.id, text: prompt, token: Date.now(), attachments})
                void agent // el label ya quedó en el título
                return
            }

            setPanelTab('terminal')
            persistLayout({tab: 'terminal'})
            const existing = sessions.find((s) => s.kind === 'agent' && s.agentId === agentId)
            if (existing) {
                setActiveSessionId(existing.id)
                void WriteLocalTerminal(existing.id, prompt)
                return
            }

            const agent = agentList.find((a) => a.id === agentId)
            const session: PanelSession = {
                id: `git-term-${repoId}-${nextTerminalSeq()}`,
                kind: 'agent',
                agentId,
                // La sesión se nombra por la TAREA y no solo por el agente:
                // con tres sesiones abiertas, "Claude Code", "Claude Code" y
                // "Claude Code" no ayuda a encontrar la que estabas usando.
                title: `${agent?.label ?? agentId} · ${shortAbout(about)}`,
                autoStart: true,
            }
            const next = [...sessions, session]
            setSessions(next)
            setActiveSessionId(session.id)
            persistSessions(next)
            setPendingPrompt({sessionId: session.id, text: prompt, about})
        },
        [sessions, agentList, chatCapable, repoId, persistLayout, persistSessions, enterAgentMode],
    )

    // «Validar con otro»: abre el chat del revisor con el prompt y, ADJUNTO y a
    // la vista, lo que necesita para revisar de verdad — qué hizo el primer
    // agente y qué quedó cambiado en el árbol de trabajo. En modo consulta un
    // CLI muchas veces no puede ni correr git, así que decirle «mirá el diff»
    // sin dárselo era pedirle que adivinara. Las fichas se leen y se quitan
    // antes de enviar: nada viaja a escondidas.
    const validateWithAnother = useCallback(
        async (reviewerId: string, lastTurn: ChatLastTurn) => {
            // Sin cambios no hay diff que adjuntar y el revisor recibe solo lo
            // que hizo el primero. Un fallo REAL con cambios presentes sí se
            // avisa: seguir en silencio mandaría una revisión sin diff.
            const changes = await GitReviewContext(repoId).catch(async (e) => {
                const st = await GitStatus(repoId).catch(() => null)
                if (st && st.files.length > 0) setError(String(e))
                return null
            })
            const r = i18n().git.tab.review
            askAgent(reviewerId, r.prompt, r.about, buildReviewBlocks(lastTurn, changes))
        },
        [repoId, askAgent],
    )


    const toggleAgentMode = useCallback(() => {
        if (!agentMode) {
            enterAgentMode()
            // Si hay una conversación abierta se muestra ESA, no el
            // contexto: entrar en modo agente para tener que hacer un clic
            // más y llegar a lo que ya estabas hablando es una fricción sin
            // motivo.
            setAgentsView(sessions.some((s) => s.kind === 'chat') ? 'chats' : 'context')
            return
        }
        const prev = beforeAgentMode.current
        setAgentMode(false)
        setSideHidden(prev?.side ?? false)
        setDiffHidden(prev?.diff ?? false)
        setView(prev?.view ?? 'commits')
        persistLayout({sideHidden: prev?.side ?? false, diffHidden: prev?.diff ?? false})
    }, [agentMode, enterAgentMode, sessions, persistLayout])


    // adoptConversation abre una conversación que venía del propio CLI.
    //
    // La "adopta": la registra en el historial de la app con el id del CLI ya
    // apuntado, y a partir de ahí se comporta como cualquier otra —se puede
    // renombrar, se retoma sola—. No se copian los mensajes: el historial lo
    // sigue teniendo el CLI, y duplicarlo acá sería una segunda memoria que se
    // desincroniza con la real.
    const adoptConversation = useCallback(
        async (agentId: string, conv: agentchat.Conversation) => {
            // Si ya se abrió antes, es la misma conversación: se retoma esa
            // entrada en vez de crear una segunda que apunte al mismo lugar.
            const known = chatHistory.find((c) => c.conversationId === conv.id)
            if (known) {
                resumeChat(known)
                return
            }

            const id = `git-term-${repoId}-${nextTerminalSeq()}`
            const title = conv.title || i18n().git.tab.session.conversationWith({agent: agentList.find((a) => a.id === agentId)?.label ?? agentId})
            try {
                await CreateAgentChat(id, repoId, agentId, title, 'git', repoId)
                await TouchAgentChat(id, conv.id)
            } catch {
                // Si el vault no la pudo registrar no se abre a medias: se
                // abriría un chat que al reabrir la app no estaría.
                return
            }
            reloadChatHistory()
            resumeChat(vault.AgentChat.createFrom({id, repoId, agentId, title, conversationId: conv.id}))
        },
        [chatHistory, repoId, agentList, resumeChat, reloadChatHistory],
    )


    // Con qué agente se redacta el mensaje de commit.
    //
    // La elección la resuelve el BACKEND (`AgentDraftCommit`): el agente por
    // defecto de la aplicación —el mismo que usan el generador de consultas y
    // el análisis de EXPLAIN— y solo si no hay ninguno elegido, el por defecto
    // de este repositorio. Acá solo se decide si la acción se OFRECE, que es
    // otra pregunta: alcanza con que haya algún CLI instalado con chat
    // verificado, porque sin eso el botón solo puede terminar en un error.
    const draftables = useMemo(
        () => agentList.filter((a) => a.available && chatCapable.has(a.id)),
        [agentList, chatCapable],
    )

    const [drafting, setDrafting] = useState(false)
    // Última redacción, para poder decir quién la escribió y sobre qué. "¿Qué
    // le mandaste de mi repositorio?" tiene que poder contestarse, igual que en
    // el asistente de consultas.
    const [draft, setDraft] = useState<main.CommitDraft | null>(null)

    // Un mensaje editado a mano deja de ser el que redactó el agente: mantener
    // la firma abajo diría que el agente escribió algo que no escribió.
    useEffect(() => {
        setDraft((prev) => (prev && prev.message !== commitMessage ? null : prev))
    }, [commitMessage])

    // draftCommitMessage pide el mensaje a partir del diff PREPARADO y lo
    // escribe en el campo.
    //
    // Dos decisiones que hacen que esto sirva en vez de estorbar:
    //   - El contexto lo arma Go (parche recortado, archivos y los últimos
    //     mensajes del repositorio como referencia de estilo) en vez de pedirle
    //     al agente que corra `git diff` él mismo: así la respuesta no depende
    //     de que el CLI decida ejecutar un comando, y se puede DECIR qué se le
    //     mandó.
    //   - El prefijo de tipo/scope que el usuario ya haya elegido se vuelve a
    //     aplicar sobre lo que devuelva: la convención del proyecto la decide
    //     el selector, no el agente.
    const draftCommitMessage = useCallback(
        async (agentId = '') => {
            if (drafting) return
            setDrafting(true)
            setError(null)
            try {
                const result = await AgentDraftCommit(repoId, agentId)
                const {type, scope} = currentPrefixOf(commitMessage)
                const clean = result.message.trim()
                const message = type ? applyPrefix(clean, buildCommitPrefix(type, scope)) : clean
                setCommitMessage(message)
                setDraft(main.CommitDraft.createFrom({...result, message}))
            } catch (e) {
                setError(String(e))
            } finally {
                setDrafting(false)
            }
        },
        [drafting, repoId, commitMessage],
    )

    // Elegir OTRO proveedor para esta redacción no cambia el agente activo de
    // la app: es una segunda opinión sobre el mismo diff, misma idea que el
    // selector del análisis de EXPLAIN.
    const pickDraftAgent = useCallback(
        (e: {clientX: number; clientY: number}) => {
            setMenu({
                x: e.clientX,
                y: e.clientY,
                items: draftables.map((a) => ({
                    label: i18n().git.tab.draft.draftWith({agent: a.label}),
                    icon: 'auto_awesome',
                    hint: i18n().git.tab.draft.onlyThisMessage,
                    onSelect: () => void draftCommitMessage(a.id),
                })),
            })
        },
        [draftables, draftCommitMessage],
    )

    // askAgentPicking resuelve CON QUÉ agente. Con uno por defecto va directo;
    // sin él abre el menú, porque elegir por el usuario un asistente que
    // consume su cuota no es algo que nadie haya pedido.
    const askAgentPicking = useCallback(
        (prompt: string, about: string, e?: {clientX: number; clientY: number}) => {
            const usable = agentList.filter((a) => a.available)
            if (defaultAgent && usable.some((a) => a.id === defaultAgent)) {
                askAgent(defaultAgent, prompt, about)
                return
            }
            if (usable.length === 0) {
                setError(i18n().git.tab.noAgentsInstalled)
                return
            }
            if (usable.length === 1) {
                askAgent(usable[0].id, prompt, about)
                return
            }
            setMenu({
                x: e?.clientX ?? 200,
                y: e?.clientY ?? 200,
                items: usable.map((a) => ({
                    label: i18n().git.tab.askAgentLabel({agent: a.label}),
                    icon: 'smart_toy',
                    hint: about,
                    onSelect: () => askAgent(a.id, prompt, about),
                })),
            })
        },
        [agentList, defaultAgent, askAgent],
    )

    const addSession = useCallback(
        (kind: 'shell' | 'agent' | 'chat', agent?: agentsModel.Agent) => {
            const session: PanelSession =
                kind !== 'shell' && agent
                    ? {
                          id: `git-term-${repoId}-${nextTerminalSeq()}`,
                          kind,
                          agentId: agent.id,
                          title: kind === 'chat' ? i18n().git.tab.session.chatAbout({about: agent.label}) : agent.label,
                          // Creada por un clic acá y ahora: el agente arranca
                          // solo. Solo las restauradas esperan (ver PanelSession).
                          autoStart: true,
                      }
                    : newShellSession(repoId)
            const next = [...sessions, session]
            setSessions(next)
            persistSessions(next)

            if (kind === 'chat') {
                setActiveChatId(session.id)
                setAgentsView('chats')
                setPanelTab('agents')
                persistLayout({tab: 'agents'})
                enterAgentMode()
                if (agent) {
                    // Sin título a propósito: se nombra con el primer mensaje (backend,
                    // nameUntitledChat). Un «Chat con <agente>» repetido no distingue una
                    // conversación de otra en el historial.
                    void CreateAgentChat(session.id, repoId, agent.id, '', 'git', repoId).catch(() => {})
                }
                return
            }

            setActiveSessionId(session.id)
            setPanelTab('terminal')
            persistLayout({tab: 'terminal'})
        },
        [repoId, sessions, persistLayout, persistSessions, enterAgentMode],
    )

    // renameChat abre el diálogo de renombrar. Lo usan la solapa de un chat
    // abierto y las filas de la vista Historial.
    const renameChat = useCallback(
        (id: string, current: string) => {
            setPrompt({
                title: i18n().git.tab.chat.renameTitle,
                label: i18n().git.tab.chat.nameLabel,
                initial: current,
                confirmLabel: i18n().common.save,
                onSubmit: (name: string) => {
                    const title = name.trim()
                    if (!title) return
                    setSessions((prev) => prev.map((x) => (x.id === id ? {...x, title} : x)))
                    void RenameAgentChat(id, title).then(reloadChatHistory).catch(() => {})
                },
            })
        },
        [reloadChatHistory],
    )

    // chatMenuItems arma el menú del `+`: **solo empezar una conversación**.
    //
    // El historial vivía acá y se fue a su propia vista. Dejarlo en los dos
    // lados no era redundancia inofensiva: el menú solo entra unas pocas
    // filas, así que mostraba un recorte —las más recientes de cada agente— y
    // esa lista corta parecía ser el historial completo. Un menú que contesta
    // "esto es todo lo que hay" cuando no lo es es peor que no contestar.
    // Abajo queda el acceso a la vista, que sí lo tiene todo, con buscador.
    const chatMenuItems = useCallback(
        (): (DropdownItem | DropdownHeader | 'separator')[] => {
            const usable = agentList.filter((a) => a.available && chatCapable.has(a.id))
            const items: (DropdownItem | DropdownHeader | 'separator')[] = [{header: i18n().git.tab.chat.startHeader}]

            for (const a of usable) {
                items.push({
                    label: a.label,
                    icon: 'chat',
                    hint: a.vendor,
                    onSelect: () => addSession('chat', a),
                })
            }

            const saved = chatHistory.length + cliChats.length
            if (saved > 0) {
                items.push('separator', {
                    label: i18n().git.tab.chat.viewHistory,
                    icon: 'history',
                    hint: i18n().git.tab.chat.conversations(saved),
                    onSelect: () => setAgentsView('history'),
                })
            }
            return items
        },
        [agentList, chatCapable, chatHistory, cliChats, addSession],
    )

    const closeSession = useCallback(
        (id: string) => {
            const next = sessions.filter((s) => s.id !== id)
            setSessions(next)
            // Al cerrar la activa se pasa a la última que quede, no a la
            // primera: es la que estaba al lado y la que uno espera ver.
            setActiveSessionId((current) => (current === id ? (next[next.length - 1]?.id ?? null) : current))
            persistSessions(next)
        },
        [sessions, persistSessions],
    )

    // openPanel abre una solapa, o cierra el panel si ya estaba en esa misma.
    const openPanel = useCallback(
        (tab: Exclude<PanelTab, null>) => {
            const next = panelTab === tab ? null : tab
            setPanelTab(next)
            // Abrir Agentes ES ponerse a trabajar con un agente, y entonces lo
            // que se quiere ver son los archivos del proyecto, no el grafo de
            // commits. Vale para las tres puertas de entrada —este botón, la
            // solapa del panel y abrir un chat— porque desde el lado del
            // usuario son la misma acción, y que una sola de ellas reacomode la
            // pantalla es exactamente lo que se siente roto.
            if (next === 'agents') enterAgentMode()
            // Antes, abrir la solapa de sesiones sin ninguna abierta creaba
            // una terminal directamente. El resultado era un prompt de zsh
            // mudo: nada indicaba que además se puede chatear con un agente,
            // retomar una conversación o ver qué tiene preparado el
            // repositorio. Ahora se muestra el lanzador (ver más abajo), y la
            // terminal es UNA de las opciones en vez de la única.
            persistLayout({tab: next})
        },
        [panelTab, sessions.length, repoId, persistLayout, persistSessions, enterAgentMode],
    )

    // El catálogo de agentes se pide una vez: qué hay instalado en la máquina
    // no cambia mientras la pestaña está abierta.
    useEffect(() => {
        ListAgents()
            .then(async (list) => {
                const agents = list ?? []
                setAgentList(agents)
                // Qué agentes tienen chat nativo lo decide el backend, que es
                // donde está la lista de adaptadores verificados — duplicarla
                // acá se desincronizaría en cuanto se agregue uno.
                const flags = await Promise.all(agents.map((a) => AgentChatSupported(a.id).catch(() => false)))
                setChatCapable(new Set(agents.filter((_, i) => flags[i]).map((a) => a.id)))
            })
            .catch(() => setAgentList([]))
    }, [])

    // changeDock mueve el panel de anclaje. El componente de terminal no se
    // remonta (ver terminalStarted): solo cambian los estilos del contenedor,
    // así que la shell y el directorio actual sobreviven al cambio.
    const changeDock = useCallback(
        (next: Dock) => {
            setDock(next)
            persistLayout({dock: next})
        },
        [persistLayout],
    )

    // El valor nuevo se calcula ANTES de setState y no dentro del updater:
    // React puede ejecutar un updater más de una vez, y persistir desde
    // adentro convertiría eso en dos escrituras al vault por cada clic.
    const toggleSide = useCallback(() => {
        const next = !sideHidden
        setSideHidden(next)
        persistLayout({sideHidden: next})
    }, [sideHidden, persistLayout])

    const toggleDiff = useCallback(() => {
        const next = !diffHidden
        setDiffHidden(next)
        persistLayout({diffHidden: next})
    }, [diffHidden, persistLayout])

    // Drag handling lives on window, not on the handle, so the pointer can
    // leave the 4px strip mid-drag without the resize stopping — the usual
    // reason a splitter feels like it "slips".
    useEffect(() => {
        if (!dragging) return
        const onMove = (e: MouseEvent) => {
            const box = layoutRef.current?.getBoundingClientRect()
            if (!box) return
            if (dragging === 'side') {
                setSideWidth(clampSide(e.clientX - box.left))
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
            // Y el ancho de ESTE repositorio, que es el que manda al reabrirlo.
            saveWorkPrefs(repoId, {width: sideWidth})
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
    }, [dragging, sideWidth, diffWidth, repoId])

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
            const [log, st, prog, stash, tgs] = await Promise.all([
                GitLog(repoId, logOpts),
                GitStatus(repoId),
                GitInProgress(repoId),
                GitStashes(repoId),
                GitTags(repoId),
            ])
            setStashes(stash ?? [])
            setCommits(log ?? [])
            setBranches(brs ?? [])
            setTags(tgs ?? [])
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
                    i18n().git.tab.notice.branchTipOutside({branch: b.name, hash: outside.shortHash, count: LOG_PAGE}),
                )
            } catch (e) {
                setError(String(e))
            }
        },
        [commits, repoId],
    )

    // Single click on a tag: same contract as clicking a branch — the graph
    // jumps to the commit it marks. A tag pointing at something older than the
    // loaded window is the norm (that is what a release tag from six months
    // ago is), so the out-of-window path is not an edge case here, it is the
    // usual one.
    const revealCommit = useCallback(
        async (hash: string) => {
            setView('commits')
            setSelectedPath(null)
            setSelectedBranch(null)

            // startsWith: la salida de un pull da el hash abreviado.
            const known = commits.find((c) => c.hash === hash || (hash.length >= 7 && c.hash.startsWith(hash)))
            if (known) {
                setSelectedCommit(known)
                setReveal({hash: known.hash, token: ++revealSeq.current})
                return
            }
            try {
                const [outside] = (await GitLog(repoId, new git.LogOptions({maxCount: 1, rev: hash, withStats: false}))) ?? []
                if (!outside) return
                setSelectedCommit(outside)
                setNotice(
                    i18n().git.tab.notice.commitOutside({hash: outside.shortHash, count: LOG_PAGE}),
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
            const m = i18n().git.tab.branchMenu
            return [
                {
                    label: m.checkout({name: b.name}),
                    icon: 'check',
                    hint: m.checkoutRemoteHint,
                    onSelect: () => void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => { if (ok) void selectBranch(b) }),
                },
                {
                    label: m.createLocal({name: localName}),
                    icon: 'account_tree',
                    disabled: branches.some((x) => !x.isRemote && x.name === localName),
                    hint: branches.some((x) => !x.isRemote && x.name === localName) ? m.localExists : undefined,
                    onSelect: () => run(`checkout -b ${localName}`, () => GitCreateBranch(repoId, localName, b.name, true)),
                },
                {
                    label: m.mergeInto({name: b.name, into: current?.name ?? m.theCurrentShort}),
                    icon: 'merge',
                    onSelect: () => run(`merge ${b.name}`, () => GitMerge(repoId, b.name, false)),
                },
                rebaseOntoItem(b),
                searchInBranchItem(b),
                {label: m.copyName({name: b.name}), icon: 'content_copy', onSelect: () => copy(b.name)},
                'separator',
                {
                    label: m.delete({name: b.name}),
                    icon: 'delete',
                    danger: true,
                    hint: m.deleteRemoteHint,
                    onSelect: () =>
                        setConfirm({
                            title: m.deleteRemoteTitle,
                            description: m.deleteRemoteDesc({name: b.name}),
                            confirmLabel: m.deleteFromRemote,
                            command: 'push --delete',
                            run: () => GitDeleteRemoteBranch(repoId, b.name, new git.AuthConfig({})),
                        }),
                },
            ]
        }

        const remoteCandidates = branches.filter((x) => x.isRemote).map((x) => x.name)
        const m = i18n().git.tab.branchMenu
        return [
            {
                label: m.checkout({name: b.name}),
                icon: 'check',
                disabled: b.isCurrent,
                hint: b.isCurrent ? m.alreadyOn : undefined,
                onSelect: () => void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => { if (ok) void selectBranch(b) }),
            },
            {
                label: m.mergeInto({name: b.name, into: current?.name ?? m.theCurrent}),
                icon: 'merge',
                disabled: b.isCurrent,
                onSelect: () => run(`merge ${b.name}`, () => GitMerge(repoId, b.name, false)),
            },
            rebaseOntoItem(b),
            searchInBranchItem(b),
            'separator',
            {
                label: m.rename({name: b.name}),
                icon: 'edit',
                onSelect: () =>
                    setPrompt({
                        title: m.renameTitle({name: b.name}),
                        label: m.newName,
                        initial: b.name,
                        description: m.renameDesc,
                        onSubmit: (v) => run(`branch -m ${v}`, () => GitRenameBranch(repoId, b.name, v)),
                    }),
            },
            {
                label: m.setUpstream,
                icon: 'link',
                disabled: remoteCandidates.length === 0,
                hint: b.upstream ? m.upstreamNow({upstream: b.upstream}) : m.noUpstream,
                onSelect: () =>
                    setPrompt({
                        title: m.upstreamTitle({name: b.name}),
                        label: m.remoteBranch,
                        initial: b.upstream || remoteCandidates[0] || '',
                        placeholder: UPSTREAM_PLACEHOLDER,
                        description: m.upstreamDesc({remotes: remoteCandidates.join(', ') || m.none}),
                        onSubmit: (v) => run('branch --set-upstream-to', () => GitSetUpstream(repoId, b.name, v)),
                    }),
            },
            {
                label: m.unsetUpstream,
                icon: 'link_off',
                disabled: !b.upstream,
                hint: m.unsetUpstreamHint,
                onSelect: () => run('branch --unset-upstream', () => GitUnsetUpstream(repoId, b.name)),
            },
            {label: m.copyName({name: b.name}), icon: 'content_copy', onSelect: () => copy(b.name)},
            'separator',
            {
                label: m.delete({name: b.name}),
                icon: 'delete',
                danger: true,
                disabled: b.isCurrent,
                hint: b.isCurrent ? m.cantDeleteCurrent : undefined,
                onSelect: () =>
                    setConfirm({
                        title: m.deleteLocalTitle,
                        description: m.deleteLocalDesc({name: b.name}),
                        confirmLabel: i18n().common.delete,
                        command: 'branch -D',
                        run: () => GitDeleteBranch(repoId, b.name, true),
                    }),
            },
        ]
    }

    // Right-click menu for a tag row. Mirrors the sidebar tree's tag menu
    // (GitRepoTree.tagMenuItems) so the same right-click does the same thing
    // in both places, with two differences this panel can afford: it knows
    // which commit the graph is showing, and its confirmations go through
    // this tab's own setConfirm/setPrompt.
    function tagMenuItems(tag: git.Tag): (DropdownItem | 'separator')[] {
        const short = tag.hash.slice(0, 8)
        const m = i18n().git.tab.tagMenu
        return [
            {
                label: m.branchFrom({name: tag.name}),
                icon: 'account_tree',
                // Offered above checkout on purpose: checking a tag out leaves
                // the repository in detached HEAD, which is where people lose
                // commits. Branching from it is what someone who wants to work
                // from a release almost always actually means.
                hint: m.branchFromHint,
                onSelect: () =>
                    setPrompt({
                        title: m.branchFromTitle({name: tag.name}),
                        label: m.branchName,
                        initial: '',
                        description: m.branchFromDesc({hash: short}),
                        onSubmit: (v) => run(`checkout -b ${v} ${tag.name}`, () => GitCreateBranch(repoId, v, tag.name, true)),
                    }),
            },
            {
                label: m.checkout({name: tag.name}),
                icon: 'check',
                hint: m.checkoutHint,
                onSelect: () => run(`checkout ${tag.name}`, () => GitCheckout(repoId, tag.name)),
            },
            {label: m.copyName({name: tag.name}), icon: 'content_copy', onSelect: () => copy(tag.name)},
            {label: m.copyCommit({hash: short}), icon: 'content_copy', onSelect: () => copy(tag.hash)},
            'separator',
            {
                label: m.pushToOrigin({name: tag.name}),
                icon: 'upload',
                hint: m.pushHint,
                onSelect: () => run(`push origin ${tag.name}`, () => GitPushTag(repoId, 'origin', tag.name, new git.AuthConfig({}))),
            },
            'separator',
            // Local y remoto van separados a propósito: borrar un tag local lo
            // deja vivo en el servidor y viceversa, y es la sorpresa número uno
            // que da trabajar con tags. Un solo "Borrar" tendría que elegir por
            // el usuario cuál de las dos cosas hace.
            {
                label: m.delete({name: tag.name}),
                icon: 'delete',
                danger: true,
                hint: m.localOnly,
                onSelect: () =>
                    setConfirm({
                        title: m.deleteLocalTitle,
                        description: m.deleteLocalDesc({name: tag.name, hash: short}),
                        confirmLabel: i18n().common.delete,
                        command: 'tag -d',
                        run: () => GitDeleteTag(repoId, tag.name),
                    }),
            },
            {
                label: m.deleteFromOrigin({name: tag.name}),
                icon: 'delete_forever',
                danger: true,
                hint: m.remoteOnly,
                onSelect: () =>
                    setConfirm({
                        title: m.deleteRemoteTitle,
                        description: m.deleteRemoteDesc({name: tag.name, hash: short}),
                        confirmLabel: i18n().git.tab.branchMenu.deleteFromRemote,
                        command: 'push --delete',
                        run: () => GitDeleteRemoteTag(repoId, 'origin', tag.name, new git.AuthConfig({})),
                    }),
            },
        ]
    }

    // Right-click menu for a commit row.
    function commitMenuItems(c: git.CommitInfo): (DropdownItem | 'separator')[] {
        const short = c.shortHash
        const m = i18n().git.tab.commitMenu
        return [
            // Va primero porque es de solo lectura y sin consecuencias, a
            // diferencia de todo lo que sigue.
            {
                label: m.askAgent,
                icon: 'smart_toy',
                hint: m.askAgentHint,
                onSelect: () =>
                    askAgentPicking(
                        m.askAgentPrompt({hash: c.hash}),
                        `commit ${short}`,
                    ),
            },
            'separator',
            {
                label: m.rebaseFromHere,
                icon: 'low_priority',
                // Rebases onto this commit, so THIS one is the base and
                // everything after it is what gets rewritten — which is what
                // "desde acá" has to mean for the action to be predictable.
                onSelect: () => setRebaseBase({hash: c.hash, label: short}),
            },
            'separator',
            {
                label: m.branchHere,
                icon: 'account_tree',
                onSelect: () =>
                    setPrompt({
                        title: m.branchAtTitle({hash: short}),
                        label: i18n().git.tab.tagMenu.branchName,
                        placeholder: m.branchPlaceholder,
                        confirmLabel: m.createAndSwitch,
                        description: m.branchAtDesc({subject: c.subject}),
                        onSubmit: (v) => run(`checkout -b ${v}`, () => GitCreateBranch(repoId, v, c.hash, true)),
                    }),
            },
            {
                label: m.tagHere,
                icon: 'sell',
                onSelect: () =>
                    setPrompt({
                        title: m.tagAtTitle({hash: short}),
                        label: m.tagName,
                        placeholder: 'v1.0.0',
                        secondLabel: m.tagMessage,
                        secondPlaceholder: m.tagMessageHint,
                        confirmLabel: m.createTag,
                        description: m.tagAtDesc,
                        onSubmit: (v, msg) => run(`tag ${v}`, () => GitCreateTag(repoId, v, c.hash, msg)),
                    }),
            },
            {label: m.checkoutThis, icon: 'check', hint: m.checkoutThisHint, onSelect: () => run(`checkout ${short}`, () => GitCheckout(repoId, c.hash))},
            'separator',
            {
                label: m.revert({hash: short}),
                icon: 'undo',
                hint: m.revertHint,
                onSelect: () => run(`revert ${short}`, () => GitRevert(repoId, c.hash, false)),
            },
            {
                label: m.cherryPick({hash: short}),
                icon: 'content_paste',
                hint: m.cherryPickHint,
                onSelect: () => run(`cherry-pick ${short}`, () => GitCherryPick(repoId, c.hash, false)),
            },
            {label: i18n().git.tab.branchMenu.copyName({name: c.hash}), icon: 'content_copy', onSelect: () => copy(c.hash)},
            ...(c.branches.length > 0
                ? ([
                      'separator',
                      {
                          label: m.hideBranches({count: c.branches.length, first: c.branches[0]}),
                          icon: 'visibility_off',
                          hint: m.hideBranchesHint,
                          onSelect: () => setHidden((prev) => new Set([...prev, ...c.branches])),
                      },
                  ] as (DropdownItem | 'separator')[])
                : []),
            'separator',
            // The three resets are listed separately, worst-last, because they
            // differ enormously in what they destroy — a single "Reset" entry
            // with a mode picker buries that distinction behind another click.
            {
                label: m.resetSoft,
                icon: 'restart_alt',
                hint: m.resetSoftHint,
                onSelect: () => run('reset --soft', () => GitReset(repoId, c.hash, 'soft')),
            },
            {
                label: m.resetMixed,
                icon: 'restart_alt',
                hint: m.resetMixedHint,
                onSelect: () => run('reset --mixed', () => GitReset(repoId, c.hash, 'mixed')),
            },
            {
                label: m.resetHard,
                icon: 'restart_alt',
                danger: true,
                hint: m.resetHardHint,
                onSelect: () =>
                    setConfirm({
                        title: RESET_HARD,
                        description: m.resetHardDesc({branch: current?.name ?? i18n().git.tab.branchMenu.theCurrent, hash: short}),
                        confirmLabel: RESET_HARD,
                        command: 'reset --hard',
                        run: () => GitReset(repoId, c.hash, 'hard'),
                    }),
            },
        ]
    }

    // Lo mismo, pero para los archivos de un COMMIT: el resumen de un commit se
    // lee igual que se revisa uno propio —de arriba hacia abajo, archivo por
    // archivo— y obligar a saltar al panel de diff por cada uno convierte esa
    // lectura en veinte clics.
    //
    // Estado aparte del de la lista de cambios a propósito: son parches de
    // fuentes distintas (`git show <hash>` contra `git diff`) y vaciarlos junto
    // con el commit elegido tiene que ser una sola línea, no un filtro.
    const [commitDiffs, setCommitDiffs] = useState<Record<string, InlineDiffState>>({})

    const fetchCommitDiff = useCallback(
        (path: string, hash: string) => {
            GitDiff(repoId, new git.DiffTarget({mode: 'commit', commit: hash, path, contextLines: diffContext, ignoreWhitespace: diffIgnoreWs}))
                .then((d) => setCommitDiffs((prev) => (prev[path] ? {...prev, [path]: {loading: false, patch: d.patch, isBinary: d.isBinary, error: null}} : prev)))
                .catch((e) => setCommitDiffs((prev) => (prev[path] ? {...prev, [path]: {loading: false, patch: '', isBinary: false, error: String(e)}} : prev)))
        },
        [repoId, diffContext, diffIgnoreWs],
    )

    const toggleCommitDiff = useCallback(
        (path: string) => {
            const hash = selectedCommit?.hash
            if (!hash) return
            if (commitDiffs[path]) {
                setCommitDiffs((prev) => {
                    const next = {...prev}
                    delete next[path]
                    return next
                })
                return
            }
            setCommitDiffs((prev) => ({...prev, [path]: {loading: true, patch: '', isBinary: false, error: null}}))
            fetchCommitDiff(path, hash)
        },
        [commitDiffs, selectedCommit?.hash, fetchCommitDiff],
    )

    // Expandir todo es una lectura de un parche por archivo. Es barato en un
    // commit normal y no lo es en uno de cientos de archivos, así que el botón
    // se apaga arriba de ese tope en vez de disparar la avalancha y dejar la
    // pestaña trabada — ver CommitDetail, que explica el motivo en su tooltip.
    const expandAllCommitDiffs = useCallback(
        (paths: string[]) => {
            const hash = selectedCommit?.hash
            if (!hash) return
            setCommitDiffs((prev) => {
                const next = {...prev}
                for (const p of paths) if (!next[p]) next[p] = {loading: true, patch: '', isBinary: false, error: null}
                return next
            })
            for (const p of paths) if (!commitDiffs[p]) fetchCommitDiff(p, hash)
        },
        [commitDiffs, selectedCommit?.hash, fetchCommitDiff],
    )

    // Selecting a commit loads its file list. The diff for a specific file is
    // a separate fetch, made only once a file is picked — a commit touching
    // hundreds of files must not pull hundreds of patches.
    useEffect(() => {
        // Lo desplegado del commit anterior se pliega acá: dejar abierto el
        // diff de un archivo de otro commit mostraría un cambio que este no
        // hizo.
        setCommitDiffs({})
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
                // Antes se auto-seleccionaba el primer archivo para no dejar el
                // panel derecho en blanco. Ya no hace falta: el resumen ocupa el
                // panel entero y muestra los archivos con su churn. En su lugar
                // se DESPLIEGA el primero —una sola lectura de parche, la misma
                // que costaba la auto-selección— así un clic en el commit ya
                // muestra un cambio, y abrir el visor sigue siendo del usuario.
                setSelectedPath(null)
                const first = list.find((f) => !f.isBinary)
                if (!first) return
                setCommitDiffs({[first.path]: {loading: true, patch: '', isBinary: false, error: null}})
                fetchCommitDiff(first.path, selectedCommit.hash)
            })
            .catch((e) => !cancelled && setError(String(e)))
        return () => {
            cancelled = true
        }
    }, [repoId, selectedCommit, fetchCommitDiff])

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

    // Diffs desplegados DENTRO de la lista de cambios (uno por archivo).
    //
    // Viven acá y no en el panel porque el que sabe leer un diff es este
    // componente —tiene el repoId y las preferencias de contexto/espacios—, y
    // porque hay que refrescarlos cuando cambia el estado del repositorio:
    // stagear un archivo con su diff abierto cambia de qué lado se lee el
    // parche, y un panel que se quedara con el anterior mostraría un cambio que
    // ya no está donde dice.
    const [inlineDiffs, setInlineDiffs] = useState<Record<string, InlineDiffState>>({})

    const fetchInlineDiff = useCallback(
        (path: string, staged: boolean) => {
            GitDiff(
                repoId,
                new git.DiffTarget({
                    mode: staged ? 'staged' : 'worktree',
                    path,
                    contextLines: diffContext,
                    ignoreWhitespace: diffIgnoreWs,
                }),
            )
                .then((d) =>
                    // Solo se escribe si el archivo SIGUE desplegado: cerrarlo
                    // mientras cargaba no puede volver a abrirlo solo.
                    setInlineDiffs((prev) => (prev[path] ? {...prev, [path]: {loading: false, patch: d.patch, isBinary: d.isBinary, error: null}} : prev)),
                )
                .catch((e) =>
                    setInlineDiffs((prev) => (prev[path] ? {...prev, [path]: {loading: false, patch: '', isBinary: false, error: String(e)}} : prev)),
                )
        },
        [repoId, diffContext, diffIgnoreWs],
    )

    const toggleInlineDiff = useCallback(
        (path: string, staged: boolean) => {
            if (inlineDiffs[path]) {
                setInlineDiffs((prev) => {
                    const next = {...prev}
                    delete next[path]
                    return next
                })
                return
            }
            setInlineDiffs((prev) => ({...prev, [path]: {loading: true, patch: '', isBinary: false, error: null}}))
            fetchInlineDiff(path, staged)
        },
        [inlineDiffs, fetchInlineDiff],
    )

    // Refresco silencioso de los diffs abiertos, con el mismo criterio que el
    // del panel derecho: el archivo que dejó de tener cambios se cierra —su
    // parche ya no existe— y el resto se vuelve a leer sin spinner.
    //
    // Las rutas se leen de un ref y no del estado para que escribir el
    // resultado no vuelva a disparar este efecto.
    const openInlineRef = useRef<string[]>([])
    useEffect(() => {
        openInlineRef.current = Object.keys(inlineDiffs)
    }, [inlineDiffs])

    useEffect(() => {
        // Sin `status` no se decide nada: todavía no se sabe si el archivo
        // sigue teniendo cambios, y darlo por cerrado plegaría un diff que el
        // usuario acababa de abrir.
        if (view !== 'changes' || !status || openInlineRef.current.length === 0) return
        for (const path of openInlineRef.current) {
            const entry = status?.files.find((f) => f.path === path)
            if (!entry) {
                setInlineDiffs((prev) => {
                    const next = {...prev}
                    delete next[path]
                    return next
                })
                continue
            }
            fetchInlineDiff(path, entry.staged)
        }
    }, [status, view, fetchInlineDiff])

    const persistDiffPrefs = useCallback((context: number, ignoreWs: boolean, wrap: boolean) => {
        setDiffContext(context)
        setDiffIgnoreWs(ignoreWs)
        setDiffWrap(wrap)
        void GitSetDiffPrefs(context, ignoreWs, wrap).catch(() => {})
    }, [])

    const current = branches.find((b) => b.isCurrent)
    const upstream = current?.upstream ?? ''

    const remoteNames = [...new Set(branches.filter((b) => b.isRemote).map((b) => b.name.split('/')[0]))].filter(Boolean)
    const fetchItems: (DropdownItem | 'separator')[] = [
        {label: CMD.fetch, hint: g.fetch.fetchHint, icon: 'cloud_download', onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({}), new git.AuthConfig({})))},
        {label: CMD.fetchAll, hint: g.fetch.allHint, onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({all: true}), new git.AuthConfig({})))},
        {label: CMD.fetchTags, hint: g.fetch.tagsHint, onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({tags: true}), new git.AuthConfig({})))},
        {label: CMD.fetchPrune, hint: g.fetch.pruneHint, onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({prune: true}), new git.AuthConfig({})))},
        // Fetch de UN remoto. Estaba en el menú de cada remoto del árbol de
        // ramas que se fue de esta pestaña; con varios remotos sigue siendo la
        // forma de traer solo uno.
        ...(remoteNames.length > 1
            ? ([
                  'separator',
                  ...remoteNames.map(
                      (r): DropdownItem => ({
                          label: g.folderMenu.fetchFrom({remote: r}),
                          icon: 'cloud_download',
                          hint: g.folderMenu.fetchFromHint,
                          onSelect: () => run('fetch', () => GitFetch(repoId, new git.FetchOptions({remote: r}), new git.AuthConfig({}))),
                      }),
                  ),
              ] as (DropdownItem | 'separator')[])
            : []),
    ]

    const pullItems: DropdownItem[] = [
        {label: CMD.pull, hint: g.pull.pullHint, icon: 'download', onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({}), new git.AuthConfig({})))},
        {label: CMD.pullFfOnly, hint: g.pull.ffOnlyHint, onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({ffOnly: true}), new git.AuthConfig({})))},
        {label: CMD.pullRebase, hint: g.pull.rebaseHint, onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({rebase: true}), new git.AuthConfig({})))},
        {label: CMD.pullRebaseAutostash, hint: g.pull.autostashHint, onSelect: () => run('pull', () => GitPull(repoId, new git.PullOptions({rebase: true, autostash: true}), new git.AuthConfig({})))},
    ]

    // La recuperación de "esta rama todavía no tiene upstream" vale para
    // TODAS las variantes de push, no solo para el push pelado.
    //
    // Era el motivo real por el que "push --force no funcionaba": git rechaza
    // un --force en una rama sin publicar exactamente igual que un push
    // simple ("The current branch X has no upstream branch"), y el arreglo
    // inline estaba escrito a mano dentro del ítem "push" nada más. Desde
    // --force, --force-with-lease, --tags o --no-verify el error caía en el
    // banner genérico y la acción no pasaba nunca — se veía como que la
    // opción estaba rota, cuando lo que faltaba era el vínculo con el remoto.
    //
    // El reintento CONSERVA los flags originales: forzar y vincular es un
    // solo `push --force --set-upstream`, no dos pasos donde el primero
    // publica sin forzar.
    const recoverMissingUpstream = useCallback(
        (opts: Record<string, unknown>, label: string) => (e: unknown): boolean => {
            if (!current?.name || !String(e).includes('no upstream branch')) return false
            const m = i18n().git.tab.push
            setConfirm({
                title: m.publishTitle,
                description: m.publishDesc({branch: current.name, command: label}),
                confirmLabel: m.publishConfirm,
                command: `${label} --set-upstream`,
                danger: false,
                run: () =>
                    GitPush(repoId, new git.PushOptions({...opts, setUpstream: true, remote: 'origin', branch: current.name}), new git.AuthConfig({})),
            })
            return true
        },
        [repoId, current?.name],
    )

    // Único punto por el que sale un push, para que la recuperación de arriba
    // no haya que acordarse de enchufarla en cada ítem nuevo del menú.
    const pushWith = useCallback(
        (opts: Record<string, unknown>, label: string) =>
            run('push', () => GitPush(repoId, new git.PushOptions(opts), new git.AuthConfig({})), recoverMissingUpstream(opts, label)),
        [repoId, run, recoverMissingUpstream],
    )

    // Alta de ramas y tags DESDE EL PANEL LATERAL.
    //
    // Faltaba entera: el panel listaba, filtraba, plegaba, anclaba, borraba y
    // publicaba ramas y tags, pero para CREAR uno había que irse al grafo,
    // encontrar un commit y usar su menú contextual. Un rodeo largo para lo
    // que casi siempre arranca donde ya estás parado — por eso las dos altas
    // de acá parten de HEAD y lo dicen en la descripción, en vez de pedir un
    // punto de partida que el 90% de las veces es "acá".
    const promptCreateBranch = useCallback(
        (prefix: string) =>
            setPrompt({
                title: prefix ? i18n().git.tab.create.branchInTitle({prefix}) : i18n().git.tab.create.branchTitle,
                label: i18n().git.tab.tagMenu.branchName,
                // Con el prefijo puesto, una convención de nombres se sostiene
                // sola en vez de depender de que cada uno lo escriba igual.
                initial: prefix ? `${prefix}/` : '',
                placeholder: i18n().git.tab.commitMenu.branchPlaceholder,
                confirmLabel: i18n().git.tab.commitMenu.createAndSwitch,
                description: current?.name
                    ? i18n().git.tab.create.branchDescAt({branch: current.name})
                    : i18n().git.tab.create.branchDesc,
                onSubmit: (v) => run(`checkout -b ${v}`, () => GitCreateBranch(repoId, v, '', true)),
            }),
        [repoId, current?.name, run],
    )

    const promptCreateTag = useCallback(
        () =>
            setPrompt({
                title: i18n().git.tab.commitMenu.createTag,
                label: i18n().git.tab.commitMenu.tagName,
                placeholder: 'v1.0.0',
                secondLabel: i18n().git.tab.commitMenu.tagMessage,
                secondPlaceholder: i18n().git.tab.commitMenu.tagMessageHint,
                confirmLabel: i18n().git.tab.commitMenu.createTag,
                description: current?.name
                    ? i18n().git.tab.create.tagDescAt({branch: current.name})
                    : i18n().git.tab.create.tagDesc,
                onSubmit: (v, msg) => run(`tag ${v}`, () => GitCreateTag(repoId, v, '', msg)),
            }),
        [repoId, current?.name, run],
    )

    // Git Flow, nativo: solo escribe la configuración y crea ramas.
    //
    // El menú cambia de forma según el estado porque son dos preguntas
    // distintas y mezclarlas confunde: sin inicializar hay una sola cosa que
    // hacer, y una vez inicializado "inicializar" no vuelve a ofrecerse.
    const gitFlowItems = (): (DropdownItem | 'separator')[] => {
        if (!flow) return []
        if (!flow.initialized) {
            return [
                {
                    label: g.flow.init,
                    icon: 'account_tree',
                    hint: g.flow.initHint({develop: flow.develop, master: flow.master}),
                    onSelect: () =>
                        setConfirm({
                            title: g.flow.initTitle,
                            description: g.flow.initDesc({feature: flow.feature, release: flow.release, hotfix: flow.hotfix, develop: flow.develop, master: flow.master}),
                            confirmLabel: g.flow.initConfirm,
                            command: 'git flow init',
                            danger: false,
                            run: () => GitFlowInit(repoId, new git.GitFlowConfig({})),
                        }),
                },
            ]
        }

        // La BASE de cada tipo va en el hint porque es lo único de git-flow
        // que hay que saber y lo que más se equivoca a mano: un hotfix
        // arrancado desde develop se lleva a producción todo lo que develop
        // tenga sin publicar.
        const start = (kind: string, label: string, prefix: string, base: string): DropdownItem => ({
            label: g.flow.startLabel({label}),
            icon: kind === 'hotfix' ? 'emergency' : 'account_tree',
            hint: g.flow.startHint({prefix, base}),
            onSelect: () =>
                setPrompt({
                    title: label,
                    label: g.chat.nameLabel,
                    placeholder: kind === 'release' || kind === 'hotfix' ? '1.2.0' : g.flow.featurePlaceholder,
                    confirmLabel: g.commitMenu.createAndSwitch,
                    description: g.flow.startDesc({prefix, base}),
                    onSubmit: (v) => run(`git flow ${kind} start`, () => GitFlowStart(repoId, kind, v)),
                }),
        })

        return [
            start('feature', g.flow.newFeature, flow.feature, flow.develop),
            start('release', g.flow.newRelease, flow.release, flow.develop),
            start('hotfix', g.flow.newHotfix, flow.hotfix, flow.master),
        ]
    }

    // "Buscar en esta rama…" — acota el grafo a la historia de esa rama y
    // deja el cursor listo para el término.
    //
    // No es una búsqueda nueva: el buscador ya entendía `hash:<algo>`, que
    // acepta un hash, un tag o una rama. Lo que faltaba era la puerta de
    // entrada — había que saber que el prefijo existía y escribir el nombre
    // de la rama a mano, con lo cual la función existía sin ser usable desde
    // donde se piensa ("quiero buscar algo en ESTA rama").
    const searchInBranchItem = (b: git.Branch): DropdownItem => ({
        label: g.branchMenu.searchIn({name: b.name}),
        icon: 'manage_search',
        hint: g.branchMenu.searchInHint,
        onSelect: () => prefillSearch(`hash:${b.name} `),
    })

    // "Rebase la rama actual SOBRE esta" — el rebase plano, que hasta ahora
    // no existía: lo único que el módulo sabía hacer era el interactivo
    // (reordenar los commits de la propia rama desde el grafo), que es otra
    // operación y se pide desde otro lado.
    //
    // La dirección importa y por eso está escrita entera en la etiqueta: lo
    // que se reescribe es la rama en la que estás parado, no la que tocaste
    // con el botón derecho. Al revés es lo que la gente teme al ver "rebase"
    // en el menú de una rama ajena.
    const rebaseOntoItem = (b: git.Branch): DropdownItem => ({
        label: g.branchMenu.rebaseOnto({current: current?.name ?? g.branchMenu.theCurrent, name: b.name}),
        icon: 'low_priority',
        hint: g.branchMenu.rebaseOntoHint,
        disabled: b.isCurrent,
        danger: true,
        onSelect: () =>
            setConfirm({
                title: g.branchMenu.rebaseOntoTitle,
                description: g.branchMenu.rebaseOntoDesc({current: current?.name ? `"${current.name}"` : g.branchMenu.theCurrent, name: b.name}),
                confirmLabel: g.branchMenu.rebaseOntoConfirm,
                command: `rebase ${b.name}`,
                danger: true,
                run: () => GitRebase(repoId, b.name, true),
            }),
    })

    const pushItems: (DropdownItem | 'separator')[] = [
        {
            label: CMD.push,
            hint: g.push.pushHint,
            icon: 'upload',
            onSelect: () => void pushWith({}, 'push'),
        },
        {
            label: CMD.pushSetUpstream,
            hint: g.push.setUpstreamHint,
            disabled: !!upstream,
            onSelect: () => run('push', () => GitPush(repoId, new git.PushOptions({setUpstream: true, remote: 'origin', branch: current?.name ?? ''}), new git.AuthConfig({}))),
        },
        {label: CMD.pushTags, hint: g.fetch.tagsHint, onSelect: () => void pushWith({tags: true}, 'push --tags')},
        'separator',
        // Revisar ANTES de publicar, que es cuando todavía se puede arreglar
        // barato. No pushea: abre el chat con el prompt escrito.
        {
            label: g.push.review,
            icon: 'smart_toy',
            hint: upstream ? g.push.reviewHint({upstream}) : g.push.reviewHintNoUpstream,
            onSelect: () =>
                askAgentPicking(
                    upstream ? g.push.reviewPrompt({upstream}) : g.push.reviewPromptNoUpstream,
                    g.push.reviewAbout,
                ),
        },
        'separator',
        {
            label: CMD.pushForceWithLease,
            hint: g.push.forceWithLeaseHint,
            danger: true,
            onSelect: () => void pushWith({forceWithLease: true}, 'push --force-with-lease'),
        },
        {
            // La única variante que pide confirmación, por la misma regla que
            // ya siguen `reset --hard`, `branch -D` y `push --delete` en este
            // mismo menú: lo que se pierde no está en el reflog de nadie.
            // --force-with-lease no la pide porque aborta solo cuando habría
            // pisado algo.
            label: CMD.pushForce,
            hint: g.push.forceHint,
            danger: true,
            onSelect: () =>
                setConfirm({
                    title: g.push.forceTitle,
                    description: g.push.forceDesc({target: upstream ? `"${upstream}"` : g.push.forceRemoteBranch}),
                    confirmLabel: g.push.forceConfirm,
                    command: 'push --force',
                    danger: true,
                    run: () => GitPush(repoId, new git.PushOptions({force: true}), new git.AuthConfig({})),
                    onError: recoverMissingUpstream({force: true}, 'push --force'),
                }),
        },
        {label: CMD.pushNoVerify, hint: g.push.noVerifyHint, danger: true, onSelect: () => void pushWith({noVerify: true}, 'push --no-verify')},
    ]

    // La acción de siempre de un menú partido (Fetch / Pull / Push): su primer
    // ítem. El menú ofrece las variantes; el clic en el botón hace la normal.
    const firstAction = (items: (DropdownItem | 'separator')[]): (() => void) => {
        const first = items.find((i): i is DropdownItem => i !== 'separator')
        return first ? first.onSelect : () => {}
    }

    // El panel derecho nunca se come el grafo: deja al centro al menos 300px.
    const effDiffWidth =
        layoutW > 0 ? Math.max(200, Math.min(diffWidth, layoutW - (sideHidden ? 36 : sideWidth) - 300)) : diffWidth

    const staged = status?.files?.filter((f) => f.staged) ?? []
    const unstaged = status?.files?.filter((f) => !f.staged) ?? []

    // Las ramas que entran en «Solo mi trabajo» (la actual, los troncos que
    // existen y las ancladas), en ese orden. La columna de Historial las ofrece
    // como saltos rápidos; el resto de las ramas se busca desde el chip de la
    // barra.
    const quickRefs = useMemo(
        () => focusRefsOf(branches, pinned).map((n) => branches.find((b) => b.name === n)).filter((b): b is git.Branch => !!b),
        [branches, pinned],
    )

    // El mensaje del commit al que apunta HEAD, para precargar «Enmendar».
    const lastCommitMessage = useMemo(() => {
        const head = commits.find((c) => c.isHead)
        return head ? (head.body ? `${head.subject}\n\n${head.body}` : head.subject) : ''
    }, [commits])

    // Stash elegido en la lista. Se mantiene apuntando a uno que exista: el
    // más nuevo es el que casi siempre se quiere, y borrar el elegido no debe
    // dejar la vista previa colgada de una referencia que ya no está.
    const [selectedStash, setSelectedStash] = useState<string | null>(null)
    useEffect(() => {
        if (!stashes.some((x) => x.ref === selectedStash)) setSelectedStash(stashes[0]?.ref ?? null)
    }, [stashes, selectedStash])

    // Contenedor, dentro de la columna de trabajo, donde el editor de archivos
    // dibuja su árbol (portal). Estado y no ref: el editor tiene que enterarse
    // cuando aparece.
    const [filesHost, setFilesHost] = useState<HTMLDivElement | null>(null)

    // Prellena el buscador de commits y deja el cursor adentro: lo que se
    // prellena es el ÁMBITO («en esta rama»), lo que falta escribir es el
    // término. El buscador vive en la columna de Historial, así que primero se
    // pasa a esa solapa.
    const prefillSearch = (text: string) => {
        setView('commits')
        setSearchText(text)
        setSearch(parseGitSearch(text))
        // Dos frames: el primero monta la columna de Historial, el segundo ya
        // tiene el input para enfocar.
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                const el = searchInputRef.current
                if (!el) return
                el.focus()
                el.setSelectionRange(text.length, text.length)
            }),
        )
    }

    // Pedidos de la barra lateral principal (lib/gitBus.ts): revelar una rama o
    // un tag en el grafo, buscar en una rama, y el aviso de ramas ancladas
    // cambiadas. El handler se lee de un ref para suscribirse UNA vez por
    // pestaña sin quedar atado a las funciones de un render viejo.
    const gitRequestRef = useRef<(r: GitRequest) => void>(() => {})
    gitRequestRef.current = (r) => {
        if (r.kind === 'reveal-branch') {
            const b = branches.find((x) => x.name === r.name) ?? new git.Branch({name: r.name, hash: r.hash})
            void selectBranch(b)
        } else if (r.kind === 'reveal-commit') void revealCommit(r.hash)
        else if (r.kind === 'search-branch') prefillSearch(`hash:${r.name} `)
        else if (r.kind === 'pinned-changed') setPinned(r.pinned)
    }
    useEffect(() => onGitRequest(repoId, (r) => gitRequestRef.current(r)), [repoId])

    // Los pedidos hechos antes de que la pestaña existiera (la barra abre la
    // pestaña y después pide) se recogen una sola vez, cuando ya hay ramas y
    // commits contra los que resolverlos.
    const pendingTaken = useRef(false)
    useEffect(() => {
        if (pendingTaken.current || loadingLog || branches.length === 0 || commits.length === 0) return
        pendingTaken.current = true
        for (const r of takePendingGit(repoId)) gitRequestRef.current(r)
    }, [repoId, loadingLog, branches, commits])

    const checkoutBranch = (b: git.Branch) =>
        void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => {
            if (ok) void selectBranch(b)
        })

    // Cambiar/atajar la vista de paneles. Los mismos ítems viven en el menú de
    // la barra y, cuando no entran, en su «⋯».
    const viewItems: (DropdownItem | 'separator')[] = [
        {
            label: sideHidden ? g.viewMenu.showBranches : g.viewMenu.hideBranches,
            icon: sideHidden ? 'visibility' : 'visibility_off',
            hint: sideHidden ? g.viewMenu.nowHidden : g.viewMenu.left,
            onSelect: toggleSide,
        },
        {
            label: diffHidden ? g.viewMenu.showDiff : g.viewMenu.hideDiff,
            icon: diffHidden ? 'visibility' : 'visibility_off',
            hint: diffHidden ? g.viewMenu.nowHidden : g.viewMenu.right,
            onSelect: toggleDiff,
        },
        'separator',
        {
            label: showWorktrees ? g.viewMenu.hideWorktrees : g.viewMenu.showWorktrees,
            icon: 'dashboard',
            hint: g.viewMenu.worktreesHint,
            onSelect: () => setShowWorktrees((v) => !v),
        },
        {
            label: showSubmodules ? g.viewMenu.hideSubmodules : g.viewMenu.showSubmodules,
            icon: 'account_tree',
            hint: g.viewMenu.submodulesHint,
            onSelect: () => setShowSubmodules((v) => !v),
        },
        'separator',
        // Los dos archivos de configuración que se editan a mano y viven en la
        // raíz del repositorio. El editor ya abre como NUEVO y vacío un archivo
        // que no existe, así que «crear» y «editar» son lo mismo acá.
        ...gitFlowItems(),
        'separator',
        {
            label: g.viewMenu.editFile({file: '.gitignore'}),
            icon: 'rule',
            hint: g.viewMenu.gitignoreHint,
            onSelect: () => {
                setEditRequest({path: '.gitignore', token: Date.now()})
                setView('files')
            },
        },
        {
            label: g.viewMenu.editFile({file: '.gitattributes'}),
            icon: 'tune',
            hint: g.viewMenu.gitattributesHint,
            onSelect: () => {
                setEditRequest({path: '.gitattributes', token: Date.now()})
                setView('files')
            },
        },
    ]

    // El diff del archivo elegido. Se arma una vez y se coloca donde toque: en
    // el área principal cuando se trabaja en Cambios (donde es el protagonista),
    // en el panel derecho cuando se mira el historial.
    const diffViewer = selectedPath ? (
        <DiffViewer
            patch={diff?.patch ?? ''}
            isBinary={diff?.isBinary ?? false}
            path={selectedPath}
            loading={loadingDiff}
            error={diffError}
            editorThemeId={editorThemeId}
            appTheme={appTheme}
            appearance={appearance}
            context={diffContext}
            ignoreWs={diffIgnoreWs}
            wrap={diffWrap}
            onChangePrefs={persistDiffPrefs}
            // Only the working-tree/index views can be staged from. A commit's
            // diff is history: there is nothing to prepare.
            staged={view === 'changes' && stagedPaths(status).includes(selectedPath)}
            blame={blame ?? undefined}
            // A commit's diff is blamed AT that commit, so its added lines
            // belong to it and map to the new side. A working-tree diff is
            // blamed at HEAD, where the added lines do not exist yet.
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
            // Solo desde el working tree. En el diff de un commit «editar»
            // llevaría al archivo de HOY, que puede no tener nada que ver con
            // las líneas que se están mirando.
            onEdit={
                view === 'changes'
                    ? () => {
                          setEditRequest({path: selectedPath, token: Date.now()})
                          setView('files')
                      }
                    : undefined
            }
            onAsk={
                view === 'changes'
                    ? () =>
                          askAgentPicking(
                              // Se nombra el archivo y se le pide al agente que
                              // mire el diff él mismo: `git diff` es una
                              // herramienta que los tres tienen, y pegar el
                              // parche entero en el prompt gasta contexto y
                              // rompe el pegado del PTY.
                              g.ask.diffPrompt({path: selectedPath}),
                              g.ask.diffAbout({path: selectedPath}),
                          )
                    : undefined
            }
            onApplyPatch={
                view === 'changes'
                    ? (patch, action) => {
                          if (action === 'discard') {
                              setConfirmDiscardPatch(patch)
                              return
                          }
                          // stage = apply to the index; unstage = the same
                          // patch, applied to the index in reverse.
                          void run(action === 'stage' ? 'apply --cached' : 'apply --cached --reverse', () =>
                              GitApplyPatch(repoId, patch, true, action === 'unstage'),
                          )
                      }
                    : undefined
            }
        />
    ) : null

    const stashToConfirmDrop = (ref: string) => {
        const st = stashes.find((x) => x.ref === ref)
        setConfirm({
            title: t.git.stash.confirmTitle,
            description: t.git.stash.confirmBody({message: st?.message ?? ref}),
            confirmLabel: t.git.stash.drop,
            command: 'stash drop',
            run: () => GitStashDrop(repoId, ref),
        })
    }

    return (
        // min-w-0 is load-bearing, not cosmetic: without it this root's
        // min-width defaults to its content (min-content), which includes the
        // fixed-width right diff pane that cannot shrink. The root then refuses
        // to shrink below ~1700px, overflows the tab's overflow-hidden wrapper,
        // and the diff pane is clipped off the right edge — the "no se ve el
        // diff" bug. Every level of a nested flex chain that must shrink needs
        // this; the layout row below carries it for the same reason.
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-surface">
            {/* Barra única: repo + rama a la izquierda, sincronizar / abrir /
                ajustes a la derecha. Ver GitToolbar. */}
            <GitToolbar
                repoName={repoName}
                branchLabel={status?.detached ? g.toolbar.detached : (current?.name ?? status?.branch ?? '—')}
                detached={!!status?.detached}
                branchTitle={upstream ? g.toolbar.currentBranchTracking({upstream}) : g.toolbar.currentBranchNoUpstream}
                ahead={current?.ahead ?? 0}
                behind={current?.behind ?? 0}
                branches={branches}
                tags={tags}
                pinned={pinned}
                onCheckout={checkoutBranch}
                onRevealBranch={(b) => void selectBranch(b)}
                onTogglePin={(name) => void togglePinned(name)}
                onBranchMenu={(b, e) => setMenu({x: e.clientX, y: e.clientY, items: branchMenuItems(b)})}
                onRevealTag={(tg) => void revealCommit(tg.hash)}
                onTagMenu={(tg, e) => setMenu({x: e.clientX, y: e.clientY, items: tagMenuItems(tg)})}
                onCreateBranch={() => promptCreateBranch('')}
                onCreateTag={promptCreateTag}
                onManageRemotes={() => openSettings('remotes')}
                hiddenNames={[...hidden]}
                onUnhide={() => setHidden(new Set())}
                busy={!!busy}
                fetchItems={fetchItems}
                pullItems={pullItems}
                pushItems={pushItems}
                onFetch={firstAction(fetchItems)}
                onPull={firstAction(pullItems)}
                onPush={firstAction(pushItems)}
                onReload={() => void reload()}
                onSettings={() => openSettings('identity')}
                forge={forge?.compareUrl ? {provider: forge.provider, compareUrl: forge.compareUrl} : null}
                onCreatePr={() => forge && void GitOpenInBrowser(forge.compareUrl)}
                onDescribePr={() =>
                    askAgentPicking(
                        g.bar.describePrPrompt({branch: status?.branch ?? ''}),
                        g.bar.describePrAbout({branch: status?.branch ?? g.bar.thisBranch}),
                    )
                }
                agentMode={agentMode}
                onToggleAgentMode={toggleAgentMode}
                viewItems={viewItems}
                editors={editors}
                onOpenEditor={(id) => {
                    void OpenRepoInEditor(repoId, id).catch((e) => setError(String(e)))
                }}
                onOpenFolder={() => {
                    void OpenRepoInFileManager(repoId).catch((e) => setError(String(e)))
                }}
                onOpenTerminal={() => openPanel('terminal')}
                panelOpen={panelTab !== null}
                onOpenAgentsPanel={() => openPanel('agents')}
            />

            {busy && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-primary-container px-3 py-1.5 text-ui-11 font-medium text-on-primary-container">
                    <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-t-transparent border-on-primary-container" />
                    {g.toolbar.running.before}<span className="font-mono">{GIT} {busy}</span>{g.toolbar.running.after}
                </div>
            )}
            {inProgress && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-error-container/50 px-3 py-1.5 text-ui-11 text-on-error-container">
                    <Icon name="warning" size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1">
                        {g.inProgress.before}<span className="font-mono">{inProgress}</span>{g.inProgress.after}
                    </span>
                    <button
                        onClick={() => setView('conflicts')}
                        title={g.inProgress.resolveTitle}
                        className="shrink-0 rounded bg-primary px-2 py-0.5 text-on-primary hover:opacity-90"
                    >
                        {g.inProgress.resolve}
                    </button>
                    {/* El abortar valía para merge, cherry-pick y revert pero
                        NO para rebase — justamente la única que reescribe
                        historia— porque no había backend detrás. Ahora sí:
                        RebaseAbort devuelve el repositorio a donde estaba. */}
                    <button
                        onClick={() => run(`${inProgress} --abort`, () => GitAbort(repoId, inProgress))}
                        disabled={!!busy}
                        title={g.inProgress.abortTitle({op: inProgress})}
                        className="shrink-0 rounded bg-error px-2 py-0.5 text-on-error hover:opacity-90 disabled:opacity-40"
                    >
                        {g.inProgress.abort}
                    </button>
                </div>
            )}
            {showWorktrees && (
                <div className="shrink-0 border-b border-outline-variant bg-surface-container-low px-2 py-1 text-ui-11">
                    {worktrees.length === 0 ? (
                        <p className="text-on-surface-variant">{g.worktrees.onlyOne}</p>
                    ) : (
                        worktrees.map((w) => (
                            <div key={w.path} className="flex items-center gap-2 py-0.5">
                                <Icon name={w.isMain ? 'home' : 'dashboard'} size={12} className="shrink-0 text-on-surface-variant" />
                                <span className="shrink-0 font-mono text-on-surface">{w.branch || w.head.slice(0, 7)}</span>
                                <span className="min-w-0 flex-1 truncate text-on-surface-variant/70" title={w.path}>
                                    {w.path}
                                </span>
                                {w.prunable && (
                                    <span className="shrink-0 text-tertiary" title={w.reason || g.worktrees.folderGoneTitle}>
                                        {g.worktrees.folderGone}
                                    </span>
                                )}
                                {w.isMain ? (
                                    <span className="shrink-0 text-on-surface-variant/60">{g.worktrees.main}</span>
                                ) : (
                                    <button
                                        onClick={() => void run('worktree remove', () => GitRemoveWorktree(repoId, w.path, false))}
                                        title={g.worktrees.removeTitle}
                                        className="shrink-0 rounded px-1 text-error hover:bg-error-container"
                                    >
                                        {g.worktrees.remove}
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            )}

            {showSubmodules && (
                <div className="shrink-0 border-b border-outline-variant bg-surface-container-low px-2 py-1 text-ui-11">
                    {/* Acciones de todo el conjunto. "Actualizar" y
                        "Actualizar e inicializar" son dos botones y no uno
                        con checkbox porque son dos decisiones distintas: el
                        segundo CLONA por red los submódulos que nunca se
                        bajaron, contra URLs para las que puede que no tengas
                        credenciales. */}
                    <div className="flex flex-wrap items-center gap-1 pb-1">
                        <span className="mr-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{g.submodules.heading}</span>
                        <button
                            onClick={() =>
                                setPrompt({
                                    title: g.submodules.addTitle,
                                    label: g.submodules.urlLabel,
                                    placeholder: g.submodules.urlPlaceholder,
                                    secondLabel: g.submodules.folderLabel,
                                    secondPlaceholder: g.submodules.folderPlaceholder,
                                    confirmLabel: g.submodules.addConfirm,
                                    description: g.submodules.addDesc,
                                    onSubmit: (url, path) =>
                                        run('submodule add', () => GitAddSubmodule(repoId, url, path, '', new git.AuthConfig({}))),
                                })
                            }
                            title={g.submodules.addButtonTitle}
                            className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {g.submodules.addButton}
                        </button>
                        <button
                            onClick={() => void run('submodule update', () => GitUpdateSubmodules(repoId, false, true, new git.AuthConfig({})))}
                            title={g.submodules.updateAllTitle}
                            className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {g.submodules.updateAll}
                        </button>
                        <button
                            onClick={() => void run('submodule update --init', () => GitUpdateSubmodules(repoId, true, true, new git.AuthConfig({})))}
                            title={g.submodules.updateInitTitle}
                            className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {g.submodules.updateInit}
                        </button>
                        <button
                            onClick={() => void run('submodule sync', () => GitSyncSubmodules(repoId, true))}
                            title={g.submodules.syncTitle}
                            className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {g.submodules.sync}
                        </button>
                    </div>

                    {submodules.length === 0 ? (
                        <p className="text-on-surface-variant">{g.submodules.none}</p>
                    ) : (
                        submodules.map((m) => (
                            <div key={m.path} className="flex items-center gap-2 py-0.5">
                                <Icon
                                    name={m.conflicted ? 'error' : m.initialized ? 'account_tree' : 'download'}
                                    size={12}
                                    className={`shrink-0 ${m.conflicted ? 'text-error' : 'text-on-surface-variant'}`}
                                />
                                <span className="shrink-0 font-mono text-on-surface" title={m.url || g.submodules.noUrl}>
                                    {m.path}
                                </span>
                                <span
                                    className="min-w-0 flex-1 truncate font-mono text-on-surface-variant/70"
                                    title={g.submodules.pinnedAt({hash: m.hash})}
                                >
                                    {m.described || m.hash.slice(0, 7)}
                                </span>
                                {!m.initialized && (
                                    <span
                                        className="shrink-0 text-tertiary"
                                        title={g.submodules.uninitTitle}
                                    >
                                        {g.submodules.uninit}
                                    </span>
                                )}
                                {m.modified && (
                                    <span
                                        className="shrink-0 text-tertiary"
                                        title={g.submodules.movedTitle}
                                    >
                                        {g.submodules.moved}
                                    </span>
                                )}
                                {m.conflicted && (
                                    <span className="shrink-0 text-error" title={g.submodules.conflictTitle}>
                                        {g.submodules.conflict}
                                    </span>
                                )}
                                <button
                                    onClick={() =>
                                        void run('submodule update', () =>
                                            GitUpdateSubmodule(repoId, m.path, !m.initialized, true, new git.AuthConfig({})),
                                        )
                                    }
                                    title={m.initialized ? g.submodules.updateOneTitle({path: m.path}) : g.submodules.initOneTitle({path: m.path})}
                                    className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    {m.initialized ? g.submodules.update : g.submodules.init}
                                </button>
                                <button
                                    onClick={() =>
                                        setConfirm({
                                            title: g.submodules.removeTitle,
                                            description: g.submodules.removeDesc({path: m.path}),
                                            confirmLabel: g.worktrees.remove,
                                            command: `submodule deinit ${m.path}`,
                                            run: () => GitRemoveSubmodule(repoId, m.path),
                                        })
                                    }
                                    title={g.submodules.removeButtonTitle({path: m.path})}
                                    className="shrink-0 rounded px-1 text-error hover:bg-error-container"
                                >
                                    {g.worktrees.remove}
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}

            {error && <Banner kind="error" text={error} onClose={() => setError(null)} />}
            {notice && (
                <GitOutputNotice
                    text={notice}
                    onClose={() => setNotice(null)}
                    onOpenFile={(path) => {
                        setEditRequest({path, token: Date.now()})
                        setView('files')
                    }}
                    onRevealCommit={(hash) => void revealCommit(hash)}
                />
            )}

            {/* Cuerpo de la pestaña. El panel de la terminal se dibuja
                ENCIMA en position:absolute y el área principal le hace lugar
                con un margen, en vez de ser un hermano en el flujo: así el
                panel ocupa siempre el mismo lugar del árbol de React sin
                importar dónde esté anclado, y moverlo de lado no lo remonta
                (lo que mataría la shell). */}
            <div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1">
            <div
                ref={layoutRef}
                className="flex min-h-0 min-w-0 flex-1"
                style={
                    panelTab === null
                        ? undefined
                        : {
                              marginBottom: dock === 'bottom' ? panelSize : undefined,
                              marginLeft: dock === 'left' ? panelSize : undefined,
                              marginRight: dock === 'right' ? panelSize : undefined,
                          }
                }
            >
                {/* Izquierda: la columna de TRABAJO. Cuatro solapas —Historial,
                    Cambios, Stash, Archivos— y lo que cada una opera. El árbol
                    de ramas/remotas/tags que vivía acá repetía el de la barra
                    lateral principal y se fue; el cambio rápido de rama está en
                    el chip de la barra de arriba. */}
                {(!sideHidden || !agentMode) && (
                    <GitWorkPanel
                        view={view === 'conflicts' ? 'conflicts' : view}
                        onView={(v) => setView(v)}
                        changesCount={status?.files.length ?? 0}
                        stashCount={stashes.length}
                        width={sideWidth}
                        collapsed={sideHidden}
                        onToggleCollapsed={toggleSide}
                        onFilesHost={setFilesHost}
                    >
                        {view === 'commits' ? (
                            <HistoryPanel
                                searchText={searchText}
                                onSearchText={setSearchText}
                                search={search}
                                onSearch={setSearch}
                                inputRef={searchInputRef}
                                focusMode={focusMode}
                                onFocusMode={setFocusMode}
                                commitCount={commits.length}
                                loading={loadingLog}
                                quickRefs={quickRefs}
                                pinned={pinned}
                                selectedBranch={selectedBranch}
                                busy={!!busy}
                                onRevealBranch={(b) => void selectBranch(b)}
                                onCheckout={checkoutBranch}
                                onTogglePin={(name) => void togglePinned(name)}
                            />
                        ) : view === 'stash' ? (
                            <StashPanel
                                stashes={stashes}
                                selected={selectedStash}
                                onSelect={setSelectedStash}
                                busy={!!busy}
                                onPush={() => void run('stash push', () => GitStashPush(repoId, '', true))}
                                onApply={(ref, drop) => void run(drop ? 'stash pop' : 'stash apply', () => GitStashApply(repoId, ref, drop))}
                                onDrop={stashToConfirmDrop}
                            />
                        ) : (
                            <ChangesPanel
                                staged={staged}
                                unstaged={unstaged}
                                selectedPath={selectedPath}
                                busy={!!busy}
                                commitMessage={commitMessage}
                                lastCommitMessage={lastCommitMessage}
                                branchName={status?.branch ?? ''}
                                onSelectPath={setSelectedPath}
                                onStage={(paths) => run('add', () => GitStage(repoId, paths))}
                                onStageAll={() => run('add --all', () => GitStageAll(repoId))}
                                onUnstage={(paths) => run('restore --staged', () => GitUnstage(repoId, paths))}
                                onDiscard={(paths) => setConfirmDiscard(paths)}
                                onChangeMessage={setCommitMessage}
                                inlineDiffs={inlineDiffs}
                                onToggleDiff={toggleInlineDiff}
                                drafting={drafting}
                                draft={draft}
                                onDraftMessage={draftables.length > 0 ? () => void draftCommitMessage() : undefined}
                                onPickDraftAgent={draftables.length > 1 ? pickDraftAgent : undefined}
                                onCommit={(amend) =>
                                    run(amend ? 'commit --amend' : 'commit', async () => {
                                        await GitCommit(repoId, commitMessage, amend)
                                        setCommitMessage('')
                                    })
                                }
                            />
                        )}
                    </GitWorkPanel>
                )}

                {!sideHidden && (
                    <PaneHandle onStart={() => setDragging('side')} title={g.panes.sideHandle} />
                )}

                {/* Centro: lo que muestra la solapa activa — el grafo, el diff
                    del archivo elegido, el parche del stash, el editor. */}
                <div className="flex min-w-0 flex-1 flex-col">
                    {view === 'conflicts' ? (
                        <GitConflictResolver
                            repoId={repoId}
                            operation={inProgress || 'merge'}
                            busy={!!busy}
                            onContinue={() => void run(`${inProgress} --continue`, () => GitContinue(repoId, inProgress))}
                            onAbort={() => void run(`${inProgress} --abort`, () => GitAbort(repoId, inProgress))}
                            onResolved={() => void reload()}
                            onAsk={(path) =>
                                askAgentPicking(
                                    g.ask.conflictPrompt({op: inProgress || 'merge', path}),
                                    g.ask.conflictAbout({path}),
                                )
                            }
                            onClose={() => setView('commits')}
                        />
                    ) : view === 'stash' ? (
                        <StashPreview
                            repoId={repoId}
                            stash={stashes.find((x) => x.ref === selectedStash) ?? null}
                            busy={!!busy}
                            appearance={appearance}
                            onApply={(ref, drop) => void run(drop ? 'stash pop' : 'stash apply', () => GitStashApply(repoId, ref, drop))}
                            onDrop={stashToConfirmDrop}
                        />
                    ) : view === 'files' ? (
                        // Con la columna plegada no hay dónde montar el árbol:
                        // el editor lo dibuja a su izquierda, como antes.
                        <GitFileEditor
                            repoId={repoId}
                            editorThemeId={editorThemeId}
                            appearance={appearance}
                            appTheme={appTheme}
                            request={editRequest}
                            initialFiles={openFiles ?? undefined}
                            onOpenFilesChange={(paths) => {
                                // Solo después de restaurar: guardar la lista
                                // vacía del primer render borraría lo anterior.
                                if (openFiles === null) return
                                void GitSetOpenFiles(repoId, paths).catch(() => {})
                            }}
                            onAskAgent={(prompt, about) => askAgentPicking(prompt, about)}
                            status={status}
                            // Guardar un archivo lo vuelve un cambio sin
                            // commitear: sin este refresco habría que esperar
                            // al siguiente poll para verlo en Cambios.
                            onSaved={() => void reload()}
                            onClose={() => setView('commits')}
                            treeHost={sideHidden ? null : filesHost}
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
                        // Cambios: el diff del archivo elegido ocupa el área
                        // principal. Es lo que se REVISA mientras en la columna
                        // se prepara y se escribe el commit.
                        <div className="min-h-0 flex-1 overflow-hidden">
                            {diffViewer ?? (
                                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                                    <Icon name="difference" size={32} className="text-on-surface-variant/40" />
                                    <p className="text-ui-13 font-medium text-on-surface">{t.git.workbench.changes.pickFileTitle}</p>
                                    <p className="max-w-xs text-ui-11 text-on-surface-variant/80">{t.git.workbench.changes.pickFileBody}</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Derecha: detalle del commit + su diff. Solo en el Historial:
                    en Cambios el diff pasó al área principal, y en Stash y
                    Archivos este panel no tenía nada que mostrar.

                    overflow-hidden por el mismo motivo que la columna de
                    trabajo: ancho fijo + hijos con min-width:auto = contenido
                    dibujado fuera del panel. */}
                {view === 'commits' && !diffHidden && (
                    <>
                        <PaneHandle onStart={() => setDragging('diff')} title={g.panes.diffHandle} />
                        <div style={{width: effDiffWidth}} className="flex shrink-0 flex-col overflow-hidden">
                            {selectedCommit && (
                                <CommitDetail
                                    commit={selectedCommit}
                                    files={changedFiles}
                                    selectedPath={selectedPath}
                                    onSelectPath={setSelectedPath}
                                    diffs={commitDiffs}
                                    onToggleDiff={toggleCommitDiff}
                                    onExpandAll={expandAllCommitDiffs}
                                    onCollapseAll={() => setCommitDiffs({})}
                                    full={!selectedPath}
                                />
                            )}
                            {/* El visor solo ocupa lugar cuando hay algo que ver:
                                con un commit elegido y ningún archivo abierto, el
                                resumen se queda con el panel entero en vez de
                                repartirlo con un cartel que dice «elegí un
                                archivo». */}
                            {!(selectedCommit && !selectedPath) && (
                                <div className="min-h-0 flex-1 overflow-hidden border-t border-outline-variant">
                                    {diffViewer ?? (
                                        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                                            <Icon name="difference" size={28} className="text-on-surface-variant/40" />
                                            <p className="text-xs text-on-surface-variant/70">{g.panes.pickCommitThenFile}</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Panel anclado (Sesiones / Comandos). Position absolute sobre
                el cuerpo de la pestaña, con el tamaño y el lado que diga el
                layout guardado. */}
            {(panelTab !== null || sessions.length > 0) && (
                <div
                    className="absolute flex flex-col overflow-hidden border-outline-variant bg-surface-container-lowest"
                    style={{
                        display: panelTab === null ? 'none' : undefined,
                        ...(dock === 'bottom'
                            ? {left: 0, right: 0, bottom: 0, height: panelSize, borderTopWidth: 1}
                            : dock === 'left'
                              ? {left: 0, top: 0, bottom: 0, width: panelSize, borderRightWidth: 1}
                              : {right: 0, top: 0, bottom: 0, width: panelSize, borderLeftWidth: 1}),
                    }}
                >
                    {/* El asa va sobre el borde que da al área principal, que
                        es el que se mueve al arrastrar. */}
                    <div
                        onMouseDown={(e) => {
                            e.preventDefault()
                            setPanelDragging(true)
                        }}
                        role="separator"
                        aria-orientation={dock === 'bottom' ? 'horizontal' : 'vertical'}
                        title={dock === 'bottom' ? g.panel.resizeHeight : g.panel.resizeWidth}
                        className={`absolute z-10 ${
                            dock === 'bottom'
                                ? 'left-0 right-0 top-0 h-1.5 cursor-row-resize'
                                : dock === 'left'
                                  ? 'bottom-0 right-0 top-0 w-1.5 cursor-col-resize'
                                  : 'bottom-0 left-0 top-0 w-1.5 cursor-col-resize'
                        } hover:bg-primary/30`}
                    />

                    {/* Barra del panel: solapas Sesiones/Comandos a la
                        izquierda y los ajustes que valen para TODAS las
                        terminales (letra, paleta, anclaje) a la derecha —
                        repetirlos en cada sesión sería repetir un ajuste que
                        no es de la sesión. */}
                    <div
                        className={`flex shrink-0 items-center gap-1 border-b border-outline-variant px-2 py-0.5 text-ui-11 ${
                            dock === 'bottom' ? 'mt-1.5' : dock === 'right' ? 'ml-1.5' : 'mr-1.5'
                        }`}
                    >
                        <button
                            onClick={() => openPanel('terminal')}
                            title={g.panel.sessionsTitle}
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'terminal' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="terminal" size={13} />
                            {g.panel.sessions}
                        </button>
                        <button
                            onClick={() => {
                                setPanelTab('commands')
                                persistLayout({tab: 'commands'})
                            }}
                            title={g.panel.commandsTitle}
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'commands' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="history" size={13} />
                            {dock === 'bottom' ? g.panel.commandsLong : g.panel.commands}
                        </button>
                        <button
                            onClick={() => {
                                setPanelTab('reflog')
                                persistLayout({tab: 'reflog'})
                            }}
                            title={g.panel.reflogTitle}
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'reflog' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="restore" size={13} />
                            {g.panel.reflog}
                        </button>
                        <button
                            onClick={() => {
                                setPanelTab('agents')
                                persistLayout({tab: 'agents'})
                                enterAgentMode()
                            }}
                            title={g.panel.agentsTitle}
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'agents' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="smart_toy" size={13} />
                            {g.bar.agents}
                            {/* Un contador: una solapa que dice cuántas cosas
                                tiene adentro invita a abrirla; una vacía de
                                señales se ignora. Cuenta lo que ESTE repo
                                tiene preparado, no lo que la app soporta. */}
                            {agentBadge > 0 && (
                                <span className="rounded-full bg-primary/20 px-1 text-ui-10 text-primary">{agentBadge}</span>
                            )}
                        </button>

                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                            <button
                                onClick={() => onChangeTerminalFontSize(terminalFontSize - 1)}
                                disabled={terminalFontSize <= TERMINAL_FONT_MIN}
                                title={
                                    terminalFontSize <= TERMINAL_FONT_MIN
                                        ? g.panel.fontMin({px: TERMINAL_FONT_MIN})
                                        : g.panel.fontDecrease({px: terminalFontSize - 1})
                                }
                                className="rounded px-1 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
                            >
                                <Icon name="text_decrease" size={14} />
                            </button>
                            <button
                                onClick={() => onChangeTerminalFontSize(terminalFontSize + 1)}
                                disabled={terminalFontSize >= TERMINAL_FONT_MAX}
                                title={
                                    terminalFontSize >= TERMINAL_FONT_MAX
                                        ? g.panel.fontMax({px: TERMINAL_FONT_MAX})
                                        : g.panel.fontIncrease({px: terminalFontSize + 1})
                                }
                                className="rounded px-1 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
                            >
                                <Icon name="text_increase" size={14} />
                            </button>
                            <TerminalThemeMenu value={terminalThemeId} appTheme={appTheme} onChange={onChangeTerminalTheme} />
                            <span className="mx-0.5 h-4 w-px shrink-0 bg-outline-variant" />
                            {DOCK_BUTTONS.map((d) => (
                                <button
                                    key={d.id}
                                    onClick={() => changeDock(d.id)}
                                    title={dock === d.id ? g.panel.dockCurrent({title: g.dock[d.id]}) : g.dock[d.id]}
                                    className={`rounded px-1 py-0.5 ${
                                        dock === d.id
                                            ? 'bg-primary/15 text-primary'
                                            : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name={d.icon} size={14} />
                                </button>
                            ))}
                            <span className="mx-0.5 h-4 w-px shrink-0 bg-outline-variant" />
                            <button
                                onClick={() => {
                                    setPanelTab(null)
                                    persistLayout({tab: null})
                                }}
                                title={g.panel.closeTitle}
                                className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="close" size={15} />
                            </button>
                        </div>
                    </div>

                    {/* Tira de la solapa Agentes: las conversaciones abiertas
                        y el contexto del repositorio. Es la hermana de la tira
                        de sesiones de abajo — una para lo agéntico, otra para
                        las terminales. */}
                    {panelTab === 'agents' && (
                        <div
                            className={`flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-outline-variant px-1 py-1 ${
                                dock === 'bottom' ? '' : dock === 'right' ? 'ml-1.5' : 'mr-1.5'
                            }`}
                        >
                            <button
                                onClick={() => setAgentsView('context')}
                                title={g.panel.contextTitle}
                                className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 ${
                                    agentsView === 'context'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-on-surface-variant hover:bg-surface-variant'
                                }`}
                            >
                                <Icon name="dataset" size={12} />
                                {g.panel.context}
                            </button>
                            <button
                                onClick={() => setAgentsView('history')}
                                data-agents-history
                                title={g.panel.historyTitle}
                                className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 ${
                                    agentsView === 'history'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-on-surface-variant hover:bg-surface-variant'
                                }`}
                            >
                                <Icon name="history" size={12} />
                                {g.panel.history}
                                {chatHistory.length + cliChats.length > 0 && (
                                    <span className="opacity-60">{chatHistory.length + cliChats.length}</span>
                                )}
                            </button>

                            {sessions
                                .filter((s) => s.kind === 'chat')
                                .map((s) => (
                                    <span
                                        key={s.id}
                                        className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 ${
                                            agentsView === 'chats' && activeChatId === s.id
                                                ? 'bg-primary/15 text-primary'
                                                : 'text-on-surface-variant hover:bg-surface-variant'
                                        }`}
                                    >
                                        <button
                                            onClick={() => {
                                                setAgentsView('chats')
                                                setActiveChatId(s.id)
                                                // Abrir un chat ES ponerse a
                                                // trabajar con el agente, y ahí
                                                // lo que importa son los
                                                // archivos, no el grafo.
                                                enterAgentMode()
                                            }}
                                            onContextMenu={(e: ReactMouseEvent) => {
                                                e.preventDefault()
                                                setMenu({
                                                    x: e.clientX,
                                                    y: e.clientY,
                                                    items: [
                                                        {
                                                            label: g.panel.renameChat,
                                                            icon: 'edit',
                                                            onSelect: () =>
                                                                setPrompt({
                                                                    title: g.chat.renameTitle,
                                                                    label: g.chat.nameLabel,
                                                                    initial: s.title,
                                                                    confirmLabel: t.common.save,
                                                                    onSubmit: (name: string) => {
                                                                        const title = name.trim()
                                                                        if (!title) return
                                                                        setSessions((prev) =>
                                                                            prev.map((x) => (x.id === s.id ? {...x, title} : x)),
                                                                        )
                                                                        void RenameAgentChat(s.id, title)
                                                                            .then(reloadChatHistory)
                                                                            .catch(() => {})
                                                                    },
                                                                }),
                                                        },
                                                        {
                                                            label: g.panel.removeFromHistory,
                                                            icon: 'delete',
                                                            danger: true,
                                                            hint: g.panel.removeFromHistoryHintShort,
                                                            onSelect: () => {
                                                                void DeleteAgentChat(s.id).then(reloadChatHistory).catch(() => {})
                                                                closeSession(s.id)
                                                            },
                                                        },
                                                    ],
                                                })
                                            }}
                                            title={g.panel.chatTabTitle({title: s.title})}
                                            className="max-w-40 truncate"
                                        >
                                            {s.title}
                                        </button>
                                        <button
                                            onClick={() => {
                                                closeSession(s.id)
                                                setActiveChatId((cur) => (cur === s.id ? null : cur))
                                            }}
                                            title={g.panel.closeChatTitle}
                                            className="rounded hover:text-on-surface"
                                        >
                                            <Icon name="close" size={12} />
                                        </button>
                                    </span>
                                ))}

                            <DropdownMenu
                                label=""
                                icon="add"
                                title={g.panel.newChatTitle}
                                width={360}
                                items={chatMenuItems()}
                            />
                        </div>
                    )}

                    {/* Tira de sesiones. Solo en la solapa de sesiones: en
                        Comandos no habría nada que elegir. */}
                    {panelTab === 'terminal' && (
                        <div
                            className={`flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-outline-variant px-1 py-0.5 text-ui-11 ${
                                dock === 'right' ? 'ml-1.5' : dock === 'left' ? 'mr-1.5' : ''
                            }`}
                        >
                            {sessions.filter((s) => s.kind !== 'chat').map((s) => (
                                <div
                                    key={s.id}
                                    onClick={() => setActiveSessionId(s.id)}
                                    // Renombrar y borrar del historial viven en
                                    // el menú contextual y no como botones: la
                                    // tira de solapas ya está apretada, y son
                                    // acciones que se usan de a una cada tanto.
                                    onContextMenu={
                                        s.kind === 'chat'
                                            ? (e: ReactMouseEvent) => {
                                                  e.preventDefault()
                                                  setMenu({
                                                      x: e.clientX,
                                                      y: e.clientY,
                                                      items: [
                                                          {
                                                              label: g.panel.renameChat,
                                                              icon: 'edit',
                                                              onSelect: () =>
                                                                  setPrompt({
                                                                      title: g.chat.renameTitle,
                                                                      label: g.chat.nameLabel,
                                                                      placeholder: s.title,
                                                                      initial: s.title,
                                                                      confirmLabel: t.common.save,
                                                                      onSubmit: (name: string) => {
                                                                          const title = name.trim()
                                                                          if (!title) return
                                                                          setSessions((prev) =>
                                                                              prev.map((x) => (x.id === s.id ? {...x, title} : x)),
                                                                          )
                                                                          void RenameAgentChat(s.id, title)
                                                                              .then(reloadChatHistory)
                                                                              .catch(() => {})
                                                                      },
                                                                  }),
                                                          },
                                                          {
                                                              label: g.panel.removeFromHistory,
                                                              icon: 'delete',
                                                              danger: true,
                                                              hint: g.panel.removeFromHistoryHint,
                                                              onSelect: () => {
                                                                  void DeleteAgentChat(s.id)
                                                                      .then(reloadChatHistory)
                                                                      .catch(() => {})
                                                                  closeSession(s.id)
                                                              },
                                                          },
                                                      ],
                                                  })
                                              }
                                            : undefined
                                    }
                                    title={
                                        s.kind === 'chat'
                                            ? g.panel.chatTabTitle({title: s.title})
                                            : s.kind === 'agent'
                                              ? g.panel.agentSessionTitle({title: s.title})
                                              : g.panel.terminalSessionTitle
                                    }
                                    className={`group flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 ${
                                        activeSessionId === s.id
                                            ? 'bg-primary/15 text-primary'
                                            : 'text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <Icon
                                        name={s.kind === 'chat' ? 'chat' : s.kind === 'agent' ? 'smart_toy' : 'terminal'}
                                        size={12}
                                        className="shrink-0"
                                    />
                                    <span className="max-w-32 truncate">{s.title}</span>
                                    <span
                                        role="button"
                                        tabIndex={-1}
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            closeSession(s.id)
                                        }}
                                        title={s.kind === 'agent' ? g.panel.closeAgentSession({title: s.title}) : g.panel.closeSession}
                                        className="shrink-0 rounded opacity-0 hover:bg-surface-variant group-hover:opacity-70"
                                    >
                                        <Icon name="close" size={12} />
                                    </span>
                                </div>
                            ))}

                            <DropdownMenu
                                label={g.panel.newSession}
                                icon="add"
                                title={g.panel.newSessionTitle}
                                width={340}
                                items={[
                                    // Acá NO van los chats. Esta solapa es la
                                    // de terminales, y los chats viven en la
                                    // solapa Agentes desde que se separaron:
                                    // ofrecerlos en los dos lados vuelve a
                                    // mezclar lo que se separó, y deja la
                                    // misma conversación abierta desde dos
                                    // menús distintos.
                                    {
                                        label: g.session.terminal,
                                        icon: 'terminal',
                                        hint: g.panel.shellAtRoot,
                                        onSelect: () => addSession('shell'),
                                    },
                                    // Los CLIs en su terminal completa: es otra
                                    // cosa que el chat y por eso va en otro
                                    // grupo, no intercalado.
                                    // Un servidor de modelos no es un programa de
                                    // terminal: solo se usa por el chat.
                                    ...agentList.filter((a) => !isModelServerAgent(a.id)).map((a) => ({
                                        label: g.panel.agentInTerminal({agent: a.label}),
                                        icon: 'smart_toy',
                                        hint: a.available ? g.panel.agentInTerminalHint({vendor: a.vendor}) : g.panel.notInstalled,
                                        disabled: !a.available,
                                        onSelect: () => addSession('agent', a),
                                    })),
                                ]}
                            />
                        </div>
                    )}

                    <div
                        className={`relative min-h-0 flex-1 ${dock === 'right' ? 'ml-1.5' : dock === 'left' ? 'mr-1.5' : ''}`}
                    >
                        {/* Lanzador: lo que se ve al abrir el panel sin
                            ninguna sesión.
                            
                            Existe porque el estado anterior —una terminal
                            vacía— no comunicaba nada: alguien podía usar la
                            app meses sin enterarse de que puede chatear con un
                            agente sobre el repositorio abierto. Acá se nombran
                            las opciones con lo que hacen, y se muestra lo que
                            este repo tiene preparado. */}
                        {panelTab === 'terminal' && sessions.filter((s) => s.kind !== 'chat').length === 0 && (
                            <div className="absolute inset-0 overflow-y-auto p-4">
                                <p className="mb-3 text-xs text-on-surface-variant">
                                    {g.launcher.workOn.before}<span className="text-on-surface">{repoName}</span>{g.launcher.workOn.after}
                                </p>

                                <div className="flex flex-col gap-1.5">
                                    {agentList
                                        .filter((a) => a.available && chatCapable.has(a.id))
                                        .map((a) => (
                                            <button
                                                key={`chat-${a.id}`}
                                                onClick={() => addSession('chat', a)}
                                                title={g.launcher.chatTitle({agent: a.label})}
                                                className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                            >
                                                <Icon name="chat" size={14} className="mt-0.5 shrink-0 text-primary" />
                                                <span className="min-w-0">
                                                    <span className="block text-xs text-on-surface">{g.launcher.chatWith({agent: a.label})}</span>
                                                    <span className="block text-ui-11 text-on-surface-variant">
                                                        {g.launcher.chatDesc}
                                                    </span>
                                                </span>
                                            </button>
                                        ))}

                                    {chatHistory.length > 0 && (
                                        <button
                                            onClick={() => resumeChat(chatHistory[0])}
                                            title={g.launcher.resumeTitle({title: chatHistory[0].title || g.launcher.theLastConversation})}
                                            className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                        >
                                            <Icon name="history" size={14} className="mt-0.5 shrink-0 text-primary" />
                                            <span className="min-w-0">
                                                <span className="block truncate text-xs text-on-surface">
                                                    {g.launcher.resume({title: chatHistory[0].title || g.launcher.lastConversation})}
                                                </span>
                                                <span className="block text-ui-11 text-on-surface-variant">
                                                    {g.launcher.savedCount(chatHistory.length)}
                                                </span>
                                            </span>
                                        </button>
                                    )}

                                    <button
                                        onClick={() => addSession('shell')}
                                        title={g.launcher.terminalTitle}
                                        className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                    >
                                        <Icon name="terminal" size={14} className="mt-0.5 shrink-0 text-on-surface-variant" />
                                        <span className="min-w-0">
                                            <span className="block text-xs text-on-surface">{g.launcher.openTerminal}</span>
                                            <span className="block text-ui-11 text-on-surface-variant">
                                                {g.panel.shellAtRoot}
                                            </span>
                                        </span>
                                    </button>

                                    <button
                                        onClick={() => {
                                            setPanelTab('agents')
                                            persistLayout({tab: 'agents'})
                                            enterAgentMode()
                                        }}
                                        title={g.launcher.contextTitle}
                                        className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                    >
                                        <Icon name="smart_toy" size={14} className="mt-0.5 shrink-0 text-on-surface-variant" />
                                        <span className="min-w-0">
                                            <span className="block text-xs text-on-surface">{g.launcher.context}</span>
                                            <span className="block text-ui-11 text-on-surface-variant">
                                                {g.launcher.contextDesc}
                                            </span>
                                        </span>
                                    </button>
                                </div>

                                {agentList.filter((a) => a.available).length === 0 && (
                                    <p className="mt-3 text-ui-11 text-on-surface-variant">
                                        {g.launcher.noAgents}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Todas las sesiones se renderizan siempre y se
                            ocultan por CSS: desmontar la inactiva mataría su
                            proceso. */}
                        {sessions.map((s) => (
                            <div
                                key={s.id}
                                className="absolute inset-0"
                                style={{
                                    // Los chats viven en la solapa Agentes y
                                    // las terminales en Sesiones: son cosas
                                    // distintas y mezclarlas obligaba a leer el
                                    // ícono de cada solapa para saber qué era.
                                    // Todas se renderizan siempre y se ocultan
                                    // por CSS — desmontar una terminal mataría
                                    // su proceso.
                                    display:
                                        s.kind === 'chat'
                                            ? panelTab === 'agents' && agentsView === 'chats' && activeChatId === s.id
                                                ? undefined
                                                : 'none'
                                            : panelTab === 'terminal' && activeSessionId === s.id
                                              ? undefined
                                              : 'none',
                                }}
                            >
                                {s.kind === 'chat' ? (
                                    <AgentChat
                                        sessionId={s.id}
                                        // A la vista sólo con la pestaña activa y
                                        // esta conversación delante: el chat se
                                        // registra como visto (avisos y leído).
                                        active={active && panelTab === 'agents' && agentsView === 'chats' && activeChatId === s.id}
                                        context={gitContext}
                                        agentId={s.agentId ?? ''}
                                        agentLabel={agentList.find((a) => a.id === s.agentId)?.label ?? s.title}
                                        seed={chatSeed?.sessionId === s.id ? chatSeed : null}
                                        // Al retomar, el chat vuelve a dibujar
                                        // lo que ya se habló leyendo el
                                        // transcript del propio CLI.
                                        resumeConversationId={
                                            chatHistory.find((c) => c.id === s.id)?.conversationId || undefined
                                        }
                                        resumeChatId={chatHistory.find((c) => c.id === s.id)?.id}
                                        initialSettings={(() => {
                                            const c = chatHistory.find((x) => x.id === s.id)
                                            return c ? {model: c.model, effort: c.effort, mode: c.mode, brain: c.brain} : undefined
                                        })()}
                                        // Después de un turno autónomo: se
                                        // relee el estado y se informa cuántos
                                        // archivos quedaron tocados, para que
                                        // revisarlos sea el paso siguiente y no
                                        // algo que haya que acordarse de hacer.
                                        onTurnFinished={async () => {
                                            await reload()
                                            const st = await GitStatus(repoId).catch(() => null)
                                            return st?.files.length ?? 0
                                        }}
                                        onReviewChanges={() => setView('changes')}
                                        onValidateWithAnother={(exclude, lastTurn) => {
                                            // Otro agente, no el mismo: el
                                            // valor de que revise otro está en
                                            // que no comparte los puntos ciegos
                                            // del que escribió.
                                            const other = agentList.find(
                                                (a) => a.available && chatCapable.has(a.id) && a.id !== exclude,
                                            )
                                            if (!other) {
                                                setError(g.review.noOther)
                                                return
                                            }
                                            void validateWithAnother(other.id, lastTurn)
                                        }}
                                        onConversation={(conversationId) => {
                                            void TouchAgentChat(s.id, conversationId)
                                                .then(reloadChatHistory)
                                                .catch(() => {})
                                        }}
                                    />
                                ) : (
                                <LocalTerminalPanel
                                    sessionId={s.id}
                                    repoId={repoId}
                                    kind={s.kind}
                                    agentId={s.agentId}
                                    agentLabel={s.title}
                                    autoStart={s.autoStart}
                                    shellId={localShellId}
                                    theme={appTheme}
                                    terminalThemeId={terminalThemeId}
                                    fontSize={terminalFontSize}
                                    visible={active && panelTab === 'terminal' && activeSessionId === s.id}
                                />
                                )}
                            </div>
                        ))}
                        {/* Prompt esperando a que el agente termine de
                            arrancar. Es una barra y no un envío automático a
                            propósito: el CLI tarda en levantar y escribirle
                            antes de tiempo se lo come la shell. */}
                        {pendingPrompt && panelTab === 'terminal' && activeSessionId === pendingPrompt.sessionId && (
                            <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-outline-variant bg-surface-container-high px-2 py-1 text-ui-11">
                                <Icon name="smart_toy" size={13} className="shrink-0 text-primary" />
                                <span className="min-w-0 flex-1 truncate text-on-surface-variant">
                                    {g.pending.before}<span className="text-on-surface">{pendingPrompt.about}</span>{g.pending.after}
                                </span>
                                <button
                                    onClick={() => {
                                        void WriteLocalTerminal(pendingPrompt.sessionId, pendingPrompt.text)
                                        setPendingPrompt(null)
                                    }}
                                    title={g.pending.insertTitle}
                                    className="shrink-0 rounded bg-primary px-2 py-0.5 text-on-primary"
                                >
                                    {g.pending.insert}
                                </button>
                                <button
                                    onClick={() => setPendingPrompt(null)}
                                    title={g.pending.discardTitle}
                                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="close" size={14} />
                                </button>
                            </div>
                        )}
                        {panelTab === 'reflog' && (
                            <div className="absolute inset-0 flex flex-col">
                                <GitReflogPanel
                                    repoId={repoId}
                                    onChanged={() => void reload()}
                                    // Reusa el mismo camino que un clic en una
                                    // etiqueta: un commit del reflog casi
                                    // siempre queda FUERA de la ventana cargada
                                    // del grafo —es lo que uno viene a
                                    // recuperar—, y revealCommit ya sabe
                                    // resolver ese caso y decirlo.
                                    onOpenCommit={(hash) => void revealCommit(hash)}
                                />
                            </div>
                        )}
                        {panelTab === 'commands' && (
                            <div className="absolute inset-0">
                                <GitCommandLogDrawer
                                    reloadToken={logToken}
                                    onAsk={(command, output) =>
                                        askAgentPicking(
                                            g.ask.failedCommandPrompt({command, output}),
                                            command,
                                        )
                                    }
                                />
                            </div>
                        )}
                        {panelTab === 'agents' && agentsView === 'history' && (
                            <div className="absolute inset-0">
                                <AgentChatHistory
                                    agents={agentList.filter((a) => chatCapable.has(a.id))}
                                    mine={chatHistory}
                                    cli={cliChats}
                                    activeId={activeChatId}
                                    onOpen={(e: ChatHistoryEntry) => {
                                        if (e.external && e.conv) {
                                            void adoptConversation(e.agentId, e.conv)
                                            return
                                        }
                                        const chat = chatHistory.find((c) => c.id === e.id)
                                        if (chat) resumeChat(chat)
                                    }}
                                    onRename={renameChat}
                                    onDelete={(id) => {
                                        setConfirm({
                                            title: g.panel.removeFromHistory,
                                            description: g.panel.removeFromHistoryDesc,
                                            command: chatHistory.find((c) => c.id === id)?.title || g.panel.untitled,
                                            confirmLabel: g.worktrees.remove,
                                            danger: true,
                                            run: () => DeleteAgentChat(id).then(reloadChatHistory),
                                        })
                                    }}
                                    onNew={(agentId) => {
                                        const agent = agentList.find((a) => a.id === agentId)
                                        if (agent) addSession('chat', agent)
                                    }}
                                />
                            </div>
                        )}
                        {panelTab === 'agents' && agentsView === 'context' && (
                            <div className="absolute inset-0">
                                <GitAgentPanel
                                    repoId={repoId}
                                    // Un skill o un CLAUDE.md que falta se
                                    // arregla en el editor de al lado: el panel
                                    // lista, la solapa Archivos edita.
                                    onOpenFile={(path) => {
                                        setEditRequest({path, token: Date.now()})
                                        setView('files')
                                    }}
                                    onAskAgent={(prompt, about) => askAgentPicking(prompt, about)}
                                    defaultAgent={defaultAgent}
                                    onSetDefaultAgent={(id) => {
                                        setDefaultAgent(id)
                                        void GitSetDefaultAgent(repoId, id).catch(() => {})
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}
            </div>

            {showSettings && (
                <GitSettingsDialog
                    repoId={repoId}
                    repoName={repoName}
                    initialTab={settingsTab}
                    onClose={() => setShowSettings(false)}
                    onChanged={() => {
                        void reload()
                        onChanged()
                    }}
                />
            )}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} width={280} />}
            {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} />}
            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    description={confirm.description}
                    confirmLabel={confirm.confirmLabel}
                    danger={confirm.danger ?? true}
                    onConfirm={() => run(confirm.command, confirm.run, confirm.onError)}
                    onClose={() => setConfirm(null)}
                />
            )}


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
                    title={g.discard.hunkTitle}
                    description={g.discard.hunkDesc}
                    confirmLabel={g.discard.hunkConfirm}
                    danger
                    onConfirm={() =>
                        run('apply --reverse', () => GitApplyPatch(repoId, confirmDiscardPatch, false, true))
                    }
                    onClose={() => setConfirmDiscardPatch(null)}
                />
            )}

            {confirmDiscard && (
                <ConfirmDialog
                    title={g.discard.filesTitle}
                    description={g.discard.filesDesc({count: confirmDiscard.length, first: confirmDiscard[0]})}
                    confirmLabel={g.discard.filesConfirm}
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

// La columna de trabajo tiene piso propio: con menos de ~220px la caja de
// commit y las filas de archivos dejan de ser legibles, y las cuatro solapas
// no entran ni como íconos. El tope evita que se coma el grafo.
const MIN_SIDE = 220
const MAX_SIDE = 720
function clampSide(w: number): number {
    return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(w)))
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
    const t = useT()
    return (
        <div
            className={`flex shrink-0 items-start gap-2 border-b border-outline-variant px-3 py-1.5 text-ui-11 ${
                kind === 'error' ? 'bg-error-container/50 text-on-error-container' : 'bg-surface-container text-on-surface-variant'
            }`}
        >
            <Icon name={kind === 'error' ? 'error' : 'info'} size={14} className="mt-px shrink-0" />
            {/* Errors from git are multi-line and the useful part is often the
                last line — wrapped and shown whole rather than truncated. */}
            <pre className="max-h-[30vh] min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono">{text}</pre>
            <button onClick={onClose} title={t.git.tab.closeMessage} className="shrink-0 rounded p-0.5 hover:bg-surface-variant/50">
                <Icon name="close" size={14} />
            </button>
        </div>
    )
}

// Resumen de un commit: metadatos, mensaje completo y los archivos que tocó,
// cada uno desplegable con su diff adentro.
//
// Por qué se lee así y no como una lista que manda al panel de la derecha: un
// commit se revisa entero, de arriba hacia abajo. Con la lista sola, entender
// qué hizo un commit de veinte archivos son veinte clics de ida y veinte de
// vuelta; desplegado, es un scroll. El panel de diff sigue existiendo para lo
// que sí es de UN archivo —blame, ver con más contexto, buscar dentro—, y por
// eso el nombre de cada archivo sigue abriéndolo ahí.
// EXPAND_ALL_LIMIT es hasta cuántos archivos "Expandir todo" abre de una. Es
// una lectura de parche por archivo: en un commit normal ni se nota, en uno de
// cientos deja la pestaña dibujando durante segundos.
const EXPAND_ALL_LIMIT = 50

function CommitDetail({
    commit,
    files,
    selectedPath,
    onSelectPath,
    diffs,
    onToggleDiff,
    onExpandAll,
    onCollapseAll,
    full,
}: {
    commit: git.CommitInfo
    files: git.FileDiff[]
    selectedPath: string | null
    onSelectPath: (p: string) => void
    // Diffs desplegados dentro del resumen, por ruta. Ausente = plegado.
    diffs: Record<string, InlineDiffState>
    onToggleDiff: (path: string) => void
    onExpandAll: (paths: string[]) => void
    onCollapseAll: () => void
    // Si el resumen ocupa el panel entero. Lo hace cuando no hay ningún archivo
    // abierto en el visor: repartir la altura con un panel que solo dice "elegí
    // un archivo" es regalar la mitad de la pantalla a un cartel.
    full?: boolean
}) {
    // El total sale de los archivos que ya trajo `GitChangedFiles`, no de una
    // llamada aparte: es la misma cuenta que hace `git show --stat` y no hace
    // falta pedirla dos veces.
    const insertions = files.reduce((n, f) => n + f.stat.insertions, 0)
    const deletions = files.reduce((n, f) => n + f.stat.deletions, 0)
    const expandedCount = files.filter((f) => diffs[f.path]).length
    // Tope de "expandir todo": arriba de esto son cientos de lecturas de parche
    // seguidas, y la pestaña se traba antes de terminar de dibujar.
    const canExpandAll = files.length > 0 && files.length <= EXPAND_ALL_LIMIT
    const d = useT().git.tab.detail

    return (
        <div className={`flex min-h-0 flex-col ${full ? 'flex-1' : 'max-h-[55%] shrink-0'}`}>
            <div className="shrink-0 space-y-1 border-b border-outline-variant bg-surface-container-lowest px-3 py-2">
                <p className="text-xs font-medium text-on-surface">{commit.subject}</p>
                {commit.body && <pre className="whitespace-pre-wrap break-words text-ui-11 text-on-surface-variant">{commit.body}</pre>}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 text-ui-10 text-on-surface-variant">
                    <dt className="text-on-surface-variant/60">{d.author}</dt>
                    <dd className="truncate">{commit.author} {'<'}{commit.email}{'>'}</dd>
                    <dt className="text-on-surface-variant/60">{d.date}</dt>
                    <dd>{commit.date}</dd>
                    <dt className="text-on-surface-variant/60">{d.hash}</dt>
                    <dd className="truncate font-mono">{commit.hash}</dd>
                    {(commit.parents?.length ?? 0) > 0 && (
                        <>
                            <dt className="text-on-surface-variant/60">{commit.parents.length > 1 ? d.parents : d.parent}</dt>
                            <dd className="truncate font-mono">{commit.parents.join(' ')}</dd>
                        </>
                    )}
                    {/* Dónde vive este commit. Es la respuesta a "¿esto ya está
                        en develop?", que es lo primero que se pregunta mirando
                        uno ajeno. */}
                    {((commit.branches?.length ?? 0) > 0 || (commit.tags?.length ?? 0) > 0) && (
                        <>
                            <dt className="text-on-surface-variant/60">{d.refs}</dt>
                            <dd className="flex flex-wrap gap-1">
                                {commit.branches?.map((b) => (
                                    <span key={b} title={d.reachableFrom({branch: b})} className="rounded-full bg-primary-container/60 px-1.5 text-ui-9 text-on-primary-container">
                                        {b}
                                    </span>
                                ))}
                                {commit.tags?.map((tg) => (
                                    <span key={tg} title={d.tagOnCommit({tag: tg})} className="rounded-full bg-tertiary/20 px-1.5 text-ui-9 text-tertiary">
                                        {tg}
                                    </span>
                                ))}
                            </dd>
                        </>
                    )}
                    <dt className="text-on-surface-variant/60">{d.changes}</dt>
                    <dd className="font-mono">
                        {d.fileCount(files.length)} · <span className="text-secondary">+{insertions}</span>{' '}
                        <span className="text-error">−{deletions}</span>
                    </dd>
                </dl>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-3 py-1 text-ui-10 text-on-surface-variant">
                <span className="font-semibold uppercase tracking-wider text-on-surface-variant/70">{d.files}</span>
                <span className="rounded-full bg-surface-variant px-1.5 text-ui-9 font-semibold text-on-surface-variant">{files.length}</span>
                <button
                    onClick={() => (expandedCount > 0 ? onCollapseAll() : onExpandAll(files.map((f) => f.path)))}
                    disabled={expandedCount === 0 && !canExpandAll}
                    title={
                        expandedCount > 0
                            ? d.collapseAllTitle
                            : canExpandAll
                              ? d.expandAllTitle({count: files.length})
                              : d.tooManyTitle({count: files.length})
                    }
                    className="ml-auto shrink-0 rounded px-1.5 py-0.5 hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    {expandedCount > 0 ? d.collapseAll : d.expandAll}
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {files.map((f) => {
                    const diff = diffs[f.path]
                    return (
                        <div key={f.path}>
                            <div
                                className={`group flex items-center gap-1.5 py-1 pl-1 pr-3 text-ui-11 ${
                                    selectedPath === f.path ? 'bg-primary-container/50' : 'hover:bg-surface-variant/50'
                                }`}
                            >
                                <button
                                    onClick={() => onToggleDiff(f.path)}
                                    disabled={f.isBinary}
                                    title={
                                        f.isBinary
                                            ? d.binaryTitle
                                            : diff
                                              ? d.hideChanges({path: f.path})
                                              : d.showChanges({path: f.path})
                                    }
                                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30"
                                >
                                    <Icon name={diff ? 'expand_more' : 'chevron_right'} size={13} />
                                </button>
                                <button
                                    onClick={() => onSelectPath(f.path)}
                                    title={d.openInDiff({path: f.path})}
                                    className="min-w-0 flex-1 truncate text-left font-mono text-on-surface"
                                >
                                    {f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                                </button>
                                {f.isBinary ? (
                                    <span className="shrink-0 text-ui-9 text-on-surface-variant/60">{d.binary}</span>
                                ) : (
                                    <span className="shrink-0 font-mono text-ui-9">
                                        <span className="text-secondary">+{f.stat.insertions}</span> <span className="text-error">−{f.stat.deletions}</span>
                                    </span>
                                )}
                            </div>
                            {diff && <InlineDiff state={diff} onOpenFull={() => onSelectPath(f.path)} />}
                        </div>
                    )
                })}
            </div>
        </div>
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
