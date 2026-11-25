import {useCallback, useEffect, useMemo, useState} from 'react'
import {GitListWorkTree, GitRepoWorkspace, GitSetDefaultAgent, GitStatus, ListAgents} from '../../../wailsjs/go/main/App'
import {agents as agentsModel, git as gitModel} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {sessionTokens, useAgentSessions, type AgentSessionInfo} from '../../lib/agentSessions'
import {isModelServerAgent} from '../../lib/modelServers'
import {agentIconName} from '../agent/agentIcon'
import type {TerminalGridTile} from '../terminal/TerminalGridHost'
import {fileVisualFor, folderVisualFor} from '../../lib/fileIcons'
import GitAgentPanel from './GitAgentPanel'

interface TreeNode {
    name: string
    path: string
    isDir: boolean
    children: TreeNode[]
}

function buildFileTree(files: string[]): TreeNode[] {
    const root: TreeNode[] = []
    const dirMap = new Map<string, TreeNode>()

    const getOrCreateDir = (parts: string[]): TreeNode[] => {
        if (parts.length === 0) return root
        let parentList = root
        let acc = ''
        for (const p of parts) {
            acc = acc ? `${acc}/${p}` : p
            let node = dirMap.get(acc)
            if (!node) {
                node = {name: p, path: acc, isDir: true, children: []}
                dirMap.set(acc, node)
                parentList.push(node)
            }
            parentList = node.children
        }
        return parentList
    }

    for (const rel of files) {
        const parts = rel.split('/').filter(Boolean)
        if (parts.length === 0) continue
        const fileName = parts[parts.length - 1]
        const parent = getOrCreateDir(parts.slice(0, -1))
        parent.push({name: fileName, path: rel, isDir: false, children: []})
    }

    const sortNodes = (nodes: TreeNode[]) => {
        nodes.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
            return a.name.localeCompare(b.name)
        })
        for (const n of nodes) if (n.isDir) sortNodes(n.children)
    }
    sortNodes(root)
    return root
}

