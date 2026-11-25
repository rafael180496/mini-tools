import {useCallback, useEffect, useMemo, useState} from 'react'
import {GitListRepos, ListAgents, MCPServerStatus} from '../../../wailsjs/go/main/App'
import {agents as agentsModel, vault} from '../../../wailsjs/go/models'
import type {Theme} from '../../hooks/useTheme'
import {useT} from '../../i18n'
import {requestOpenSettings} from '../../lib/appBus'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import Select, {type SelectOption} from '../Select'
import {agentIconName} from '../agent/agentIcon'
import {isModelServerAgent} from '../../lib/modelServers'
import LocalTerminalPanel from './LocalTerminalPanel'

export interface TerminalGridTile {
    id: string
    kind: 'shell' | 'agent'
    agentId?: string
    label: string
    repoId: string
    repoName?: string
}

type GridColsMode = 'auto' | 1 | 2 | 3

export interface TerminalLaunchRequest {
    token: number
    repoId: string
    kind: 'shell' | 'agent'
    agentId?: string
    label?: string
}

interface TerminalGridHostProps {
    visible: boolean
    activeRepoId?: string | null
    shellId: string
    theme: Theme
    terminalThemeId: string
    terminalFontSize: number
    launchRequest?: TerminalLaunchRequest | null
    focusTileId?: string | null
    closeTileReq?: {id: string; token: number} | null
    onTilesChange?: (tiles: TerminalGridTile[]) => void
}

let tileSeq = 1
function nextTileId(): string {
    tileSeq += 1
    return `grid-term-${Date.now().toString(36)}-${tileSeq}`
}

function autoColumns(count: number): number {
    if (count <= 1) return 1
    if (count <= 4) return 2
    return 3
}

