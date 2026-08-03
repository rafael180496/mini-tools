import {useCallback, useEffect, useState} from 'react'
import {ClearAgentKey, ListAgents, SetAgentCommand, SetAgentKey} from '../../wailsjs/go/main/App'
import {BrowserOpenURL} from '../../wailsjs/runtime'
import {agents} from '../../wailsjs/go/models'
import Icon from './Icon'

// Sección "Agentes de código" de Configuración.
//
// Qué se puede y qué NO se puede configurar acá, que es la parte que suele
// malinterpretarse: Claude Code, Codex y Gemini CLI son programas de terminal
// que manejan su PROPIA autenticación (su login por navegador, su token, su
// archivo de configuración). Esta app no lee, no replica y no intercepta esas
// credenciales — hacerlo sería frágil y una responsabilidad que nadie le
// pidió. "Vincular la cuenta" se hace en el propio CLI, abriendo una sesión y
// siguiendo su login.
//
// Lo único que esta pantalla guarda es (a) con qué comando se abre cada
// agente, para quien lo tiene instalado en otro lado o quiere pasarle
// argumentos fijos, y (b) OPCIONALMENTE una API key, cifrada bajo la clave
// maestra igual que un DSN o una llave SSH, para quien prefiere autenticarse
// por variable de entorno. La key nunca vuelve al frontend ni viaja en la
// línea de comandos: entra a la sesión por el entorno del proceso.
export default function AgentSettings() {
    const [list, setList] = useState<agents.Agent[]>([])
    const [error, setError] = useState('')
    // Borradores del comando por agente, para no escribir en el vault en cada
    // tecla — se guarda al salir del campo.
    const [commandDraft, setCommandDraft] = useState<Record<string, string>>({})
    const [keyDraft, setKeyDraft] = useState<Record<string, string>>({})
    const [expanded, setExpanded] = useState<string | null>(null)

    const reload = useCallback(() => {
        ListAgents()
            .then((l) => setList(l ?? []))
            .catch((e) => setError(String(e)))
    }, [])

    useEffect(() => {
        reload()
    }, [reload])

    async function saveCommand(agentId: string, value: string) {
        try {
            await SetAgentCommand(agentId, value)
            reload()
        } catch (e) {
            setError(String(e))
        }
    }

    async function saveKey(agentId: string) {
        const value = (keyDraft[agentId] ?? '').trim()
        if (!value) return
        try {
            await SetAgentKey(agentId, value)
            setKeyDraft((d) => ({...d, [agentId]: ''}))
            reload()
        } catch (e) {
            setError(String(e))
        }
    }

    async function removeKey(agentId: string) {
        try {
            await ClearAgentKey(agentId)
            reload()
        } catch (e) {
            setError(String(e))
        }
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Agentes de código</h3>

            <p className="px-1 text-xs text-on-surface-variant">
                Se abren como una sesión más del panel de una pestaña Git, sobre el repositorio abierto.{' '}
                <span
                    title="Cada CLI maneja su propia sesión: el login se hace dentro del programa, no acá. Esta app no lee ni guarda esas credenciales. La API key de abajo es una alternativa opcional para quien se autentica por variable de entorno."
                    className="underline decoration-dotted underline-offset-2"
                >
                    Tu cuenta se vincula dentro de cada agente
                </span>
                , abriendo una sesión y siguiendo su login.
            </p>

            {error && <p className="px-1 text-xs text-error">{error}</p>}

            {list.length === 0 && !error && (
                <p className="px-1 text-xs text-on-surface-variant/70">Cargando los agentes disponibles…</p>
            )}

            {list.map((a) => {
                const open = expanded === a.id
                return (
                    <div key={a.id} className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                        <div className="flex items-center gap-3">
                            <span
                                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                                    a.available ? 'bg-primary/15 text-primary' : 'bg-surface-variant text-on-surface-variant/50'
                                }`}
                            >
                                <Icon name="smart_toy" size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <span className="flex items-center gap-2 text-sm font-medium text-on-surface">
                                    {a.label}
                                    <span className="text-xs font-normal text-on-surface-variant">{a.vendor}</span>
                                    {a.hasKey && (
                                        <span
                                            title={`Hay una API key guardada, cifrada bajo tu clave maestra. Se le pasa a ${a.label} por la variable ${a.keyEnv} al abrir una sesión, nunca en la línea de comandos.`}
                                            className="flex items-center gap-1 rounded-full bg-secondary/15 px-1.5 text-[10px] text-secondary"
                                        >
                                            <Icon name="key" size={11} />
                                            key guardada
                                        </span>
                                    )}
                                </span>
                                <span
                                    className="block truncate text-xs text-on-surface-variant"
                                    title={a.available ? a.path : `No se encontró el ejecutable "${a.defaultCommand}" en este equipo`}
                                >
                                    {a.available ? a.path : 'No está instalado en este equipo'}
                                </span>
                            </div>
                            <button
                                onClick={() => setExpanded(open ? null : a.id)}
                                title={
                                    open
                                        ? 'Ocultar los ajustes de este agente'
                                        : 'Ajustes de este agente: con qué comando se abre y, si te autenticás por API key, guardarla cifrada'
                                }
                                className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name={open ? 'expand_less' : 'expand_more'} size={20} />
                            </button>
                        </div>

                        {open && (
                            <div className="flex flex-col gap-3 border-t border-outline-variant pt-3 pl-12">
                                <p className="text-xs text-on-surface-variant">{a.note}</p>
                                <p className="text-xs text-on-surface-variant">{a.loginHint}</p>

                                <label className="flex flex-col gap-1">
                                    <span className="text-xs font-medium text-on-surface">Comando</span>
                                    <input
                                        value={commandDraft[a.id] ?? a.command}
                                        onChange={(e) => setCommandDraft((d) => ({...d, [a.id]: e.target.value}))}
                                        onBlur={(e) => void saveCommand(a.id, e.target.value)}
                                        placeholder={a.defaultCommand}
                                        title={`Lo que se escribe en la terminal para abrir ${a.label}. Cambialo si lo tenés instalado con otro nombre o querés pasarle argumentos fijos. Vacío restaura "${a.defaultCommand}". Se guarda al salir del campo.`}
                                        className="w-full rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
                                    />
                                </label>

                                {a.keyEnv !== '' && (
                                    <div className="flex flex-col gap-1">
                                        <span className="text-xs font-medium text-on-surface">
                                            API key <span className="font-normal text-on-surface-variant">(opcional)</span>
                                        </span>
                                        {a.hasKey ? (
                                            <div className="flex items-center gap-2">
                                                <span className="min-w-0 flex-1 truncate text-xs text-on-surface-variant">
                                                    Guardada y cifrada. Se pasa como {a.keyEnv}.
                                                </span>
                                                <button
                                                    onClick={() => void removeKey(a.id)}
                                                    title={`Borra la API key guardada de ${a.label}. Las sesiones que ya estén abiertas la siguen teniendo hasta que las reinicies; las nuevas van a depender del login propio del CLI.`}
                                                    className="shrink-0 rounded px-2 py-1 text-xs text-error hover:bg-error-container/40"
                                                >
                                                    Quitar
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="password"
                                                    value={keyDraft[a.id] ?? ''}
                                                    onChange={(e) => setKeyDraft((d) => ({...d, [a.id]: e.target.value}))}
                                                    placeholder={a.keyEnv}
                                                    title={`Solo si te autenticás por API key en vez del login del propio ${a.label}. Se guarda cifrada con tu clave maestra, igual que las contraseñas de las conexiones, y se le pasa por la variable ${a.keyEnv} al abrir una sesión — nunca en la línea de comandos, donde quedaría visible para cualquier proceso del equipo.`}
                                                    className="min-w-0 flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
                                                />
                                                <button
                                                    onClick={() => void saveKey(a.id)}
                                                    disabled={!(keyDraft[a.id] ?? '').trim()}
                                                    title={
                                                        (keyDraft[a.id] ?? '').trim()
                                                            ? 'Guarda la API key cifrada bajo tu clave maestra'
                                                            : 'Escribí la API key para poder guardarla'
                                                    }
                                                    className="shrink-0 rounded bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-40"
                                                >
                                                    Guardar
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}

                                <button
                                    onClick={() => BrowserOpenURL(a.docsUrl)}
                                    title={`Abre en el navegador la documentación de ${a.label} — instalación y cómo iniciar sesión`}
                                    className="flex items-center gap-1.5 self-start text-xs text-primary hover:underline"
                                >
                                    <Icon name="open_in_new" size={13} />
                                    Cómo instalarlo e iniciar sesión
                                </button>
                            </div>
                        )}
                    </div>
                )
            })}
        </section>
    )
}
