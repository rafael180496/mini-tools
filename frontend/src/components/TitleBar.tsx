import {useEffect, useMemo, useState} from 'react'
import type {CSSProperties} from 'react'
import {AddAgentWorkspace, GitListRepos, PickAgentWorkspaceFolder} from '../../wailsjs/go/main/App'
import {vault} from '../../wailsjs/go/models'
import logo from '../assets/logo.png'
import Icon from './Icon'
import Select, {type SelectOption} from './Select'
import {useT} from '../i18n'
import {adeModeShortcut, type AdeMode} from '../hooks/useLayoutMode'

// La barra de título de la ventana, dibujada por la app (Fase 1 ADE).
//
// - En pantalla de desbloqueo/carga (`ade` omitido) queda limpia como marco de
//   ventana para arrastrar y cerrar.
// - Con el vault desbloqueado muestra la Top Bar unificada del ADE:
//   identidad + contexto activo, disparador de Command Palette (⌘K) y selector
//   de los 4 modos ADE (Trabajo | Pareja | Chat | Terminales).
// - macOS conserva sus semáforos a la izquierda (`TITLE_BAR_MAC_INSET = 72`);
//   Windows/Linux dibujan sus 3 botones a la derecha.

const TITLE_BAR_MAC_INSET = 72

const DRAG: CSSProperties = {'--wails-draggable': 'drag'} as CSSProperties
const NO_DRAG: CSSProperties = {'--wails-draggable': 'no-drag'} as CSSProperties

export interface TitleBarAdeProps {
    mode: AdeMode
    onChangeMode: (mode: AdeMode) => void
    contextLabel?: string
    contextIcon?: string
    activeRepoId?: string | null
    hasGitContext?: boolean
    onSelectRepo?: (repo: vault.GitRepo) => void
    onOpenPalette: () => void
    gridFilesOpen?: boolean
    gridChangesOpen?: boolean
    onToggleGridFiles?: () => void
    onToggleGridChanges?: () => void
}

async function wailsRuntime() {
    try {
        return await import('../../wailsjs/runtime/runtime')
    } catch {
        return undefined
    }
}

