import {useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import type {dockerctl} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import TreeRow from '../sidebar/TreeRow'
import {MenuButton, useTreeMenu} from '../sidebar/TreeMenu'
import {aiChatShortcuts} from '../../lib/aiChatTabs'
import {onShowAiSessionsRequest} from '../../lib/appBus'
import {useT} from '../../i18n'
import InlineRename from '../InlineRename'
import AiSessionsGroups, {useAiSessionsData, type AiRevealRequest} from './aichat/AiSessionsGroups'
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
    // El Chat de IA admite varias pestañas: acá se listan las abiertas y se pide
    // otra. Un clic en su fila lleva a la que ya está (o abre la primera); el
    // doble clic, el «+» de la fila, su menú o ⇧⌘N abren OTRA. Debajo de las
    // pestañas cuelgan sus sesiones: «Activas» y «Recientes».
    aiChat: {
        tabs: {id: string; title: string}[]
        activeTabId: string | null
        onFocusTab: (tabId: string) => void
        onNewTab: () => void
        onNewSplit: () => void
        // Renombra la conversación que muestra esa pestaña (la pestaña no tiene
        // nombre propio: su rótulo es el de su conversación).
        onRenameTab: (tabId: string, title: string) => void
        // El módulo Utilidades está a la vista: es cuando se relee «Recientes».
        visible: boolean
    }
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
export default function UtilitiesTree({openIds, activeId, onOpen, unavailable, docker, onOpenDockerSection, aiChat, filter, onMatchCount}: UtilitiesTreeProps) {
    const t = useT()
    const menu = useTreeMenu(288)
    const td = t.utilities.docker
    const query = filter.trim().toLowerCase()
    const [dockerExpanded, setDockerExpanded] = useState(true)
    const [aiExpanded, setAiExpanded] = useState(true)
    // Pestaña de chat cuyo nombre se está editando en la fila.
    const [renamingTab, setRenamingTab] = useState<string | null>(null)
    const tai = t.utilities.sidebar.aiChat
    // Cuántas pestañas de chat había en el primer clic de un doble clic. El
    // primer clic ya abre una si no había ninguna: sin esto, un doble clic sobre
    // la fila con cero pestañas abriría dos.
    const aiTabsAtClick = useRef(0)
    // Las sesiones de IA (Activas / Recientes) y el pedido de mostrar una.
    const ai = useAiSessionsData(filter, aiChat.visible)
    const aiAttention = ai.attention.running + ai.attention.approval
    const aiHits = ai.active.length + ai.recent.length
    const [aiReveal, setAiReveal] = useState<AiRevealRequest | null>(null)
    const revealSeq = useRef(0)
    useEffect(
        () =>
            onShowAiSessionsRequest((req) => {
                setAiExpanded(true)
                setAiReveal({token: ++revealSeq.current, sessionId: req.sessionId})
            }),
        [],
    )

    const visible = useMemo(
        () =>
            UTILITIES.filter((u) => {
                if (!query) return true
                // El Chat de IA también aparece si lo que se busca es una de sus
                // conversaciones: sus sesiones cuelgan de esa fila.
                if (u.id === 'aiChat' && aiHits > 0) return true
                const tool = t.utilities.tools[u.id]
                // Docker también aparece al buscar una de sus secciones («redes»).
                const sections = u.id === 'docker' ? DOCKER_SECTIONS.map((s) => td.nav[s.id].toLowerCase()) : []
                return tool.name.toLowerCase().includes(query) || tool.hint.toLowerCase().includes(query) || sections.some((s) => s.includes(query))
            }),
        [query, t, td, aiHits],
    )

    // Con una búsqueda activa, cuántas coinciden; sin ella, null: un "5"
    // permanente sobre el ícono sería ruido, no información.
    useEffect(() => {
        // Las conversaciones que coinciden cuentan aparte de la fila que las aloja.
        onMatchCount(query ? visible.length + aiHits : null)
    }, [query, visible.length, aiHits, onMatchCount])

    const countOf = (s: DockerSection): number | null => {
        const n = docker.counts?.[s]
        // -1 = no se pudo contar: sin número antes que un número que miente.
        return n === undefined || n < 0 ? null : n
    }

    // El mismo menú con clic derecho o con el «⋯» de la fila.
    const aiMenu = (e: ReactMouseEvent) => {
        const k = aiChatShortcuts()
        menu.openAt(e, [
            {label: tai.open, icon: 'forum', title: tai.openTitle, onSelect: () => onOpen('aiChat')},
            'separator',
            {label: tai.newTab, icon: 'open_in_new', hint: k.newTab, title: tai.newTabTitle({shortcut: k.newTab}), onSelect: aiChat.onNewTab},
            {label: tai.newSplit, icon: 'vertical_split', title: tai.newSplitTitle, onSelect: aiChat.onNewSplit},
        ])
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
                    const isAi = u.id === 'aiChat'
                    const aiTabs = aiChat.tabs
                    // Las pestañas de chat se listan desde la primera: una pestaña
                    // abierta que no aparece acá parece no existir.
                    // El Chat de IA siempre despliega: además de sus pestañas, tiene
                    // «Activas» y «Recientes».
                    const hasChildren = (isDocker && !reason) || isAi
                    const expandedNow = isAi ? aiExpanded : dockerExpanded
                    return (
                        <div key={u.id}>
                            <TreeRow
                                depth={0}
                                icon={u.icon}
                                label={tool.name}
                                title={
                                    reason
                                        ? `${reason} ${t.utilities.sidebar.recheck}`
                                        : isAi
                                          ? `${tai.openTitle} — ${tool.hint}`
                                          : `${t.utilities.sidebar.openTool({name: tool.name})} — ${tool.hint}`
                                }
                                iconClass={reason ? 'opacity-40' : undefined}
                                labelClass={reason ? 'opacity-50' : undefined}
                                active={activeId === u.id && (!hasChildren || (isAi && aiTabs.length === 0))}
                                expanded={hasChildren ? expandedNow || !!query : undefined}
                                onToggle={hasChildren ? () => (isAi ? setAiExpanded((v) => !v) : setDockerExpanded((v) => !v)) : undefined}
                                onClick={(e) => {
                                    // El segundo clic de un doble clic no vuelve a
                                    // enfocar: lo resuelve onDoubleClick.
                                    if (isAi && e.detail > 1) return
                                    if (isAi) aiTabsAtClick.current = aiTabs.length
                                    onOpen(u.id)
                                    if (hasChildren) (isAi ? setAiExpanded : setDockerExpanded)(true)
                                }}
                                onDoubleClick={
                                    isAi
                                        ? () => {
                                              // Con cero pestañas el primer clic ya abrió una.
                                              if (aiTabsAtClick.current > 0) aiChat.onNewTab()
                                              setAiExpanded(true)
                                          }
                                        : undefined
                                }
                                onContextMenu={isAi ? aiMenu : undefined}
                                actions={
                                    isAi ? (
                                        <>
                                            <button
                                                type="button"
                                                data-ai-new-tab
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    aiChat.onNewTab()
                                                }}
                                                title={tai.newTabTitle({shortcut: aiChatShortcuts().newTab})}
                                                aria-label={tai.newTab}
                                                className="sidebar-icon !p-0.5"
                                            >
                                                <Icon name="add" size={14} />
                                            </button>
                                            <MenuButton onOpen={aiMenu} />
                                        </>
                                    ) : undefined
                                }
                                trailing={
                                    reason ? (
                                        <span title={reason} className="flex items-center gap-1 text-ui-9 uppercase text-on-surface-variant/60">
                                            <Icon name="block" size={11} />
                                            {t.utilities.sidebar.unavailable}
                                        </span>
                                    ) : isAi && (aiTabs.length > 0 || aiAttention > 0) ? (
                                        <span className="flex items-center gap-1">
                                            {aiAttention > 0 && (
                                                <span
                                                    data-ai-attention
                                                    title={t.aiSessions.module.badgeTitle(ai.attention)}
                                                    className={`rounded-full px-1.5 font-mono text-ui-10 font-semibold tabular-nums ${
                                                        ai.attention.approval > 0 ? 'bg-tertiary text-on-tertiary' : 'bg-primary text-on-primary'
                                                    }`}
                                                >
                                                    {aiAttention}
                                                </span>
                                            )}
                                            {aiTabs.length > 0 && (
                                                <span
                                                    data-ai-tab-count
                                                    title={tai.openCount({n: aiTabs.length})}
                                                    className="rounded-full bg-primary/15 px-1.5 font-mono text-ui-10 font-semibold tabular-nums text-primary"
                                                >
                                                    {aiTabs.length}
                                                </span>
                                            )}
                                        </span>
                                    ) : open ? (
                                        <span title={t.utilities.sidebar.alreadyOpen} className="flex items-center text-primary">
                                            <Icon name="fiber_manual_record" size={8} filled />
                                        </span>
                                    ) : undefined
                                }
                            />
                            {isAi &&
                                hasChildren &&
                                (aiExpanded || !!query) &&
                                aiTabs.map((tab) => (
                                    <TreeRow
                                        key={tab.id}
                                        depth={1}
                                        icon="chat_bubble"
                                        label={tab.title}
                                        title={tai.tabTitle({title: tab.title})}
                                        active={aiChat.activeTabId === tab.id}
                                        onClick={() => aiChat.onFocusTab(tab.id)}
                                        onDoubleClick={() => setRenamingTab(tab.id)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'F2') {
                                                e.preventDefault()
                                                setRenamingTab(tab.id)
                                            }
                                        }}
                                        onContextMenu={(e) =>
                                            menu.openAt(e, [
                                                {label: t.aiSessions.tabs.rename, icon: 'edit', hint: t.aiSessions.tabs.renameHint, title: t.aiSessions.tabs.renameTitle, onSelect: () => setRenamingTab(tab.id)},
                                                {label: tai.open, icon: 'forum', title: tai.tabTitle({title: tab.title}), onSelect: () => aiChat.onFocusTab(tab.id)},
                                            ])
                                        }
                                        editor={
                                            renamingTab === tab.id ? (
                                                <InlineRename
                                                    value={tab.title}
                                                    ariaLabel={tai.renameField}
                                                    title={t.aiSessions.tabs.renameEditTitle}
                                                    onCommit={(title) => {
                                                        setRenamingTab(null)
                                                        aiChat.onRenameTab(tab.id, title)
                                                    }}
                                                    onCancel={() => setRenamingTab(null)}
                                                    className="flex-1 text-ui-12"
                                                />
                                            ) : undefined
                                        }
                                    />
                                ))}
                            {isAi && hasChildren && (aiExpanded || !!query) && (
                                <AiSessionsGroups data={ai} reveal={aiReveal} onRevealed={() => setAiReveal(null)} />
                            )}
                            {isDocker &&
                                hasChildren &&
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
            {menu.element}
        </SidebarSection>
    )
}
