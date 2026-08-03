import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {TERMINAL_THEME_IDS, TERMINAL_THEME_LABELS, resolveTerminalTheme, type TerminalThemeId} from '../../xterm/terminalThemes'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'

interface TerminalThemeMenuProps {
    value: string
    appTheme: Theme
    onChange: (id: TerminalThemeId) => void
}

// Tira de colores (fondo + 4 colores ANSI) para reconocer la paleta de un
// vistazo. Una lista de nombres no sirve acá: "Gruvbox Dark" y "Tomorrow
// Night" no le dicen nada a nadie hasta verlos, y una paleta de terminal es
// exactamente el tipo de cosa que se elige mirando.
function Swatch({id, appTheme}: {id: TerminalThemeId; appTheme: Theme}) {
    const t = resolveTerminalTheme(id, appTheme)
    const colors = [t.background, t.red, t.green, t.yellow, t.blue]
    return (
        <span className="flex h-4 w-12 shrink-0 overflow-hidden rounded border border-outline-variant">
            {colors.map((c, i) => (
                <span key={i} className="h-full flex-1" style={{backgroundColor: c}} />
            ))}
        </span>
    )
}

// Selector de tema compacto para la barra de una terminal.
//
// Es un popover y no el panel lateral fijo de las pestañas SSH
// (SshTerminalThemePicker): esa terminal ocupa una pestaña entera y le sobran
// 256px para un panel al costado, mientras que esta puede estar anclada a un
// costado midiendo 300px de ancho — un panel fijo se comería la terminal
// entera. El menú va en un portal a document.body para que no lo recorte el
// overflow del panel, mismo motivo que el <Select> de la app.
export default function TerminalThemeMenu({value, appTheme, onChange}: TerminalThemeMenuProps) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({top: 0, left: 0})
    const btnRef = useRef<HTMLButtonElement>(null)

    function place() {
        const r = btnRef.current?.getBoundingClientRect()
        if (!r) return
        // 224px es el ancho del menú; se corre a la izquierda si no entra
        // contra el borde derecho de la ventana (el caso del dock a la
        // derecha, donde el botón está pegado al borde).
        const width = 224
        setPos({top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8))})
    }

    useLayoutEffect(() => {
        if (!open) return
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
    }, [open])

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open])

    return (
        <>
            <button
                ref={btnRef}
                onClick={() => setOpen((v) => !v)}
                title="Cambiar la paleta de colores de las terminales. Se aplica al instante y a todas las terminales abiertas (local y SSH), y queda guardada."
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${
                    open ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                }`}
            >
                <Icon name="palette" size={14} />
            </button>

            {open &&
                createPortal(
                    <>
                        {/* Capa de cierre: un clic en cualquier lado cierra el
                            menú sin robarle el foco a la terminal. */}
                        <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
                        <div
                            style={{top: pos.top, left: pos.left, width: 224}}
                            className="fixed z-50 max-h-80 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg"
                        >
                            {TERMINAL_THEME_IDS.map((id) => (
                                <button
                                    key={id}
                                    onClick={() => {
                                        onChange(id)
                                        setOpen(false)
                                    }}
                                    title={
                                        id === 'auto'
                                            ? 'Sigue el modo claro/oscuro de la app: la terminal se aclara y se oscurece con el resto de la ventana'
                                            : `Usar la paleta ${TERMINAL_THEME_LABELS[id]} en todas las terminales`
                                    }
                                    className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] ${
                                        value === id
                                            ? 'bg-primary-container text-on-primary-container'
                                            : 'text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <Swatch id={id} appTheme={appTheme} />
                                    <span className="min-w-0 flex-1 truncate">
                                        {id === 'auto' ? 'Automático' : TERMINAL_THEME_LABELS[id]}
                                    </span>
                                    {value === id && <Icon name="check" size={13} className="shrink-0" />}
                                </button>
                            ))}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
