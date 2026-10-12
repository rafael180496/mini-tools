import {forwardRef, useState, type ReactNode} from 'react'
import Icon from './Icon'
import {useT} from '../i18n'

// Guía «Cómo exponer Ollama en la otra máquina».
//
// Existe por un fallo real: Ollama escucha por defecto solo en localhost, y una
// máquina en la red recibe «conexión rechazada» aunque el servicio esté en
// marcha. `lsof -i :11434` mostraba `localhost:11434` en lugar de `*:11434`. La
// guía lleva a quien lo configura de ese diagnóstico a una conexión que
// funciona, con cada comando listo para copiar y con el puerto que escribió en
// el formulario (el puerto de Ollama se puede cambiar).
//
// Los COMANDOS no se traducen: son lo que se pega en una terminal. Lo que los
// rodea sale del diccionario (`settings.modelServers.guide`).

type Os = 'mac' | 'terminal' | 'linux' | 'windows'
const OS_LIST: Os[] = ['mac', 'terminal', 'linux', 'windows']

interface Props {
    open: boolean
    onToggle: () => void
    // Puerto y host del formulario; el host puede estar vacío todavía.
    port: string
    host: string
}

// Comando de una línea (o bloque) con su botón de copiar.
function CommandRow({cmd, block}: {cmd: string; block?: boolean}) {
    const t = useT()
    const g = t.settings.modelServers.guide
    const [copied, setCopied] = useState(false)
    const copy = () => {
        void navigator.clipboard
            .writeText(cmd)
            .then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => {})
    }
    return (
        <div data-guide-command className="flex items-start gap-1 rounded-md border border-outline-variant bg-surface px-2 py-1">
            {block ? (
                <pre className="min-w-0 flex-1 select-all overflow-x-auto whitespace-pre font-mono text-ui-11 text-on-surface">{cmd}</pre>
            ) : (
                <code className="min-w-0 flex-1 select-all break-all font-mono text-ui-11 text-on-surface">{cmd}</code>
            )}
            <button
                type="button"
                onClick={copy}
                title={copied ? g.copied : g.copyTitle}
                aria-label={g.copy}
                className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
                <Icon name={copied ? 'check' : 'content_copy'} size={13} className={copied ? 'text-secondary' : ''} />
            </button>
        </div>
    )
}

function Step({n, title, children}: {n: number; title: string; children: ReactNode}) {
    return (
        <li className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-xs font-medium text-on-surface">
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-ui-10 text-primary">{n}</span>
                {title}
            </p>
            <div className="flex flex-col gap-1 pl-5">{children}</div>
        </li>
    )
}

