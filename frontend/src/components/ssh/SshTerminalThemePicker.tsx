import {TERMINAL_THEME_IDS, TERMINAL_THEME_LABELS, resolveTerminalTheme, type TerminalThemeId} from '../../xterm/terminalThemes'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'

interface SshTerminalThemePickerProps {
    value: string
    appTheme: Theme
    onChange: (id: TerminalThemeId) => void
    onClose: () => void
}

// Vista previa de una línea de terminal real, no una tira de colores.
//
// Antes cada tema se mostraba como cinco cuadraditos (fondo + 4 colores ANSI).
// Servía para distinguir un tema oscuro de uno claro, pero no para lo que uno
// decide de verdad al elegir una paleta: si el texto normal se lee cómodo sobre
// ese fondo, si el verde del prompt no compite con el amarillo de un warning, si
// el contraste aguanta una jornada entera. Eso solo se ve viéndolo escrito.
//
// La línea de ejemplo es la forma de un prompt y una salida cualquiera, con la
// tipografía y el cuerpo de la terminal, pintada con los colores exactos que va
// a usar xterm.
function ThemePreview({id, appTheme}: {id: TerminalThemeId; appTheme: Theme}) {
    const t = resolveTerminalTheme(id, appTheme)
    return (
        <div
            className="overflow-hidden rounded border border-outline-variant px-1.5 py-1 font-mono text-[10px] leading-tight"
            style={{backgroundColor: t.background, color: t.foreground}}
        >
            <div className="truncate">
                <span style={{color: t.green}}>usuario@host</span>
                <span style={{color: t.foreground}}>:</span>
                <span style={{color: t.blue}}>~/app</span>
                <span style={{color: t.foreground}}>$ ls -la</span>
            </div>
            <div className="truncate">
                <span style={{color: t.cyan ?? t.blue}}>drwxr-xr-x</span>{' '}
                <span style={{color: t.yellow}}>config</span>{' '}
                <span style={{color: t.red}}>error.log</span>
            </div>
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
                            className={`flex w-full flex-col gap-1 rounded-lg border p-1.5 text-left text-xs ${
                                value === id
                                    ? 'border-primary bg-primary-container text-on-primary-container'
                                    : 'border-transparent text-on-surface-variant hover:bg-surface-variant'
                            }`}
                        >
                            <span className="flex items-center gap-1">
                                <span className="min-w-0 flex-1 truncate">{TERMINAL_THEME_LABELS[id]}</span>
                                {value === id && <Icon name="check" size={14} className="shrink-0" />}
                            </span>
                            <ThemePreview id={id} appTheme={appTheme} />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
