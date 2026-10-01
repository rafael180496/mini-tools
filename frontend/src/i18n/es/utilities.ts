// Textos del área «utilities» (módulo Utilidades y sus herramientas).
// Ver .claude/specs/i18n.md.
export default {
    // La barra lateral del módulo.
    sidebar: {
        title: 'Utilidades',
        openTool: (p: {name: string}) => `Abrir ${p.name} en una pestaña nueva`,
        alreadyOpen: 'Abierta',
    },
    // Cada herramienta, como se la ve en la barra.
    tools: {
        portKiller: {
            name: 'Port Killer',
            hint: 'ver qué proceso tiene ocupado un puerto y terminarlo',
        },
        activityMonitor: {
            name: 'Activity Monitor',
            hint: 'procesos en vivo: qué consume CPU y memoria, y cerrarlos',
        },
    },
    portKiller: {
        searchPlaceholder: 'Buscar puerto, proceso o PID…',
        searchTitle: 'Filtra la lista por número de puerto, nombre del proceso, PID o dirección',
        clearSearch: 'Borrar la búsqueda',
        refresh: 'Actualizar',
        refreshTitle: 'Vuelve a leer qué puertos están escuchando ahora mismo',
        auto: 'Auto',
        autoOnTitle: (p: {seconds: number}) =>
            `Se actualiza solo cada ${p.seconds} s mientras esta pestaña está a la vista. Hacé clic para detenerlo`,
        autoOffTitle: 'No se actualiza solo: usá Actualizar. Hacé clic para que lo haga cada pocos segundos mientras esta pestaña está a la vista',
        count: (p: {shown: number; total: number}) =>
            p.shown === p.total ? `${p.total} ${p.total === 1 ? 'puerto' : 'puertos'}` : `${p.shown} de ${p.total} puertos`,
        updatedAt: (p: {time: string}) => `Actualizado ${p.time}`,
        columns: {
            port: 'Puerto',
            address: 'Dirección',
            process: 'Proceso',
            pid: 'PID',
        },
        filters: {all: 'Todos', local: 'Local', network: 'Red'},
        filterTitle: {
            all: 'Todos los puertos en escucha',
            local: 'Solo los que aceptan conexiones de esta máquina',
            network: 'Solo los que escuchan en todas las interfaces: otras máquinas pueden conectarse',
        },
        sortBy: (p: {column: string}) => `Ordenar por ${p.column}`,
        openBrowser: 'Abrir',
        openBrowserTitle: (p: {port: number}) => `Abre http://localhost:${p.port} en el navegador — sirve si ese puerto es un servidor web`,
        scopeLocal: 'Local',
        scopeNetwork: 'Red',
        scopeLocalTitle: 'Solo acepta conexiones de esta máquina',
        scopeNetworkTitle: 'Escucha en todas las interfaces: otras máquinas de la red pueden conectarse',
        unknownProcess: 'Sin identificar',
        terminate: 'Terminar',
        terminateTitle: (p: {process: string; pid: number}) =>
            `Pide a ${p.process} (PID ${p.pid}) que se cierre de forma ordenada, y libera el puerto`,
        force: 'Forzar',
        forceTitle: (p: {process: string; pid: number}) =>
            `Corta ${p.process} (PID ${p.pid}) de inmediato, sin darle tiempo a guardar nada`,
        protectedTitle:
            'Es un proceso del sistema, esta misma app, o el sistema no dejó identificarlo: no se ofrece terminarlo desde acá',
        loading: 'Buscando puertos…',
        empty: 'Ningún puerto TCP está escuchando ahora.',
        noMatches: (p: {query: string}) => `Ningún puerto coincide con "${p.query}".`,
        loadFailed: 'No se pudo leer la lista de puertos',
        footNote: 'Solo aparecen los procesos que el sistema deja ver sin permisos de administrador: los de otros usuarios pueden faltar.',
        confirm: {
            terminateTitle: 'Terminar el proceso',
            terminateDescription: (p: {process: string; pid: number; port: number}) =>
                `Se le pedirá a ${p.process} (PID ${p.pid}) que se cierre y libere el puerto ${p.port}. Lo que tuviera sin guardar puede perderse.`,
            terminateAction: 'Terminar',
            forceTitle: 'Forzar el cierre',
            forceDescription: (p: {process: string; pid: number; port: number}) =>
                `${p.process} (PID ${p.pid}) se corta ahora mismo, sin darle oportunidad de cerrar ordenadamente. Libera el puerto ${p.port}, pero pierde lo que tuviera sin guardar.`,
            forceAction: 'Forzar cierre',
            elevateTitle: 'Hacen falta permisos de administrador',
            elevateDescription: (p: {process: string; pid: number}) =>
                `${p.process} (PID ${p.pid}) es de otro usuario o del sistema. Si seguís, el sistema operativo te va a pedir la contraseña o la autorización de administrador antes de terminarlo.`,
            elevateAction: 'Pedir permisos',
        },
        result: {
            ended: (p: {process: string; port: number}) => `${p.process} terminó: el puerto ${p.port} quedó libre.`,
            stillRunning: (p: {process: string}) =>
                `${p.process} sigue corriendo: recibió el pedido de cierre pero no terminó. Probá con Forzar.`,
            gone: 'Ese proceso ya no existía. La lista se actualizó.',
            denied: 'No se concedieron los permisos de administrador, así que el proceso sigue corriendo.',
            failed: (p: {error: string}) => `No se pudo terminar el proceso: ${p.error}`,
        },
        dismiss: 'Cerrar el aviso',
    },
    activityMonitor: {
        searchPlaceholder: 'Buscar proceso, PID o usuario…',
        searchTitle: 'Filtra la lista por nombre del proceso, PID o usuario',
        clearSearch: 'Borrar la búsqueda',
        live: 'En vivo',
        paused: 'En pausa',
        liveTitle: (p: {seconds: number}) =>
            `Se actualiza solo cada ${p.seconds} s mientras esta pestaña está a la vista. Hacé clic para pausar`,
        pausedTitle: 'En pausa: la lista no cambia. Hacé clic para que vuelva a actualizarse sola',
        everyTitle: 'Cada cuánto se actualiza la lista. Más seguido es más fino, pero consulta más veces',
        everySeconds: (p: {seconds: number}) => `${p.seconds} s`,
        refresh: 'Actualizar',
        refreshTitle: 'Vuelve a leer los procesos ahora mismo',
        filters: {all: 'Todos', mine: 'Míos', active: 'Activos'},
        filterTitle: {
            all: 'Todos los procesos',
            mine: 'Solo los procesos de tu usuario',
            active: 'Solo los que están usando CPU en este momento',
        },
        count: (p: {shown: number; total: number}) =>
            p.shown === p.total ? `${p.total} procesos` : `${p.shown} de ${p.total} procesos`,
        updatedAt: (p: {time: string}) => `Actualizado ${p.time}`,
        columns: {name: 'Proceso', pid: 'PID', user: 'Usuario', cpu: 'CPU %', memory: 'Memoria'},
        sortBy: (p: {column: string}) => `Ordenar por ${p.column}`,
        loading: 'Leyendo procesos…',
        loadFailed: 'No se pudo leer la lista de procesos',
        empty: 'Ningún proceso coincide.',
        noMatches: (p: {query: string}) => `Ningún proceso coincide con "${p.query}".`,
        terminate: 'Terminar',
        force: 'Forzar',
        terminateTitle: (p: {process: string; pid: number}) =>
            `Pide a ${p.process} (PID ${p.pid}) que se cierre de forma ordenada`,
        forceTitle: (p: {process: string; pid: number}) =>
            `Corta ${p.process} (PID ${p.pid}) de inmediato, sin darle tiempo a guardar nada`,
        protectedTitle: 'Es un proceso del sistema o esta misma app: no se ofrece terminarlo desde acá',
        summary: {
            cpu: 'CPU',
            cpuDetail: (p: {cores: number}) => `${p.cores} núcleos`,
            memory: 'Memoria',
            memoryDetail: (p: {used: string; total: string}) => `${p.used} de ${p.total}`,
            network: 'Red',
            down: 'Bajada',
            up: 'Subida',
        },
        footNote: 'La CPU de cada proceso es el % de un núcleo: 200 son dos núcleos completos. Sin permisos de administrador algunos procesos del sistema muestran 0.',
        kill: {
            terminateTitle: 'Terminar el proceso',
            terminateDescription: (p: {process: string; pid: number}) =>
                `Se le pedirá a ${p.process} (PID ${p.pid}) que se cierre. Lo que tuviera sin guardar puede perderse.`,
            terminateAction: 'Terminar',
            forceTitle: 'Forzar el cierre',
            forceDescription: (p: {process: string; pid: number}) =>
                `${p.process} (PID ${p.pid}) se corta ahora mismo, sin darle oportunidad de cerrar ordenadamente. Pierde lo que tuviera sin guardar.`,
            forceAction: 'Forzar cierre',
            elevateTitle: 'Hacen falta permisos de administrador',
            elevateDescription: (p: {process: string; pid: number}) =>
                `${p.process} (PID ${p.pid}) es de otro usuario o del sistema. Si seguís, el sistema operativo te va a pedir la contraseña o la autorización de administrador antes de terminarlo.`,
            elevateAction: 'Pedir permisos',
            ended: (p: {process: string}) => `${p.process} terminó.`,
            stillRunning: (p: {process: string}) =>
                `${p.process} sigue corriendo: recibió el pedido de cierre pero no terminó. Probá con Forzar.`,
        },
    },
}