const OllamaExposeGuide = forwardRef<HTMLDivElement, Props>(function OllamaExposeGuide({open, onToggle, port, host}, ref) {
    const t = useT()
    const g = t.settings.modelServers.guide
    const [os, setOs] = useState<Os>('mac')
    const bind = `0.0.0.0:${port}`
    const target = host.trim() !== '' ? host.trim() : g.hostPlaceholder

    const osLabel: Record<Os, string> = {mac: g.osMac, terminal: g.osTerminal, linux: g.osLinux, windows: g.osWindows}
    const osTitle: Record<Os, string> = {mac: g.osMacTitle, terminal: g.osTerminalTitle, linux: g.osLinuxTitle, windows: g.osWindowsTitle}

    return (
        <div ref={ref} data-ollama-guide className="rounded-md border border-tertiary/40 bg-tertiary/10">
            <button
                type="button"
                data-ollama-guide-toggle
                onClick={onToggle}
                aria-expanded={open}
                title={open ? g.toggleHideTitle : g.toggleShowTitle}
                className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium text-on-surface"
            >
                <Icon name="lightbulb" size={14} className="shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1">{g.title}</span>
                <Icon name={open ? 'expand_less' : 'expand_more'} size={16} className="shrink-0 text-on-surface-variant" />
            </button>

            {open && (
                <div className="flex flex-col gap-2.5 border-t border-tertiary/30 px-2.5 py-2.5 text-ui-11 text-on-surface-variant">
                    <p>{g.intro}</p>

                    <ol className="flex flex-col gap-3">
                        <Step n={1} title={g.diagnoseTitle}>
                            <p>{g.diagnoseText({port})}</p>
                            <CommandRow cmd={`lsof -i :${port}`} />
                        </Step>

                        <Step n={2} title={g.listenTitle}>
                            <div role="tablist" aria-label={g.osLabel} className="flex flex-wrap gap-1">
                                {OS_LIST.map((o) => (
                                    <button
                                        key={o}
                                        type="button"
                                        role="tab"
                                        aria-selected={os === o}
                                        data-guide-os={o}
                                        onClick={() => setOs(o)}
                                        title={osTitle[o]}
                                        className={`rounded-full border px-2 py-0.5 text-ui-11 ${
                                            os === o
                                                ? 'border-primary bg-primary/15 text-primary'
                                                : 'border-outline-variant text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                        }`}
                                    >
                                        {osLabel[o]}
                                    </button>
                                ))}
                            </div>

                            {os === 'mac' && (
                                <>
                                    <p>{g.macSet}</p>
                                    <CommandRow cmd={`launchctl setenv OLLAMA_HOST "${bind}"`} />
                                    <p>{g.macRestart}</p>
                                    <p className="flex items-start gap-1 text-ui-10 text-on-surface-variant/80">
                                        <Icon name="info" size={12} className="mt-px shrink-0" />
                                        {g.macReboot}
                                    </p>
                                </>
                            )}
                            {os === 'terminal' && (
                                <>
                                    <p>{g.terminalText}</p>
                                    <CommandRow cmd={`OLLAMA_HOST=${bind} ollama serve`} />
                                </>
                            )}
                            {os === 'linux' && (
                                <>
                                    <p>{g.linuxEdit}</p>
                                    <CommandRow cmd="sudo systemctl edit ollama.service" />
                                    <p>{g.linuxAdd}</p>
                                    <CommandRow block cmd={`[Service]\nEnvironment="OLLAMA_HOST=${bind}"`} />
                                    <p>{g.linuxRestart}</p>
                                    <CommandRow cmd="sudo systemctl daemon-reload && sudo systemctl restart ollama" />
                                </>
                            )}
                            {os === 'windows' && (
                                <>
                                    <p>{g.windowsSet}</p>
                                    <CommandRow cmd={`setx OLLAMA_HOST "${bind}"`} />
                                    <p>{g.windowsRestart}</p>
                                </>
                            )}
                        </Step>

                        <Step n={3} title={g.ipTitle}>
                            <p>{g.ipText}</p>
                            <p className="text-ui-10 font-medium text-on-surface">{g.osMacShort}</p>
                            <CommandRow cmd="ipconfig getifaddr en0" />
                            <p className="text-ui-10 font-medium text-on-surface">{g.osLinuxShort}</p>
                            <CommandRow cmd="hostname -I" />
                            <p className="text-ui-10 font-medium text-on-surface">{g.osWindowsShort}</p>
                            <CommandRow cmd="ipconfig" />
                            <p className="text-ui-10 text-on-surface-variant/80">{g.ipWindowsNote}</p>
                        </Step>

                        <Step n={4} title={g.firewallTitle}>
                            <p>{g.firewallText({port})}</p>
                        </Step>

                        <Step n={5} title={g.verifyTitle}>
                            <p>{g.verifyText}</p>
                            <CommandRow cmd={`curl http://${target}:${port}/api/version`} />
                        </Step>
                    </ol>

                    <p className="flex items-start gap-1.5 rounded bg-error-container/30 px-2 py-1.5 text-error">
                        <Icon name="warning" size={14} className="mt-px shrink-0" />
                        <span className="text-on-surface-variant">
                            <strong className="font-medium text-error">{g.securityTitle}</strong> {g.securityText}
                        </span>
                    </p>
                </div>
            )}
        </div>
    )
})

export default OllamaExposeGuide