// Terminal Harness Multi-Agente PTY Grid (Fase 4 ADE — inspirado en Herdr).
//
// Monta múltiples instancias reales de LocalTerminalPanel (go-pty + xterm.js)
// en mosaico. Las sesiones NO se desmontan al cambiar de modo ADE ni al
// maximizar un tile individual: se ocultan por CSS y `visible={false}` evita
// que fitAddon mida 0 columnas.
export default function TerminalGridHost({
    visible,
    activeRepoId,
    shellId,
    theme,
    terminalThemeId,
    terminalFontSize,
    launchRequest,
    focusTileId,
    closeTileReq,
    onTilesChange,
}: TerminalGridHostProps) {
    const t = useT()
    const [cliAgents, setCliAgents] = useState<agentsModel.Agent[]>([])
    const [repos, setRepos] = useState<vault.GitRepo[]>([])
    const [selectedRepoId, setSelectedRepoId] = useState<string>(activeRepoId ?? '')
    const [tiles, setTiles] = useState<TerminalGridTile[]>([])
    const [focusedId, setFocusedId] = useState<string | null>(null)
    const [maximizedId, setMaximizedId] = useState<string | null>(null)
    const [colsMode, setColsMode] = useState<GridColsMode>('auto')
    // Celda de agente esperando confirmación para cerrarse: cerrar la celda
    // mata el proceso, y un agente a mitad de una tarea no se cierra de un clic.
    const [confirmClose, setConfirmClose] = useState<TerminalGridTile | null>(null)
    const [mcpEnabled, setMcpEnabled] = useState<boolean>(false)

    useEffect(() => {
        if (activeRepoId) setSelectedRepoId(activeRepoId)
    }, [activeRepoId])

    useEffect(() => {
        if (!visible) return
        let alive = true
        ListAgents()
            .then((list) => {
                if (!alive) return
                // Solo CLIs reales instalados (los model servers `llm:` no corren en PTY).
                const installed = (list ?? []).filter((a) => a.available && !isModelServerAgent(a.id))
                setCliAgents(installed)
            })
            .catch(() => {})
        GitListRepos()
            .then((list) => {
                if (alive) setRepos(list ?? [])
            })
            .catch(() => {})
        MCPServerStatus()
            .then((st) => {
                if (alive) setMcpEnabled(Boolean(st?.enabled))
            })
            .catch(() => {})
        return () => {
            alive = false
        }
    }, [visible])

    const repoNameById = useMemo(() => {
        const map = new Map<string, string>()
        for (const r of repos) map.set(r.id, r.name)
        return map
    }, [repos])

    const spaceOptions = useMemo<SelectOption[]>(
        () => [
            {
                value: '',
                label: t.terminal.grid.spaceHome,
                icon: <Icon name="home" size={14} className="text-on-surface-variant" />,
                separatorAfter: repos.length > 0,
            },
            ...repos.map((r) => ({
                value: r.id,
                label: r.name,
                icon: <Icon name="folder_code" size={14} className="text-primary" />,
            })),
        ],
        [repos, t.terminal.grid.spaceHome],
    )

    const addTile = useCallback(
        (opts: {kind: 'shell' | 'agent'; agentId?: string; label: string; repoId?: string}) => {
            const rid = opts.repoId ?? selectedRepoId
            const tile: TerminalGridTile = {
                id: nextTileId(),
                kind: opts.kind,
                agentId: opts.agentId,
                label: opts.label,
                repoId: rid,
                repoName: rid ? repoNameById.get(rid) : undefined,
            }
            setTiles((prev) => [...prev, tile])
            setFocusedId(tile.id)
            setMaximizedId(null)
        },
        [selectedRepoId, repoNameById],
    )

    const closeTile = useCallback((id: string) => {
        setTiles((prev) => prev.filter((tile) => tile.id !== id))
        setMaximizedId((curr) => (curr === id ? null : curr))
        setFocusedId((curr) => (curr === id ? null : curr))
    }, [])

    useEffect(() => {
        onTilesChange?.(tiles)
    }, [tiles, onTilesChange])

    useEffect(() => {
        if (!launchRequest) return
        addTile({
            kind: launchRequest.kind,
            agentId: launchRequest.agentId,
            label: launchRequest.label || t.terminal.grid.newShell,
            repoId: launchRequest.repoId,
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [launchRequest?.token])

    useEffect(() => {
        if (!focusTileId) return
        setFocusedId(focusTileId)
        setMaximizedId(null)
    }, [focusTileId])

    useEffect(() => {
        if (!closeTileReq) return
        closeTile(closeTileReq.id)
    }, [closeTileReq, closeTile])

    const cols = maximizedId ? 1 : colsMode === 'auto' ? autoColumns(tiles.length) : colsMode

    return (
        <div
            className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background ${visible ? '' : 'hidden'}`}
        >
            {/* Barra superior del Terminal Harness */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container-low px-3 py-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-on-surface">
                    <Icon name="grid_view" size={15} className="text-primary" />
                    <span>{t.terminal.grid.title}</span>
                    {tiles.length > 0 && (
                        <span className="rounded-full bg-surface-container-highest px-1.5 py-0.2 font-mono text-ui-10 font-normal text-on-surface-variant">
                            {t.terminal.grid.activeCount({count: tiles.length})}
                        </span>
                    )}
                </div>

                {/* Selector de Space/Repo destino (Select temado MD3 con buscador) */}
                <div className="flex items-center gap-1.5 text-ui-11 text-on-surface-variant">
                    <span>{t.terminal.grid.spaceLabel}:</span>
                    <Select
                        value={selectedRepoId}
                        options={spaceOptions}
                        onChange={setSelectedRepoId}
                        size="sm"
                        searchable
                        menuMinWidth={240}
                        title={t.terminal.grid.spaceTitle}
                        ariaLabel={t.terminal.grid.spaceLabel}
                        className="h-6 max-w-[200px]"
                    />
                </div>

                <div className="h-4 w-px bg-outline-variant/70" />

                {/* Lanzadores en 1 clic: CLIs agénticos instalados + Shell */}
                <div className="flex flex-wrap items-center gap-1">
                    {cliAgents.map((agent) => (
                        <button
                            key={agent.id}
                            type="button"
                            onClick={() => addTile({kind: 'agent', agentId: agent.id, label: agent.label})}
                            title={t.terminal.grid.launchAgent({name: agent.label})}
                            className="flex h-6 items-center gap-1 rounded-lg border border-outline-variant/70 bg-surface-container px-2 text-ui-11 font-medium text-on-surface transition-colors hover:border-primary/50 hover:bg-surface-container-high"
                        >
                            <Icon name={agentIconName(agent.id)} size={13} className="text-primary" />
                            <span>{agent.label}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => addTile({kind: 'shell', label: t.terminal.grid.newShell})}
                        title={t.terminal.grid.newShellTitle}
                        className="flex h-6 items-center gap-1 rounded-lg border border-outline-variant/70 bg-surface-container px-2 text-ui-11 font-medium text-on-surface transition-colors hover:border-primary/50 hover:bg-surface-container-high"
                    >
                        <Icon name="terminal" size={13} className="text-secondary" />
                        <span>+ {t.terminal.grid.newShell}</span>
                    </button>
                </div>

                {/* Estado MCP + Presets de columnas (auto / 1 / 2 / 3) */}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => requestOpenSettings('ai')}
                        title={t.shell.ade.rail.aiSettingsTitle}
                        className={`flex h-6 items-center gap-1 rounded-lg border px-2 font-mono text-ui-10 transition-colors ${
                            mcpEnabled
                                ? 'border-secondary/50 bg-secondary/15 text-secondary hover:bg-secondary/25'
                                : 'border-outline-variant/70 bg-surface-container text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <span className={`h-1.5 w-1.5 rounded-full ${mcpEnabled ? 'bg-secondary' : 'bg-on-surface-variant/40'}`} />
                        <span>MCP</span>
                    </button>
                    <div className="flex items-center rounded-lg border border-outline-variant/70 bg-surface-container p-0.5">
                        {(['auto', 1, 2, 3] as const).map((preset) => {
                            const active = !maximizedId && colsMode === preset
                            const label = preset === 'auto' ? t.terminal.grid.layoutAuto : `${preset}×`
                            const title =
                                preset === 'auto'
                                    ? t.terminal.grid.layoutAutoTitle
                                    : t.terminal.grid.layoutColsTitle({cols: preset})
                            return (
                                <button
                                    key={String(preset)}
                                    type="button"
                                    title={title}
                                    onClick={() => {
                                        setMaximizedId(null)
                                        setColsMode(preset)
                                    }}
                                    className={`rounded px-1.5 py-0.5 font-mono text-ui-10 font-medium transition-colors ${
                                        active
                                            ? 'bg-primary-container text-on-primary-container'
                                            : 'text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    {label}
                                </button>
                            )
                        })}
                    </div>
                </div>
            </div>

            {/* Mosaico o estado vacío */}
            {tiles.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                    <Icon name="grid_view" size={36} className="text-primary/50" />
                    <div>
                        <p className="text-sm font-semibold text-on-surface">{t.terminal.grid.emptyTitle}</p>
                        <p className="mt-1 text-xs text-on-surface-variant">{t.terminal.grid.emptyHint}</p>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                        {cliAgents.map((agent) => (
                            <button
                                key={agent.id}
                                type="button"
                                onClick={() => addTile({kind: 'agent', agentId: agent.id, label: agent.label})}
                                title={t.terminal.grid.launchAgent({name: agent.label})}
                                className="flex items-center gap-1.5 rounded-lg bg-primary-container px-3 py-1.5 text-xs font-medium text-on-primary-container transition-opacity hover:opacity-90"
                            >
                                <Icon name={agentIconName(agent.id)} size={15} />
                                <span>{agent.label}</span>
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => addTile({kind: 'shell', label: t.terminal.grid.newShell})}
                            title={t.terminal.grid.newShellTitle}
                            className="flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-high"
                        >
                            <Icon name="terminal" size={15} className="text-secondary" />
                            <span>+ {t.terminal.grid.newShell}</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div
                    className="grid min-h-0 flex-1 gap-2 overflow-hidden p-2"
                    style={{
                        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                        gridAutoRows: 'minmax(0, 1fr)',
                    }}
                >
                    {tiles.map((tile) => {
                        const isMax = maximizedId === tile.id
                        const hiddenByMax = Boolean(maximizedId && !isMax)
                        const isFocused = focusedId === tile.id
                        return (
                            <div
                                key={tile.id}
                                data-focused={isFocused ? 'true' : undefined}
                                onMouseDown={() => setFocusedId(tile.id)}
                                className={`ade-tile flex min-h-0 min-w-0 flex-col overflow-hidden ${
                                    hiddenByMax ? 'hidden' : ''
                                }`}
                            >
                                {/* Header compacto del tile */}
                                <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-outline-variant/60 bg-surface-container-low px-2 text-ui-11">
                                    <Icon
                                        name={tile.kind === 'agent' && tile.agentId ? agentIconName(tile.agentId) : 'terminal'}
                                        size={13}
                                        className={tile.kind === 'agent' ? 'shrink-0 text-primary' : 'shrink-0 text-secondary'}
                                    />
                                    <span className="truncate font-medium text-on-surface">{tile.label}</span>
                                    {tile.repoName && (
                                        <span className="truncate rounded bg-surface-container px-1.5 py-px font-mono text-ui-10 text-on-surface-variant">
                                            {tile.repoName}
                                        </span>
                                    )}
                                    <div className="ml-auto flex shrink-0 items-center gap-0.5">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                addTile({
                                                    kind: tile.kind,
                                                    agentId: tile.agentId,
                                                    label: tile.label,
                                                    repoId: tile.repoId,
                                                })
                                            }
                                            title={t.terminal.grid.duplicateTile}
                                            className="sidebar-icon"
                                        >
                                            <Icon name="add" size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setMaximizedId(isMax ? null : tile.id)}
                                            title={isMax ? t.terminal.grid.restoreTile : t.terminal.grid.maximizeTile}
                                            className="sidebar-icon"
                                        >
                                            <Icon name={isMax ? 'close_fullscreen' : 'open_in_full'} size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => (tile.kind === 'agent' ? setConfirmClose(tile) : closeTile(tile.id))}
                                            title={t.terminal.grid.closeTile}
                                            className="sidebar-icon hover:text-error"
                                        >
                                            <Icon name="close" size={13} />
                                        </button>
                                    </div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-hidden">
                                    <LocalTerminalPanel
                                        sessionId={tile.id}
                                        repoId={tile.repoId}
                                        kind={tile.kind}
                                        agentId={tile.agentId}
                                        agentLabel={tile.label}
                                        autoStart={true}
                                        shellId={shellId}
                                        theme={theme}
                                        terminalThemeId={terminalThemeId}
                                        fontSize={terminalFontSize}
                                        visible={visible && !hiddenByMax}
                                    />
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
            {confirmClose && (
                <ConfirmDialog
                    title={t.terminal.grid.confirmCloseAgentTitle}
                    description={t.terminal.grid.confirmCloseAgent({name: confirmClose.label})}
                    confirmLabel={t.terminal.grid.confirmCloseAgentButton}
                    danger
                    onConfirm={() => {
                        closeTile(confirmClose.id)
                        setConfirmClose(null)
                    }}
                    onClose={() => setConfirmClose(null)}
                />
            )}
        </div>
    )
}
