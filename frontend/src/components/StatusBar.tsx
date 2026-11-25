import {useEffect, useRef, useState} from 'react'
import {AppVersion} from '../../wailsjs/go/main/App'
import {DEFAULT_UI_FONT_SCALE, UI_FONT_SCALES} from '../hooks/useUIFontScale'
import {useT} from '../i18n'
import Icon from './Icon'

interface StatusBarProps {
    connectionName?: string | null
    connectionDbType?: string | null
    connectionLive?: boolean
    repoName?: string | null
    liveAgentsCount: number
    pendingApprovalsCount: number
    onClickAgents: () => void
    uiFontScale: number
    onChangeUIFontScale: (pct: number) => void
    updateAvailable?: string | null
    onOpenSettings: () => void
}

// Status Bar inferior del ADE (Fase 6 — estilo Deck/Herdr).
// Muestra contexto activo, estado de agentes y selector rápido de escala
// (`90–150%` + valor personalizado) conectado a `--ui-font-scale`.
export default function StatusBar({
    connectionName,
    connectionDbType,
    connectionLive,
    repoName,
    liveAgentsCount,
    pendingApprovalsCount,
    onClickAgents,
    uiFontScale,
    onChangeUIFontScale,
    updateAvailable,
    onOpenSettings,
}: StatusBarProps) {
    const t = useT()
    const [version, setVersion] = useState('')
    const [scaleMenuOpen, setScaleMenuOpen] = useState(false)
    const [customInput, setCustomInput] = useState(String(uiFontScale))
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        AppVersion()
            .then(setVersion)
            .catch(() => {})
    }, [])

    useEffect(() => {
        setCustomInput(String(uiFontScale))
    }, [uiFontScale])

    useEffect(() => {
        if (!scaleMenuOpen) return
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setScaleMenuOpen(false)
            }
        }
        window.addEventListener('mousedown', onDown)
        return () => window.removeEventListener('mousedown', onDown)
    }, [scaleMenuOpen])

    function applyCustomScale() {
        const parsed = Number.parseInt(customInput, 10)
        if (Number.isFinite(parsed) && parsed >= 80 && parsed <= 200) {
            onChangeUIFontScale(parsed)
            setScaleMenuOpen(false)
        }
    }

    return (
        <footer className="flex h-7 shrink-0 select-none items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-3 text-ui-11 text-on-surface-variant">
            {/* Izquierda: Repo o conexión activa */}
            <div className="flex min-w-0 items-center gap-3">
                {repoName && (
                    <span className="flex min-w-0 items-center gap-1 text-on-surface">
                        <Icon name="account_tree" size={13} className="shrink-0 text-primary" />
                        <span className="truncate font-medium">{repoName}</span>
                    </span>
                )}
                {connectionName && (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span
                            aria-hidden
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${connectionLive ? 'bg-secondary' : 'bg-outline-variant'}`}
                        />
                        <span className="truncate text-on-surface">{connectionName}</span>
                        {connectionDbType && (
                            <span className="hidden font-mono text-ui-10 uppercase text-on-surface-variant sm:inline">
                                {connectionDbType}
                            </span>
                        )}
                    </span>
                )}
                {!repoName && !connectionName && (
                    <span className="truncate text-on-surface-variant/75">{t.shell.ade.statusBar.disconnected}</span>
                )}
            </div>

            {/* Derecha: Agentes vivos + Escala UI + Versión */}
            <div className="flex shrink-0 items-center gap-2.5">
                {liveAgentsCount > 0 && (
                    <button
                        type="button"
                        onClick={onClickAgents}
                        title={t.shell.ade.statusBar.agentsTitle}
                        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-variant hover:text-on-surface"
                    >
                        <span
                            aria-hidden
                            className={`h-1.5 w-1.5 rounded-full ${
                                pendingApprovalsCount > 0 ? 'bg-tertiary' : 'animate-pulse bg-secondary'
                            }`}
                        />
                        <span>{t.shell.ade.statusBar.agentsCount({count: liveAgentsCount})}</span>
                    </button>
                )}

                {/* Control rápido de escala (--ui-font-scale: presets + custom) */}
                <div ref={menuRef} className="relative">
                    <button
                        type="button"
                        onClick={() => setScaleMenuOpen((o) => !o)}
                        title={t.shell.ade.statusBar.scaleTitle}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-ui-10 transition-colors hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="text_fields" size={13} />
                        <span>{t.shell.ade.statusBar.scaleLabel({pct: uiFontScale})}</span>
                    </button>

                    {scaleMenuOpen && (
                        <div className="absolute bottom-8 right-0 z-40 w-48 rounded-xl border border-outline-variant bg-surface-container-high p-2 shadow-xl">
                            <div className="mb-1.5 flex flex-wrap gap-1">
                                {UI_FONT_SCALES.map((sc) => {
                                    const active = uiFontScale === sc.value
                                    return (
                                        <button
                                            key={sc.value}
                                            type="button"
                                            title={t.shell.ade.statusBar.scaleLabel({pct: sc.value})}
                                            onClick={() => {
                                                onChangeUIFontScale(sc.value)
                                                setScaleMenuOpen(false)
                                            }}
                                            className={`rounded px-1.5 py-0.5 font-mono text-ui-10 font-medium transition-colors ${
                                                active
                                                    ? 'bg-primary-container text-on-primary-container'
                                                    : 'bg-surface-container text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                            }`}
                                        >
                                            {sc.value}%
                                        </button>
                                    )
                                })}
                            </div>
                            <div className="flex items-center gap-1 border-t border-outline-variant/60 pt-1.5">
                                <input
                                    type="number"
                                    min={80}
                                    max={200}
                                    step={5}
                                    value={customInput}
                                    onChange={(e) => setCustomInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') applyCustomScale()
                                    }}
                                    placeholder={t.shell.ade.statusBar.scaleCustomPlaceholder}
                                    className="h-6 w-16 rounded border border-outline-variant bg-surface-container px-1.5 font-mono text-ui-10 text-on-surface outline-none focus:border-primary"
                                />
                                <button
                                    type="button"
                                    onClick={applyCustomScale}
                                    title={t.shell.ade.statusBar.scaleTitle}
                                    className="h-6 flex-1 rounded bg-primary-container px-2 text-ui-10 font-medium text-on-primary-container hover:opacity-90"
                                >
                                    {t.shell.ade.statusBar.scaleApply}
                                </button>
                                {uiFontScale !== DEFAULT_UI_FONT_SCALE && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onChangeUIFontScale(DEFAULT_UI_FONT_SCALE)
                                            setScaleMenuOpen(false)
                                        }}
                                        title={t.shell.ade.statusBar.scaleResetTitle}
                                        className="sidebar-icon"
                                    >
                                        <Icon name="restart_alt" size={13} />
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {version && (
                    <button
                        type="button"
                        onClick={onOpenSettings}
                        title={
                            updateAvailable
                                ? t.shell.sidebar.settingsUpdateTitle({latest: updateAvailable})
                                : t.shell.sidebar.versionTitle({version})
                        }
                        className="relative flex items-center gap-1 rounded px-1 py-0.5 font-mono text-ui-10 transition-colors hover:bg-surface-variant hover:text-on-surface"
                    >
                        <span>v{version}</span>
                        {updateAvailable && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />}
                    </button>
                )}
            </div>
        </footer>
    )
}
