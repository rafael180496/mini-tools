// Sesiones de IA en segundo plano: los grupos «Activas» y «Recientes» de Chat de
// IA (en Utilidades, barra lateral), los avisos y las pestañas de Chat de IA
// múltiples. Ver lib/agentSessions.ts.
export default {
    // Insignia de actividad: va sobre el ícono de Utilidades y sobre la fila
    // «Chat de IA».
    module: {
        badgeTitle: (p: {running: number; approval: number}) =>
            [
                p.approval > 0 ? (p.approval === 1 ? '1 conversación necesita tu aprobación' : `${p.approval} conversaciones necesitan tu aprobación`) : '',
                p.running > 0 ? (p.running === 1 ? '1 conversación trabajando' : `${p.running} conversaciones trabajando`) : '',
            ]
                .filter(Boolean)
                .join(' · '),
    },
    sidebar: {
        active: 'Activas',
        activeHint:
            'Conversaciones que están trabajando, esperan tu permiso, fallaron, terminaron sin que las vieras o quedaron abiertas en segundo plano al cerrar su pestaña. Solo «Cerrar chat» las saca de acá.',
        recent: 'Recientes',
        recentHint: 'Las últimas conversaciones, de cualquier módulo y proveedor.',
        emptyActive: 'Nada en marcha.',
        emptyActiveHint: 'Acá aparecen las que trabajan, esperan o quedaron en segundo plano.',
        emptyRecent: 'Todavía no hay conversaciones.',
        noMatches: (p: {query: string}) => `Nada coincide con «${p.query}».`,
        untitled: 'Sin título',
        status: {
            running: 'Trabajando',
            awaiting_approval: 'Necesita aprobación',
            idle: 'Terminó — sin leer',
            error: 'Falló',
            cancelled: 'Detenida',
        },
        idleRead: 'Terminó',
        backgroundTag: 'en segundo plano',
        backgroundTitle: 'Su pestaña está cerrada pero el chat sigue abierto. Se queda acá hasta que lo cierres con «Cerrar chat».',
        tokens: (p: {n: string}) => `${p.n} tokens`,
        tokensTitle: 'Tokens que gastó el último turno (entrada + salida). Se conocen recién al terminar.',
        elapsedTitle: 'Tiempo que lleva este turno trabajando.',
        rowTitle: (p: {title: string}) => `Abrir «${p.title}» en una pestaña y ver su progreso en vivo`,
        open: 'Abrir',
        openTitle: 'Abre la conversación en una pestaña de Chat de IA (o lleva a la que ya la tiene) y retoma el turno donde va.',
        stop: 'Detener',
        stopTitle: 'Corta el turno en curso y deja el chat abierto: sigue en esta lista y se le puede escribir de nuevo. Lo que el agente ya escribió queda en la conversación. Para terminar el chat del todo, usá «Cerrar chat».',
        letFinish: 'Dejar terminar',
        letFinishTitle: 'La saca de esta lista sin detenerla: el turno sigue hasta terminar, y vuelve a aparecer cuando termine o pida permiso.',
        approve: 'Aprobar…',
        approveTitle: 'Abre el permiso que está esperando esta conversación, para permitirlo o denegarlo.',
        markRead: 'Marcar leído',
        markReadTitle: 'Ya viste cómo terminó. Si su pestaña se cerró, el chat sigue abierto en esta lista hasta que lo cierres.',
        more: 'Más acciones del chat',
        moreTitle: 'Abrir, detener, dejar terminar, marcar leído o cerrar el chat. También con clic derecho sobre la fila.',
        rename: 'Renombrar…',
        renameTitle: 'Cambia el nombre de esta conversación. Se actualiza en las pestañas, en el historial y en esta lista.',
        closeChat: 'Cerrar chat',
        closeChatTitle:
            'Cierra el chat: corta lo que esté corriendo, lo saca de «Activas» y suelta su memoria. La conversación queda en «Recientes» y se puede abrir de nuevo. No es lo mismo que «Detener», que corta el turno pero deja el chat abierto.',
        closeConfirm: {
            title: '¿Cerrar este chat?',
            description: (p: {title: string}) =>
                `«${p.title}» está trabajando: se corta ahora y el chat se cierra. Lo que ya escribió o modificó queda como está; los cambios en archivos no se deshacen solos. La conversación sigue en el historial.`,
            confirm: 'Cerrar chat',
        },
        stopConfirm: {
            title: '¿Detener esta conversación?',
            description: (p: {title: string}) =>
                `«${p.title}» deja de trabajar ahora. Lo que ya escribió o modificó queda como está; los cambios en archivos no se deshacen solos.`,
            confirm: 'Detener',
        },
        recentOpenTitle: (p: {title: string}) => `Abrir «${p.title}» en una pestaña de Chat de IA`,
    },
    toast: {
        region: 'Avisos de conversaciones de IA',
        done: 'Terminó una conversación',
        error: 'Falló una conversación',
        approval: 'Necesita tu aprobación',
        approvalText: (p: {tool: string}) => `Quiere usar ${p.tool}.`,
        review: 'Revisar',
        reviewTitle: 'Muestra qué acción pide el agente para que la permitas o la denegues.',
        open: 'Abrir',
        openTitle: 'Lleva a la conversación en una pestaña de Chat de IA.',
        close: 'Cerrar aviso',
        backgroundTitle: 'Sigue trabajando en segundo plano',
        background: (p: {title: string}) => `«${p.title}» sigue trabajando en segundo plano — la encontrás en Utilidades → Chat de IA → Activas.`,
        see: 'Ver',
        seeTitle: 'Abre Utilidades → Chat de IA → Activas en la barra lateral y te lleva a este chat.',
        stop: 'Detener',
        stopTitle: 'Corta el turno en curso. El chat queda abierto en Chat de IA → Activas; para cerrarlo del todo usá «Cerrar chat» allí.',
    },
    tabs: {
        newWindow: 'Nueva pestaña de chat',
        newWindowShort: 'Nueva pestaña',
        newWindowTitle: (p: {shortcut: string}) =>
            `Abre OTRA pestaña de Chat de IA, con su propio proyecto, proveedor y conversación (${p.shortcut}). Los turnos que corren en las demás siguen corriendo.`,
        newChatMenu: 'Más opciones de chat nuevo',
        newChatMenuTitle: 'Elegí dónde abrir el chat nuevo: en esta pestaña, en otra pestaña o dividiendo esta en dos paneles.',
        newInThisTab: 'Nuevo chat en esta pestaña',
        newInThisTabTitle: (p: {shortcut: string}) =>
            `Empieza una conversación nueva en esta misma pestaña (${p.shortcut}). La actual queda en el historial.`,
        newInNewTab: 'Nuevo chat en una pestaña nueva',
        newSplitTab: 'Nuevo chat dividido (pestaña nueva)',
        newSplitTabTitle: 'Abre una pestaña de Chat de IA nueva ya dividida en dos paneles, para tener dos chats lado a lado.',
        splitMenu: 'Dividir: dos chats lado a lado',
        unsplitShort: 'Quitar división',
        emptyHint: (p: {shortcut: string}) => `Podés tener varias conversaciones a la vez: ${p.shortcut} abre otra pestaña, o Dividir para verlas lado a lado.`,
        openInNewTab: 'Abrir en una pestaña nueva',
        openInNewTabTitle: 'Abre esta conversación en su propia pestaña de Chat de IA, para tenerla a la vista junto a otras.',
        split: 'Dividir',
        splitTitle: 'Muestra DOS chats lado a lado en esta pestaña, cada uno con su proyecto, proveedor y sesión.',
        unsplit: 'Cerrar panel',
        unsplitTitle: 'Cierra el segundo panel. Sus turnos en curso no se detienen: siguen en Utilidades → Chat de IA → Activas.',
        paneLabel: (p: {n: number}) => `Panel ${p.n}`,
        stateRunning: 'Una conversación de esta pestaña está trabajando',
        stateApproval: 'Una conversación de esta pestaña espera tu aprobación',
        stateUnread: 'Una conversación de esta pestaña terminó sin que la leyeras',
        closeTabTitle:
            'Cierra la pestaña, no el chat: si una conversación está trabajando, sigue en segundo plano y la encontrás en Utilidades → Chat de IA → Activas. Para terminarla del todo: clic derecho → «Cerrar y detener el chat».',
        draftTitle: 'Nuevo chat',
        rename: 'Renombrar…',
        renameHint: 'F2',
        renameTitle:
            'Cambia el nombre de la conversación que muestra esta pestaña (también con doble clic o F2). El rótulo de la pestaña es el nombre de su conversación; sin nombre ni proyecto dice «Nuevo chat».',
        renameField: 'Nombre de la conversación',
        renameEditTitle: 'Escribí el nombre nuevo. Enter guarda, Esc cancela; si lo dejás vacío no cambia nada (máximo 120 caracteres).',
        tabHint: (p: {title: string}) => `${p.title} — doble clic o F2 para renombrar la conversación`,
        closeTabKeep: 'Cerrar pestaña (el chat sigue en segundo plano)',
        closeTabKeepTitle: 'Cierra la pestaña sin cortar nada: las conversaciones que trabajan siguen y quedan en Chat de IA → Activas.',
        closeForReal: 'Cerrar y detener el chat',
        closeForRealTitle: 'Cierra la pestaña Y las conversaciones que muestra: corta lo que corra, las saca de Chat de IA → Activas y suelta su memoria. El historial guardado queda.',
        closeForRealConfirm: {
            title: '¿Cerrar y detener el chat?',
            description: (p: {n: number; title: string}) =>
                p.n === 1
                    ? `«${p.title}» está trabajando: se corta ahora y el chat se cierra con la pestaña. Lo que ya escribió o modificó queda como está; los cambios en archivos no se deshacen solos.`
                    : `${p.n} conversaciones de esta pestaña están trabajando: se cortan ahora y se cierran con la pestaña. Lo que ya escribieron o modificaron queda como está; los cambios en archivos no se deshacen solos.`,
            confirm: 'Cerrar y detener',
        },
    },
}
