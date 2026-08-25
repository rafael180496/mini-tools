import {useCallback, useEffect, useState} from 'react'
import {MCPServerStatus, SetMCPNotesWrite, SetMCPServerEnabled} from '../../wailsjs/go/main/App'
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
    vault_create_note: 'Creó una nota',
    vault_update_note: 'Reescribió una nota suya',
}

// Cómo se conecta cada CLI. Son tres formatos distintos porque cada uno guarda
// su configuración a su manera — es la misma razón por la que la solapa Agentes
// tiene que leer cinco archivos para responder "qué MCP ve este agente".
//
// Se ofrecen para COPIAR y no se escriben solas. Dos motivos: `~/.claude.json`
// no es un archivo de configuración sino el archivo de ESTADO de Claude Code
// —historial por proyecto y mucho más, típicamente enorme— y reescribirlo
// entero para agregar una clave es un riesgo desproporcionado; y el lector de
// TOML de esta app está acotado a lo que necesita leer, así que no alcanza para
// escribir el `config.toml` de Codex preservando lo que no entiende.
function connectSnippets(exe: string) {
    const path = exe || '/ruta/a/mini-tools'
    return [
        {
            agent: 'Claude Code',
            how: 'En una terminal, una sola vez:',
            code: `claude mcp add mini-tools -- "${path}" --mcp`,
            note: 'Queda disponible en todos tus proyectos. Con `claude mcp list` se verifica que quedó.',
        },
        {
            agent: 'Codex CLI',
            how: 'Agregá esto a ~/.codex/config.toml:',
            code: `[mcp_servers.mini-tools]\ncommand = "${path}"\nargs = ["--mcp"]`,
            note: 'Si el archivo no existe, crealo con ese contenido.',
        },
        {
            agent: 'Antigravity CLI',
            how: 'Agregá esto a ~/.gemini/config/mcp_config.json:',
            code: `{\n  "mcpServers": {\n    "mini-tools": {\n      "command": "${path}",\n      "args": ["--mcp"]\n    }\n  }\n}`,
            note: 'Si ya tenés otros servidores, agregá solo la entrada "mini-tools" adentro de "mcpServers".',
        },
    ]
}

