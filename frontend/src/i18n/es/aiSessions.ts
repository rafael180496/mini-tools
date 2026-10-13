// Conversaciones de IA persistentes y en segundo plano: los grupos «Abiertas» y
// «Recientes» de Chat de IA (en Utilidades, barra lateral), los avisos y las
// pestañas de Chat de IA múltiples. Ver lib/agentSessions.ts.
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
        active: 'Abiertas',
        activeHint:
            'Tus conversaciones abiertas. Se quedan acá aunque cierres su pestaña o la app —las que estaban trabajando figuran «interrumpidas» y se retoman con un clic— hasta que las cierres con «Cerrar chat» o las elimines. Las fijadas van arriba.',
        pinned: 'Fijadas',
        pinnedHint: 'Conversaciones fijadas arriba de la lista. Siguen abiertas como las demás.',
        others: 'Abiertas',
        recent: 'Recientes',
        recentHint: 'Las últimas conversaciones que no están abiertas, de cualquier módulo y proveedor.',
        emptyActive: 'No hay conversaciones abiertas.',
        emptyActiveHint: 'Cada chat nuevo aparece acá desde que lo creás, aunque todavía no le hayas escrito, y se queda hasta que lo cierres.',
        emptyRecent: 'Todavía no hay conversaciones.',
        noMatches: (p: {query: string}) => `Nada coincide con «${p.query}».`,
        untitled: 'Sin título',
        draftTitle: 'Nuevo chat · borrador',
        status: {
            running: 'Trabajando',
            awaiting_approval: 'Necesita aprobación',
            idle: 'Terminó — sin leer',
            error: 'Falló',
            cancelled: 'Detenida',
            interrupted: 'Interrumpido al cerrar la app',
            draft: 'Borrador — sin mensajes',
        },
        idleRead: 'Terminó',
        backgroundTag: 'en segundo plano',
        backgroundTitle: 'Su pestaña está cerrada pero el chat sigue abierto. Se queda acá hasta que lo cierres con «Cerrar chat».',
        tokens: (p: {n: string}) => `${p.n} tokens`,
        tokensTitle: 'Tokens que gastó el último turno (entrada + salida). Se conocen recién al terminar.',
        elapsedTitle: 'Tiempo que lleva este turno trabajando.',
        rowTitle: (p: {title: string}) => `Abrir «${p.title}» en una pestaña (si está trabajando, ves su progreso en vivo)`,
        rowInterruptedTitle: (p: {title: string}) =>
            `«${p.title}» estaba trabajando cuando se cerró la app y se cortó. Abrila para retomarla: se vuelve a dibujar lo que quedó guardado y podés seguir escribiéndole.`,
        open: 'Abrir',
        openTitle: 'Abre la conversación en una pestaña de Chat de IA (o lleva a la que ya la tiene) y retoma el turno donde va.',
        openInterruptedTitle: 'Abre la conversación interrumpida en una pestaña de Chat de IA, con lo que quedó guardado, para seguir escribiéndole.',
        pin: 'Fijar',
        pinTitle: 'Fija esta conversación arriba de la lista. Sigue abierta aunque cierres la pestaña o la app; fijar solo cambia el orden.',
        unpin: 'Desfijar',
        unpinTitle: 'Quita la fijación: la conversación sigue abierta, pero vuelve a ordenarse con las demás.',
        stop: 'Detener',
        stopTitle: 'Corta el turno en curso y deja el chat abierto: sigue en esta lista y se le puede escribir de nuevo. Lo que el agente ya escribió queda en la conversación. Para terminar el chat del todo, usá «Cerrar chat».',
        approve: 'Aprobar…',
        approveTitle: 'Abre el permiso que está esperando esta conversación, para permitirlo o denegarlo.',
        markRead: 'Marcar leído',
        markReadTitle: 'Ya viste cómo terminó. El chat sigue abierto en esta lista hasta que lo cierres.',
        more: 'Más acciones del chat',
        moreTitle: 'Abrir, fijar, renombrar, detener, marcar leído, cerrar o eliminar el chat. También con clic derecho sobre la fila.',
        rename: 'Renombrar…',
        renameTitle: 'Cambia el nombre de esta conversación. Se actualiza en las pestañas, en el historial y en esta lista.',
        closeChat: 'Cerrar chat',
        closeChatTitle:
            'Cierra el chat: corta lo que esté corriendo, lo saca de «Abiertas» y suelta su memoria. La conversación queda en «Recientes» y se puede abrir de nuevo (un borrador vacío se descarta). No es lo mismo que «Detener», que corta el turno pero deja el chat abierto, ni que «Eliminar», que la borra.',
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
        delete: 'Eliminar',
        deleteTitle: 'Borra la conversación y todos sus mensajes guardados. No se puede deshacer. Si querés conservarla, usá «Cerrar chat».',
        deleteConfirm: {
            title: '¿Eliminar esta conversación?',
            description: (p: {title: string}) =>
                `«${p.title}» se borra con todos sus mensajes y, si está trabajando, se corta. No se puede deshacer. La conversación que el propio CLI guardó por su cuenta no se toca.`,
            confirm: 'Eliminar',
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
        background: (p: {title: string}) => `«${p.title}» sigue trabajando en segundo plano — la encontrás en Utilidades → Chat de IA → Abiertas.`,
        see: 'Ver',
        seeTitle: 'Abre Utilidades → Chat de IA → Abiertas en la barra lateral y te lleva a este chat.',
        stop: 'Detener',
        stopTitle: 'Corta el turno en curso. El chat queda abierto en Chat de IA → Abiertas; para cerrarlo del todo usá «Cerrar chat» allí.',
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
        unsplitTitle: 'Cierra el segundo panel. Sus turnos en curso no se detienen: siguen en Utilidades → Chat de IA → Abiertas.',
        paneLabel: (p: {n: number}) => `Panel ${p.n}`,
        stateRunning: 'Una conversación de esta pestaña está trabajando',
        stateApproval: 'Una conversación de esta pestaña espera tu aprobación',
        stateUnread: 'Una conversación de esta pestaña terminó sin que la leyeras',
        closeTabTitle:
            'Cierra la pestaña, no el chat: si una conversación está trabajando, sigue en segundo plano y la encontrás en Utilidades → Chat de IA → Abiertas. Para terminarla del todo: clic derecho → «Cerrar y detener el chat».',
        draftTitle: 'Nuevo chat',
        rename: 'Renombrar…',
        renameHint: 'F2',
        renameTitle:
            'Cambia el nombre de la conversación que muestra esta pestaña (también con doble clic o F2). El rótulo de la pestaña es el nombre de su conversación; sin nombre ni proyecto dice «Nuevo chat».',
        renameField: 'Nombre de la conversación',
        renameEditTitle: 'Escribí el nombre nuevo. Enter guarda, Esc cancela; si lo dejás vacío no cambia nada (máximo 120 caracteres).',
        tabHint: (p: {title: string}) => `${p.title} — doble clic o F2 para renombrar la conversación`,
        closeTabKeep: 'Cerrar pestaña (el chat sigue en segundo plano)',
        closeTabKeepTitle: 'Cierra la pestaña sin cortar nada: las conversaciones siguen abiertas en Chat de IA → Abiertas (las que trabajan, trabajando).',
        closeForReal: 'Cerrar y detener el chat',
        closeForRealTitle: 'Cierra la pestaña Y las conversaciones que muestra: corta lo que corra, las saca de Chat de IA → Abiertas y suelta su memoria. El historial guardado queda.',
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
