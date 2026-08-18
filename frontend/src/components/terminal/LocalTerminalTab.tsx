import {useState} from 'react'
import {AppendLocalHistory, ClearLocalHistory, ListLocalHistory, WriteLocalTerminal} from '../../../wailsjs/go/main/App'
import type {Theme} from '../../hooks/useTheme'
import type {TerminalThemeId} from '../../xterm/terminalThemes'
import Icon from '../Icon'
import SshHistoryPanel from '../ssh/SshHistoryPanel'
import SshSnippetsPanel from '../ssh/SshSnippetsPanel'
import SshTerminalThemePicker from '../ssh/SshTerminalThemePicker'
import LocalTerminalPanel from './LocalTerminalPanel'

// Una terminal del SISTEMA OPERATIVO como pestaña del módulo SSH.
//
// **Por qué vive en el módulo SSH.** Lo que se hace ahí no es "administrar
// servidores" sino trabajar en una terminal: se mira un log en el server, se
// copia algo a la máquina de uno, se corre un `scp` o un `kubectl` local. Tener
// que salir de la app para lo local partía ese trabajo en dos, y encima dejaba
// afuera las dos cosas que hacen usable una terminal acá — los snippets y el
// historial— que hasta ahora solo servían para las sesiones remotas.
//
// **Es la misma terminal del módulo Git**, no una segunda implementación:
// `LocalTerminalPanel` es el mismo widget con el mismo backend (backend/localterm),
// y lo que agrega esta pestaña es la barra con snippets, historial y tema.
//
// **Los snippets son los mismos que los de SSH**, sin copia ni migración: la
// lista siempre fue global y lo único atado a la pestaña era a qué sesión se le
// mandan los bytes. El historial, en cambio, es aparte y por intérprete — ver
// backend/vault/local_history_repo.go.

interface Props {
    // Id de la sesión: lo genera quien abre la pestaña y tiene que sobrevivir
    // mientras la pestaña siga abierta. Si cambia, se abre otra shell y se
    // pierde el directorio en el que estabas.
    sessionId: string
    // Intérprete de esta pestaña. Vacío = el configurado en Configuración.
    shellId: string
    // Cómo se lo nombra en la interfaz ("PowerShell", "zsh").
    shellLabel: string
    theme: Theme
    terminalThemeId: string
    onChangeTerminalTheme: (id: TerminalThemeId) => void
    terminalFontSize: number
    visible: boolean
}

export default function LocalTerminalTab({
    sessionId,
    shellId,
    shellLabel,
    theme,
    terminalThemeId,
    onChangeTerminalTheme,
    terminalFontSize,
    visible,
}: Props) {
    const [showHistory, setShowHistory] = useState(false)
    const [showSnippets, setShowSnippets] = useState(false)
    const [showThemePicker, setShowThemePicker] = useState(false)

    // El historial se agrupa por intérprete y no por pestaña: dos terminales de
    // zsh abiertas son la misma historia, y la de PowerShell es otra.
    const scope = shellId || 'default'

    const write = (data: string) => void WriteLocalTerminal(sessionId, data)

    return (
        // Fila, no columna: snippets, historial y tema son **columnas laterales**
        // (`h-full w-72`), las mismas que usa la terminal SSH. Apilados en una
        // columna ocupaban todo el alto y la terminal desaparecía de la vista.
        //
        // `flex-1 min-w-0` porque el contenedor de la pestaña es a su vez una
        // fila: sin eso la terminal se queda con el ancho de su contenido, una
        // franja angosta pegada a la izquierda.
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant bg-surface-container-low px-2 py-1 text-[11px]">
                {/* El nombre del intérprete NO se repite acá: la barra del
                    propio widget, justo debajo, ya lo muestra con su indicador
                    de "viva". Esta fila es solo lo que agrega el módulo SSH
                    —snippets, historial, tema—, y decir dos veces "zsh" en dos
                    renglones seguidos era ruido en un panel donde el espacio
                    es la terminal. */}
                <Icon name="terminal" size={13} className="shrink-0 text-primary" />
                <span
                    className="font-medium text-on-surface"
                    title="Corre en ESTA máquina, no en un servidor: lo que ejecutes acá pasa en tu equipo, con tus permisos."
                >
                    Terminal local
                </span>

                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                        onClick={() => {
                            setShowSnippets((v) => !v)
                            // Los tres paneles son columnas del mismo ancho:
                            // abiertos a la vez no queda terminal. Abrir uno
                            // cierra los otros, igual que en la terminal SSH.
                            setShowHistory(false)
                            setShowThemePicker(false)
                        }}
                        title="Snippets — los MISMOS que usás en las terminales SSH. Ejecutar los manda a esta shell local; Pegar los deja escritos para revisarlos antes."
                        className={`rounded p-1 ${showSnippets ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'}`}
                    >
                        <Icon name="code_blocks" size={14} />
                    </button>
                    <button
                        onClick={() => {
                            setShowHistory((v) => !v)
                            setShowSnippets(false)
                            setShowThemePicker(false)
                        }}
                        title={`Comandos que ya ejecutaste en ${shellLabel || 'esta shell'}, guardados cifrados en el vault. Se puede apagar el registro y borrar lo guardado desde el mismo panel.`}
                        className={`rounded p-1 ${showHistory ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'}`}
                    >
                        <Icon name="history" size={14} />
                    </button>
                    <button
                        onClick={() => {
                            setShowThemePicker((v) => !v)
                            setShowSnippets(false)
                            setShowHistory(false)
                        }}
                        title="Colores de la terminal. Es un ajuste de TODAS las terminales de la app, no solo de esta pestaña."
                        className={`rounded p-1 ${showThemePicker ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'}`}
                    >
                        <Icon name="palette" size={14} />
                    </button>
                </span>
            </div>

            <div className="min-h-0 flex-1">
                <LocalTerminalPanel
                    sessionId={sessionId}
                    repoId=""
                    kind="shell"
                    shellOverride={shellId}
                    shellId={shellId}
                    // Fire and forget: guardar el historial no puede demorar ni
                    // romper el comando, que ya salió hacia la shell. El backend
                    // decide qué se guarda —descarta lo que parece traer un
                    // secreto y respeta el interruptor—, así que desde acá se
                    // manda todo y no hay dos criterios que puedan discrepar.
                    onCommand={(command) => void AppendLocalHistory(scope, command).catch(() => {})}
                    theme={theme}
                    terminalThemeId={terminalThemeId}
                    fontSize={terminalFontSize}
                    visible={visible}
                />
            </div>
            </div>

            {showThemePicker && (
                <SshTerminalThemePicker
                    appTheme={theme}
                    value={terminalThemeId}
                    onChange={onChangeTerminalTheme}
                    onClose={() => setShowThemePicker(false)}
                />
            )}

            {showSnippets && <SshSnippetsPanel write={write} onClose={() => setShowSnippets(false)} />}

            {showHistory && (
                <SshHistoryPanel
                    scope={scope}
                    scopeLabel={shellLabel || 'la terminal local'}
                    load={(limit) => ListLocalHistory(scope, limit)}
                    clear={() => ClearLocalHistory(scope)}
                    keepsNote="El historial del propio shell de tu máquina (~/.zsh_history, el de PowerShell y compañía) no se toca: eso vive afuera de la app y se limpia afuera."
                    onClose={() => setShowHistory(false)}
                    onPaste={(cmd) => write(cmd)}
                    onRun={(cmd) => write(cmd + '\r')}
                />
            )}

        </div>
    )
}
