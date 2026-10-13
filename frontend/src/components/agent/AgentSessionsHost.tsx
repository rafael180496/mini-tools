import {useEffect, useMemo} from 'react'
import {CancelAgentChat, RespondAgentApproval} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'
import AgentApprovalDialog, {isRiskyApproval, type ApprovalRequest} from './AgentApprovalDialog'
import {canonicalToolName} from './ToolCallCard'
import {requestOpenAiChat, requestShowAiSessions} from '../../lib/appBus'
import {
    dismissToast,
    removeApproval,
    reviewApproval,
    startAgentSessions,
    useAgentSessions,
    usePendingApprovals,
    useReviewingApproval,
    useSessionToasts,
    useVisibleChats,
    type SessionToast,
} from '../../lib/agentSessions'
import {useT} from '../../i18n'

// El anfitrión único de los permisos y avisos de las sesiones de IA.
//
// Vive una sola vez, en el workspace, y por eso un permiso ya no depende de que
// haya un chat montado: antes lo atendía cada `AgentChat` visible y, si no había
// ninguno (la pestaña cerrada, otro módulo a la vista), la petición se perdía y
// el agente quedaba bloqueado hasta el plazo de 5 minutos.
//
// **Cómo se presenta un permiso**, según de quién sea:
//
//   - de la conversación que tenés delante (o sin dueño conocido): el diálogo de
//     siempre, en el acto. Es la respuesta a lo que acabás de pedir.
//   - de otra conversación: un aviso discreto en la esquina, NO un modal. Un
//     diálogo que aparece de golpe mientras escribís otra cosa se contesta sin
//     leerlo, y esto es una autorización. «Revisar» abre el mismo diálogo con
//     el rótulo de la conversación que lo pide y la opción de ir a verla.
//
// Contestar es una sola vez por permiso (el botón quita la petición de la cola
// antes de salir), y cerrar es denegar: del otro lado hay un proceso bloqueado.
//
// Además avisa de las conversaciones que terminan o fallan sin que las estés
// mirando. No usa la barra de estado del pie porque ésa muestra UN texto que no
// se borra solo y sólo en algunas pestañas.

const TOAST_MS = 10_000
const TOAST_ERROR_MS = 16_000
// El aviso de «sigue en segundo plano» trae dos botones y una frase larga.
const TOAST_BACKGROUND_MS = 14_000
const MAX_APPROVAL_CARDS = 3

export default function AgentSessionsHost() {
    const t = useT()
    const th = t.aiSessions.toast
    const approvals = usePendingApprovals()
    const toasts = useSessionToasts()
    const reviewing = useReviewingApproval()
    const visible = useVisibleChats()
    const sessions = useAgentSessions()

    useEffect(() => startAgentSessions(), [])

    // Un permiso se muestra en el acto si no se sabe de quién es o si su chat
    // está a la vista.
    const inContext = (r: ApprovalRequest) => !r.sessionId || visible.has(r.sessionId)
    const current = useMemo(
        () => approvals.find(inContext) ?? approvals.find((r) => r.id === reviewing) ?? null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [approvals, reviewing, visible],
    )
    const cards = approvals.filter((r) => r.id !== current?.id && !inContext(r))
    const queued = current ? approvals.length - 1 : 0

    const answer = (req: ApprovalRequest, allow: boolean) => {
        // Se quita de la cola ANTES de mandar: un doble clic no manda dos
        // veredictos contradictorios a un proceso que está esperando uno solo.
        removeApproval(req.id)
        void RespondAgentApproval(req.id, allow, allow ? '' : t.agent.approvalDeniedReason).catch(() => {})
    }

    const labelOf = (r: ApprovalRequest) => r.agentLabel || sessions.find((s) => s.sessionId === r.sessionId)?.agentId || ''

    return (
        <>
            {current && (
                <AgentApprovalDialog
                    request={current}
                    agentLabel={labelOf(current)}
                    queued={queued}
                    onOpenConversation={
                        inContext(current) || !current.sessionId ? undefined : () => requestOpenAiChat({chatId: chatIdOf(sessions, current.sessionId!)})
                    }
                    onAllow={() => answer(current, true)}
                    onDeny={() => answer(current, false)}
                />
            )}

            {(cards.length > 0 || toasts.length > 0) && (
                <div
                    role="region"
                    aria-label={th.region}
                    aria-live="polite"
                    className="pointer-events-none fixed right-4 top-12 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
                >
                    {cards.slice(0, MAX_APPROVAL_CARDS).map((r) => (
                        <ApprovalCard
                            key={r.id}
                            req={r}
                            onReview={() => reviewApproval(r.id)}
                            onOpen={() => r.sessionId && requestOpenAiChat({chatId: chatIdOf(sessions, r.sessionId)})}
                        />
                    ))}
                    {toasts.map((x) => (
                        <ToastCard key={x.id} toast={x} onOpen={() => requestOpenAiChat({chatId: chatIdOf(sessions, x.sessionId)})} />
                    ))}
                </div>
            )}
        </>
    )
}

