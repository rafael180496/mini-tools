import {useCallback, useEffect, useState} from 'react'
import {MCPServerStatus, SetMCPServerEnabled} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import Toggle from './Toggle'

// Panel "Acceso de la IA": el interruptor del servidor MCP y qué se leyó.
//
// Contesta la pregunta que ningún cortafuegos contesta solo: **¿qué ve hoy la
// IA?**. Confiar en la regla y poder verificarla son dos cosas distintas, y el
// registro de accesos es la segunda.

// Cómo se lee cada herramienta en el registro. El nombre técnico
// (`db_get_schema`) es lo que ve el agente; acá va lo que hizo.
const TOOL_LABELS: Record<string, string> = {
    vault_search_notes: 'Buscó en tus notas',
    vault_read_note: 'Leyó una nota',
    db_list_connections: 'Listó tus conexiones',
    db_get_schema: 'Leyó el esquema de una tabla',
    db_explain_query: 'Analizó un plan de ejecución',
    ssh_get_recent_logs: 'Leyó una terminal SSH',
    git_status: 'Miró el estado de un repositorio',
}

export default function AiAccessPanel() {
    const [status, setStatus] = useState<main.MCPStatus | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const refresh = useCallback(() => {
        MCPServerStatus()
            .then(setStatus)
            .catch((e) => setError(String(e)))
    }, [])

    useEffect(refresh, [refresh])

    // Mientras está encendido se refresca solo, para que el registro se vea
    // llenarse. **Apagado no hay ningún intervalo corriendo**: sería gastar
    // ciclos mirando algo que no puede cambiar.
    useEffect(() => {
        if (!status?.enabled) return
        const t = setInterval(refresh, 4000)
        return () => clearInterval(t)
    }, [status?.enabled, refresh])

    const toggle = (enabled: boolean) => {
        setBusy(true)
        setError('')
        SetMCPServerEnabled(enabled)
            .then(refresh)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                Acceso de la IA
            </h3>

            <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container p-3">
                <div className="flex items-start gap-3">
                    <Icon
                        name={status?.enabled ? 'lan' : 'lan_connect'}
                        size={18}
                        className={`mt-0.5 shrink-0 ${status?.enabled ? 'text-primary' : 'text-on-surface-variant'}`}
                    />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-on-surface">Servidor MCP</p>
                        <p className="mt-0.5 text-[11px] leading-4 text-on-surface-variant">
                            Deja que Claude Code, Codex o Antigravity le <strong>pidan</strong> datos a mini-tools desde
                            su propia conversación: buscar en tus notas, leer el esquema de una tabla, mirar las últimas
                            líneas de una terminal.{' '}
                            <strong>Mientras esté apagado no hay nada escuchando</strong> — ni socket, ni proceso, ni
                            consumo.
                        </p>
                    </div>
                    <Toggle
                        checked={!!status?.enabled}
                        disabled={busy}
                        onChange={toggle}
                        title={
                            status?.enabled
                                ? 'Apagar el servidor: se cierra el canal y se borra el socket. Los agentes dejan de poder pedir datos al instante.'
                                : 'Encender el servidor. Abre un canal local (nunca un puerto de red) para que los agentes que vos lances puedan pedir datos. Se apaga cuando quieras.'
                        }
                    />
                </div>

                {error && <p className="rounded bg-error-container/40 px-2 py-1 text-[11px] text-error">{error}</p>}

                {status?.enabled && (
                    <>
                        <p
                            className="rounded bg-surface-container-high px-2 py-1 font-mono text-[10px] text-on-surface-variant"
                            title="El canal es un socket local del sistema de archivos, con permisos solo para tu usuario. Nunca se abre un puerto de red."
                        >
                            {status.socketPath}
                        </p>
                        <p className="text-[11px] text-on-surface-variant">
                            {status.tools} herramientas expuestas. Ninguna devuelve filas de tus bases, ni DSN, ni
                            contraseñas, ni el contenido de una nota que hayas marcado como privada.
                        </p>
                    </>
                )}

                <div className="rounded border border-outline-variant bg-surface-container-low p-2">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-on-surface-variant">
                        Últimos accesos
                    </p>
                    {!status?.audit?.length ? (
                        <p className="text-[11px] text-on-surface-variant">
                            {status?.enabled
                                ? 'Todavía ningún agente pidió nada.'
                                : 'El servidor está apagado, así que no hay accesos posibles.'}
                        </p>
                    ) : (
                        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                            {status.audit.map((e, i) => (
                                <li key={i} className="flex items-center gap-1.5 text-[11px]">
                                    <Icon
                                        name={e.denied ? 'block' : 'check'}
                                        size={11}
                                        className={`shrink-0 ${e.denied ? 'text-error' : 'text-tertiary'}`}
                                    />
                                    <span className="shrink-0 text-on-surface">{TOOL_LABELS[e.tool] ?? e.tool}</span>
                                    {e.resource && (
                                        <span className="min-w-0 truncate font-mono text-on-surface-variant">
                                            {e.resource}
                                        </span>
                                    )}
                                    <span
                                        className="ml-auto shrink-0 text-on-surface-variant/70"
                                        title={new Date(e.at * 1000).toLocaleString('es')}
                                    >
                                        {new Date(e.at * 1000).toLocaleTimeString('es', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="mt-1 text-[10px] leading-4 text-on-surface-variant/70">
                        Se registra <strong>qué se pidió, no lo que se leyó</strong>: guardar el contenido sería una
                        segunda copia de lo mismo que se quiere proteger. Vive en memoria y se va al cerrar la app.
                    </p>
                </div>
            </div>
        </section>
    )
}
