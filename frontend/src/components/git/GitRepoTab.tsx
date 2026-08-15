import {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
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
    GitRepoWorkspace,
    GitSetOpenFiles,
    GitSetDefaultAgent,
    AgentChatSupported,
    AgentCLIConversations,
    AskAgentOnce,
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
import {agentchat, agents as agentsModel, git, vault} from '../../../wailsjs/go/models'
import type {Theme} from '../../hooks/useTheme'
import type {TerminalThemeId} from '../../xterm/terminalThemes'
import {buildBranchTree, countBranches, expandedForBranch, leafLabel, type BranchTreeNode} from '../../lib/branchTree'
import {groupTags} from '../../lib/tagGroups'
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
import DropdownMenu, {type DropdownHeader, type DropdownItem} from './DropdownMenu'
import GitSettingsDialog from './GitSettingsDialog'
import GitConflictResolver from './GitConflictResolver'
import GitCommandLogDrawer from './GitCommandLog'
import GitRebaseDialog from './GitRebaseDialog'
import GitStashPanel from './GitStashPanel'
import GitFileEditor from './GitFileEditor'
import GitAgentPanel from './GitAgentPanel'
import AgentChat from './AgentChat'
import LocalTerminalPanel from '../terminal/LocalTerminalPanel'
import TerminalThemeMenu from '../terminal/TerminalThemeMenu'
import {TERMINAL_FONT_MAX, TERMINAL_FONT_MIN} from '../../xterm/terminalFont'
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

// Dónde va anclado el panel de la terminal, y qué solapa muestra. Espejan
// settings.git_term_dock/git_panel_tab (migración 27); null es la solapa
// vacía, que en la base es ''.
type Dock = 'bottom' | 'left' | 'right'
type PanelTab = 'terminal' | 'commands' | 'agents' | null

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
    {id: 'left' as const, icon: 'dock_to_right', title: 'Anclar el panel a la izquierda — útil para tenerlo al lado del grafo en una pantalla ancha'},
    {id: 'bottom' as const, icon: 'dock_to_bottom', title: 'Anclar el panel abajo, a lo ancho de la pestaña — el lugar clásico, y el que más columnas le da a la terminal'},
    {id: 'right' as const, icon: 'dock_to_left', title: 'Anclar el panel a la derecha — deja el grafo y las ramas a la izquierda, como en un IDE'},
]

// shortAbout recorta el asunto para el título de una solapa. Se queda con el
// final de la ruta, que es la parte que distingue: "src/components/git/" es
// idéntico en veinte archivos, "GitRepoTab.tsx:120-140" no.
function shortAbout(about: string): string {
    const tail = about.split('/').pop() ?? about
    return tail.length > 28 ? `…${tail.slice(-27)}` : tail
}

function newShellSession(repoId: string): PanelSession {
    return {id: `git-term-${repoId}-${nextTerminalSeq()}`, kind: 'shell', title: 'Terminal', autoStart: false}
}

