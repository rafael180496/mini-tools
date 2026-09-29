// Textos del área «agent» (chat con agentes, consumo, historial, acceso MCP).
// Ver .claude/specs/i18n.md.
//
// Marcas de formato: en los textos que se dibujan con `rich()`
// (components/agent/rich.tsx), `**x**` sale resaltado, `*x*` en cursiva y
// `` `x` `` en monoespaciada. Así la frase queda entera en el diccionario y el
// orden de las palabras lo decide cada idioma.
export default {
    // Motivo que se le manda al agente cuando el usuario rechaza una acción.
    // No es un rótulo: lo lee el agente, y va en el idioma de la interfaz
    // para que conteste en ese mismo idioma.
    approvalDeniedReason: 'el usuario no autorizó esta acción',
    // Edad relativa de una conversación en las listas de historial.
    age: {
        today: 'hoy',
        yesterday: 'ayer',
        days: (p: {n: number}) => `${p.n}d`,
        months: (p: {n: number}) => `${p.n}m`,
        years: (p: {n: number}) => `${p.n}a`,
    },
    context: {
        // Prefijo del encabezado ("Base · Prod_Analytics"). Git, SSH y HTTP
        // son nombres técnicos y no se traducen.
        prefixDb: 'Base',
        prefixNote: 'Nota',
        // Cómo se nombra el recurso en una frase ("sobre repositorio «x»").
        nouns: {
            git: 'repositorio',
            db: 'conexión',
            ssh: 'servidor',
            note: 'nota',
            http: 'petición',
        },
    },
    chat: {
        thinking: (p: {agent: string}) => `${p.agent} está pensando…`,
        workingOn: (p: {noun: string; label: string}) =>
            `El agente está trabajando sobre ${p.noun} «${p.label}». Cambia solo cuando cambiás de módulo, y no reinicia la conversación.`,
        mcpTitle: (p: {servers: string}) => `Servidores MCP que el CLI reporta al arrancar, con su estado real:\n${p.servers}`,
        mcpCount: (p: {n: number}) => `· MCP: ${p.n}`,
        cost: (p: {usd: string}) => ` · US$${p.usd}`,
        validateTitle:
            'Abre un chat con OTRO agente para que revise los cambios sin commitear. Corre en paralelo: este chat sigue como está.',
        validate: 'Validar con otro',
        searchTitle:
            'Buscar en esta conversación. Filtra los mensajes que contienen lo que escribas — útil para volver a un comando o a una explicación de hace media hora.',
        resetTitle: 'Olvida la conversación: el próximo mensaje arranca de cero en vez de encadenar con lo anterior.',
        searchPlaceholder: 'Buscar en esta conversación… (Esc cierra)',
        searchInputTitle: 'Muestra solo los mensajes que contienen este texto. La conversación no se toca: es un filtro de lectura.',
        searchCount: (p: {shown: number; total: number}) => `${p.shown} de ${p.total}`,
        searchCloseTitle: 'Cierra la búsqueda y vuelve a mostrar la conversación entera',
        // `**…**`: el primero es el nombre del recurso, el segundo el modo.
        emptyWithContext: (p: {noun: string; label: string}) =>
            `Sobre ${p.noun} **«${p.label}»**. Empieza en **solo consulta**: lee y propone, no toca nada.`,
        empty: 'Empieza en **solo consulta**: lee y propone, no toca nada.',
        emptyHint: (p: {paste: string}) => `**@** referencia tablas, notas y terminales · ${p.paste} pega una captura`,
        you: 'Vos',
        reuseTitle:
            'Trae este mensaje a la caja para mandarlo otra vez, corregido si hace falta. No borra lo que ya tengas escrito ni deshace la conversación: la respuesta anterior sigue estando.',
        reuse: 'Reusar',
        copyTitle: 'Copia este mensaje al portapapeles',
        copy: 'Copiar',
        copied: 'Copiado',
        turnUsageTitle: 'Tokens de este turno, informados por el propio CLI',
        turnUsage: (p: {total: string; output: string}) => `${p.total} tokens · ${p.output} de salida`,
        blockLines: (p: {n: number}) => `${p.n} líneas · se manda tal cual`,
        closePreview: 'Cerrar la vista previa',
        workingAttachedTitle: 'Se va a adjuntar al próximo mensaje. Hacé clic para NO mandarlo.',
        workingDetachedTitle: 'No se va a adjuntar. Hacé clic para incluirlo.',
        attached: 'adjunto',
        notAttached: 'sin adjuntar',
        chars: (p: {n: string}) => `${p.n} car.`,
        dequeueTitle: 'Sacar de la cola: este mensaje no se manda',
        queueHeld: 'La cola quedó esperando: el turno anterior falló o lo cortaste.',
        sendAnywayTitle: 'Manda igual lo que quedó en cola, uno por uno',
        sendAnyway: 'Mandar igual',
        modes: {
            query: {
                label: 'Solo consulta',
                hint: 'Lee, razona y propone. Sin modo explícito, una edición que necesita confirmación no se puede aprobar desde el chat y el agente la salta.',
            },
            plan: {
                label: 'Plan',
                hint: 'Explora y arma un plan sin tocar ningún archivo. Es el modo honesto para "decime cómo harías esto".',
            },
            approve: {
                label: 'Aprobar cada acción',
                hint: 'El agente trabaja, pero te pregunta antes de CADA acción y espera tu respuesta. Es el modo con más control: no hace nada que no hayas autorizado, una por una.',
            },
            auto: {
                label: 'Automático',
                hint: 'El CLI aprueba solo lo que pasa su propio control de seguridad y frena en lo riesgoso. Lo decide él, no esta app.',
            },
            edit: {
                label: 'Aplicar ediciones',
                hint: 'El agente MODIFICA archivos del repositorio sin preguntar. Los cambios caen en el árbol de trabajo: se ven en Cambios y se descartan desde ahí. Nunca se le da permiso para ejecutar cualquier comando.',
            },
        },
        effortTitle: 'Esfuerzo de razonamiento para este turno',
        effort: 'Esfuerzo',
        effortDefault: 'El que tenga configurado el CLI',
        imageTitle: 'Adjunta una imagen desde el equipo. También podés pegarla directamente en la caja de texto.',
        image: 'Imagen',
        modelTitle: 'Modelo para este turno. La lista la informa el propio CLI.',
        modelDefault: 'Por defecto',
        willEditFiles: 'Va a modificar archivos',
        actsAlone: 'Actúa sin volver a preguntarte',
        sessionUsageTitle:
            'Consumo de los turnos de esta ventana, informado por el propio CLI. Una conversación retomada empieza a contar desde acá: los turnos anteriores los corrió el CLI y no informó su consumo al reabrirlos.\n\nNo es cuánto te queda del plan: ese saldo lo sabe el servidor, no un archivo local. Se ve con /status en Claude Code y /usage en Antigravity.',
        sessionUsageEmptyTitle: 'Acá se acumulan los tokens de esta conversación en cuanto el agente conteste el primer turno.',
        inSession: (p: {n: string}) => `${p.n} en la sesión`,
        outputShort: (p: {n: string}) => `· ${p.n} de salida`,
        noUsageYet: 'sin consumo todavía',
        // `**…**` es el número de archivos.
        touched: (p: {n: number}) =>
            p.n === 1
                ? 'El agente dejó **1** archivo modificado sin commitear.'
                : `El agente dejó **${p.n}** archivos modificados sin commitear.`,
        reviewTitle:
            'Lleva a Cambios, con el diff de lo que tocó — revisarlo antes de commitear es todo el punto de que trabaje solo sobre un repositorio',
        review: 'Revisar',
        dismissTouchedTitle: 'Oculta el aviso. Los cambios siguen en el árbol de trabajo.',
        approvalTitle: (p: {tool: string}) => `¿Permitir ${p.tool}?`,
        approvalDescription: (p: {agent: string; tool: string; summary: string; detail: string}) =>
            `${p.agent} quiere ejecutar ${p.tool}` +
            (p.summary ? ` sobre ${p.summary}` : '') +
            (p.detail ? ` (${p.detail})` : '') +
            '. El agente está esperando tu respuesta: si cancelás, no lo hace y se le dice por qué.',
        allow: 'Permitir',
        allowEditsTitle: 'Permitir que modifique archivos',
        allowAutoTitle: 'Permitir que actúe automáticamente',
        allowEditsDescription: (p: {agent: string}) =>
            `${p.agent} va a editar archivos de este repositorio sin volver a preguntarte, durante toda esta sesión de chat. Los cambios quedan en el árbol de trabajo: los vas a ver en Cambios y los podés descartar desde ahí. Nunca se le da permiso para ejecutar cualquier comando.`,
        allowAutoDescription: (p: {agent: string}) =>
            `${p.agent} va a aprobar por su cuenta las acciones que pasen su propio control de seguridad, y a frenar solo en lo que considere riesgoso — ese criterio lo aplica el CLI, no esta app. Vale para toda esta sesión de chat.`,
        allowEdits: 'Permitir ediciones',
        // Arranques del chat vacío, por módulo. El texto visible es el mismo
        // que se escribe en la caja, así que sigue el idioma de la interfaz.
        starters: {
            db: ['Explicá esta consulta', 'Optimizá esta consulta', '¿Qué tablas tiene esta conexión?'],
            ssh: ['¿Qué falló acá?', 'Explicá este log', '¿Cómo reviso el uso de disco?'],
            http: ['Explicá esta respuesta', '¿Por qué falla esta petición?', 'Escribí pruebas para este endpoint'],
            note: ['Resumí esta nota', '¿Este procedimiento sigue teniendo sentido?', 'Ampliá el último paso'],
            git: ['¿Qué cambió en esta rama?', 'Revisá los cambios preparados', 'Escribí el mensaje del commit'],
            none: ['¿Qué podés hacer en mini-tools?'],
        },
        starterTitle: 'Escribe esto en la caja de mensaje. Podés editarlo antes de mandarlo.',
        blockChipTitle: (p: {label: string; n: number}) =>
            `${p.label} — ${p.n} líneas. Clic para leer exactamente lo que se va a mandar.`,
        removeBlockTitle: 'Quitar este contexto — no se va a mandar',
        attachmentTitle: (p: {path: string}) =>
            `${p.path} — se le pasa al agente por su ruta; el archivo vive en los datos de la app, no en el repositorio`,
        removeAttachmentTitle: 'Quitar del mensaje',
        busyPlaceholder: (p: {agent: string}) =>
            `${p.agent} está trabajando — escribí y Enter lo deja en cola para cuando termine`,
        placeholder: (p: {agent: string}) => `Preguntale a ${p.agent}… (Enter manda, Shift+Enter salta de línea)`,
        enqueueTitle: 'Deja este mensaje en cola: sale solo cuando termine el turno en curso',
        stopTitle: 'Corta el turno en curso. Lo que haya en cola no sale solo: queda esperando con un botón para mandarlo.',
        sendTitle: 'Manda el mensaje (Enter)',
    },
    host: {
        agent: 'Agente',
        noneInstalledTitle: 'No hay ningún CLI agéntico instalado en esta máquina. Configuralos en Configuración → Agentes.',
        pickerTitle:
            'Con qué agente hablás. Cambiarlo empieza una conversación nueva: el historial lo guarda cada CLI por su cuenta, así que otro no puede continuar la anterior.',
        noneInstalled: 'Ninguno instalado',
        pickAgent: 'Elegí un agente',
        backToChat: 'Vuelve a la conversación, que siguió corriendo detrás',
        usageTitle:
            'Cuánta cuota llevás usada y cuántos tokens gastaste con cada CLI, con tu plan al lado. Ocupa el panel como una solapa: el chat sigue donde estaba.',
        historyTitle:
            'Conversaciones anteriores de TODOS los módulos, no solo de este. Retomar una la continúa donde había quedado. Ocupa el panel como una solapa.',
        dockFloat: 'Ventana flotante: el chat queda por encima del contenido, sin quitarle ancho',
        dockLeft: 'Anclar el panel a la izquierda',
        dockRight: 'Anclar el panel a la derecha',
        dockBottom: 'Anclar el panel a la parte de abajo',
        closeTitle: 'Cierra el panel. La conversación queda como está: volver a abrirlo la retoma.',
        emptyNoAgent: 'No hay ningún agente instalado',
        emptyNoAgentHint:
            'mini-tools usa los CLIs que ya tengas: Claude Code, Codex o Antigravity. Instalá uno y aparecerá acá — la autenticación la sigue manejando cada CLI.',
        emptyPick: 'Elegí un agente arriba para empezar.',
        resizeTitle: 'Arrastrar para cambiar el tamaño del panel — queda guardado',
        renameTitle: 'Cambiar el nombre de la conversación',
        renameLabel: 'Nombre',
        renameDescription: 'Es solo el nombre con el que la vas a encontrar acá. No toca la conversación que el CLI tiene guardada.',
        openChatTitle: (p: {agent: string; shortcut: string}) =>
            `Abre el chat con ${p.agent} (${p.shortcut}). Hay una conversación por conexión, servidor o nota: cambiar de módulo cambia de hilo, sin reiniciar ni cortar el que dejás atrás, aunque esté respondiendo.`,
        theAgent: 'el agente',
        noCliTitle:
            'No hay ningún CLI agéntico instalado. mini-tools usa Claude Code, Codex o Antigravity — instalá uno para habilitar el chat.',
    },
    // Lista de conversaciones de la pestaña Git (AgentChatHistory).
    history: {
        untitled: 'Sin nombre',
        allTitle: 'Todas las conversaciones de este repositorio, de cualquier agente',
        all: 'Todas',
        onlyAgentTitle: (p: {agent: string}) => `Solo las conversaciones con ${p.agent}`,
        searchPlaceholder: 'Buscar en las conversaciones…',
        newTitle: 'Empezar una conversación nueva con este agente',
        new: 'Nueva',
        noMatch: (p: {query: string}) => `Ninguna conversación coincide con "${p.query}".`,
        empty: 'Todavía no hay conversaciones en este repositorio. Empezá una desde el + de arriba.',
        externalTitle: 'Ya existía en el agente, fuera de esta app',
        ownTitle: 'Conversación de esta app',
        renameTitle: 'Cambiarle el nombre a esta conversación',
        deleteTitle: 'Quitarla del historial. La conversación sigue existiendo en el agente; se pierde el atajo para retomarla.',
    },
    // Historial de todo el programa (AgentHistoryPanel).
    historyPanel: {
        groups: {
            db: 'Bases de datos',
            git: 'Repositorios',
            ssh: 'Servidores',
            note: 'Notas',
            http: 'Peticiones HTTP',
            none: 'Sin módulo',
        },
        searchPlaceholder: (p: {n: number}) => `Buscar entre ${p.n} conversaciones…`,
        searchTitle:
            'Busca por el título de la conversación o por el nombre de la conexión, repositorio o nota desde donde se abrió',
        clearSearch: 'Limpia la búsqueda',
        onlyKindTitle: (p: {group: string}) =>
            `Estás viendo solo las conversaciones de ${p.group}. Hacé clic para ver todas.`,
        thisModule: 'este módulo',
        onlyThisModule: 'Solo este módulo',
        groupedByModuleTitle: 'Agrupado por módulo (de dónde salió cada conversación). Hacé clic para agrupar por agente.',
        groupedByAgentTitle: 'Agrupado por agente. Hacé clic para agrupar por módulo.',
        module: 'Módulo',
        agent: 'Agente',
        backToChat: 'Vuelve a la conversación, que siguió corriendo detrás',
        empty: 'Todavía no hay conversaciones. Una entra al historial con su primer mensaje.',
        noMatch: (p: {query: string}) => `Ninguna coincide con «${p.query}».`,
        groupTitle: (p: {n: number; group: string}) =>
            `${p.n} ${p.n === 1 ? 'conversación' : 'conversaciones'} · ${p.group}`,
        resumeTitle: (p: {agent: string}) =>
            `Retoma esta conversación con ${p.agent}. Los mensajes los tiene el CLI: se vuelven a dibujar al abrirla.`,
        notInstalledTitle: (p: {agent: string}) =>
            `Esta conversación es de ${p.agent}, que no está instalado en esta máquina.`,
        untitled: 'Sin título',
        renameTitle:
            'Cambiar el nombre de esta conversación. El título sale de lo primero que escribiste, que casi nunca es cómo la vas a buscar después.',
        deleteTitle:
            'Quita la conversación del historial de mini-tools. NO borra la conversación del CLI: esa vive en su propio almacenamiento y se puede seguir retomando desde ahí.',
    },
    limits: {
        resetsAnyMoment: 'se reinicia en cualquier momento',
        resetsInMin: (p: {n: number}) => `se reinicia en ${p.n} min`,
        resetsInHours: (p: {n: number}) => `se reinicia en ${p.n} h`,
        resetsInDays: (p: {n: number}) => `se reinicia en ${p.n} días`,
        justMeasured: 'recién medido',
        measuredMin: (p: {n: number}) => `medido hace ${p.n} min`,
        measuredHours: (p: {n: number}) => `medido hace ${p.n} h`,
        measuredDays: (p: {n: number}) => `medido hace ${p.n} días`,
        queryingTitle:
            'Preguntándole al CLI del agente — arranca su servidor y le consulta la cuota al servicio, suele tardar unos segundos',
        refreshTitle: 'Vuelve a preguntarle al CLI cuánto queda de cada límite. No consume cuota.',
        queryTitle:
            'Le pregunta al CLI del agente cuánto queda de cada límite (lo mismo que /usage dentro de su sesión). Tarda unos segundos y no consume cuota.',
        querying: 'Consultando…',
        refresh: 'Actualizar',
        query: 'Consultar',
        unknown: 'Este agente no publica su límite en el disco.',
        windowTitle: (p: {label: string; percent: number; reset: string; active: boolean; detail: string}) =>
            `${p.label}: ${p.percent}% del límite usado${p.reset ? ` — ${p.reset}` : ' — el proveedor no informa cuándo se reinicia'}${
                p.active ? '. Es la ventana que manda ahora mismo: la primera que corta el trabajo si se llena.' : ''
            }${p.detail ? `\n\n${p.detail}` : ''}`,
        sourceTitle: (p: {source: string}) => `De dónde salió este dato: ${p.source}`,
        plan: (p: {plan: string}) => ` · plan ${p.plan}`,
    },
    refPicker: {
        kindHint: (p: {injects: string; never: string}) => `${p.injects}${p.never ? ` Nunca: ${p.never}` : ''}`,
        kindUnavailable: (p: {injects: string}) => `Todavía no disponible en esta versión. ${p.injects}`,
        gitStaged: 'El diff de lo que está preparado para commitear',
        gitWorktree: 'El diff de lo modificado y todavía sin preparar',
        explainLast: 'El último plan de ejecución de la conexión activa',
        explainConn: 'El último plan guardado de esa conexión',
        notePrivate: 'Marcada como privada: el agente no puede leerla. Abrí el candado en la nota para permitirlo.',
        noteFull: 'Se le manda el Markdown completo de la nota',
        sshLast: 'Las últimas 50 líneas de esa terminal, con los secretos ocultados',
        dbPickTable: (p: {dbType: string}) => `${p.dbType} — elegí una tabla`,
        dbNoConn: 'No hay ninguna conexión guardada con ese nombre',
        dbReading: 'Leyendo el esquema…',
        dbTable: 'Columnas, tipos, PK y FK — nunca filas',
    },
    usage: {
        title: (p: {days: number | null}) => (p.days === null ? 'Consumo' : `Consumo · ${p.days} días`),
        backToChat: 'Vuelve a la conversación, que siguió corriendo detrás',
        thisConversation: 'Esta conversación',
        tokens: (p: {n: string}) => `${p.n} tokens`,
        output: (p: {n: string}) => `${p.n} de salida`,
        reading: 'Leyendo lo que dejó cada CLI…',
        unknownPlan: 'plan desconocido',
        tokensTitle: (p: {total: string; messages: string}) => `${p.total} tokens en ${p.messages} respuestas`,
        conversationsTitle: 'Conversaciones registradas por el CLI en esta máquina',
        conversations: 'Conversaciones:',
        stepsTitle: 'Pasos (turnos de trabajo del agente) sumados de todas las conversaciones',
        steps: 'Pasos:',
        lastUsed: (p: {date: string}) => `último uso: ${p.date}`,
        cacheTitle:
            'Qué parte de los tokens de ENTRADA salió del caché en vez de reprocesarse. Es el único número de acá sobre el que se puede actuar: cuanto más alto, más barata la sesión larga.',
        cache: 'Caché:',
        outputTitle: 'Los tokens que generó el modelo. Son los más caros de las cuatro clases.',
        outputLabel: 'Salida:',
        footer:
            'Las **barras de límite** son el porcentaje que calculó el servidor de cada proveedor y que su CLI dejó cacheado en esta máquina: se leen tal cual, con la hora en que se midieron — no son en vivo. Los porcentajes de **consumo** (modelo, caché) son proporciones de lo gastado, no de un tope. Para el dato del momento, cada CLI lo contesta con su propio comando (`/status`, `/usage`).',
    },
    askPicker: {
        title: 'Con qué proveedor se hace ESTE análisis. No cambia el agente activo de la aplicación: sirve para pedirle la misma pregunta a otro modelo y comparar.',
        activeAgent: 'Agente activo',
        active: 'activo',
    },
    codeBlock: {
        text: 'texto',
        lines: (p: {n: number}) => (p.n === 1 ? '1 línea' : `${p.n} líneas`),
        toTerminalTitle: 'Escribe el comando en la terminal SIN ejecutarlo — lo leés y el Enter lo ponés vos',
        toEditorTitle: 'Inserta este código donde está el cursor, sin pisar lo que ya escribiste',
        inserted: 'Insertado',
        toTerminal: 'A la terminal',
        toEditor: 'Al editor',
        copyTitle: 'Copia el bloque entero al portapapeles',
        copy: 'Copiar',
        copied: 'Copiado',
    },
    aiAccess: {
        tools: {
            vault_search_notes: 'Buscó en tus notas',
            vault_read_note: 'Leyó una nota',
            db_list_connections: 'Listó tus conexiones',
            db_get_schema: 'Leyó el esquema de una tabla',
            db_explain_query: 'Analizó un plan de ejecución',
            ssh_get_recent_logs: 'Leyó una terminal SSH',
            git_status: 'Miró el estado de un repositorio',
            vault_create_note: 'Creó una nota',
            vault_update_note: 'Reescribió una nota suya',
        },
        examplePath: '/ruta/a/mini-tools',
        claudeHow: 'En una terminal, una sola vez:',
        claudeNote: 'Queda disponible en todos tus proyectos. Con `claude mcp list` se verifica que quedó.',
        codexHow: 'Agregá esto a ~/.codex/config.toml:',
        codexNote: 'Si el archivo no existe, crealo con ese contenido.',
        antigravityHow: 'Agregá esto a ~/.gemini/config/mcp_config.json:',
        antigravityNote: 'Si ya tenés otros servidores, agregá solo la entrada "mini-tools" adentro de "mcpServers".',
        heading: 'Acceso de la IA',
        server: 'Servidor MCP',
        intro: 'Deja que Claude Code, Codex o Antigravity le **pidan** datos a mini-tools desde su propia conversación: buscar en tus notas, leer el esquema de una tabla, mirar las últimas líneas de una terminal. **Mientras esté apagado no hay nada escuchando** — ni socket, ni proceso, ni consumo.',
        turnOffTitle:
            'Apagar el servidor: se cierra el canal y se borra el socket. Los agentes dejan de poder pedir datos al instante.',
        turnOnTitle:
            'Encender el servidor. Abre un canal local (nunca un puerto de red) para que los agentes que vos lances puedan pedir datos. Se apaga cuando quieras.',
        socketTitle:
            'El canal es un socket local del sistema de archivos, con permisos solo para tu usuario. Nunca se abre un puerto de red.',
        toolsExposed: (p: {n: number}) =>
            `${p.n} herramientas expuestas. Ninguna devuelve filas de tus bases, ni DSN, ni contraseñas, ni el contenido de una nota que hayas marcado como privada.`,
        notesWriteTitle: 'Dejar que el agente escriba en tu base de conocimiento',
        notesWriteBody:
            'Le agrega herramientas para **crear notas nuevas** —dejar asentado un procedimiento, un diagnóstico, una decisión— y para **corregir las suyas**. Cada nota que crea queda marcada como suya.',
        notesWriteRules:
            '**Nunca toca lo que escribiste vos.** Solo puede reescribir notas que creó él y que nadie editó después: apenas guardás una de sus notas, pasa a ser tuya y él deja de poder cambiarla. Una nota marcada como privada le queda fuera de alcance, igual que para leer. **Borrar no puede nunca.** Apagado, las herramientas ni siquiera aparecen en su catálogo.',
        notesWriteTiming:
            '**Vale sobre la sesión que ya esté abierta**, sin reiniciar el CLI: quitarlo rechaza la llamada aunque el agente todavía crea que puede, y darlo le avisa —después de su próxima acción— que vuelva a pedir la lista de herramientas. Si su CLI ignora ese aviso, alcanza con reiniciarlo.',
        revokeTitle:
            'Quitarle el permiso: la herramienta desaparece de su catálogo y una llamada en curso se rechaza. Las notas que ya creó quedan como están.',
        grantTitle:
            'Darle permiso para crear notas nuevas. Seguirá sin poder modificar ni borrar las tuyas, y vas a ver cada alta en el registro de acceso de abajo.',
        howToTitle: 'Los pasos exactos para que Claude Code, Codex o Antigravity vean este servidor',
        howTo: 'Cómo conectar tu agente a este servidor',
        steps: '3 pasos',
        step1: 'Encendé el servidor con el interruptor de arriba. **Tiene que quedar encendido** mientras uses el agente: apagado no hay nada escuchando.',
        step2: 'Pegá la configuración de tu CLI (abajo). Se hace una sola vez.',
        step3: 'Reiniciá el CLI. Preguntale *"¿qué herramientas de mini-tools tenés?"* para confirmar.',
        copyTitle: 'Copia el comando al portapapeles',
        copy: 'Copiar',
        copied: 'Copiado',
        copyNotWrite:
            '**Se copia y no se escribe solo**, a propósito: el archivo de Claude Code es su archivo de *estado* —con el historial de todos tus proyectos adentro— y reescribirlo entero para agregar una línea es un riesgo desproporcionado.',
        recent: 'Últimos accesos',
        noAccessYet: 'Todavía ningún agente pidió nada.',
        serverOff: 'El servidor está apagado, así que no hay accesos posibles.',
        auditNote:
            'Se registra **qué se pidió, no lo que se leyó**: guardar el contenido sería una segunda copia de lo mismo que se quiere proteger. Vive en memoria y se va al cerrar la app.',
    },
}
