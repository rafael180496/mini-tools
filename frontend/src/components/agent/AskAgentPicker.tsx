import {useEffect, useState} from 'react'
import {AgentAskAgents} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import Select from '../Select'

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
        <Select
            value={value}
            disabled={disabled}
            onChange={onChange}
            title="Con qué proveedor se hace ESTE análisis. No cambia el agente activo de la aplicación: sirve para pedirle la misma pregunta a otro modelo y comparar."
            size="sm"
            leadingIcon="auto_awesome"
            menuMinWidth={200}
            className="max-w-48 min-w-0 rounded-md"
            options={[
                {
                    value: '',
                    label: agents.find((a) => a.active)?.label ?? 'Agente activo',
                    hint: 'activo',
                },
                ...agents.filter((a) => !a.active).map((a) => ({value: a.id, label: a.label})),
            ]}
        />
    )
}