export default function GitRepoTab({
    repoId,
    repoName,
    editorThemeId,
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
    const [view, setView] = useState<CenterView>('commits')
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
    const [chatSeed, setChatSeed] = useState<{sessionId: string; text: string; token: number} | null>(null)
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
    const [branchFilter, setBranchFilter] = useState('')
    // Carpetas del árbol de ramas que están abiertas. Arranca vacío y se
    // siembra con las que llevan a la rama actual (ver el efecto más abajo):
    // en un repositorio con 364 remotas, abrir todo por defecto sería la lista
    // plana de antes con indentación extra.
    // Secciones plegadas del panel de ramas. Se guarda lo CERRADO y no lo
    // abierto: el estado natural es todo desplegado, y así una sección nueva
    // aparece visible en vez de escondida.
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
    const toggleSection = useCallback((key: string) => {
        setCollapsedSections((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }, [])

    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    const seededFoldersRef = useRef(false)
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
    // Qué muestra la solapa Agentes: las conversaciones o el contexto del
    // repositorio (skills, MCP, consumo).
    const [agentsView, setAgentsView] = useState<'chats' | 'context'>('context')
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
    const [forge, setForge] = useState<git.ForgeInfo | null>(null)

    // Id de la sesión de terminal de ESTA pestaña. Un ref y no un valor
    // derivado de repoId: el mismo repositorio puede estar abierto en dos
    // pestañas, y compartir el id haría que las dos escriban en la misma
    // shell (el id es además el nombre del evento de Wails, ver
    // LocalTerminalPanel).
    const termSessionIdRef = useRef(`git-term-${repoId}-${nextTerminalSeq()}`)

    const toggleFolder = useCallback((path: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
        })
    }, [])

    // Con filtro escrito, todo se muestra abierto: buscar una rama y que el
    // resultado quede escondido dentro de una carpeta plegada haría parecer
    // que no existe. Sin filtro manda lo que el usuario abrió a mano.
    const filtering = branchFilter.trim() !== ''

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
                    title: p.title || (p.kind === 'agent' ? (p.agentId ?? 'Agente') : 'Terminal'),
                    autoStart: false,
                }))
                // Restaurar la solapa de sesiones implica levantar sus
                // procesos: dejarla guardada y abrir la pestaña con el panel
                // vacío sería restaurar el layout a medias. Si quedó abierta
                // en esa solapa pero no hay sesiones anotadas (una instalación
                // que viene de la versión de una sola terminal), se abre una
                // terminal, que es exactamente lo que había antes.
                const openTab =
                    st.gitPanelTab === 'terminal' || st.gitPanelTab === 'commands' || st.gitPanelTab === 'agents'
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

    // Se piden por agente y en paralelo: cada uno lee un almacenamiento
    // distinto, y que uno no esté instalado no puede dejar sin lista a los
    // otros. Un fallo acá no rompe nada — es conveniencia, no navegación.
    const reloadCliChats = useCallback(() => {
        Promise.all(
            ['claude', 'codex'].map((id) => AgentCLIConversations(id, repoId).catch(() => [] as agentchat.Conversation[])),
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
                title: chat.title || `Chat con ${agentList.find((a) => a.id === chat.agentId)?.label ?? chat.agentId}`,
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
        (agentId: string, prompt: string, about: string) => {
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
                    setChatSeed({sessionId: existingChat.id, text: prompt, token: Date.now()})
                    return
                }
                const agent = agentList.find((a) => a.id === agentId)
                const session: PanelSession = {
                    id: `git-term-${repoId}-${nextTerminalSeq()}`,
                    kind: 'chat',
                    agentId,
                    title: `Chat · ${shortAbout(about)}`,
                    autoStart: false,
                }
                const next = [...sessions, session]
                setSessions(next)
                setActiveChatId(session.id)
                persistSessions(next)
                // El chat entra al historial del repositorio con el asunto como
                // título: es lo que después permite reconocerlo en la lista y
                // retomarlo.
                void CreateAgentChat(session.id, repoId, agentId, about).catch(() => {})
                setChatSeed({sessionId: session.id, text: prompt, token: Date.now()})
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
            const title = conv.title || `Conversación con ${agentList.find((a) => a.id === agentId)?.label ?? agentId}`
            try {
                await CreateAgentChat(id, repoId, agentId, title)
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


    // draftAgent es con qué agente se redacta el mensaje de commit: el que
    // esté fijado por defecto si sirve, o el primero con chat verificado. Sin
    // ninguno, la acción no se ofrece — mejor que ofrecerla y fallar al
    // tocarla.
    const draftAgent = useMemo(() => {
        if (defaultAgent && chatCapable.has(defaultAgent)) return defaultAgent
        return agentList.find((a) => a.available && chatCapable.has(a.id))?.id ?? ''
    }, [defaultAgent, chatCapable, agentList])

    const [drafting, setDrafting] = useState(false)

    // draftCommitMessage le pide al agente el mensaje a partir del diff
    // PREPARADO y lo escribe en el campo.
    //
    // Tres decisiones que hacen que esto sirva en vez de estorbar:
    //   - Se le pide que lea `git diff --staged` él mismo en vez de pegarle el
    //     parche: el diff de un commit grande no entra cómodo en un prompt, y
    //     git es una herramienta que los dos agentes ya tienen.
    //   - Se le pide el mensaje PELADO, sin markdown ni explicación, porque va
    //     derecho a un campo de texto.
    //   - El prefijo de tipo/scope que el usuario ya haya elegido se vuelve a
    //     aplicar sobre lo que devuelva: la convención del proyecto la decide
    //     el selector, no el agente.
    const draftCommitMessage = useCallback(async () => {
        if (!draftAgent || drafting) return
        setDrafting(true)
        setError(null)
        try {
            const answer = await AskAgentOnce(
                repoId,
                draftAgent,
                'Mirá el diff preparado para commitear en este repositorio (git diff --staged) y escribí el mensaje de commit. ' +
                    'Respondé SOLO con el mensaje: primera línea de resumen en imperativo y menos de 72 caracteres, y si hace falta ' +
                    'una línea en blanco y un cuerpo breve explicando el porqué. Sin markdown, sin comillas y sin ninguna explicación adicional.',
            )
            const {type, scope} = currentPrefixOf(commitMessage)
            const clean = answer.trim()
            setCommitMessage(type ? applyPrefix(clean, buildCommitPrefix(type, scope)) : clean)
        } catch (e) {
            setError(String(e))
        } finally {
            setDrafting(false)
        }
    }, [draftAgent, drafting, repoId, commitMessage])

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
                setError('No hay ningún asistente de código instalado en este equipo.')
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
                    label: `Preguntar a ${a.label}`,
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
                          title: kind === 'chat' ? `Chat · ${agent.label}` : agent.label,
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
                    void CreateAgentChat(session.id, repoId, agent.id, `Chat con ${agent.label}`).catch(() => {})
                }
                return
            }

            setActiveSessionId(session.id)
            setPanelTab('terminal')
            persistLayout({tab: 'terminal'})
        },
        [repoId, sessions, persistLayout, persistSessions, enterAgentMode],
    )

    // chatMenuItems arma el menú del `+`: primero empezar una conversación,
    // después el historial, **separado y agrupado por agente**.
    //
    // Los dos grupos no se intercalan a propósito. Mezclados —"Chat nuevo ·
    // Claude Code" seguido de "Chat con Claude Code"— las dos filas se leen
    // casi igual y hay que detenerse a distinguir cuál abre algo nuevo y cuál
    // retoma algo que ya existe, que es justo la decisión que uno viene a
    // tomar al abrir este menú.
    //
    // Lo usan el `+` de la solapa Agentes y el "Nueva" de Sesiones: tenerlo
    // dos veces garantizaba que a uno le faltara lo que el otro tenía, que ya
    // pasó con las conversaciones del CLI.
    // renameChat abre el mismo diálogo que el clic derecho sobre la solapa de
    // un chat. Está acá arriba porque ahora lo usan los dos lugares: la
    // solapa y el historial del menú.
    const renameChat = useCallback(
        (id: string, current: string) => {
            setPrompt({
                title: 'Renombrar el chat',
                label: 'Nombre',
                initial: current,
                confirmLabel: 'Guardar',
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

    const chatMenuItems = useCallback(
        (limitPerAgent: number) => {
            const usable = agentList.filter((a) => a.available && chatCapable.has(a.id))
            const items: (DropdownItem | DropdownHeader | 'separator')[] = [{header: 'Empezar una conversación'}]

            for (const a of usable) {
                items.push({
                    label: a.label,
                    icon: 'chat',
                    hint: a.vendor,
                    onSelect: () => addSession('chat', a),
                })
            }

            // Un grupo por agente, con su propio encabezado: el historial de
            // los tres en una sola lista obliga a leer de quién es cada fila.
            for (const a of usable) {
                const mine = chatHistory.filter((c) => c.agentId === a.id)
                // Las del propio CLI que todavía no se adoptaron. Se marcan
                // distinto: son las mismas que ves en la extensión de VS Code
                // o en la terminal, y saberlo explica por qué aparecen sin que
                // las hayas abierto nunca desde acá.
                const external = cliChats.filter(
                    (c) => c.agent === a.id && !chatHistory.some((h) => h.conversationId === c.id),
                )
                if (mine.length === 0 && external.length === 0) continue

                items.push('separator', {header: `${a.label} · historial`})
                for (const c of mine.slice(0, limitPerAgent)) {
                    items.push({
                        label: c.title || 'Sin nombre',
                        icon: 'history',
                        hint: new Date(c.updatedAt * 1000).toLocaleDateString('es'),
                        onSelect: () => resumeChat(c),
                        onContext: () => renameChat(c.id, c.title),
                    })
                }
                for (const c of external.slice(0, limitPerAgent)) {
                    items.push({
                        label: c.title,
                        icon: 'cloud_download',
                        hint: `ya estaba en ${a.label}`,
                        onSelect: () => void adoptConversation(a.id, c),
                    })
                }
            }
            return items
        },
        [agentList, chatCapable, chatHistory, cliChats, addSession, resumeChat, adoptConversation, renameChat],
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
                    `El último commit de "${b.name}" (${outside.shortHash}) queda fuera de los ${LOG_PAGE} commits cargados en el grafo, así que no hay fila a la que saltar. Lo tenés a la derecha.`,
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

            const known = commits.find((c) => c.hash === hash)
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
                    `El commit ${outside.shortHash} queda fuera de los ${LOG_PAGE} commits cargados en el grafo, así que no hay fila a la que saltar. Lo tenés a la derecha.`,
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

    // Right-click menu for a tag row. Mirrors the sidebar tree's tag menu
    // (GitRepoTree.tagMenuItems) so the same right-click does the same thing
    // in both places, with two differences this panel can afford: it knows
    // which commit the graph is showing, and its confirmations go through
    // this tab's own setConfirm/setPrompt.
    function tagMenuItems(t: git.Tag): (DropdownItem | 'separator')[] {
        const short = t.hash.slice(0, 8)
        return [
            {
                label: `Crear rama desde ${t.name}…`,
                icon: 'account_tree',
                // Offered above checkout on purpose: checking a tag out leaves
                // the repository in detached HEAD, which is where people lose
                // commits. Branching from it is what someone who wants to work
                // from a release almost always actually means.
                hint: 'Lo que casi siempre querés en vez de un checkout',
                onSelect: () =>
                    setPrompt({
                        title: `Crear rama desde el tag "${t.name}"`,
                        label: 'Nombre de la rama',
                        initial: '',
                        description: `La rama nueva arranca en el commit ${short}, al que apunta el tag. El tag no se modifica.`,
                        onSubmit: (v) => run(`checkout -b ${v} ${t.name}`, () => GitCreateBranch(repoId, v, t.name, true)),
                    }),
            },
            {
                label: `Checkout ${t.name}`,
                icon: 'check',
                hint: 'Deja el repo en HEAD desacoplado',
                onSelect: () => run(`checkout ${t.name}`, () => GitCheckout(repoId, t.name)),
            },
            {label: `Copiar '${t.name}'`, icon: 'content_copy', onSelect: () => copy(t.name)},
            {label: `Copiar el commit ${short}`, icon: 'content_copy', onSelect: () => copy(t.hash)},
            'separator',
            {
                label: `Push ${t.name} a origin`,
                icon: 'upload',
                hint: 'Un tag no viaja solo con un push normal',
                onSelect: () => run(`push origin ${t.name}`, () => GitPushTag(repoId, 'origin', t.name, new git.AuthConfig({}))),
            },
            'separator',
            // Local y remoto van separados a propósito: borrar un tag local lo
            // deja vivo en el servidor y viceversa, y es la sorpresa número uno
            // que da trabajar con tags. Un solo "Borrar" tendría que elegir por
            // el usuario cuál de las dos cosas hace.
            {
                label: `Borrar ${t.name}`,
                icon: 'delete',
                danger: true,
                hint: 'Solo local',
                onSelect: () =>
                    setConfirm({
                        title: 'Borrar tag local',
                        description: `Esto borra el tag "${t.name}" de tu repositorio local. La copia en el remoto (si la hay) sigue existiendo, y un fetch con tags te lo vuelve a traer. El commit ${short} no se toca.`,
                        confirmLabel: 'Borrar',
                        label: 'tag -d',
                        run: () => GitDeleteTag(repoId, t.name),
                    }),
            },
            {
                label: `Borrar ${t.name} de origin`,
                icon: 'delete_forever',
                danger: true,
                hint: 'Solo en el remoto',
                onSelect: () =>
                    setConfirm({
                        title: 'Borrar tag del remoto',
                        description: `Esto borra el tag "${t.name}" en el servidor, no tu copia local. Si el tag marca una versión publicada, cualquiera que dependa de él lo pierde. El commit ${short} no se toca.`,
                        confirmLabel: 'Borrar del remoto',
                        label: 'push --delete',
                        run: () => GitDeleteRemoteTag(repoId, 'origin', t.name, new git.AuthConfig({})),
                    }),
            },
        ]
    }

    // Right-click menu for a commit row.
    function commitMenuItems(c: git.CommitInfo): (DropdownItem | 'separator')[] {
        const short = c.shortHash
        return [
            // Va primero porque es de solo lectura y sin consecuencias, a
            // diferencia de todo lo que sigue.
            {
                label: 'Preguntarle al agente sobre este commit',
                icon: 'smart_toy',
                hint: 'Abre el chat con el prompt escrito; enviar y seguir la conversación es tuyo',
                onSelect: () =>
                    askAgentPicking(
                        `Explicá qué hizo el commit ${c.hash} de este repositorio (git show ${c.hash}) y `,
                        `commit ${short}`,
                    ),
            },
            'separator',
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
        // Revisar ANTES de publicar, que es cuando todavía se puede arreglar
        // barato. No pushea: abre el chat con el prompt escrito.
        {
            label: 'Revisar con el agente antes de pushear',
            icon: 'smart_toy',
            hint: upstream ? `Revisa ${upstream}..HEAD sin publicar nada` : 'La rama no tiene upstream: se revisan los commits locales',
            onSelect: () =>
                askAgentPicking(
                    upstream
                        ? `Revisá los commits que estoy por pushear en este repositorio (git log ${upstream}..HEAD y git diff ${upstream}..HEAD) y decime si ves algo que no debería publicarse. `
                        : 'Revisá los commits locales de esta rama que todavía no están publicados y decime si ves algo que no debería publicarse. ',
                    'lo que voy a pushear',
                ),
        },
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

    // Umbral medido contra el contenido real de la fila: ícono (14) + texto
    // (~45 a 11px) + relleno, por tres, más los separadores. Por debajo de eso
    // los tres botones no entran y hay que quedarse con los íconos.
    // Cinco solapas (Commits, Cambios, Stash, Archivos, Agente) no entran con
    // texto ni siquiera en una columna de 260px: quedaban recortadas a
    // "C…"/"St…"/"Ar…", que ocupa casi lo mismo y encima no se entiende. El
    // umbral sube para pasar a solo íconos antes de llegar a ese punto — los
    // cinco íconos son distintos entre sí y el tooltip sigue diciendo qué hace
    // cada uno.
    const compactTabs = sideWidth < 340

    const localBranches = pinnedFirst(branches.filter((b) => !b.isRemote && matchesFilter(b)))
    const remoteBranches = pinnedFirst(branches.filter((b) => b.isRemote && matchesFilter(b)))

    // Las ancladas se dibujan planas arriba de la sección, no dentro del árbol
    // (ver el comentario en el render). El resto va agrupado por los segmentos
    // del nombre: `feature/TIGOCHAT-11607` cuelga de una carpeta `feature`.
    const isPinnedBranch = (b: git.Branch) => pinned.includes(b.name)
    const pinnedLocal = localBranches.filter(isPinnedBranch)
    const pinnedRemote = remoteBranches.filter(isPinnedBranch)
    // El filtro de la caja de arriba es uno solo a propósito: buscar "1.31" o
    // "TIGOCHAT" sin tener que decidir de antemano si eso es una rama o un tag
    // es justamente lo que uno quiere de un buscador de referencias.
    const visibleTags = useMemo(
        () => tags.filter((t) => !branchQuery || t.name.toLowerCase().includes(branchQuery)),
        [tags, branchQuery],
    )
    const tagGroups = useMemo(() => groupTags(visibleTags), [visibleTags])

    const localTree = useMemo(
        () => buildBranchTree(localBranches.filter((b) => !isPinnedBranch(b))),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [localBranches, pinned],
    )
    const remoteTree = useMemo(
        () => buildBranchTree(remoteBranches.filter((b) => !isPinnedBranch(b))),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [remoteBranches, pinned],
    )

    // Props comunes de cada fila de rama. Están acá y no repetidas en los
    // cuatro puntos donde se dibuja una (ancladas locales, árbol local,
    // ancladas remotas, árbol remoto) para que un cambio de comportamiento no
    // tenga que aplicarse cuatro veces.
    const branchRowProps = (b: git.Branch) => ({
        branch: b,
        isPinned: isPinnedBranch(b),
        onTogglePin: () => void togglePinned(b.name),
        selected: selectedBranch === b.name,
        disabled: !!busy,
        onSelect: () => void selectBranch(b),
        onCheckout: () =>
            void run(`checkout ${b.name}`, () => GitCheckout(repoId, b.name)).then((ok) => {
                if (ok) void selectBranch(b)
            }),
        onContextMenu: (e: ReactMouseEvent) => setMenu({x: e.clientX, y: e.clientY, items: branchMenuItems(b)}),
    })

    // Abre de entrada solo las carpetas que llevan a la rama actual, una vez
    // por pestaña. Si se recalculara en cada render volvería a abrirlas
    // después de que las cierres a mano, que es la clase de "ayuda" que
    // termina peleando con el usuario.
    useEffect(() => {
        if (seededFoldersRef.current) return
        const current = branches.find((b) => b.isCurrent)
        if (!current) return
        seededFoldersRef.current = true
        const paths = expandedForBranch(buildBranchTree(branches.filter((b) => !b.isRemote)), current.name)
        if (paths.length > 0) setExpandedFolders((prev) => new Set([...prev, ...paths]))
    }, [branches])

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
                {/* Describir el PR va al lado de crearlo, que es donde uno se
                    queda mirando el formulario vacío. Abre el chat con el
                    prompt escrito: el título y el cuerpo los pega el usuario
                    en la página del forge, esta app no tiene token de nadie. */}
                {forge?.compareUrl && (
                    <button
                        onClick={() =>
                            askAgentPicking(
                                `Escribí el título y el cuerpo del pull request de la rama "${status?.branch ?? ''}" de este repositorio, mirando los commits que la separan de su base (git log y git diff contra la rama principal). `,
                                `PR de ${status?.branch ?? 'esta rama'}`,
                            )
                        }
                        title="Le pide al agente el título y el cuerpo del PR a partir de los commits de la rama. Lo escribe en el chat para que lo revises y lo pegues."
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="smart_toy" size={13} />
                        Describir
                    </button>
                )}
                {/* Modo agente: deja archivos + conversación y esconde ramas,
                    grafo y diff.

                    Va en la barra de arriba y NO en la columna de ramas: el
                    modo oculta esa columna, así que el botón que lo apaga se
                    escondía junto con ella y no había forma de volver más que
                    reabrir el panel a mano. Un interruptor tiene que
                    sobrevivir a lo que apaga. */}
                <button
                    onClick={toggleAgentMode}
                    title={
                        agentMode
                            ? 'Volver a la vista de siempre: ramas, grafo y diff'
                            : 'Modo agente: archivos del proyecto y conversación, sin ramas, grafo ni diff ocupando la pantalla'
                    }
                    className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
                        agentMode
                            ? 'bg-primary text-on-primary'
                            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                    }`}
                >
                    <Icon name="smart_toy" size={14} />
                    Agente
                </button>
                {/* Los interruptores de paneles viven en un menú y no como
                    botones sueltos: la fila ya tenía "Crear pull request",
                    Terminal y Comandos, y tres botones más la desbordaban en
                    una ventana angosta. Además, un botón permanentemente
                    resaltado (el estado normal de Ramas y Diff, que están
                    visibles casi siempre) compite visualmente con los que
                    marcan algo abierto de verdad. */}
                <DropdownMenu
                    label="Vista"
                    icon="visibility"
                    title="Mostrar u ocultar los paneles de esta pestaña. Lo que elijas queda guardado y la pestaña vuelve a abrirse así."
                    width={300}
                    items={[
                        {
                            label: sideHidden ? 'Mostrar el panel de ramas' : 'Ocultar el panel de ramas',
                            icon: sideHidden ? 'visibility' : 'visibility_off',
                            hint: sideHidden ? 'Ahora está oculto' : 'Izquierda',
                            onSelect: toggleSide,
                        },
                        {
                            label: diffHidden ? 'Mostrar el panel de diff' : 'Ocultar el panel de diff',
                            icon: diffHidden ? 'visibility' : 'visibility_off',
                            hint: diffHidden ? 'Ahora está oculto' : 'Derecha',
                            onSelect: toggleDiff,
                        },
                        'separator',
                        {
                            label: showWorktrees ? 'Ocultar worktrees' : 'Ver worktrees',
                            icon: 'dashboard',
                            hint: 'Varias ramas a la vez, en carpetas distintas',
                            onSelect: () => setShowWorktrees((v) => !v),
                        },
                    ]}
                />
                {panelTab === null && <button
                    onClick={() => openPanel('terminal')}
                    title="Abre una terminal de verdad en la raíz de este repositorio: podés hacer cd, correr los tests, un rebase interactivo o cualquier comando que la interfaz no cubra, sin salir de la app. Se puede anclar abajo, a la izquierda o a la derecha, y el intérprete (zsh, bash, PowerShell, Git Bash…) se elige en Configuración → Terminal."
                    className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant"
                >
                    <Icon name="terminal" size={13} />
                    Terminal
                </button>}
                {/* Antes acá había un botón "Comandos" que repetía una solapa
                    del panel de abajo. Se reemplazó por el acceso a lo
                    agéntico, que es lo que de verdad no se encontraba: los
                    chats, los skills del repo, los servidores MCP y el consumo
                    estaban todos detrás de una solapa chica sin nada que
                    anunciara qué había adentro. */}
                {panelTab === null && <button
                    onClick={() => openPanel('agents')}
                    title="Asistentes de código sobre este repositorio: chatear con Claude Code, Codex o Antigravity, ver qué skills e instrucciones tiene preparadas el repo, qué servidores MCP ve cada agente, y cuántos tokens llevás gastados."
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant"
                >
                    <Icon name="smart_toy" size={13} />
                    Agentes
                </button>}
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
                {/* Left: view switch + branches.

                    overflow-hidden no es cosmético: `width` fija el ancho de
                    la columna, pero sus hijos siguen teniendo min-width:auto,
                    así que cualquier fila cuyo contenido no pueda encogerse
                    (la de Commits/Cambios/Stash es la que lo hacía) se
                    dibujaba PASADO el borde, encima del grafo. Clipear acá lo
                    vuelve imposible; el min-w-0 de las filas es lo que además
                    hace que se degraden bien en vez de quedar cortadas. */}
                {!sideHidden && (
                <div style={{width: sideWidth}} className="flex shrink-0 flex-col overflow-hidden border-r border-outline-variant bg-surface-container-lowest">
                    <div className="flex shrink-0 gap-0.5 border-b border-outline-variant p-1">
                        <ViewTab
                            active={view === 'commits'}
                            onClick={() => setView('commits')}
                            icon="history"
                            label="Commits"
                            compact={compactTabs}
                            title="Ver el historial de commits del repositorio"
                        />
                        <ViewTab
                            compact={compactTabs}
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
                            compact={compactTabs}
                            active={view === 'stash'}
                            onClick={() => setView('stash')}
                            icon="inventory_2"
                            label="Stash"
                            badge={stashes.length}
                            title="Ver los cambios apartados en stashes, con su contenido, antes de aplicarlos"
                        />
                        <ViewTab
                            compact={compactTabs}
                            active={view === 'files'}
                            onClick={() => setView('files')}
                            icon="edit_document"
                            label="Archivos"
                            title="Abrir y editar los archivos del repositorio sin salir de la app"
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
                                placeholder="Filtrar ramas y tags…"
                                title="Filtra por nombre en las ramas locales, las remotas y los tags a la vez — no hace falta decidir de antemano qué de las tres cosas estás buscando"
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
                        <SectionLabel
                            count={localBranches.length}
                            open={!collapsedSections.has('local')}
                            onToggle={() => toggleSection('local')}
                        >
                            Ramas
                        </SectionLabel>
                        {/* Las ancladas van planas y arriba de todo: anclarlas
                            existe justamente para sacarlas del montón, así que
                            volver a meterlas dentro de su carpeta anularía la
                            función. */}
                        {!collapsedSections.has('local') && pinnedLocal.map((b) => (
                            <BranchRow {...branchRowProps(b)} key={b.name} />
                        ))}
                        {!collapsedSections.has('local') && (
                            <BranchTree
                                node={localTree}
                                depth={0}
                                expanded={expandedFolders}
                                expandAll={filtering}
                                onToggleFolder={toggleFolder}
                                renderBranch={(b, folderPath) => (
                                    <BranchRow {...branchRowProps(b)} key={b.name} label={leafLabel(b, folderPath)} depth={folderDepth(folderPath)} />
                                )}
                            />
                        )}

                        <SectionLabel
                            count={remoteBranches.length}
                            open={!collapsedSections.has('remote')}
                            onToggle={() => toggleSection('remote')}
                        >
                            Remotas
                        </SectionLabel>
                        {!collapsedSections.has('remote') && pinnedRemote.map((b) => (
                            <BranchRow {...branchRowProps(b)} key={b.name} />
                        ))}
                        {!collapsedSections.has('remote') && (
                            <BranchTree
                                node={remoteTree}
                                depth={0}
                                expanded={expandedFolders}
                                expandAll={filtering}
                                onToggleFolder={toggleFolder}
                                renderBranch={(b, folderPath) => (
                                    <BranchRow {...branchRowProps(b)} key={b.name} label={leafLabel(b, folderPath)} depth={folderDepth(folderPath)} />
                                )}
                            />
                        )}

                        {/* Tags. Hasta ahora solo estaban en el árbol de la
                            barra lateral, que no puede llevar el grafo a
                            ningún lado: para mirar qué entró en una versión
                            había que buscar el tag ahí, copiar el nombre y
                            filtrar el log a mano. Acá un click lo revela en
                            el grafo, igual que una rama. */}
                        {tags.length > 0 && (
                            <>
                                <SectionLabel
                                    count={visibleTags.length}
                                    open={!collapsedSections.has('tags')}
                                    onToggle={() => toggleSection('tags')}
                                >
                                    Tags
                                </SectionLabel>
                                {!collapsedSections.has('tags') && tagGroups.groups.map((group) => {
                                    const key = `tag:${group.key}`
                                    const open = filtering || expandedFolders.has(key)
                                    return (
                                        <div key={key}>
                                            <button
                                                onClick={() => toggleFolder(key)}
                                                title={
                                                    open
                                                        ? `Plegar "${group.key}" — sus ${group.tags.length} tags dejan de ocupar la lista`
                                                        : `Desplegar "${group.key}" — tiene ${group.tags.length} tags`
                                                }
                                                className="flex w-full items-center gap-1 rounded py-1 pl-2 pr-2 text-left text-[11px] text-on-surface-variant hover:bg-surface-variant"
                                            >
                                                <Icon name={open ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0 opacity-60" />
                                                <Icon name="sell" size={13} className="shrink-0 opacity-60" />
                                                <span className="truncate">{group.key}</span>
                                                <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums opacity-50">{group.tags.length}</span>
                                            </button>
                                            {open &&
                                                group.tags.map((t) => (
                                                    <TagRow key={t.name} tag={t} depth={1} onSelect={() => revealCommit(t.hash)} onContextMenu={(e) => setMenu({x: e.clientX, y: e.clientY, items: tagMenuItems(t)})} />
                                                ))}
                                        </div>
                                    )
                                })}
                                {!collapsedSections.has('tags') && tagGroups.loose.map((t) => (
                                    <TagRow key={t.name} tag={t} depth={0} onSelect={() => revealCommit(t.hash)} onContextMenu={(e) => setMenu({x: e.clientX, y: e.clientY, items: tagMenuItems(t)})} />
                                ))}
                            </>
                        )}

                        {branchFilter && localBranches.length === 0 && remoteBranches.length === 0 && visibleTags.length === 0 && (
                            <p className="px-2 py-3 text-[11px] text-on-surface-variant/70">Ninguna rama ni tag coincide con «{branchFilter}».</p>
                        )}
                    </div>
                </div>
                )}

                {!sideHidden && (
                    <PaneHandle onStart={() => setDragging('side')} title="Arrastrá para cambiar el ancho del panel de ramas — el tamaño se guarda" />
                )}

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
                            onAsk={(path) =>
                                askAgentPicking(
                                    `Estoy resolviendo un conflicto de ${inProgress || 'merge'} en el archivo ${path} de este repositorio. Leelo, explicame qué está en conflicto y proponeme un criterio para resolverlo. No lo edites: la resolución la aplico yo. `,
                                    `conflicto en ${path}`,
                                )
                            }
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
                    ) : view === 'files' ? (
                        <GitFileEditor
                            repoId={repoId}
                            editorThemeId={editorThemeId}
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
                            drafting={drafting}
                            onDraftMessage={draftAgent ? () => void draftCommitMessage() : undefined}
                            onCommit={() =>
                                run('commit', async () => {
                                    await GitCommit(repoId, commitMessage, false)
                                    setCommitMessage('')
                                })
                            }
                        />
                    )}
                </div>

                {!diffHidden && (
                    <PaneHandle onStart={() => setDragging('diff')} title="Arrastrá para cambiar el ancho del panel de diff — el tamaño se guarda" />
                )}

                {/* Right: commit detail + file list + diff.

                    overflow-hidden por el mismo motivo que la columna de
                    ramas: ancho fijo + hijos con min-width:auto = contenido
                    dibujado fuera del panel. */}
                {!diffHidden && (
                <div style={{width: diffWidth}} className="flex shrink-0 flex-col overflow-hidden">
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
                                // Solo desde el working tree. En el diff de un
                                // commit "editar" llevaría al archivo de HOY,
                                // que puede no tener nada que ver con las
                                // líneas que se están mirando.
                                onEdit={
                                    view === 'changes' && selectedPath
                                        ? () => {
                                              setEditRequest({path: selectedPath, token: Date.now()})
                                              setView('files')
                                          }
                                        : undefined
                                }
                                onAsk={
                                    view === 'changes' && selectedPath
                                        ? () =>
                                              askAgentPicking(
                                                  // Se nombra el archivo y se
                                                  // le pide al agente que mire
                                                  // el diff él mismo: `git
                                                  // diff` es una herramienta
                                                  // que los tres tienen, y
                                                  // pegar el parche entero en
                                                  // el prompt gasta contexto y
                                                  // rompe el pegado del PTY.
                                                  `Revisá el cambio sin commitear de ${selectedPath} (git diff) y `,
                                                  `diff de ${selectedPath}`,
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
                        title={
                            dock === 'bottom'
                                ? 'Arrastrá para cambiar el alto del panel — el tamaño queda guardado'
                                : 'Arrastrá para cambiar el ancho del panel — el tamaño queda guardado'
                        }
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
                        className={`flex shrink-0 items-center gap-1 border-b border-outline-variant px-2 py-0.5 text-[11px] ${
                            dock === 'bottom' ? 'mt-1.5' : dock === 'right' ? 'ml-1.5' : 'mr-1.5'
                        }`}
                    >
                        <button
                            onClick={() => openPanel('terminal')}
                            title="Sesiones abiertas: terminales y asistentes de código corriendo en este repositorio"
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'terminal' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="terminal" size={13} />
                            Sesiones
                        </button>
                        <button
                            onClick={() => {
                                setPanelTab('commands')
                                persistLayout({tab: 'commands'})
                            }}
                            title="Registro de solo lectura de los comandos git que ejecutó la app, con su salida y cuánto tardaron"
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'commands' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="history" size={13} />
                            {dock === 'bottom' ? 'Comandos ejecutados' : 'Comandos'}
                        </button>
                        <button
                            onClick={() => {
                                setPanelTab('agents')
                                persistLayout({tab: 'agents'})
                                enterAgentMode()
                            }}
                            title="Qué le ofrece este repositorio a un agente: skills, subagentes, comandos y archivos de instrucciones — incluidos los que faltan"
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${panelTab === 'agents' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'}`}
                        >
                            <Icon name="smart_toy" size={13} />
                            Agentes
                            {/* Un contador: una solapa que dice cuántas cosas
                                tiene adentro invita a abrirla; una vacía de
                                señales se ignora. Cuenta lo que ESTE repo
                                tiene preparado, no lo que la app soporta. */}
                            {agentBadge > 0 && (
                                <span className="rounded-full bg-primary/20 px-1 text-[10px] text-primary">{agentBadge}</span>
                            )}
                        </button>

                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                            <button
                                onClick={() => onChangeTerminalFontSize(terminalFontSize - 1)}
                                disabled={terminalFontSize <= TERMINAL_FONT_MIN}
                                title={
                                    terminalFontSize <= TERMINAL_FONT_MIN
                                        ? `Ya estás en el tamaño mínimo (${TERMINAL_FONT_MIN}px) — más chico deja de leerse`
                                        : `Achicar la letra a ${terminalFontSize - 1}px. Entran más columnas y más líneas; aplica a todas las terminales y queda guardado.`
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
                                        ? `Ya estás en el tamaño máximo (${TERMINAL_FONT_MAX}px) — más grande entran tan pocas columnas que la salida se rompe`
                                        : `Agrandar la letra a ${terminalFontSize + 1}px. Aplica a todas las terminales y queda guardado.`
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
                                    title={dock === d.id ? `${d.title} (es donde está ahora)` : d.title}
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
                                title="Cierra el panel. Las sesiones siguen vivas: al volver a abrirlo seguís en el mismo directorio y con lo mismo en pantalla."
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
                                title="Qué le ofrece este repositorio a un agente: skills, instrucciones, servidores MCP, consumo y plan"
                                className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                                    agentsView === 'context'
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-on-surface-variant hover:bg-surface-variant'
                                }`}
                            >
                                <Icon name="dataset" size={12} />
                                Contexto
                            </button>

                            {sessions
                                .filter((s) => s.kind === 'chat')
                                .map((s) => (
                                    <span
                                        key={s.id}
                                        className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
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
                                                            label: 'Renombrar el chat…',
                                                            icon: 'edit',
                                                            onSelect: () =>
                                                                setPrompt({
                                                                    title: 'Renombrar el chat',
                                                                    label: 'Nombre',
                                                                    initial: s.title,
                                                                    confirmLabel: 'Guardar',
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
                                                            label: 'Quitar del historial',
                                                            icon: 'delete',
                                                            danger: true,
                                                            hint: 'La conversación sigue en el CLI; se pierde el atajo',
                                                            onSelect: () => {
                                                                void DeleteAgentChat(s.id).then(reloadChatHistory).catch(() => {})
                                                                closeSession(s.id)
                                                            },
                                                        },
                                                    ],
                                                })
                                            }}
                                            title={`${s.title} — click derecho para renombrarlo o quitarlo del historial`}
                                            className="max-w-40 truncate"
                                        >
                                            {s.title}
                                        </button>
                                        <button
                                            onClick={() => {
                                                closeSession(s.id)
                                                setActiveChatId((cur) => (cur === s.id ? null : cur))
                                            }}
                                            title="Cierra la conversación. Queda en el historial y se puede retomar."
                                            className="rounded hover:text-on-surface"
                                        >
                                            <Icon name="close" size={12} />
                                        </button>
                                    </span>
                                ))}

                            <DropdownMenu
                                label=""
                                icon="add"
                                title="Empezar una conversación nueva con un agente, o retomar una de las anteriores de este repositorio — incluidas las que ya tenías fuera de la app. Clic derecho sobre una del historial para renombrarla."
                                width={360}
                                items={chatMenuItems(5)}
                            />
                        </div>
                    )}

                    {/* Tira de sesiones. Solo en la solapa de sesiones: en
                        Comandos no habría nada que elegir. */}
                    {panelTab === 'terminal' && (
                        <div
                            className={`flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-outline-variant px-1 py-0.5 text-[11px] ${
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
                                                              label: 'Renombrar el chat…',
                                                              icon: 'edit',
                                                              onSelect: () =>
                                                                  setPrompt({
                                                                      title: 'Renombrar el chat',
                                                                      label: 'Nombre',
                                                                      placeholder: s.title,
                                                                      initial: s.title,
                                                                      confirmLabel: 'Guardar',
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
                                                              label: 'Quitar del historial',
                                                              icon: 'delete',
                                                              danger: true,
                                                              hint: 'La conversación sigue existiendo en el CLI; se pierde el atajo para retomarla',
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
                                            ? `${s.title} — click derecho para renombrarlo o quitarlo del historial`
                                            : s.kind === 'agent'
                                              ? `Sesión de ${s.title} en este repositorio`
                                              : 'Terminal en la raíz de este repositorio'
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
                                        title={`Cierra esta sesión y termina su proceso${s.kind === 'agent' ? ` — ${s.title} deja de correr` : ''}`}
                                        className="shrink-0 rounded opacity-0 hover:bg-surface-variant group-hover:opacity-70"
                                    >
                                        <Icon name="close" size={12} />
                                    </span>
                                </div>
                            ))}

                            <DropdownMenu
                                label="Nueva"
                                icon="add"
                                title="Abrir una terminal en este repositorio, o un asistente en su terminal completa con su propio render y su diálogo de permisos. Para chatear con un agente, la solapa Agentes."
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
                                        label: 'Terminal',
                                        icon: 'terminal',
                                        hint: 'Shell en la raíz del repositorio',
                                        onSelect: () => addSession('shell'),
                                    },
                                    // Los CLIs en su terminal completa: es otra
                                    // cosa que el chat y por eso va en otro
                                    // grupo, no intercalado.
                                    ...agentList.map((a) => ({
                                        label: `${a.label} en terminal`,
                                        icon: 'smart_toy',
                                        hint: a.available
                                            ? `${a.vendor} — su render y su propio diálogo de permisos`
                                            : 'No está instalado en este equipo',
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
                                    Trabajá sobre <span className="text-on-surface">{repoName}</span> sin salir de la app.
                                </p>

                                <div className="flex flex-col gap-1.5">
                                    {agentList
                                        .filter((a) => a.available && chatCapable.has(a.id))
                                        .map((a) => (
                                            <button
                                                key={`chat-${a.id}`}
                                                onClick={() => addSession('chat', a)}
                                                title={`Conversación con ${a.label}: se ve lo que hace paso a paso y cuántos tokens costó. Para que edite archivos hay que autorizarlo explícitamente.`}
                                                className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                            >
                                                <Icon name="chat" size={14} className="mt-0.5 shrink-0 text-primary" />
                                                <span className="min-w-0">
                                                    <span className="block text-xs text-on-surface">Chatear con {a.label}</span>
                                                    <span className="block text-[11px] text-on-surface-variant">
                                                        Pregunta, revisa y propone. Edita solo si lo autorizás.
                                                    </span>
                                                </span>
                                            </button>
                                        ))}

                                    {chatHistory.length > 0 && (
                                        <button
                                            onClick={() => resumeChat(chatHistory[0])}
                                            title={`Retoma "${chatHistory[0].title || 'la última conversación'}" donde la dejaste`}
                                            className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                        >
                                            <Icon name="history" size={14} className="mt-0.5 shrink-0 text-primary" />
                                            <span className="min-w-0">
                                                <span className="block truncate text-xs text-on-surface">
                                                    Seguir: {chatHistory[0].title || 'última conversación'}
                                                </span>
                                                <span className="block text-[11px] text-on-surface-variant">
                                                    {chatHistory.length} conversación{chatHistory.length === 1 ? '' : 'es'} guardada
                                                    {chatHistory.length === 1 ? '' : 's'} en este repositorio
                                                </span>
                                            </span>
                                        </button>
                                    )}

                                    <button
                                        onClick={() => addSession('shell')}
                                        title="Una shell en la raíz del repositorio, para lo que la interfaz no cubre"
                                        className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                    >
                                        <Icon name="terminal" size={14} className="mt-0.5 shrink-0 text-on-surface-variant" />
                                        <span className="min-w-0">
                                            <span className="block text-xs text-on-surface">Abrir una terminal</span>
                                            <span className="block text-[11px] text-on-surface-variant">
                                                Shell en la raíz del repositorio
                                            </span>
                                        </span>
                                    </button>

                                    <button
                                        onClick={() => {
                                            setPanelTab('agents')
                                            persistLayout({tab: 'agents'})
                                            enterAgentMode()
                                        }}
                                        title="Skills, subagentes, archivos de instrucciones, servidores MCP y consumo de tokens de este repositorio"
                                        className="flex items-start gap-2 rounded border border-outline-variant px-2 py-1.5 text-left hover:bg-surface-container-high"
                                    >
                                        <Icon name="smart_toy" size={14} className="mt-0.5 shrink-0 text-on-surface-variant" />
                                        <span className="min-w-0">
                                            <span className="block text-xs text-on-surface">Ver qué tiene este repositorio</span>
                                            <span className="block text-[11px] text-on-surface-variant">
                                                Skills, instrucciones, servidores MCP y consumo
                                            </span>
                                        </span>
                                    </button>
                                </div>

                                {agentList.filter((a) => a.available).length === 0 && (
                                    <p className="mt-3 text-[11px] text-on-surface-variant">
                                        No hay ningún asistente de código instalado en este equipo. Se configuran en Configuración →
                                        Agentes de código.
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
                                        repoId={repoId}
                                        agentId={s.agentId ?? ''}
                                        agentLabel={agentList.find((a) => a.id === s.agentId)?.label ?? s.title}
                                        seed={chatSeed?.sessionId === s.id ? chatSeed : null}
                                        // Al retomar, el chat vuelve a dibujar
                                        // lo que ya se habló leyendo el
                                        // transcript del propio CLI.
                                        resumeConversationId={
                                            chatHistory.find((c) => c.id === s.id)?.conversationId || undefined
                                        }
                                        initialSettings={(() => {
                                            const c = chatHistory.find((x) => x.id === s.id)
                                            return c ? {model: c.model, effort: c.effort, mode: c.mode} : undefined
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
                                        onValidateWithAnother={(exclude) => {
                                            // Otro agente, no el mismo: el
                                            // valor de que revise otro está en
                                            // que no comparte los puntos ciegos
                                            // del que escribió.
                                            const other = agentList.find(
                                                (a) => a.available && chatCapable.has(a.id) && a.id !== exclude,
                                            )
                                            if (!other) {
                                                setError('No hay otro asistente con chat instalado para revisar.')
                                                return
                                            }
                                            askAgent(
                                                other.id,
                                                'Revisá los cambios sin commitear de este repositorio (git diff) como si fueras otro par: decime qué está mal, qué falta y qué no haría así. ',
                                                'revisión cruzada',
                                            )
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
                            <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-outline-variant bg-surface-container-high px-2 py-1 text-[11px]">
                                <Icon name="smart_toy" size={13} className="shrink-0 text-primary" />
                                <span className="min-w-0 flex-1 truncate text-on-surface-variant">
                                    Prompt listo sobre <span className="text-on-surface">{pendingPrompt.about}</span> — insertalo cuando el agente
                                    haya arrancado.
                                </span>
                                <button
                                    onClick={() => {
                                        void WriteLocalTerminal(pendingPrompt.sessionId, pendingPrompt.text)
                                        setPendingPrompt(null)
                                    }}
                                    title="Escribe el prompt en la sesión. No lo envía: revisalo, completalo y mandalo vos."
                                    className="shrink-0 rounded bg-primary px-2 py-0.5 text-on-primary"
                                >
                                    Insertar
                                </button>
                                <button
                                    onClick={() => setPendingPrompt(null)}
                                    title="Descarta el prompt"
                                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="close" size={14} />
                                </button>
                            </div>
                        )}
                        {panelTab === 'commands' && (
                            <div className="absolute inset-0">
                                <GitCommandLogDrawer
                                    reloadToken={logToken}
                                    onAsk={(command, output) =>
                                        askAgentPicking(
                                            `Este comando falló en este repositorio:\n\n${command}\n\nY devolvió:\n\n${output}\n\nExplicame qué pasó y cómo salir de esto. `,
                                            command,
                                        )
                                    }
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

function ViewTab({
    active,
    onClick,
    icon,
    label,
    title,
    badge,
    compact,
}: {
    active: boolean
    onClick: () => void
    icon: string
    label: string
    title: string
    badge?: number
    // Con la columna angosta se muestra solo el ícono. Es mejor que recortar
    // el texto a "Comm…"/"Camb…", que ocupa casi lo mismo y encima no se
    // entiende; los tres íconos son distintos entre sí y el tooltip sigue
    // diciendo qué hace cada uno.
    compact?: boolean
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            // min-w-0 anula el min-width:auto que traen los ítems flex por
            // defecto — sin él `flex-1` no sirve de nada: el botón se niega a
            // bajar del ancho de su propio contenido y los tres desbordan la
            // columna en vez de repartirse lo que hay.
            className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] ${
                active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
            }`}
        >
            <Icon name={icon} size={14} className="shrink-0" />
            {!compact && <span className="truncate">{label}</span>}
            {/* secondary is the commit/success role — a live count of pending
                changes reads as "there is work here", not as an error. */}
            {badge != null && badge > 0 && (
                <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10px] font-medium leading-4 text-on-secondary">{badge}</span>
            )}
        </button>
    )
}

// SectionLabel es la cabecera PLEGABLE de cada bloque del panel de ramas.
//
// Antes era un título fijo: con muchas ramas remotas o muchos tags, encontrar
// las locales obligaba a scrollear todo lo demás sin poder sacarlo de en
// medio. Ahora cada bloque se pliega, y el contador queda a la vista cuando
// está cerrado — que es lo que hace que plegarlo no sea perder de vista que
// hay algo ahí.
function SectionLabel({
    children,
    count,
    open,
    onToggle,
}: {
    children: React.ReactNode
    count?: number
    open?: boolean
    onToggle?: () => void
}) {
    const label = (
        <>
            <Icon
                name={open === false ? 'chevron_right' : 'expand_more'}
                size={12}
                className="shrink-0 opacity-70"
            />
            {children}
            {count != null && <span className="font-mono text-[9px] font-normal tabular-nums opacity-70">{count}</span>}
        </>
    )
    if (!onToggle) {
        return (
            <p className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">
                {label}
            </p>
        )
    }
    return (
        <button
            onClick={onToggle}
            title={open === false ? 'Desplegar esta sección' : 'Plegar esta sección — el contador sigue a la vista'}
            className="flex w-full items-center gap-1.5 rounded px-2 pb-1 pt-2 text-left text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60 hover:bg-surface-variant hover:text-on-surface-variant"
        >
            {label}
        </button>
    )
}

// folderDepth es cuántos niveles de indentación le tocan a una rama según la
// carpeta de la que cuelga. Vive acá porque la comparten el árbol y las filas.
function folderDepth(folderPath: string): number {
    return folderPath === '' ? 0 : folderPath.split('/').length
}

// Fila de carpeta del árbol de ramas: plegable, con el nombre del segmento y
// cuántas ramas hay adentro (el contador es lo que permite decidir si vale la
// pena abrirla sin abrirla).
function BranchFolderRow({
    node,
    depth,
    open,
    onToggle,
}: {
    node: BranchTreeNode
    depth: number
    open: boolean
    onToggle: () => void
}) {
    const total = countBranches(node)
    return (
        <button
            onClick={onToggle}
            title={
                open
                    ? `Plegar "${node.path}" — sus ${total} ramas dejan de ocupar la lista`
                    : `Desplegar "${node.path}" — tiene ${total} ${total === 1 ? 'rama' : 'ramas'}`
            }
            style={{paddingLeft: 8 + depth * 12}}
            className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-[11px] text-on-surface-variant hover:bg-surface-variant"
        >
            <Icon name={open ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0 opacity-60" />
            <Icon name={open ? 'folder_open' : 'folder'} size={13} className="shrink-0 opacity-60" />
            <span className="truncate">{node.label}</span>
            <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums opacity-50">{total}</span>
        </button>
    )
}

// BranchTree dibuja carpetas y ramas recursivamente. No sabe cómo es una fila
// de rama —la recibe por renderBranch— para que el mismo árbol sirva en la
// barra lateral de la pestaña y en cualquier otra vista sin arrastrar el
// diseño de la fila con él.
function BranchTree({
    node,
    depth,
    expanded,
    expandAll,
    onToggleFolder,
    renderBranch,
}: {
    node: BranchTreeNode
    depth: number
    expanded: Set<string>
    // Fuerza todo abierto (el caso del filtro de texto), sin tocar el conjunto
    // de carpetas que el usuario abrió a mano.
    expandAll?: boolean
    onToggleFolder: (path: string) => void
    renderBranch: (branch: git.Branch, folderPath: string) => React.ReactNode
}) {
    return (
        <>
            {node.folders.map((folder) => {
                const open = expandAll || expanded.has(folder.path)
                return (
                    <div key={folder.path}>
                        <BranchFolderRow node={folder} depth={depth} open={open} onToggle={() => onToggleFolder(folder.path)} />
                        {open && (
                            <BranchTree
                                node={folder}
                                depth={depth + 1}
                                expanded={expanded}
                                expandAll={expandAll}
                                onToggleFolder={onToggleFolder}
                                renderBranch={renderBranch}
                            />
                        )}
                    </div>
                )
            })}
            {node.branches.map((b) => renderBranch(b, node.path))}
        </>
    )
}

// Fila de tag. Más chata que la de rama a propósito: un tag no tiene estado
// (no es la actual, no está adelante ni atrás, no se ancla), así que lo único
// que aporta además del nombre es a qué commit apunta y de cuándo es.
function TagRow({
    tag,
    depth,
    onSelect,
    onContextMenu,
}: {
    tag: git.Tag
    depth: number
    onSelect: () => void
    onContextMenu: (e: ReactMouseEvent) => void
}) {
    const date = tag.taggerDate ? tag.taggerDate.slice(0, 10) : ''
    return (
        <button
            onClick={onSelect}
            onContextMenu={(e) => {
                e.preventDefault()
                onContextMenu(e)
            }}
            title={[
                `Tag "${tag.name}" → commit ${tag.hash.slice(0, 8)}`,
                tag.annotated ? 'Anotado' : 'Ligero (sin mensaje ni autor propios)',
                tag.message ? `\n${tag.message}` : '',
                '\nClick: llevar el grafo a ese commit. Click derecho: crear rama desde el tag, push, borrar…',
            ]
                .filter(Boolean)
                .join(' · ')}
            style={{paddingLeft: 8 + depth * 12}}
            className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[11px] text-on-surface-variant hover:bg-surface-variant"
        >
            <Icon name="sell" size={13} className="shrink-0 opacity-50" />
            <span className="truncate">{tag.name}</span>
            {date && <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums opacity-45">{date}</span>}
        </button>
    )
}

function BranchRow({
    branch,
    label,
    depth,
    selected,
    disabled,
    onSelect,
    onCheckout,
    onContextMenu,
    isPinned,
    onTogglePin,
}: {
    branch: git.Branch
    // Texto a mostrar. Dentro del árbol es el nombre sin el prefijo de su
    // carpeta; suelto (una rama anclada, o una sin barras) es el nombre
    // completo. El checkout siempre usa branch.name, nunca esto.
    label?: string
    // Nivel de indentación heredado de la carpeta contenedora.
    depth?: number
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
            style={{paddingLeft: 10 + (depth ?? 0) * 12}}
            className={`group relative flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-[11px] transition-colors disabled:opacity-40 ${
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
            <span className="truncate">{label ?? branch.name}</span>
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
    onDraftMessage,
    drafting,
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
    // Ausente cuando no hay ningún agente con chat verificado instalado: la
    // acción no se ofrece en vez de ofrecerla y fallar al tocarla.
    onDraftMessage?: () => void
    drafting?: boolean
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
                    {/* Redactar el mensaje desde el diff preparado. Respeta el
                        prefijo de tipo/scope que ya haya: el agente escribe el
                        resumen, la convención del proyecto la sigue poniendo
                        el selector de al lado. */}
                    {onDraftMessage && (
                        <button
                            onClick={onDraftMessage}
                            disabled={busy || staged.length === 0 || drafting}
                            title={
                                staged.length === 0
                                    ? 'Agregá archivos al stage: el mensaje se redacta a partir de lo que está preparado'
                                    : 'Le pasa el diff preparado al agente para que redacte el mensaje. Lo escribe en el campo — commitear sigue siendo tuyo.'
                            }
                            className="ml-auto flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-[10px] text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                        >
                            <Icon name={drafting ? 'hourglass_top' : 'smart_toy'} size={11} />
                            {drafting ? 'Redactando…' : 'Redactar'}
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
