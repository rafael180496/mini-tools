import {TERMINAL_THEME_IDS, TERMINAL_THEME_LABELS, resolveTerminalTheme, type TerminalThemeId} from '../../xterm/terminalThemes'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'

interface SshTerminalThemePickerProps {
    value: string
    appTheme: Theme
    onChange: (id: TerminalThemeId) => void
    onClose: () => void
}

// Small color-swatch strip (background + 4 ANSI colors) so a theme is
// recognizable at a glance instead of just a name — same reasoning
// DataGrip/Termius-style theme pickers use, more useful here than a plain
// <select> (frontend/src/components/SettingsDialog.tsx's editor theme
// picker) because terminal palettes are exactly the kind of thing you want
// to SEE before picking.
function Swatch({id, appTheme}: {id: TerminalThemeId; appTheme: Theme}) {
    const t = resolveTerminalTheme(id, appTheme)
    const colors = [t.background, t.red, t.green, t.yellow, t.blue]
    return (
        <div className="flex h-5 w-14 shrink-0 overflow-hidden rounded border border-outline-variant">
            {colors.map((c, i) => (
                <div key={i} className="h-full flex-1" style={{backgroundColor: c}} />
            ))}
        </div>
    )
}

export default function SshTerminalThemePicker({value, appTheme, onChange, onClose}: SshTerminalThemePickerProps) {
    return (
        <div className="flex h-full w-64 shrink-0 flex-col border-l border-outline-variant bg-surface-container">
            <div className="flex items-center gap-1.5 border-b border-outline-variant px-2 py-1.5">
                <Icon name="palette" size={16} className="text-on-surface-variant" />
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Tema de terminal</span>
                <div className="flex-1" />
                <button
                    onClick={onClose}
                    title="Cierra este panel"
                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <div className="flex flex-col gap-1">
                    {TERMINAL_THEME_IDS.map((id) => (
                        <button
                            key={id}
                            onClick={() => onChange(id)}
                            title={`Usar el tema "${TERMINAL_THEME_LABELS[id]}" en esta terminal — aplica a todas las sesiones SSH abiertas`}
                            className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs ${
                                value === id
                                    ? 'border-primary bg-primary-container text-on-primary-container'
                                    : 'border-transparent text-on-surface-variant hover:bg-surface-variant'
                            }`}
                        >
                            <Swatch id={id} appTheme={appTheme} />
                            <span className="min-w-0 flex-1 truncate">{TERMINAL_THEME_LABELS[id]}</span>
                            {value === id && <Icon name="check" size={14} />}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
