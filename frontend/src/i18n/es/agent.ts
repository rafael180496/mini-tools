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
        prefixRepo: 'Proyecto',
        // Cómo se nombra el recurso en una frase ("sobre repositorio «x»").
        nouns: {
            git: 'repositorio',
            db: 'conexión',
            ssh: 'servidor',
            note: 'nota',
            http: 'petición',
            utilities: 'proyecto',
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
        // Con otro modo ya elegido (por ejemplo el que se recordó de este proyecto).
        emptyWithContextMode: (p: {noun: string; label: string; mode: string}) =>
            `Sobre ${p.noun} **«${p.label}»**. Modo **${p.mode}**: el selector de abajo dice qué puede hacer sin preguntar.`,
        emptyMode: (p: {mode: string}) => `Modo **${p.mode}**: el selector de abajo dice qué puede hacer sin preguntar.`,
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
        // Un servidor de modelos (Ollama, compatible con OpenAI) no es un CLI: sus
        // modos gobiernan las herramientas de archivos y comandos que esta app
        // ejecuta en TU máquina dentro del repositorio de trabajo.
        llmModes: {
            query: {
                label: 'Solo consulta',
                hint: 'Lee y razona. Con un proyecto de trabajo puede leer, listar y buscar archivos y consultar sus skills; usa también las herramientas MCP si el servidor está encendido. No modifica nada.',
            },
            plan: {
                label: 'Plan',
                hint: 'Explora (lee archivos y busca) y arma un plan, sin escribir archivos ni correr comandos.',
            },
            approve: {
                label: 'Aprobar cada acción',
                hint: 'Puede escribir y editar archivos y correr comandos en el proyecto de trabajo, pero te pregunta antes de CADA una. Las herramientas MCP (notas, bases) no preguntan.',
            },
            auto: {
                label: 'Automático',
                hint: 'Trabaja solo, como un asistente de código: edita y crea archivos y corre comandos del proyecto sin preguntar. Los comandos de riesgo (rm -rf, git push, sudo…) siempre preguntan. Un comando corre con tus permisos y puede tocar cosas fuera del proyecto.',
            },
            edit: {
                label: 'Aplicar ediciones',
                hint: 'Crea y edita archivos del proyecto sin preguntar. Los comandos le preguntan cada vez. En un repositorio git los cambios caen en el árbol de trabajo: se ven en Cambios y se descartan desde ahí.',
            },
        },
        willEditFilesLlm: 'Edita archivos; los comandos preguntan',
        actsAloneLlm: 'Edita y corre comandos sin preguntar',
        allowEditsDescriptionLlm: (p: {agent: string}) =>
            `${p.agent} va a crear y editar archivos del proyecto de trabajo sin volver a preguntarte, durante toda esta sesión de chat. Cada comando que quiera correr sí te lo va a preguntar. En un repositorio git los cambios quedan en el árbol de trabajo: los ves en Cambios y los descartás desde ahí; en una carpeta sin git no hay vuelta atrás automática.`,
        allowAutoDescriptionLlm: (p: {agent: string}) =>
            `${p.agent} va a editar y crear archivos y correr comandos del proyecto de trabajo sin preguntarte, durante toda esta sesión de chat. Solo los comandos de riesgo (rm -rf, git push, git reset --hard, sudo…) piden tu permiso. Los archivos están confinados al proyecto, pero un comando corre con tus permisos y puede afectar cosas fuera de él. Si el proyecto es una carpeta sin git, no hay vuelta atrás automática. Se te pregunta esta vez; después queda recordado para este proyecto.`,
        // Diálogo de aprobación de UNA acción (herramienta) del agente.
        approval: {
            title: (p: {tool: string}) => `¿Permitir ${p.tool}?`,
            titleRisky: (p: {tool: string}) => `Comando de riesgo (${p.tool})`,
            riskyReason: (p: {reason: string}) => `Motivo: ${p.reason}`,
            intro: (p: {agent: string; tool: string}) => `${p.agent} quiere ejecutar ${p.tool}:`,
            waiting: 'El agente está esperando tu respuesta. Si denegás, no lo hace y se le dice por qué.',
            riskyHint:
                'Puede borrar o sobrescribir datos sin vuelta atrás. Estos comandos preguntan siempre, en todos los modos: revisalo antes de permitirlo.',
            deny: 'Denegar',
            denyTitle: 'No lo ejecuta y le avisa al agente que no lo autorizaste',
            allow: 'Permitir',
            allowTitle: 'Deja que el agente ejecute esta acción, una vez',
            allowRisky: 'Permitir de todos modos',
            allowRiskyTitle: 'Ejecuta este comando de riesgo bajo tu responsabilidad. Solo vale para esta vez.',
        },
        toolCard: {
            openNote: 'Abrir nota',
            openNoteTitle: (p: {title: string}) => `Abre la nota «${p.title}» en una pestaña`,
            skillTitle: 'Carga las instrucciones completas de una skill del proyecto, que el modelo eligió por su nombre y descripción',
            skillFileTitle: 'Lee un archivo que acompaña a una skill (una plantilla, un script, una referencia). Solo lectura.',
            globTitle: 'Busca archivos del proyecto por patrón de nombre (por ejemplo **/*.go). Solo lectura.',
        },
        // Sugerencia del modo Automático sobre un proyecto (servidores de modelos).
        autoHint: {
            text: 'Para que trabaje como un asistente de código —**edita y crea archivos y corre comandos sin preguntar**; los de riesgo (rm -rf, git push, sudo…) siempre preguntan— elegí el modo **Automático**.',
            use: 'Usar Automático',
            useTitle: 'Cambia al modo Automático, con la confirmación de siempre la primera vez en este proyecto. Queda recordado para la próxima.',
            dismissTitle: 'No volver a sugerirlo en este proyecto',
        },
        // Servidor de modelos sin repositorio de trabajo (Chat de IA).
        noRepo: {
            onlyMcp:
                'Sin proyecto de trabajo, este modelo solo dispone de las **herramientas MCP** (notas, bases, SSH, Git). Para que lea o edite archivos y corra comandos, elegí un proyecto —un repositorio o una carpeta— en la cabecera.',
            noTools:
                'Sin proyecto de trabajo y con el servidor MCP apagado, este modelo **no tiene herramientas**: solo conversa. Elegí un proyecto en la cabecera, o encendé el servidor MCP en Configuración → IA.',
            dismissTitle: 'Ocultar este aviso',
        },
        // Servidor de modelos remoto con herramientas de archivos o comandos.
        remote: {
            banner: (p: {server: string; url: string}) =>
                `**«${p.server}» es un servidor remoto** (${p.url}). Con herramientas de archivos o comandos, lo que el agente lea —contenido de archivos, salida de comandos— se envía a ese servidor.`,
            ack: 'Entendido',
            ackTitle: 'Oculta este aviso en esta conversación',
            recorded: (p: {server: string}) =>
                `Aviso: «${p.server}» es un servidor remoto. Lo que el agente lea de tu proyecto (archivos, salida de comandos) se envía a ese servidor.`,
            chip: 'remoto',
            chipTitle: (p: {server: string; url: string}) =>
                `«${p.server}» está en otra máquina (${p.url}). Lo que le mandes, y lo que el agente lea con sus herramientas, viaja por la red.`,
        },
        // «Guardar en mi cerebro»: el agente registra notas solo.
        brain: {
            label: 'Guardar en mi cerebro',
            titleOn: (p: {root: string}) =>
                `Activado para esta conversación: el agente deja en tu cerebro («${p.root}») lo que valga la pena conservar, en notas por proyecto o por tema. Hacé clic para apagarlo.`,
            titleOff: (p: {root: string}) =>
                `Apagado. Si lo activás, el agente anota por su cuenta en tu cerebro («${p.root}») lo que valga la pena conservar. Cada nota es visible y queda marcada como creada por un agente. Se recuerda en esta conversación.`,
            blockedMcp:
                'No disponible: el servidor MCP está apagado. Se enciende en Configuración → IA. Hacé clic para abrirla.',
            blockedNotes:
                'No disponible: falta el permiso de escritura de notas. Se da en Configuración → IA → Acceso de la IA. Hacé clic para abrirla.',
            applyFailed: (p: {error: string}) => `No se pudo guardar el ajuste «Guardar en mi cerebro»: ${p.error}`,
        },
        // Arranques del chat vacío, por módulo. El texto visible es el mismo
        // que se escribe en la caja, así que sigue el idioma de la interfaz.
        starters: {
            db: ['Explicá esta consulta', 'Optimizá esta consulta', '¿Qué tablas tiene esta conexión?'],
            ssh: ['¿Qué falló acá?', 'Explicá este log', '¿Cómo reviso el uso de disco?'],
            http: ['Explicá esta respuesta', '¿Por qué falla esta petición?', 'Escribí pruebas para este endpoint'],
            note: ['Resumí esta nota', '¿Este procedimiento sigue teniendo sentido?', 'Ampliá el último paso'],
            git: ['¿Qué cambió en esta rama?', 'Revisá los cambios preparados', 'Escribí el mensaje del commit'],
            utilities: [
                'Explicame un concepto técnico',
                'Ayudame a depurar un error',
                'Escribí un script que automatice una tarea',
                'Revisá este código y proponé mejoras',
            ],
            none: ['¿Qué podés hacer en mini-tools?'],
        },
        starterTitle: 'Escribe esto en la caja de mensaje. Podés editarlo antes de mandarlo.',
        startersLabel: 'Sugerencias para empezar',
        // Etiquetas de accesibilidad de los controles que son solo un ícono.
        a11y: {
            messages: 'Conversación',
            composer: 'Mensaje para el agente',
            send: 'Enviar mensaje',
            stop: 'Detener el turno',
            enqueue: 'Dejar el mensaje en cola',
            search: 'Buscar en la conversación',
            reset: 'Reiniciar la conversación',
            jumpLatest: 'Ir al último mensaje',
            copyMessage: 'Copiar el mensaje',
        },
        jumpLatestTitle: 'Vuelve al final de la conversación. Mientras leías más arriba, la respuesta que sigue llegando no te movió de lugar.',
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
        noneInstalledTitle: 'No hay ningún CLI agéntico instalado ni servidor de modelos agregado. Configuralos en Configuración → IA.',
        pickerTitle:
            'Con qué agente hablás. Cambiarlo empieza una conversación nueva: el historial lo guarda cada CLI por su cuenta, así que otro no puede continuar la anterior.',
        noneInstalled: 'Ninguno instalado',
        pickAgent: 'Elegí un agente',
        backToChat: 'Vuelve a la conversación, que siguió corriendo detrás',
        usageTitle:
            'Cuánta cuota llevás usada y cuántos tokens gastaste con cada CLI y con cada servidor de modelos (Ollama, OpenAI-compatible), con tu plan al lado. Ocupa el panel como una solapa: el chat sigue donde estaba.',
        historyTitle:
            'Conversaciones anteriores de TODOS los módulos, no solo de este. Retomar una la continúa donde había quedado. Ocupa el panel como una solapa.',
        dockFloat: 'Ventana flotante: el chat queda por encima del contenido, sin quitarle ancho',
        dockLeft: 'Anclar el panel a la izquierda',
        dockRight: 'Anclar el panel a la derecha',
        dockBottom: 'Anclar el panel a la parte de abajo',
        closeTitle: 'Cierra el panel. La conversación queda como está: volver a abrirlo la retoma.',
        emptyNoAgent: 'No hay ningún agente instalado',
        emptyNoAgentHint:
            'mini-tools usa los CLIs que ya tengas (Claude Code, Codex o Antigravity) o un servidor de modelos (Ollama u otro compatible con OpenAI). Instalá un CLI o agregá un servidor en Configuración → IA y aparecerá acá.',
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
            utilities: 'Chat de IA',
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
        // Servidores de modelos (Ollama, compatibles con OpenAI): su consumo sale
        // del historial de chats de la app, no de archivos de un CLI.
        servers: {
            title: 'Servidores de modelos',
            reading: 'Leyendo el historial de los servidores…',
            local: 'Local',
            remote: 'Remoto',
            localTitle: 'Corre en esta máquina: lo que le mandás no sale de ella',
            remoteTitle: 'Corre en otra máquina: lo que le mandás viaja por la red hasta ella',
            deletedTitle: 'Este servidor ya no está en la lista, pero quedan conversaciones suyas dentro de la ventana',
            unused: 'Sin uso en estos días',
            tokens: (p: {n: string}) => `${p.n} tokens`,
            tokensTitle: (p: {total: string; input: string; output: string}) => `${p.total} tokens en total: ${p.input} de entrada y ${p.output} de salida`,
            inOut: (p: {input: string; output: string}) => `${p.input} entrada · ${p.output} salida`,
            turns: (p: {n: number}) => (p.n === 1 ? '1 turno' : `${p.n} turnos`),
            turnsTitle: 'Respuestas del modelo guardadas en el historial (un turno es un mensaje tuyo con todo lo que el modelo hizo para contestarlo)',
            conversations: (p: {n: number}) => (p.n === 1 ? '1 conversación' : `${p.n} conversaciones`),
            conversationsTitle: 'Conversaciones distintas con este servidor dentro de la ventana',
            speed: (p: {n: string}) => `${p.n} tok/s`,
            speedTitle: 'Velocidad media de salida: tokens generados por segundo de generación del servidor. No cuenta la espera de aprobaciones ni lo que tardan las herramientas.',
            speedUnknown: 'velocidad sin medir',
            speedUnknownTitle: 'Todavía no hay turnos con el tiempo de generación registrado. Los de antes de esta versión no lo tienen.',
            modelTokensTitle: (p: {total: string; turns: number}) => `${p.total} tokens en ${p.turns} turnos`,
            unknownModel: 'modelo sin registrar',
            unknownModelTitle: 'Turnos guardados antes de que la app registrara con qué modelo se hizo cada uno',
            dailyTitle: (p: {first: string; last: string; max: string}) => `Tokens por día, del ${p.first} al ${p.last}. El día más alto: ${p.max}.`,
            dayBar: (p: {day: string; tokens: string; turns: number}) => `${p.day}: ${p.tokens} tokens · ${p.turns === 1 ? '1 turno' : `${p.turns} turnos`}`,
            lastUsed: (p: {date: string}) => `último uso: ${p.date}`,
            costNote:
                'No se muestra costo: un servidor propio o compatible con OpenAI no informa precio por token, y calcularlo acá sería inventarlo. Lo que ves son tokens, turnos y velocidad.',
            tokensNote: 'Los tokens son los que informó cada servidor; uno que no los informa figura con turnos pero sin tokens.',
        },
    },
    // Salud de un servidor de modelos (punto de estado, aviso del chat).
    health: {
        statusOk: 'Responde',
        statusError: 'Sin respuesta',
        statusChecking: 'Comprobando',
        statusUnknown: 'Sin comprobar',
        agoNow: 'hace un momento',
        ago: (p: {sec: number}) => (p.sec < 5 ? 'hace un momento' : p.sec < 60 ? `hace ${p.sec} s` : `hace ${Math.floor(p.sec / 60)} min`),
        dotOk: (p: {server: string; latency: number; ago: string}) => `«${p.server}» responde · ${p.latency} ms · comprobado ${p.ago}`,
        dotError: (p: {server: string; error: string}) => `«${p.server}» no responde: ${p.error}`,
        dotChecking: (p: {server: string}) => `Comprobando si «${p.server}» responde…`,
        dotUnknown: (p: {server: string}) => `Todavía no se comprobó si «${p.server}» responde`,
        badgeOk: (p: {latency: number}) => `${p.latency} ms`,
        badgeError: 'sin respuesta',
        badgeChecking: 'comprobando…',
        bannerTitle: (p: {server: string}) => `«${p.server}» no responde`,
        bannerHint: 'Podés seguir escribiendo, pero enviar va a fallar enseguida hasta que el servidor conteste.',
        serverGone: 'Este servidor ya no está en la lista',
        retry: 'Reintentar',
        retrying: 'Comprobando…',
        retryTitle: 'Vuelve a preguntarle ahora al servidor si responde, sin esperar a la próxima comprobación automática (cada 60 s mientras el chat está a la vista)',
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
    // Configuración → IA → Cerebro: carpeta raíz y qué falta para encenderlo.
    brainPanel: {
        heading: 'Cerebro',
        title: 'Notas que escribe el agente',
        intro:
            'Con **Guardar en mi cerebro** encendido en una conversación, el agente anota solo lo que valga la pena conservar —un procedimiento, un diagnóstico, una decisión— como notas tuyas, ordenadas por proyecto y por tema. Está **apagado por defecto** y se enciende conversación por conversación.',
        reqMcp: 'Servidor MCP encendido',
        reqMcpHint: 'Se enciende arriba, en «Acceso de la IA»: las notas entran por sus herramientas.',
        reqNotes: 'Escritura de notas permitida',
        reqNotesHint: 'Se da arriba, en «Acceso de la IA»: sin ese permiso el agente solo puede leer tus notas.',
        reqChat: 'En cada conversación: interruptor **Guardar en mi cerebro**, junto al selector de modo.',
        rootLabel: 'Carpeta del cerebro',
        rootTitle: 'Carpeta de tus notas donde el agente escribe. Por defecto «Cerebro»; se crea sola con la primera nota.',
        rootHint: (p: {def: string}) =>
            `Ruta dentro de tus notas, con \`/\` para subcarpetas (p. ej. \`Trabajo/Cerebro\`). Por defecto \`${p.def}\`. Cambiarla no mueve las notas que ya existan.`,
        rootInvalid: 'Ruta no válida: sin carpetas vacías ni «..», hasta 80 caracteres.',
        save: 'Guardar',
        saved: 'Guardado',
        saveTitle: 'Guarda la carpeta raíz. Vale para las próximas notas que escriba el agente.',
        structureHeading: 'Cómo lo ordena',
        exampleProjectNote: 'Decisión de caché',
        exampleTopicNote: 'Índices en Oracle',
        structureBody:
            'Con contexto (un repositorio, una conexión, un servidor SSH) escribe en **Proyectos/<proyecto>**; sin contexto, en **Temas/<tema>**. Antes de crear busca, para **ampliar** una nota con `vault_append_to_note` en vez de duplicarla; enlaza con `[[Título]]` y etiqueta con `#etiqueta`.',
        indexBody:
            'Cada proyecto y cada tema tiene una nota **_Índice** (un mapa de contenido, como en Obsidian) que enlaza a sus notas: el grafo de notas lo muestra como un cerebro navegable.',
        rules:
            'Las reglas de siempre siguen: no toca notas privadas, no reescribe notas tuyas y todo queda en el registro de accesos.',
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
            vault_append_to_note: 'Amplió una nota suya',
            vault_list_folders: 'Listó las carpetas de notas',
            vault_list_notes: 'Listó las notas de una carpeta',
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