export default function AiAccessPanel() {
    const [status, setStatus] = useState<main.MCPStatus | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [howTo, setHowTo] = useState(false)
    const [copied, setCopied] = useState('')

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

    // Permiso de escritura. Aparte del interruptor del servidor a propósito:
    // ver el texto de la tarjeta y SetMCPNotesWrite en el backend.
    const toggleNotesWrite = (enabled: boolean) => {
        setBusy(true)
        setError('')
        SetMCPNotesWrite(enabled)
            .then(refresh)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
    }

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
            <h3 className="px-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">
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
                        <p className="mt-0.5 text-ui-11 leading-4 text-on-surface-variant">
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

                {error && <p className="rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">{error}</p>}

                {status?.enabled && (
                    <>
                        <p
                            className="rounded bg-surface-container-high px-2 py-1 font-mono text-ui-10 text-on-surface-variant"
                            title="El canal es un socket local del sistema de archivos, con permisos solo para tu usuario. Nunca se abre un puerto de red."
                        >
                            {status.socketPath}
                        </p>
                        <p className="text-ui-11 text-on-surface-variant">
                            {status.tools} herramientas expuestas. Ninguna devuelve filas de tus bases, ni DSN, ni
                            contraseñas, ni el contenido de una nota que hayas marcado como privada.
                        </p>

                        {/* Escritura en la base de conocimiento. Va acá adentro
                            —solo con el servidor encendido— porque es un permiso
                            sobre algo que no existe si no hay servidor, y va con
                            su propio interruptor porque cambia la promesa del
                            módulo: hasta acá el agente solo miraba. */}
                        <div className="flex items-start gap-3 rounded border border-outline-variant bg-surface-container-low p-2">
                            <Icon
                                name="note_add"
                                size={16}
                                className={`mt-0.5 shrink-0 ${status.notesWrite ? 'text-primary' : 'text-on-surface-variant'}`}
                            />
                            <div className="min-w-0 flex-1">
                                <p className="text-ui-11 font-medium text-on-surface">
                                    Dejar que el agente escriba en tu base de conocimiento
                                </p>
                                <p className="mt-0.5 text-ui-11 leading-4 text-on-surface-variant">
                                    Le agrega herramientas para <strong>crear notas nuevas</strong> —dejar asentado un
                                    procedimiento, un diagnóstico, una decisión— y para <strong>corregir las suyas</strong>.
                                    Cada nota que crea queda marcada como suya.
                                </p>
                                <p className="mt-1 text-ui-11 leading-4 text-on-surface-variant">
                                    <strong>Nunca toca lo que escribiste vos.</strong> Solo puede reescribir notas que
                                    creó él y que nadie editó después: apenas guardás una de sus notas, pasa a ser tuya y
                                    él deja de poder cambiarla. Una nota marcada como privada le queda fuera de alcance,
                                    igual que para leer. <strong>Borrar no puede nunca.</strong> Apagado, las
                                    herramientas ni siquiera aparecen en su catálogo.
                                </p>
                                {/* Honestidad sobre el momento en que cada
                                    cambio surte efecto. Quitar el permiso vale
                                    al instante porque se vuelve a comprobar al
                                    ejecutar; darlo puede necesitar que el CLI
                                    vuelva a pedir la lista, y eso no lo decide
                                    esta aplicación. Callarlo dejaría a alguien
                                    peleando con un agente que "no ve" la
                                    herramienta que acaba de habilitar. */}
                                <p className="mt-1 text-ui-10 leading-4 text-on-surface-variant/70">
                                    <strong>Vale sobre la sesión que ya esté abierta</strong>, sin reiniciar el CLI:
                                    quitarlo rechaza la llamada aunque el agente todavía crea que puede, y darlo le
                                    avisa —después de su próxima acción— que vuelva a pedir la lista de herramientas. Si
                                    su CLI ignora ese aviso, alcanza con reiniciarlo.
                                </p>
                            </div>
                            <Toggle
                                checked={!!status.notesWrite}
                                disabled={busy}
                                onChange={toggleNotesWrite}
                                title={
                                    status.notesWrite
                                        ? 'Quitarle el permiso: la herramienta desaparece de su catálogo y una llamada en curso se rechaza. Las notas que ya creó quedan como están.'
                                        : 'Darle permiso para crear notas nuevas. Seguirá sin poder modificar ni borrar las tuyas, y vas a ver cada alta en el registro de acceso de abajo.'
                                }
                            />
                        </div>
                    </>
                )}

                {/* Cómo conectarlo. Estaba el interruptor y no había forma de
                    saber qué hacer después: encender un servidor que ningún
                    agente sabe que existe no sirve de nada. */}
                <div className="rounded border border-outline-variant bg-surface-container-low">
                    <button
                        onClick={() => setHowTo((v) => !v)}
                        title="Los pasos exactos para que Claude Code, Codex o Antigravity vean este servidor"
                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-ui-11 text-on-surface hover:bg-surface-variant"
                    >
                        <Icon name={howTo ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0" />
                        <Icon name="help" size={13} className="shrink-0 text-primary" />
                        <span className="font-medium">Cómo conectar tu agente a este servidor</span>
                        <span className="ml-auto text-on-surface-variant/70">3 pasos</span>
                    </button>

                    {howTo && (
                        <div className="flex flex-col gap-2 border-t border-outline-variant p-2 text-ui-11">
                            <ol className="ml-4 list-decimal space-y-1 text-on-surface-variant">
                                <li>
                                    Encendé el servidor con el interruptor de arriba.{' '}
                                    <strong className="text-on-surface">Tiene que quedar encendido</strong> mientras
                                    uses el agente: apagado no hay nada escuchando.
                                </li>
                                <li>Pegá la configuración de tu CLI (abajo). Se hace una sola vez.</li>
                                <li>
                                    Reiniciá el CLI. Preguntale <em>"¿qué herramientas de mini-tools tenés?"</em> para
                                    confirmar.
                                </li>
                            </ol>

                            {connectSnippets(status?.executable ?? '').map((s2) => (
                                <div key={s2.agent} className="rounded border border-outline-variant bg-surface p-1.5">
                                    <p className="mb-1 flex items-center gap-1.5">
                                        <Icon name="smart_toy" size={12} className="shrink-0 text-primary" />
                                        <span className="font-medium text-on-surface">{s2.agent}</span>
                                        <span className="text-on-surface-variant">{s2.how}</span>
                                        <button
                                            onClick={() => {
                                                void navigator.clipboard.writeText(s2.code)
                                                setCopied(s2.agent)
                                            }}
                                            title="Copia el comando al portapapeles"
                                            className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name={copied === s2.agent ? 'check' : 'content_copy'} size={12} />
                                            {copied === s2.agent ? 'Copiado' : 'Copiar'}
                                        </button>
                                    </p>
                                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface-container-highest px-2 py-1 font-mono text-ui-10 text-on-surface">
                                        {s2.code}
                                    </pre>
                                    <p className="mt-1 text-ui-10 text-on-surface-variant/70">{s2.note}</p>
                                </div>
                            ))}

                            <p className="text-ui-10 leading-4 text-on-surface-variant/70">
                                <strong>Se copia y no se escribe solo</strong>, a propósito: el archivo de Claude Code es
                                su archivo de <em>estado</em> —con el historial de todos tus proyectos adentro— y
                                reescribirlo entero para agregar una línea es un riesgo desproporcionado.
                            </p>
                        </div>
                    )}
                </div>

                <div className="rounded border border-outline-variant bg-surface-container-low p-2">
                    <p className="mb-1 text-ui-10 font-medium uppercase tracking-wider text-on-surface-variant">
                        Últimos accesos
                    </p>
                    {!status?.audit?.length ? (
                        <p className="text-ui-11 text-on-surface-variant">
                            {status?.enabled
                                ? 'Todavía ningún agente pidió nada.'
                                : 'El servidor está apagado, así que no hay accesos posibles.'}
                        </p>
                    ) : (
                        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                            {status.audit.map((e, i) => (
                                <li key={i} className="flex items-center gap-1.5 text-ui-11">
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
                    <p className="mt-1 text-ui-10 leading-4 text-on-surface-variant/70">
                        Se registra <strong>qué se pidió, no lo que se leyó</strong>: guardar el contenido sería una
                        segunda copia de lo mismo que se quiere proteger. Vive en memoria y se va al cerrar la app.
                    </p>
                </div>
            </div>
        </section>
    )
}
