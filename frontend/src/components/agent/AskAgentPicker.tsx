import {useEffect, useState} from 'react'
import {AgentAskAgents} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'

// Con qué proveedor se hace este análisis puntual.
//
// **Por qué se elige acá y no solo en la barra de agente.** Un análisis de una
// tirada —"explicá este plan", "qué falló en esta terminal"— es justo donde
// tiene sentido pedir una segunda opinión: si la respuesta de uno no convence,
// lo que uno quiere es preguntarle a otro modelo lo MISMO, no cambiar de
// proveedor en toda la aplicación y acordarse de volverlo atrás después.
//
// Elegir acá **no cambia el agente activo**. Es una decisión para esta
// consulta, y termina con ella.
//
// La lista viene filtrada del backend (`AgentAskAgents`): solo los instalados
// y con adaptador verificado. Si queda uno solo, no se dibuja nada — un
// selector con una sola opción es ruido.

interface Props {
    value: string
    onChange: (agentID: string) => void
    disabled?: boolean
}

export default function AskAgentPicker({value, onChange, disabled}: Props) {
    const [agents, setAgents] = useState<main.AskAgent[]>([])

    useEffect(() => {
        AgentAskAgents()
            .then((list) => setAgents(list ?? []))
            .catch(() => setAgents([]))
    }, [])

    if (agents.length < 2) return null

    return (
        <select
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            title="Con qué proveedor se hace ESTE análisis. No cambia el agente activo de la aplicación: sirve para pedirle la misma pregunta a otro modelo y comparar."
            className="rounded-md border border-outline-variant bg-surface px-1.5 py-1 text-ui-11 text-on-surface-variant hover:text-on-surface disabled:opacity-50"
        >
            <option value="">
                {agents.find((a) => a.active)?.label
                    ? `${agents.find((a) => a.active)?.label} (activo)`
                    : 'Agente activo'}
            </option>
            {agents
                .filter((a) => !a.active)
                .map((a) => (
                    <option key={a.id} value={a.id}>
                        {a.label}
                    </option>
                ))}
        </select>
    )
}
