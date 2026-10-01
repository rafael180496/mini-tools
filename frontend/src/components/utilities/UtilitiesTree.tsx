import {useEffect, useMemo, useState} from 'react'
import type {dockerctl} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import TreeRow from '../sidebar/TreeRow'
import {useT} from '../../i18n'
import {DOCKER_SECTIONS, type DockerSection} from './docker/sections'
import {UTILITIES, type UtilityId} from './utilities'

interface UtilitiesTreeProps {
    // Herramientas que ya tienen una pestaña abierta. Se marcan: abrir una que
    // ya está abierta no crea otra, lleva a la que existe, y la marca dice de
    // antemano que eso es lo que va a pasar.
    openIds: Set<UtilityId>
    // La herramienta de la pestaña activa, para resaltar su fila.
    activeId: UtilityId | null
    onOpen: (id: UtilityId) => void
    // Utilidades que hoy no se pueden usar (Docker apagado o sin instalar), con el
    // motivo ya redactado. Se muestran apagadas y no abren pestaña: abrirla solo
    // serviría para mostrar un error. El clic sigue llegando a `onOpen`, que
    // vuelve a comprobar por si ya se arregló.
    unavailable: Partial<Record<UtilityId, string>>
    // El submenú de Docker, como el de Git: sus secciones cuelgan de la fila.
    docker: {
        section: DockerSection
        // Totales de cada sección. null mientras la pestaña de Docker no está
        // abierta: contarlos sin que nadie los mire sería gastar en balde.
        counts: dockerctl.Counts | null
    }
    onOpenDockerSection: (s: DockerSection) => void
    // Búsqueda global de la barra: filtra por nombre y por descripción.
    filter: string
    onMatchCount: (n: number | null) => void
}

// El cuerpo del módulo Utilidades: la lista de herramientas.
//
// Es una lista plana salvo Docker, que despliega un submenú con sus secciones
// (Contenedores, Imágenes, Volúmenes, Redes, Builds): es lo que antes era un
// menú propio dentro de la pestaña, y vive acá porque la barra lateral es donde
// se navega en esta app —igual que las ramas, remotos y tags de Git—, dejando a
// la pestaña todo el ancho para el contenido.
export default function UtilitiesTree({openIds, activeId, onOpen, unavailable, docker, onOpenDockerSection, filter, onMatchCount}: UtilitiesTreeProps) {
    const t = useT()
    const td = t.utilities.docker
    const query = filter.trim().toLowerCase()
    const [dockerExpanded, setDockerExpanded] = useState(true)

    const visible = useMemo(
        () =>
            UTILITIES.filter((u) => {
                if (!query) return true
                const tool = t.utilities.tools[u.id]
                // Docker también aparece al buscar una de sus secciones («redes»).
                const sections = u.id === 'docker' ? DOCKER_SECTIONS.map((s) => td.nav[s.id].toLowerCase()) : []
                return tool.name.toLowerCase().includes(query) || tool.hint.toLowerCase().includes(query) || sections.some((s) => s.includes(query))
            }),
        [query, t, td],
    )

    // Con una búsqueda activa, cuántas coinciden; sin ella, null: un "5"
    // permanente sobre el ícono sería ruido, no información.
    useEffect(() => {
        onMatchCount(query ? visible.length : null)
    }, [query, visible.length, onMatchCount])

    const countOf = (s: DockerSection): number | null => {
        const n = docker.counts?.[s]
        // -1 = no se pudo contar: sin número antes que un número que miente.
        return n === undefined || n < 0 ? null : n
    }

    return (
        <SidebarSection title={t.utilities.sidebar.title} count={query ? `${visible.length}/${UTILITIES.length}` : String(UTILITIES.length)}>
            {visible.length === 0 ? (
                <p className="px-3 py-2 text-xs text-on-surface-variant">{t.sidebar.folders.noMatchesFor({query: filter.trim()})}</p>
            ) : (
                visible.map((u) => {
                    const tool = t.utilities.tools[u.id]
                    const open = openIds.has(u.id)
                    const reason = unavailable[u.id]
                    const isDocker = u.id === 'docker'
                    // Con Docker apagado el submenú no se ofrece: sus secciones
                    // no tienen nada que mostrar.
                    const hasChildren = isDocker && !reason
                    return (
                        <div key={u.id}>
                            <TreeRow
                                depth={0}
                                icon={u.icon}
                                label={tool.name}
                                title={reason ? `${reason} ${t.utilities.sidebar.recheck}` : `${t.utilities.sidebar.openTool({name: tool.name})} — ${tool.hint}`}
                                iconClass={reason ? 'opacity-40' : undefined}
                                labelClass={reason ? 'opacity-50' : undefined}
                                active={activeId === u.id && !hasChildren}
                                expanded={hasChildren ? dockerExpanded || !!query : undefined}
                                onToggle={hasChildren ? () => setDockerExpanded((v) => !v) : undefined}
                                onClick={() => {
                                    onOpen(u.id)
                                    if (hasChildren) setDockerExpanded(true)
                                }}
                                trailing={
                                    reason ? (
                                        <span title={reason} className="flex items-center gap-1 text-ui-9 uppercase text-on-surface-variant/60">
                                            <Icon name="block" size={11} />
                                            {t.utilities.sidebar.unavailable}
                                        </span>
                                    ) : open ? (
                                        <span title={t.utilities.sidebar.alreadyOpen} className="flex items-center text-primary">
                                            <Icon name="fiber_manual_record" size={8} filled />
                                        </span>
                                    ) : undefined
                                }
                            />
                            {hasChildren &&
                                (dockerExpanded || !!query) &&
                                DOCKER_SECTIONS.map((s) => {
                                    const n = countOf(s.id)
                                    return (
                                        <TreeRow
                                            key={s.id}
                                            depth={1}
                                            icon={s.icon}
                                            label={td.nav[s.id]}
                                            title={td.navTitle[s.id]}
                                            active={activeId === 'docker' && docker.section === s.id}
                                            onClick={() => onOpenDockerSection(s.id)}
                                            trailing={
                                                n !== null ? (
                                                    <span className="font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{n}</span>
                                                ) : undefined
                                            }
                                        />
                                    )
                                })}
                        </div>
                    )
                })
            )}
        </SidebarSection>
    )
}
