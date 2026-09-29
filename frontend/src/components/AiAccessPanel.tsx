import {useCallback, useEffect, useState} from 'react'
import {MCPServerStatus, SetMCPNotesWrite, SetMCPServerEnabled} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import Toggle from './Toggle'
import {rich} from './agent/rich'
import {formatDateTime, useT, type Dict} from '../i18n'

// Panel "Acceso de la IA": el interruptor del servidor MCP y qué se leyó.
//
// Contesta la pregunta que ningún cortafuegos contesta solo: **¿qué ve hoy la
// IA?**. Confiar en la regla y poder verificarla son dos cosas distintas, y el
// registro de accesos es la segunda.

// Cómo se lee cada herramienta en el registro. El nombre técnico
// (`db_get_schema`) es lo que ve el agente; acá va lo que hizo.
function toolLabel(t: Dict, tool: string): string {
    const labels: Record<string, string> = t.agent.aiAccess.tools
    return labels[tool] ?? tool
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
function connectSnippets(exe: string, t: Dict) {
    const a = t.agent.aiAccess
    const path = exe || a.examplePath
    return [
        {
            agent: 'Claude Code',
            how: a.claudeHow,
            code: `claude mcp add mini-tools -- "${path}" --mcp`,
            note: a.claudeNote,
        },
        {
            agent: 'Codex CLI',
            how: a.codexHow,
            code: `[mcp_servers.mini-tools]\ncommand = "${path}"\nargs = ["--mcp"]`,
            note: a.codexNote,
        },
        {
            agent: 'Antigravity CLI',
            how: a.antigravityHow,
            code: `{\n  "mcpServers": {\n    "mini-tools": {\n      "command": "${path}",\n      "args": ["--mcp"]\n    }\n  }\n}`,
            note: a.antigravityNote,
        },
    ]
}

export default function AiAccessPanel() {
    const t = useT()
    const a = t.agent.aiAccess
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
                {a.heading}
            </h3>

            <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container p-3">
                <div className="flex items-start gap-3">
                    <Icon
                        name={status?.enabled ? 'lan' : 'lan_connect'}
                        size={18}
                        className={`mt-0.5 shrink-0 ${status?.enabled ? 'text-primary' : 'text-on-surface-variant'}`}
                    />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-on-surface">{a.server}</p>
                        <p className="mt-0.5 text-ui-11 leading-4 text-on-surface-variant">
                            {rich(a.intro)}
                        </p>
                    </div>
                    <Toggle
                        checked={!!status?.enabled}
                        disabled={busy}
                        onChange={toggle}
                        title={
                            status?.enabled
                                ? a.turnOffTitle
                                : a.turnOnTitle
                        }
                    />
                </div>

                {error && <p className="rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">{error}</p>}

                {status?.enabled && (
                    <>
                        <p
                            className="rounded bg-surface-container-high px-2 py-1 font-mono text-ui-10 text-on-surface-variant"
                            title={a.socketTitle}
                        >
                            {status.socketPath}
                        </p>
                        <p className="text-ui-11 text-on-surface-variant">
                            {a.toolsExposed({n: status.tools})}
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
                                    {a.notesWriteTitle}
                                </p>
                                <p className="mt-0.5 text-ui-11 leading-4 text-on-surface-variant">
                                    {rich(a.notesWriteBody)}
                                </p>
                                <p className="mt-1 text-ui-11 leading-4 text-on-surface-variant">
                                    {rich(a.notesWriteRules)}
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
                                    {rich(a.notesWriteTiming)}
                                </p>
                            </div>
                            <Toggle
                                checked={!!status.notesWrite}
                                disabled={busy}
                                onChange={toggleNotesWrite}
                                title={
                                    status.notesWrite
                                        ? a.revokeTitle
                                        : a.grantTitle
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
                        title={a.howToTitle}
                        data-mcp-howto
                        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-ui-11 text-on-surface hover:bg-surface-variant"
                    >
                        <Icon name={howTo ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0" />
                        <Icon name="help" size={13} className="shrink-0 text-primary" />
                        <span className="font-medium">{a.howTo}</span>
                        <span className="ml-auto text-on-surface-variant/70">{a.steps}</span>
                    </button>

                    {howTo && (
                        <div className="flex flex-col gap-2 border-t border-outline-variant p-2 text-ui-11">
                            <ol className="ml-4 list-decimal space-y-1 text-on-surface-variant">
                                <li>{rich(a.step1, (s) => <strong className="text-on-surface">{s}</strong>)}</li>
                                <li>{a.step2}</li>
                                <li>{rich(a.step3)}</li>
                            </ol>

                            {connectSnippets(status?.executable ?? '', t).map((s2) => (
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
                                            title={a.copyTitle}
                                            className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name={copied === s2.agent ? 'check' : 'content_copy'} size={12} />
                                            {copied === s2.agent ? a.copied : a.copy}
                                        </button>
                                    </p>
                                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface-container-highest px-2 py-1 font-mono text-ui-10 text-on-surface">
                                        {s2.code}
                                    </pre>
                                    <p className="mt-1 text-ui-10 text-on-surface-variant/70">{rich(s2.note)}</p>
                                </div>
                            ))}

                            <p className="text-ui-10 leading-4 text-on-surface-variant/70">
                                {rich(a.copyNotWrite)}
                            </p>
                        </div>
                    )}
                </div>

                <div className="rounded border border-outline-variant bg-surface-container-low p-2">
                    <p className="mb-1 text-ui-10 font-medium uppercase tracking-wider text-on-surface-variant">
                        {a.recent}
                    </p>
                    {!status?.audit?.length ? (
                        <p className="text-ui-11 text-on-surface-variant">
                            {status?.enabled
                                ? a.noAccessYet
                                : a.serverOff}
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
                                    <span className="shrink-0 text-on-surface">{toolLabel(t, e.tool)}</span>
                                    {e.resource && (
                                        <span className="min-w-0 truncate font-mono text-on-surface-variant">
                                            {e.resource}
                                        </span>
                                    )}
                                    <span
                                        className="ml-auto shrink-0 text-on-surface-variant/70"
                                        title={formatDateTime(e.at)}
                                    >
                                        {formatDateTime(e.at, {hour: '2-digit', minute: '2-digit'})}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="mt-1 text-ui-10 leading-4 text-on-surface-variant/70">
                        {rich(a.auditNote)}
                    </p>
                </div>
            </div>
        </section>
    )
}