function norm(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

// Coincidencia fuzzy + multi-token ranqueada (exacto > prefijo > substring > subsecuencia).
// Devuelve 0 si no coincide; mayor = más relevante.
function scoreFilePath(path: string, tokens: string[]): number {
    const pNorm = norm(path)
    const slash = pNorm.lastIndexOf('/')
    const base = slash >= 0 ? pNorm.slice(slash + 1) : pNorm
    let total = 0

    for (const tok of tokens) {
        if (base === tok) {
            total += 120
            continue
        }
        if (base.startsWith(tok)) {
            total += 90
            continue
        }
        const bi = base.indexOf(tok)
        if (bi >= 0) {
            total += 65 - Math.min(bi, 20)
            continue
        }
        const pi = pNorm.indexOf(tok)
        if (pi >= 0) {
            total += 40
            continue
        }
        // Subsecuencia fuzzy sobre la ruta completa.
        let ti = 0
        let streak = 0
        let bonus = 0
        for (let i = 0; i < pNorm.length && ti < tok.length; i++) {
            if (pNorm[i] === tok[ti]) {
                ti++
                streak++
                bonus += streak * 2
            } else {
                streak = 0
            }
        }
        if (ti < tok.length) return 0
        total += 10 + Math.min(bonus, 25)
    }

    // Preferir rutas más cortas a igualdad de puntaje.
    return total - Math.min(path.length * 0.05, 8)
}

function FileGlyph({path}: {path: string}) {
    const v = fileVisualFor(path)
    if (v.badge) {
        return (
            <span className={`inline-flex w-4 shrink-0 items-center justify-center font-mono text-ui-9 font-bold leading-none ${v.color}`}>
                {v.badge}
            </span>
        )
    }
    return <Icon name={v.icon} size={14} className={`w-4 shrink-0 ${v.color}`} />
}

interface ProjectExplorerProps {
    repoId: string
    repoName: string
    gridTiles: TerminalGridTile[]
    onBackToRepos: () => void
    onOpenFile: (path: string) => void
    onOpenInTerminals: (opts: {repoId: string; kind: 'shell' | 'agent'; agentId?: string; label?: string}) => void
    onFocusGridTile: (tileId: string) => void
    onOpenSession: (session: AgentSessionInfo) => void
    onNewAgentChat: () => void
    onAskAgent?: (prompt: string, about: string) => void
    // Cuando Sidebar ya tiene el buscador arriba, lo reutilizamos acá para no apilar dos inputs.
    externalFilter?: string
    // Contenedor donde GitRepoTab monta su panel Git real (Historial / Cambios / Stash).
    gitWorkHostRef?: (el: HTMLDivElement | null) => void
}

// Explorador unificado del proyecto activo (Fase 9.1 ADE — estilo Deck):
// Archivos reales (GitListWorkTree) + Git/Rama/Cambios (GitWorkPanel portaleado) + Agentes vivos + MCP/Skills/Uso.
export default function ProjectExplorer({
    repoId,
    repoName,
    gridTiles,
    onBackToRepos,
    onOpenFile,
    onOpenInTerminals,
    onFocusGridTile,
    onOpenSession,
    onNewAgentChat,
    onAskAgent,
    externalFilter,
    gitWorkHostRef,
}: ProjectExplorerProps) {
    const t = useT()
    const sessions = useAgentSessions()
    const [subTab, setSubTab] = useState<'files' | 'git' | 'agents'>('files')
    const [files, setFiles] = useState<string[]>([])
    const [status, setStatus] = useState<gitModel.RepoStatus | null>(null)
    const [cliAgents, setCliAgents] = useState<agentsModel.Agent[]>([])
    const [defaultAgent, setDefaultAgent] = useState('')
    const [filter, setFilter] = useState('')
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})

    const refresh = useCallback(() => {
        GitListWorkTree(repoId)
            .then((wt) => setFiles(wt?.files ?? []))
            .catch(() => setFiles([]))
        GitStatus(repoId)
            .then(setStatus)
            .catch(() => setStatus(null))
        GitRepoWorkspace(repoId)
            .then((ws) => setDefaultAgent(ws?.defaultAgent ?? ''))
            .catch(() => setDefaultAgent(''))
    }, [repoId])

    const handleSetDefaultAgent = useCallback(
        (agentId: string) => {
            setDefaultAgent(agentId)
            void GitSetDefaultAgent(repoId, agentId).catch(() => {})
        },
        [repoId],
    )

    useEffect(() => {
        setFilter('')
        setExpanded({})
        refresh()
    }, [refresh])

    useEffect(() => {
        ListAgents()
            .then((list) => setCliAgents((list ?? []).filter((a) => a.available && !isModelServerAgent(a.id))))
            .catch(() => {})
    }, [])

    const activeFilter = externalFilter !== undefined ? externalFilter : filter
    const isSearching = activeFilter.trim().length > 0

    const searchMatches = useMemo(() => {
        if (!isSearching) return []
        const tokens = norm(activeFilter.trim()).split(/\s+/).filter(Boolean)
        if (tokens.length === 0) return []
        const scored: {path: string; score: number}[] = []
        for (const f of files) {
            const s = scoreFilePath(f, tokens)
            if (s > 0) scored.push({path: f, score: s})
        }
        scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        return scored.slice(0, 150).map((x) => x.path)
    }, [files, activeFilter, isSearching])

    const tree = useMemo(() => buildFileTree(files), [files])
    const changedFiles = useMemo(() => {
        if (!status?.files) return []
        return status.files.map((f) => ({
            path: f.path,
            badge: f.untracked ? '?' : f.workStatus || f.indexStatus || 'M',
        }))
    }, [status])
    const statusBadgeByPath = useMemo(() => {
        const m = new Map<string, string>()
        for (const cf of changedFiles) m.set(cf.path, cf.badge)
        return m
    }, [changedFiles])

    const toggleDir = (path: string) => setExpanded((prev) => ({...prev, [path]: !prev[path]}))

    function renderNodes(nodes: TreeNode[], depth: number) {
        return nodes.map((node) => {
            if (node.isDir) {
                const isOpen = Boolean(expanded[node.path])
                const fvis = folderVisualFor(node.name)
                return (
                    <div key={node.path}>
                        <button
                            type="button"
                            onClick={() => toggleDir(node.path)}
                            title={node.path}
                            style={{paddingLeft: `${8 + depth * 12}px`}}
                            className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-on-surface hover:bg-surface-variant/60"
                        >
                            <Icon
                                name={isOpen ? 'expand_more' : 'chevron_right'}
                                size={14}
                                className="shrink-0 text-on-surface-variant"
                            />
                            <Icon name={isOpen ? fvis.openIcon : fvis.icon} size={14} className={`shrink-0 ${fvis.color}`} />
                            <span className="min-w-0 flex-1 truncate">{node.name}</span>
                        </button>
                        {isOpen && renderNodes(node.children, depth + 1)}
                    </div>
                )
            }
            const gitBadge = statusBadgeByPath.get(node.path)
            return (
                <button
                    key={node.path}
                    type="button"
                    onClick={() => onOpenFile(node.path)}
                    title={`${node.path} — ${t.shell.ade.projectExplorer.openFileTitle}`}
                    style={{paddingLeft: `${24 + depth * 12}px`}}
                    className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-on-surface-variant transition-colors hover:bg-surface-variant/60 hover:text-on-surface"
                >
                    <FileGlyph path={node.path} />
                    <span className={`min-w-0 flex-1 truncate ${gitBadge ? 'text-on-surface' : ''}`}>{node.name}</span>
                    {gitBadge && (
                        <span
                            className={`shrink-0 font-mono text-ui-9 font-bold ${
                                gitBadge === '?' || gitBadge === 'A'
                                    ? 'text-secondary'
                                    : gitBadge === 'D'
                                      ? 'text-error'
                                      : 'text-tertiary'
                            }`}
                        >
                            {gitBadge}
                        </span>
                    )}
                </button>
            )
        })
    }

    const pe = t.shell.ade.projectExplorer
    const repoTiles = gridTiles.filter((tile) => !tile.repoId || tile.repoId === repoId)

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Cabecera del proyecto activo (nombre + rama + volver + refrescar) */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant/60 px-2.5 py-2">
                <button
                    type="button"
                    onClick={onBackToRepos}
                    title={pe.backToProjectsTitle}
                    className="sidebar-icon"
                >
                    <Icon name="arrow_back" size={14} />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-on-surface">{repoName}</div>
                    {status?.branch && (
                        <div className="flex items-center gap-1 truncate font-mono text-ui-10 text-primary">
                            <Icon name="account_tree" size={11} className="shrink-0" />
                            <span className="truncate">{status.branch}</span>
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    title={pe.refreshFilesTitle}
                    className="sidebar-icon"
                >
                    <Icon name="refresh" size={14} />
                </button>
            </div>

            {/* 3 sub-tabs limpios: Archivos | Git | Agentes */}
            <div className="flex shrink-0 items-center gap-1 border-b border-outline-variant/60 px-2 py-1.5">
                {(['files', 'git', 'agents'] as const).map((tab) => {
                    const active = subTab === tab
                    const label = tab === 'files' ? pe.tabFiles : tab === 'git' ? pe.tabGit : pe.tabAgents
                    const count = tab === 'git' ? changedFiles.length : tab === 'agents' ? repoTiles.length + sessions.length : 0
                    return (
                        <button
                            key={tab}
                            type="button"
                            onClick={() => setSubTab(tab)}
                            title={label}
                            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-ui-11 font-medium transition-colors ${
                                active
                                    ? 'bg-primary-container text-on-primary-container'
                                    : 'text-on-surface-variant hover:bg-surface-variant/60 hover:text-on-surface'
                            }`}
                        >
                            <span>{label}</span>
                            {count > 0 && (
                                <span
                                    className={`rounded-full px-1 font-mono text-ui-9 ${
                                        active ? 'bg-on-primary-container/15 text-on-primary-container' : 'bg-surface-container-highest text-on-surface-variant'
                                    }`}
                                >
                                    {count}
                                </span>
                            )}
                        </button>
                    )
                })}
            </div>

            {/* Vista Archivos */}
            {subTab === 'files' && (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {externalFilter === undefined && (
                        <div className="shrink-0 px-2.5 pb-1 pt-2">
                            <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                                <Icon name="search" size={13} className="shrink-0 text-on-surface-variant/60" />
                                <input
                                    type="text"
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                    placeholder={pe.filterFilesPlaceholder}
                                    className="min-w-0 flex-1 bg-transparent text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/60"
                                />
                                {filter && (
                                    <button
                                        type="button"
                                        onClick={() => setFilter('')}
                                        title={t.shell.sidebar.clearSearch}
                                        className="shrink-0 text-on-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name="close" size={12} />
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
                        {isSearching ? (
                            searchMatches.length === 0 ? (
                                <div className="px-2 py-4 text-center text-ui-11 text-on-surface-variant/75">
                                    {pe.emptyFiles}
                                </div>
                            ) : (
                                <div className="space-y-0.5">
                                    {searchMatches.map((path) => {
                                        const slash = path.lastIndexOf('/')
                                        const name = slash >= 0 ? path.slice(slash + 1) : path
                                        const dir = slash >= 0 ? path.slice(0, slash) : ''
                                        const gitBadge = statusBadgeByPath.get(path)
                                        return (
                                            <button
                                                key={path}
                                                type="button"
                                                onClick={() => onOpenFile(path)}
                                                title={`${path} — ${pe.openFileTitle}`}
                                                className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-variant/60"
                                            >
                                                <span className="mt-0.5">
                                                    <FileGlyph path={path} />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-xs font-medium text-on-surface">
                                                        {name}
                                                    </span>
                                                    {dir && (
                                                        <span className="block truncate font-mono text-ui-10 text-on-surface-variant/70">
                                                            {dir}
                                                        </span>
                                                    )}
                                                </span>
                                                {gitBadge && (
                                                    <span
                                                        className={`mt-0.5 shrink-0 font-mono text-ui-9 font-bold ${
                                                            gitBadge === '?' || gitBadge === 'A'
                                                                ? 'text-secondary'
                                                                : gitBadge === 'D'
                                                                  ? 'text-error'
                                                                  : 'text-tertiary'
                                                        }`}
                                                    >
                                                        {gitBadge}
                                                    </span>
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            )
                        ) : tree.length === 0 ? (
                            <div className="px-2 py-4 text-center text-ui-11 text-on-surface-variant/75">
                                {pe.emptyFiles}
                            </div>
                        ) : (
                            renderNodes(tree, 0)
                        )}
                    </div>
                </div>
            )}

            {/* Vista Git — aloja el GitWorkPanel real (Historial / Cambios / Stash) portaleado desde GitRepoTab.
                Permanece montado en el DOM oculto por CSS para que el portal no pierda estado al cambiar de sub-tab. */}
            {gitWorkHostRef ? (
                <div
                    ref={gitWorkHostRef}
                    className="flex min-h-0 flex-1 flex-col overflow-hidden"
                    style={{display: subTab === 'git' ? undefined : 'none'}}
                />
            ) : (
                subTab === 'git' && (
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                        <div className="mb-1.5 px-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                            {pe.changesHeading}
                        </div>
                        {changedFiles.length === 0 ? (
                            <div className="px-2 py-3 text-ui-11 text-on-surface-variant/75">{pe.noChanges}</div>
                        ) : (
                            <div className="flex flex-col gap-0.5">
                                {changedFiles.map((cf) => (
                                    <button
                                        key={cf.path}
                                        type="button"
                                        onClick={() => onOpenFile(cf.path)}
                                        title={`${cf.path} — ${pe.openFileTitle}`}
                                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant/60"
                                    >
                                        <span
                                            className={`w-4 shrink-0 text-center font-mono text-ui-10 font-bold ${
                                                cf.badge === '?'
                                                    ? 'text-secondary'
                                                    : cf.badge === 'D'
                                                      ? 'text-error'
                                                      : 'text-tertiary'
                                            }`}
                                        >
                                            {cf.badge}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">{cf.path}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )
            )}

            {/* Vista Agentes sobre este proyecto */}
            {subTab === 'agents' && (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                        {repoTiles.map((tile) => (
                            <button
                                key={tile.id}
                                type="button"
                                onClick={() => onFocusGridTile(tile.id)}
                                title={t.shell.ade.rail.openPtyTileTitle}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-on-surface hover:bg-surface-variant/60"
                            >
                                <Icon
                                    name={tile.kind === 'agent' && tile.agentId ? agentIconName(tile.agentId) : 'terminal'}
                                    size={14}
                                    className="shrink-0 text-primary"
                                />
                                <span className="min-w-0 flex-1 truncate">{tile.label}</span>
                                <span className="rounded bg-surface-container px-1 font-mono text-ui-9 text-on-surface-variant">
                                    PTY
                                </span>
                                <span className="h-2 w-2 shrink-0 rounded-full bg-secondary" />
                            </button>
                        ))}
                        {sessions.map((s) => {
                            const toks = sessionTokens(s)
                            return (
                                <button
                                    key={s.sessionId}
                                    type="button"
                                    onClick={() => onOpenSession(s)}
                                    title={t.shell.ade.rail.openSessionTitle}
                                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-on-surface hover:bg-surface-variant/60"
                                >
                                    <Icon name={agentIconName(s.agentId)} size={14} className="shrink-0 text-on-surface-variant" />
                                    <span className="min-w-0 flex-1 truncate">{s.title || s.agentLabel}</span>
                                    {toks > 0 && (
                                        <span className="font-mono text-ui-9 text-on-surface-variant">
                                            {toks >= 1000 ? `${(toks / 1000).toFixed(1)}k` : toks}
                                        </span>
                                    )}
                                </button>
                            )
                        })}
                        {repoTiles.length === 0 && sessions.length === 0 && (
                            <div className="px-2 py-2 text-ui-11 text-on-surface-variant/75">
                                {t.shell.ade.rail.agentsEmpty}
                            </div>
                        )}
                        <div className="mt-2 border-t border-outline-variant/60 pt-1">
                            <GitAgentPanel
                                embedded
                                repoId={repoId}
                                onOpenFile={onOpenFile}
                                onAskAgent={(prompt, about) => {
                                    if (onAskAgent) onAskAgent(prompt, about)
                                    else onNewAgentChat()
                                }}
                                defaultAgent={defaultAgent}
                                onSetDefaultAgent={handleSetDefaultAgent}
                            />
                        </div>
                    </div>

                    <div className="shrink-0 border-t border-outline-variant/60 bg-surface-container/40 px-2.5 py-2">
                        <div className="mb-1.5 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                            {t.shell.ade.rail.quickLaunchHeading}
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {cliAgents.map((a) => (
                                <button
                                    key={a.id}
                                    type="button"
                                    onClick={() =>
                                        onOpenInTerminals({repoId, kind: 'agent', agentId: a.id, label: a.label})
                                    }
                                    title={t.shell.ade.rail.launchCliTitle({name: a.label})}
                                    className="flex items-center gap-1 rounded-md border border-outline-variant/70 bg-surface-container px-2 py-0.5 text-ui-11 text-on-surface hover:border-primary/50 hover:bg-surface-container-high"
                                >
                                    <Icon name={agentIconName(a.id)} size={12} className="text-primary" />
                                    <span>{a.label}</span>
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={() => onOpenInTerminals({repoId, kind: 'shell'})}
                                title={t.shell.ade.rail.launchShellTitle}
                                className="flex items-center gap-1 rounded-md border border-outline-variant/70 bg-surface-container px-2 py-0.5 text-ui-11 text-on-surface hover:border-secondary/60 hover:bg-surface-container-high"
                            >
                                <Icon name="terminal" size={12} className="text-secondary" />
                                <span>{t.terminal.grid.newShell}</span>
                            </button>
                            <button
                                type="button"
                                onClick={onNewAgentChat}
                                title={t.shell.ade.rail.launchChatTitle}
                                className="flex items-center gap-1 rounded-md border border-outline-variant/70 bg-surface-container px-2 py-0.5 text-ui-11 text-on-surface hover:border-primary/50 hover:bg-surface-container-high"
                            >
                                <Icon name="forum" size={12} className="text-primary" />
                                <span>{t.shell.ade.modes.chat}</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
