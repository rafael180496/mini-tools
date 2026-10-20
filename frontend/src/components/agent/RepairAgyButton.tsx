import {useState} from 'react'
import {RepairAntigravityPermissions} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'
import {useT} from '../../i18n'

// «Reparar permisos» bajo la nota de un rechazo de Antigravity. El backend
// marca esa nota con Event.Action = "repair-agy-perms" (agentchat.
// ActionRepairAgyPerms): el chat no la reconoce leyendo el texto, que va en el
// idioma de la interfaz. Reparar vuelve a aprobar las herramientas de mini-tools
// en el settings.json de Antigravity; reintentar el mensaje lo decide la
// persona, no se reenvía solo.
export default function RepairAgyButton() {
    const r = useT().agent.chat.repairAgy
    const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
    const [note, setNote] = useState('')
    const [failed, setFailed] = useState(false)

    const repair = () => {
        setState('busy')
        setNote('')
        setFailed(false)
        RepairAntigravityPermissions()
            .then((p) => {
                setNote(r.done({n: p.approved}))
                setState('done')
            })
            .catch((e) => {
                setNote(r.failed({error: String(e)}))
                setFailed(true)
                setState('idle')
            })
    }

    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-ui-11" data-repair-agy>
            <button
                onClick={repair}
                disabled={state !== 'idle'}
                title={state === 'busy' ? r.busyTitle : r.title}
                className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5 font-medium text-on-secondary hover:opacity-90 disabled:opacity-40"
            >
                {state === 'busy' ? (
                    <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-on-secondary" />
                ) : (
                    <Icon name="build" size={12} />
                )}
                {state === 'busy' ? r.busy : r.button}
            </button>
            {note && <span className={`min-w-0 break-words ${failed ? 'text-error' : 'text-on-surface-variant'}`}>{note}</span>}
        </div>
    )
}
