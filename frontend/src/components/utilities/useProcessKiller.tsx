import {useState, type ReactNode} from 'react'
import {KillProcess, KillProcessElevated} from '../../../wailsjs/go/main/App'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import {errorCode, errorText} from '../../i18n'

// El flujo de «terminar un proceso», compartido por el Port Killer y el
// Activity Monitor: confirmar, intentar con los permisos de la app y, solo si el
// sistema contesta «permiso denegado», ofrecer pedir los de administrador.
//
// Vive en un hook y no copiado en cada pantalla porque los pasos son los mismos
// y los errores que importan (permiso, ya no existe, rechazó el UAC) también: si
// uno de los dos lo arreglaba y el otro no, el mismo proceso se comportaba
// distinto según desde dónde se lo cerrara. Lo único que cambia entre pantallas
// son los textos, que llegan por parámetro.

export interface KillTarget {
    process: string
    pid: number
    // Solo el Port Killer sabe qué puerto libera.
    port?: number
}

export interface KillTexts {
    terminateTitle: string
    terminateDescription: (t: KillTarget) => string
    terminateAction: string
    forceTitle: string
    forceDescription: (t: KillTarget) => string
    forceAction: string
    elevateTitle: string
    elevateDescription: (t: KillTarget) => string
    elevateAction: string
    ended: (t: KillTarget) => string
    stillRunning: (t: KillTarget) => string
    gone: string
    denied: string
    failed: (error: string) => string
}

export type Notice = {tone: 'ok' | 'warn' | 'error'; text: string}

// Qué se está por confirmar. `elevated` distingue el segundo paso.
type Pending = {target: KillTarget; force: boolean; elevated: boolean}

export function useProcessKiller(texts: KillTexts, onSettled: () => void) {
    const [pending, setPending] = useState<Pending | null>(null)
    const [notice, setNotice] = useState<Notice | null>(null)
    const [busyPid, setBusyPid] = useState<number | null>(null)

    async function run(p: Pending) {
        const {target, force, elevated} = p
        setBusyPid(target.pid)
        setNotice(null)
        try {
            const exited = elevated ? await KillProcessElevated(target.pid, force) : await KillProcess(target.pid, force)
            setNotice(exited ? {tone: 'ok', text: texts.ended(target)} : {tone: 'warn', text: texts.stillRunning(target)})
        } catch (e) {
            const code = errorCode(e)
            if (code === 'permission' && !elevated) {
                // No es un error que el usuario pueda arreglar con otro
                // intento: se pasa a la confirmación de administrador.
                setPending({target, force, elevated: true})
            } else if (code === 'not-found') {
                setNotice({tone: 'warn', text: texts.gone})
            } else if (code === 'elevation-denied') {
                setNotice({tone: 'warn', text: texts.denied})
            } else {
                setNotice({tone: 'error', text: texts.failed(errorText(e))})
            }
        } finally {
            setBusyPid(null)
            onSettled()
        }
    }

    const dialog = pending ? (
        <ConfirmDialog
            title={pending.elevated ? texts.elevateTitle : pending.force ? texts.forceTitle : texts.terminateTitle}
            description={(pending.elevated
                ? texts.elevateDescription
                : pending.force
                  ? texts.forceDescription
                  : texts.terminateDescription)(pending.target)}
            confirmLabel={pending.elevated ? texts.elevateAction : pending.force ? texts.forceAction : texts.terminateAction}
            danger
            // ConfirmDialog llama onConfirm y enseguida onClose: `run` toma el
            // pendiente por valor, así que cerrar no lo pisa; y si hace falta
            // pasar al paso de administrador, lo vuelve a abrir más tarde.
            onConfirm={() => void run(pending)}
            onClose={() => setPending(null)}
        />
    ) : null

    return {
        request: (target: KillTarget, force: boolean) => setPending({target, force, elevated: false}),
        busyPid,
        notice,
        dismiss: () => setNotice(null),
        dialog,
    }
}

const NOTICE_CLASS = {
    ok: 'border-primary/40 bg-primary-container/40 text-on-primary-container',
    warn: 'border-tertiary/40 bg-tertiary-container/40 text-on-tertiary-container',
    error: 'border-error/40 bg-error-container/40 text-on-error-container',
}
const NOTICE_ICON = {ok: 'check_circle', warn: 'info', error: 'error'}

// La franja con el resultado del último intento.
export function NoticeBar({notice, onDismiss, dismissLabel}: {notice: Notice | null; onDismiss: () => void; dismissLabel: string}): ReactNode {
    if (!notice) return null
    return (
        <div role="status" className={`flex shrink-0 items-start gap-2 border-b px-4 py-2 text-xs ${NOTICE_CLASS[notice.tone]}`}>
            <Icon name={NOTICE_ICON[notice.tone]} size={14} className="mt-px shrink-0" filled />
            <span className="min-w-0 flex-1">{notice.text}</span>
            <button onClick={onDismiss} title={dismissLabel} className="shrink-0 opacity-70 hover:opacity-100">
                <Icon name="close" size={14} />
            </button>
        </div>
    )
}