export default function TitleBar({ade}: {ade?: TitleBarAdeProps}) {
    const t = useT()
    const [platform, setPlatform] = useState('')
    const [maximised, setMaximised] = useState(false)
    const [repos, setRepos] = useState<vault.GitRepo[]>([])

    useEffect(() => {
        if (!ade) return
        GitListRepos()
            .then((list) => setRepos(list ?? []))
            .catch(() => {})
    }, [Boolean(ade)])

    const projectOptions = useMemo<SelectOption[]>(
        () => [
            ...repos.map((r) => ({
                value: r.id,
                label: r.name,
                icon: <Icon name="folder_code" size={14} className="text-primary" />,
            })),
            {
                value: '__open_folder__',
                label: t.shell.ade.openFolderOption,
                icon: <Icon name="create_new_folder" size={14} className="text-secondary" />,
            },
        ],
        [repos, t.shell.ade.openFolderOption],
    )

    async function handleSelectProject(val: string) {
        if (val === '__open_folder__') {
            try {
                const path = await PickAgentWorkspaceFolder()
                if (!path) return
                const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
                await AddAgentWorkspace(name, path)
                const list = await GitListRepos()
                setRepos(list ?? [])
            } catch {
                // Cancelado.
            }
            return
        }
        const found = repos.find((r) => r.id === val)
        if (found) ade?.onSelectRepo?.(found)
    }

    useEffect(() => {
        let alive = true
        void (async () => {
            const rt = await wailsRuntime()
            if (!rt || !alive) return
            try {
                const env = await rt.Environment()
                if (alive) setPlatform(env.platform)
                const max = await rt.WindowIsMaximised()
                if (alive) setMaximised(max)
            } catch {
                // Sin runtime no hay controles; la barra sigue sirviendo como zona de arrastre.
            }
        })()
        return () => {
            alive = false
        }
    }, [])

    const isMac = platform === 'darwin'
    const showControls = platform !== '' && !isMac
    const shortcutLabel = isMac ? '⌘K' : 'Ctrl K'

    async function call(fn: 'WindowMinimise' | 'WindowToggleMaximise' | 'Quit') {
        const rt = await wailsRuntime()
        if (!rt) return
        rt[fn]()
        if (fn === 'WindowToggleMaximise') {
            try {
                setMaximised(await rt.WindowIsMaximised())
            } catch {
                setMaximised((v) => !v)
            }
        }
    }

    const modes: {id: AdeMode; label: string; title: string}[] = [
        {id: 'work', label: t.shell.ade.modes.work, title: `${t.shell.ade.modes.workTitle} (${adeModeShortcut('work')})`},
        {id: 'pair', label: t.shell.ade.modes.pair, title: `${t.shell.ade.modes.pairTitle} (${adeModeShortcut('pair')})`},
        {id: 'chat', label: t.shell.ade.modes.chat, title: `${t.shell.ade.modes.chatTitle} (${adeModeShortcut('chat')})`},
        {id: 'terminals', label: t.shell.ade.modes.terminals, title: `${t.shell.ade.modes.terminalsTitle} (${adeModeShortcut('terminals')})`},
    ]

    return (
        <header
            style={DRAG}
            onDoubleClick={() => void call('WindowToggleMaximise')}
            className="flex h-[38px] shrink-0 select-none items-center gap-2 border-b border-outline-variant bg-surface-container-low px-3 text-on-surface"
        >
            {/* Izquierda: espacio de semáforos macOS + identidad + pill de contexto */}
            <div className="flex min-w-0 flex-1 items-center gap-2" style={{paddingLeft: isMac ? TITLE_BAR_MAC_INSET : 0}}>
                {ade && (
                    <>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <img src={logo} alt="mini-tools" className="h-4 w-4 shrink-0 rounded object-contain" />
                            <span className="hidden text-xs font-semibold tracking-tight text-on-surface sm:inline">
                                mini-tools
                            </span>
                        </div>

                        <div style={NO_DRAG} onDoubleClick={(e) => e.stopPropagation()} className="hidden sm:block">
                            <Select
                                value={ade.activeRepoId ?? ''}
                                options={projectOptions}
                                onChange={(v) => void handleSelectProject(v)}
                                placeholder={t.shell.ade.projectsButton({count: repos.length})}
                                leadingIcon="grid_view"
                                size="sm"
                                searchable
                                menuMinWidth={240}
                                title={t.shell.ade.projectsTitle}
                                ariaLabel={t.shell.ade.projectsTitle}
                                className="h-6 max-w-[180px]"
                            />
                        </div>

                        {!ade.activeRepoId && ade.contextLabel && (
                            <button
                                type="button"
                                style={NO_DRAG}
                                onClick={ade.onOpenPalette}
                                title={t.shell.ade.contextPillTitle}
                                className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-outline-variant/70 bg-surface-container px-2 py-0.5 text-ui-11 text-on-surface transition-colors hover:bg-surface-container-high"
                            >
                                <Icon name={ade.contextIcon || 'workspaces'} size={13} className="shrink-0 text-primary" />
                                <span className="truncate font-medium">{ade.contextLabel}</span>
                            </button>
                        )}
                    </>
                )}
            </div>

            {/* Centro: Command Palette trigger */}
            {ade && (
                <button
                    type="button"
                    style={NO_DRAG}
                    onClick={ade.onOpenPalette}
                    title={t.shell.ade.searchTriggerTitle}
                    className="hidden h-7 w-full max-w-[340px] items-center justify-between gap-2 rounded-lg border border-outline-variant/70 bg-surface-container px-2.5 text-ui-11 text-on-surface-variant transition-colors hover:border-outline hover:bg-surface-container-high hover:text-on-surface md:flex"
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Icon name="search" size={14} className="shrink-0" />
                        <span className="truncate">{t.shell.ade.searchTrigger}</span>
                    </span>
                    <kbd className="shrink-0 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.2 font-mono text-ui-10 text-on-surface-variant">
                        {shortcutLabel}
                    </kbd>
                </button>
            )}

            {/* Derecha: switcher de modos ADE + accesos rápidos de Terminales + controles de ventana */}
            <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                {ade && (
                    <div
                        className="flex items-center gap-1.5"
                        style={NO_DRAG}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        {ade.mode === 'terminals' && ade.hasGitContext && ade.onToggleGridFiles && ade.onToggleGridChanges && (
                            <div className="hidden items-center gap-1 lg:flex">
                                <button
                                    type="button"
                                    onClick={ade.onToggleGridFiles}
                                    title={t.shell.ade.gridControls.filesTitle}
                                    className={`flex h-6 items-center gap-1 rounded-lg border px-2 text-ui-11 font-medium transition-colors ${
                                        ade.gridFilesOpen
                                            ? 'border-primary/50 bg-primary-container/25 text-primary'
                                            : 'border-outline-variant/70 bg-surface-container text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name="folder" size={13} />
                                    <span>{t.shell.ade.gridControls.files}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={ade.onToggleGridChanges}
                                    title={t.shell.ade.gridControls.changesTitle}
                                    className={`flex h-6 items-center gap-1 rounded-lg border px-2 text-ui-11 font-medium transition-colors ${
                                        ade.gridChangesOpen
                                            ? 'border-primary/50 bg-primary-container/25 text-primary'
                                            : 'border-outline-variant/70 bg-surface-container text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name="difference" size={13} />
                                    <span>{t.shell.ade.gridControls.changes}</span>
                                </button>
                            </div>
                        )}

                        <div
                            role="tablist"
                            aria-label={t.shell.ade.palette.groups.modes}
                            className="flex items-center rounded-lg border border-outline-variant/70 bg-surface-container p-0.5"
                        >
                            {modes.map((m) => {
                                const active = ade.mode === m.id
                                return (
                                    <button
                                        key={m.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        title={m.title}
                                        onClick={() => ade.onChangeMode(m.id)}
                                        className={`rounded px-2 py-0.5 text-ui-11 font-medium transition-colors ${
                                            active
                                                ? 'bg-primary-container text-on-primary-container shadow-xs'
                                                : 'text-on-surface-variant hover:text-on-surface'
                                        }`}
                                    >
                                        {m.label}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )}

                {showControls && (
                    <div className="flex shrink-0 items-center" style={NO_DRAG}>
                        <button
                            onClick={() => void call('WindowMinimise')}
                            title={t.shell.titleBar.minimizeTitle}
                            aria-label={t.shell.titleBar.minimize}
                            className="flex h-[38px] w-11 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="remove" size={16} />
                        </button>
                        <button
                            onClick={() => void call('WindowToggleMaximise')}
                            title={maximised ? t.shell.titleBar.restoreTitle : t.shell.titleBar.maximizeTitle}
                            aria-label={maximised ? t.shell.titleBar.restore : t.shell.titleBar.maximize}
                            className="flex h-[38px] w-11 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name={maximised ? 'filter_none' : 'crop_square'} size={maximised ? 13 : 15} />
                        </button>
                        <button
                            onClick={() => void call('Quit')}
                            title={t.shell.titleBar.quitTitle}
                            aria-label={t.shell.titleBar.quit}
                            className="flex h-[38px] w-11 items-center justify-center text-on-surface-variant transition-colors hover:bg-error hover:text-on-error"
                        >
                            <Icon name="close" size={16} />
                        </button>
                    </div>
                )}
            </div>
        </header>
    )
}
