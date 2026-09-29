import {TERMINAL_THEME_IDS, TERMINAL_THEME_LABELS, resolveTerminalTheme, type TerminalThemeId} from '../../xterm/terminalThemes'
import {useT} from '../../i18n'
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
// Lo que no es texto de la interfaz —una ruta, un comando, permisos y
// nombres de archivo— se escribe igual en los dos idiomas.
const SAMPLE = {path: '~/app', cmd: '$ ls -la', perms: 'drwxr-xr-x', dir: 'config', file: 'error.log'}

function ThemePreview({id, appTheme}: {id: TerminalThemeId; appTheme: Theme}) {
    const tr = useT()
    const t = resolveTerminalTheme(id, appTheme)
    return (
        <div
            className="overflow-hidden rounded border border-outline-variant px-1.5 py-1 font-mono text-ui-10 leading-tight"
            style={{backgroundColor: t.background, color: t.foreground}}
        >
            <div className="truncate">
                <span style={{color: t.green}}>{tr.terminal.theme.sampleUser}</span>
                <span style={{color: t.foreground}}>:</span>
                <span style={{color: t.blue}}>{SAMPLE.path}</span>
                <span style={{color: t.foreground}}>{SAMPLE.cmd}</span>
            </div>
            <div className="truncate">
                <span style={{color: t.cyan ?? t.blue}}>{SAMPLE.perms}</span>{' '}
                <span style={{color: t.yellow}}>{SAMPLE.dir}</span>{' '}
                <span style={{color: t.red}}>{SAMPLE.file}</span>
            </div>
        </div>
    )
}

export default function SshTerminalThemePicker({value, appTheme, onChange, onClose}: SshTerminalThemePickerProps) {
    const t = useT()
    return (
        <div className="flex h-full w-64 shrink-0 flex-col border-l border-outline-variant bg-surface-container">
            <div className="flex items-center gap-1.5 border-b border-outline-variant px-2 py-1.5">
                <Icon name="palette" size={16} className="text-on-surface-variant" />
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{t.terminal.theme.pickerTitle}</span>
                <div className="flex-1" />
                <button
                    onClick={onClose}
                    title={t.terminal.theme.closePanel}
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
                            title={t.terminal.theme.useInThis({name: TERMINAL_THEME_LABELS[id]})}
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