// El id de historial de una sesión: coincide con el id de sesión salvo que el
// backend informe otro.
function chatIdOf(sessions: ReturnType<typeof useAgentSessions>, sessionId: string): string {
    const s = sessions.find((x) => x.sessionId === sessionId)
    return s?.chatId || sessionId
}

const CARD = 'pointer-events-auto flex gap-2 rounded-xl border bg-surface-container-high p-3 text-on-surface shadow-lg'
const BTN =
    'rounded-lg px-2 py-1 text-ui-11 font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

function ApprovalCard({req, onReview, onOpen}: {req: ApprovalRequest; onReview: () => void; onOpen: () => void}) {
    const t = useT()
    const th = t.aiSessions.toast
    const risky = isRiskyApproval(req)
    return (
        <div data-approval-card data-risky={risky ? '' : undefined} className={`${CARD} ${risky ? 'border-error' : 'border-tertiary/60'}`}>
            <Icon name={risky ? 'gpp_maybe' : 'lock_open'} size={18} className={`mt-0.5 shrink-0 ${risky ? 'text-error' : 'text-tertiary'}`} />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">{th.approval}</p>
                <p className="truncate text-ui-11 text-on-surface" title={req.title}>
                    {req.title || t.aiSessions.sidebar.untitled}
                </p>
                <p className="line-clamp-2 break-words text-ui-11 text-on-surface-variant">
                    {req.summary || th.approvalText({tool: canonicalToolName(req.tool)})}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={onReview}
                        title={th.reviewTitle}
                        className={`${BTN} ${risky ? 'bg-error text-on-error' : 'bg-primary text-on-primary'} hover:opacity-90`}
                    >
                        {th.review}
                    </button>
                    <button type="button" onClick={onOpen} title={th.openTitle} className={`${BTN} text-primary hover:bg-primary/10`}>
                        {th.open}
                    </button>
                </div>
            </div>
        </div>
    )
}

function ToastCard({toast, onOpen}: {toast: SessionToast; onOpen: () => void}) {
    const t = useT()
    const th = t.aiSessions.toast
    const failed = toast.kind === 'error'
    const background = toast.kind === 'background'

    useEffect(() => {
        const timer = window.setTimeout(() => dismissToast(toast.id), failed ? TOAST_ERROR_MS : background ? TOAST_BACKGROUND_MS : TOAST_MS)
        return () => window.clearTimeout(timer)
    }, [toast.id, failed, background])

    if (background) {
        const title = toast.title || t.aiSessions.sidebar.untitled
        return (
            <div data-session-toast="background" className={`${CARD} border-primary/50`}>
                <Icon name="sync" size={18} className="mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">{th.backgroundTitle}</p>
                    <p className="break-words text-ui-11 text-on-surface-variant">{th.background({title})}</p>
                    <div className="mt-2 flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => {
                                requestShowAiSessions({sessionId: toast.sessionId})
                                dismissToast(toast.id)
                            }}
                            title={th.seeTitle}
                            className={`${BTN} bg-primary text-on-primary hover:opacity-90`}
                        >
                            {th.see}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void CancelAgentChat(toast.sessionId).catch(() => {})
                                dismissToast(toast.id)
                            }}
                            title={th.stopTitle}
                            className={`${BTN} text-error hover:bg-error/10`}
                        >
                            {th.stop}
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => dismissToast(toast.id)}
                    title={th.close}
                    aria-label={th.close}
                    className="h-fit shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
                >
                    <Icon name="close" size={14} />
                </button>
            </div>
        )
    }

    return (
        <div data-session-toast={toast.kind} className={`${CARD} ${failed ? 'border-error/60' : 'border-secondary/50'}`}>
            <Icon name={failed ? 'error' : 'check_circle'} size={18} filled className={`mt-0.5 shrink-0 ${failed ? 'text-error' : 'text-secondary'}`} />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">{failed ? th.error : th.done}</p>
                <p className="truncate text-ui-11 text-on-surface" title={toast.title}>
                    {toast.title || t.aiSessions.sidebar.untitled}
                </p>
                {toast.text && <p className="line-clamp-2 break-words text-ui-11 text-on-surface-variant">{toast.text}</p>}
                <div className="mt-2 flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => {
                            onOpen()
                            dismissToast(toast.id)
                        }}
                        title={th.openTitle}
                        className={`${BTN} bg-primary text-on-primary hover:opacity-90`}
                    >
                        {th.open}
                    </button>
                </div>
            </div>
            <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                title={th.close}
                aria-label={th.close}
                className="h-fit shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
            >
                <Icon name="close" size={14} />
            </button>
        </div>
    )
}
