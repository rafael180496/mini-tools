import {useState} from 'react'
import type {agents as agentsModel} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import Select from '../../Select'
import {agentIconName} from '../../agent/agentIcon'
import {useT} from '../../../i18n'

// Las dos franjas del Chat de IA para cambiar de proveedor SIN perder el hilo
// (solo entre proveedores de modelos: el hilo de un CLI es del propio CLI).
//
//   LostProviderBar   la conversación es de un proveedor que ya no está
//                     (apagado o eliminado). Se ve lo que se habló, la caja
//                     no manda nada, y esta franja ofrece «Continuar con otro
//                     proveedor»: elegir uno disponible y seguir ahí.
//   SwitchedBar       aviso, una vez hecho el cambio, de qué pasó y qué NO pasó:
//                     lo anterior viaja como contexto, pero el modelo nuevo no
//                     "recuerda" nada por sí mismo.

interface LostProps {
    // Nombre con que se muestra el proveedor perdido (con «desactivado» si sigue guardado).
    label: string
    // Sigue guardado pero apagado: se puede volver a encender en vez de cambiar.
    disabled: boolean
    // Proveedores de modelos disponibles para seguir.
    options: agentsModel.Agent[]
    onContinue: (agentId: string) => void
    onAdd: () => void
}

export function LostProviderBar({label, disabled, options, onContinue, onAdd}: LostProps) {
    const t = useT()
    const L = t.utilities.aiChat.lost
    const [pick, setPick] = useState('')
    const chosen = options.find((o) => o.id === pick) ?? options[0]
    return (
        <div data-lost-provider role="region" aria-label={L.title} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-tertiary/40 bg-tertiary/10 px-3 py-2 text-xs">
            <Icon name="link_off" size={16} className="shrink-0 text-tertiary" />
            <span className="min-w-0 flex-1 basis-64 text-on-surface-variant">
                <span className="font-medium text-on-surface">{disabled ? L.titleDisabled({name: label}) : L.titleRemoved} </span>
                {L.body}
            </span>
            {chosen ? (
                <span className="flex shrink-0 items-center gap-2">
                    <Select
                        value={chosen.id}
                        onChange={setPick}
                        size="sm"
                        ariaLabel={L.pickLabel}
                        title={L.pickTitle}
                        menuMinWidth={240}
                        className="max-w-56 min-w-0 rounded-lg"
                        options={options.map((o) => ({value: o.id, label: o.label, hint: o.vendor || undefined, icon: <Icon name={agentIconName(o.id)} size={14} />}))}
                    />
                    <button
                        type="button"
                        data-continue-with-another
                        onClick={() => onContinue(chosen.id)}
                        title={L.continueTitle({agent: chosen.label})}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                        <Icon name="switch_access_shortcut" size={14} />
                        {L.continue}
                    </button>
                </span>
            ) : (
                <button
                    type="button"
                    onClick={onAdd}
                    title={L.addTitle}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                >
                    <Icon name="add" size={14} />
                    {L.add}
                </button>
            )}
        </div>
    )
}

interface SwitchedProps {
    from: string
    to: string
    onDismiss: () => void
}

export function SwitchedBar({from, to, onDismiss}: SwitchedProps) {
    const t = useT()
    const L = t.utilities.aiChat.switched
    return (
        <div data-provider-switched role="status" className="flex shrink-0 items-start gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-ui-11 text-on-surface-variant">
            <Icon name="swap_horiz" size={14} className="mt-px shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
                <span className="font-medium text-on-surface">{L.title({from, to})} </span>
                {L.body}
            </span>
            <button type="button" onClick={onDismiss} title={L.dismissTitle} aria-label={L.dismissTitle} className="shrink-0 rounded p-0.5 hover:bg-surface-variant">
                <Icon name="close" size={13} />
            </button>
        </div>
    )
}
