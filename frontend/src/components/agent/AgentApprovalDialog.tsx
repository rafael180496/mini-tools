import {useEffect, useRef} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {canonicalToolName, toolIcon} from './ToolCallCard'

// Espeja agentapprove.Request: la acción que el agente quiere hacer y sobre la
// que hay que decidir. Viaja por evento, así que se escribe a mano igual que
// ChatEvent.
export interface ApprovalRequest {
    id: string
    tool: string
    input: string
    summary: string
    detail: string
}

// Un comando de riesgo (rm -rf, git push --force, sudo…) llega con el detalle
// «⚠ Comando de riesgo: <motivo>» / «⚠ Risky command: <motivo>». Se reconoce
// por el ⚠ y no por el texto, que cambia con el idioma de la interfaz.
export function isRiskyApproval(req: ApprovalRequest): boolean {
    return req.detail.trimStart().startsWith('⚠')
}

// El motivo es lo que sigue a «⚠ Comando de riesgo:». Sin los dos puntos, todo
// lo que viene después del ⚠.
function riskReason(detail: string): string {
    const body = detail.trimStart().replace(/^⚠\s*/, '')
    const colon = body.indexOf(':')
    return (colon >= 0 ? body.slice(colon + 1) : body).trim()
}

interface Props {
    request: ApprovalRequest
    agentLabel: string
    onAllow: () => void
    // Cerrar es DENEGAR: del otro lado hay un proceso bloqueado esperando.
    onDeny: () => void
}

// Diálogo de aprobación de una acción del agente.
//
// Reemplaza al ConfirmDialog genérico para este caso porque lo que se decide es
// una ACCIÓN concreta y el diálogo tiene que mostrarla entera: el comando en
// monoespaciada y sin truncar, no metido en una frase. Y porque un comando de
// riesgo no puede verse igual que una lectura: banner y botón de peligro, y el
// foco empieza en «Denegar» para que un Enter distraído no lo autorice.
export default function AgentApprovalDialog({request, agentLabel, onAllow, onDeny}: Props) {
    const t = useT()
    const a = t.agent.chat.approval
    const risky = isRiskyApproval(request)
    const tool = canonicalToolName(request.tool)
    const denyRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (risky) denyRef.current?.focus()
    }, [risky])

    // Esc deniega: es la salida segura, la misma que cerrar el diálogo.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onDeny()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onDeny])

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" role="presentation">
            <div
                role="alertdialog"
                aria-modal="true"
                aria-label={a.title({tool})}
                data-approval-dialog
                data-risky={risky ? '' : undefined}
                className={`flex w-[26rem] max-w-[92vw] flex-col gap-3 rounded-xl border bg-surface-container-high p-5 text-on-surface shadow-lg ${
                    risky ? 'border-error' : 'border-outline-variant'
                }`}
            >
                <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Icon name={risky ? 'warning' : toolIcon(request.tool)} size={18} className={risky ? 'text-error' : 'text-primary'} />
                    {risky ? a.titleRisky({tool}) : a.title({tool})}
                </h2>

                {risky && (
                    <div className="flex items-start gap-2 rounded-lg border border-error/50 bg-error-container/40 px-2.5 py-2 text-xs font-medium text-on-error-container">
                        <Icon name="gpp_maybe" size={16} className="mt-px shrink-0 text-error" />
                        <span className="min-w-0 flex-1 break-words">{a.riskyReason({reason: riskReason(request.detail)})}</span>
                    </div>
                )}

                <p className="text-xs text-on-surface-variant">{a.intro({agent: agentLabel, tool})}</p>

                {request.summary && (
                    <pre
                        className={`max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-2.5 py-2 font-mono text-ui-11 ${
                            risky ? 'border-error/40 bg-error-container/20 text-on-surface' : 'border-outline-variant bg-surface-container-lowest text-on-surface'
                        }`}
                    >
                        {tool === 'run_command' ? `$ ${request.summary}` : request.summary}
                    </pre>
                )}

                {request.detail && !risky && <p className="text-xs text-on-surface-variant">{request.detail}</p>}

                <p className="text-ui-11 text-on-surface-variant/80">{risky ? a.riskyHint : a.waiting}</p>

                <div className="mt-1 flex justify-end gap-2">
                    <button
                        ref={denyRef}
                        type="button"
                        onClick={onDeny}
                        title={a.denyTitle}
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                    >
                        {a.deny}
                    </button>
                    <button
                        type="button"
                        onClick={onAllow}
                        title={risky ? a.allowRiskyTitle : a.allowTitle}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary ${
                            risky ? 'bg-error text-on-error' : 'bg-primary text-on-primary'
                        }`}
                    >
                        {risky ? a.allowRisky : a.allow}
                    </button>
                </div>
            </div>
        </div>
    )
}
