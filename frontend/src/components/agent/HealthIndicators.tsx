import {useState} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'
import type {Dict} from '../../i18n'
import type {Health} from '../../lib/modelServerHealth'

// Cómo se dibuja la salud de un servidor de modelos (ver lib/modelServerHealth).
//
//   HealthDot     el punto: verde responde, rojo no responde, gris sin dato o
//                 comprobando (late). Va sobre el ícono del proveedor en los
//                 selectores y suelto en la lista de Configuración.
//   HealthBadge   punto + latencia o «sin respuesta», para la cabecera del Chat
//                 de IA, que tiene lugar.
//   HealthBanner  el aviso sobre la caja del chat cuando el servidor no
//                 contesta. No bloquea escribir: enviar falla enseguida solo.
//
// El color nunca es lo único que informa: el punto lleva `aria-label` y un
// `title` con el detalle (latencia y antigüedad, o el error completo).

const DOT_COLOR: Record<Health['status'], string> = {
    ok: 'bg-secondary',
    error: 'bg-error',
    checking: 'bg-outline animate-pulse',
    unknown: 'bg-outline/60',
}

export function statusLabel(t: Dict, status: Health['status']): string {
    const h = t.agent.health
    return status === 'ok' ? h.statusOk : status === 'error' ? h.statusError : status === 'checking' ? h.statusChecking : h.statusUnknown
}

// Texto completo de la salud: el del `title` del punto y de los selectores.
export function healthSummary(t: Dict, server: string, health: Health, now: number): string {
    const h = t.agent.health
    switch (health.status) {
        case 'ok':
            return h.dotOk({
                server,
                latency: health.latencyMs,
                ago: h.ago({sec: Math.max(0, Math.round((now - health.checkedAt) / 1000))}),
            })
        case 'error':
            return h.dotError({server, error: health.error})
        case 'checking':
            return h.dotChecking({server})
        default:
            return h.dotUnknown({server})
    }
}

interface DotProps {
    health: Health
    server: string
    // Pegado a la esquina inferior derecha de su contenedor `relative`, para
    // montarlo sobre un ícono sin cambiarle el ancho a la fila.
    overlay?: boolean
    className?: string
}

export function HealthDot({health, server, overlay, className}: DotProps) {
    const t = useT()
    // «Comprobado hace Xs» envejece: se recalcula al pasar el mouse, que es
    // cuando alguien lo lee, en vez de mantener un reloj por cada punto.
    const [now, setNow] = useState(() => Date.now())
    return (
        <span
            role="img"
            aria-label={`${server}: ${statusLabel(t, health.status)}`}
            data-health={health.status}
            title={healthSummary(t, server, health, now)}
            onMouseEnter={() => setNow(Date.now())}
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[health.status]} ${
                overlay ? 'absolute -right-0.5 -bottom-0.5 h-[7px] w-[7px] ring-2 ring-surface-container-highest' : ''
            } ${className ?? ''}`}
        />
    )
}

// El ícono del proveedor con el punto de salud encima. Es el `icon` de una
// opción de Select: en el disparador y en la fila del menú ocupa lo mismo que
// el ícono solo.
export function ProviderIconWithHealth({icon, health, server}: {icon: string; health: Health | null; server: string}) {
    return (
        <span className="relative inline-flex">
            <Icon name={icon} size={14} />
            {health && <HealthDot health={health} server={server} overlay />}
        </span>
    )
}

export function HealthBadge({health, server}: {health: Health; server: string}) {
    const t = useT()
    const h = t.agent.health
    const [now, setNow] = useState(() => Date.now())
    const text = health.status === 'ok' ? h.badgeOk({latency: health.latencyMs}) : health.status === 'error' ? h.badgeError : health.status === 'checking' ? h.badgeChecking : h.statusUnknown
    return (
        <span
            data-health-badge={health.status}
            title={healthSummary(t, server, health, now)}
            onMouseEnter={() => setNow(Date.now())}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-ui-11 ${
                health.status === 'error'
                    ? 'border-error/40 bg-error-container/30 text-error'
                    : 'border-outline-variant bg-surface-container-low text-on-surface-variant'
            }`}
        >
            <HealthDot health={health} server={server} />
            {text}
        </span>
    )
}

interface BannerProps {
    health: Health
    server: string
    onRetry: () => void
}

export function HealthBanner({health, server, onRetry}: BannerProps) {
    const t = useT()
    const h = t.agent.health
    const checking = health.status === 'checking'
    return (
        <div
            data-health-banner
            role="alert"
            className="flex shrink-0 items-start gap-2 border-t border-error/40 bg-error-container/30 px-2 py-1.5 text-ui-11 text-on-surface"
        >
            <Icon name="cloud_off" size={14} className="mt-px shrink-0 text-error" />
            <span className="min-w-0 flex-1">
                <span className="block font-medium text-error">{h.bannerTitle({server})}</span>
                <span className="block break-words">{health.error}</span>
                <span className="block text-on-surface-variant">{h.bannerHint}</span>
            </span>
            <button
                type="button"
                onClick={onRetry}
                disabled={checking}
                title={h.retryTitle}
                className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            >
                <Icon name="refresh" size={13} className={checking ? 'animate-spin' : ''} />
                {checking ? h.retrying : h.retry}
            </button>
        </div>
    )
}
