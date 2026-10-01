import {useEffect, useMemo} from 'react'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import TreeRow from '../sidebar/TreeRow'
import {useT} from '../../i18n'
import {UTILITIES, type UtilityId} from './utilities'

interface UtilitiesTreeProps {
    // Herramientas que ya tienen una pestaña abierta. Se marcan: abrir una que
    // ya está abierta no crea otra, lleva a la que existe, y la marca dice de
    // antemano que eso es lo que va a pasar.
    openIds: Set<UtilityId>
    onOpen: (id: UtilityId) => void
    // Búsqueda global de la barra: filtra por nombre y por descripción.
    filter: string
    onMatchCount: (n: number | null) => void
}

// El cuerpo del módulo Utilidades: la lista de herramientas.
//
// Es una lista plana y no un árbol con carpetas: son pocas, cada una es un
// programa chico, y agruparlas hoy sería inventar una jerarquía que no existe.
// Usa la misma fila que los otros módulos para que se lea igual.
export default function UtilitiesTree({openIds, onOpen, filter, onMatchCount}: UtilitiesTreeProps) {
    const t = useT()
    const query = filter.trim().toLowerCase()

    const visible = useMemo(
        () =>
            UTILITIES.filter((u) => {
                if (!query) return true
                const tool = t.utilities.tools[u.id]
                return tool.name.toLowerCase().includes(query) || tool.hint.toLowerCase().includes(query)
            }),
        [query, t],
    )

    // Con una búsqueda activa, cuántas coinciden; sin ella, null: un "5"
    // permanente sobre el ícono sería ruido, no información.
    useEffect(() => {
        onMatchCount(query ? visible.length : null)
    }, [query, visible.length, onMatchCount])

    return (
        <SidebarSection title={t.utilities.sidebar.title} count={query ? `${visible.length}/${UTILITIES.length}` : String(UTILITIES.length)}>
            {visible.length === 0 ? (
                <p className="px-3 py-2 text-xs text-on-surface-variant">{t.sidebar.folders.noMatchesFor({query: filter.trim()})}</p>
            ) : (
                visible.map((u) => {
                    const tool = t.utilities.tools[u.id]
                    const open = openIds.has(u.id)
                    return (
                        <TreeRow
                            key={u.id}
                            depth={0}
                            icon={u.icon}
                            label={tool.name}
                            title={`${t.utilities.sidebar.openTool({name: tool.name})} — ${tool.hint}`}
                            onClick={() => onOpen(u.id)}
                            trailing={
                                open ? (
                                    <span title={t.utilities.sidebar.alreadyOpen} className="flex items-center text-primary">
                                        <Icon name="fiber_manual_record" size={8} filled />
                                    </span>
                                ) : undefined
                            }
                        />
                    )
                })
            )}
        </SidebarSection>
    )
}
