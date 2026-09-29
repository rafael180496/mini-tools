// Textos del área «notes». Ver .claude/specs/i18n.md.
export default {
    untitled: 'Sin título',
    image: 'imagen',
    imageFailed: (p: {alt: string}) => `${p.alt} — no se pudo cargar`,

    editor: {
        imageReadFailed: 'No se pudo leer la imagen',
        imageTypeUnreadable: (p: {type: string}) =>
            `No se pudo leer una imagen de tipo ${p.type}. Las notas guardan PNG y JPG; probá con una captura de pantalla.`,
        imageTypeUnknown: 'desconocido',
        imageConvertFailed: 'No se pudo convertir la imagen',
        pastedImageName: 'captura',
        titleRequired: 'La nota necesita un título: es lo que la hace enlazable con [[…]]',
        placeholder: 'Escribí en Markdown. «[[» enlaza otra nota, «/» inserta un bloque.',
        tagCount: (n: number) => (n === 1 ? '1 nota' : `${n} notas`),
        completionPrivate: 'privada',
        completionVisible: 'visible para la IA',
        privateTitle:
            'PRIVADA: ningún agente puede leer esta nota, ni por el chat ni por el servidor MCP. Sigue apareciendo en tu grafo y en tus búsquedas. Hacé clic para volver a compartirla.',
        visibleTitle:
            'VISIBLE PARA LA IA (el estado por defecto): los agentes pueden leer el contenido de esta nota si la referenciás o la buscan. Hacé clic para esconderla.',
        private: 'Privado',
        aiAllowed: 'Acceso IA permitido',
        noAgent: 'No hay ningún CLI agéntico instalado. mini-tools usa Claude Code, Codex o Antigravity.',
        chatPrivate:
            'Abre el chat con esta nota como contexto. Como está marcada como PRIVADA, su contenido no se le manda: podés preguntar igual, pero el agente no la lee.',
        chatVisible:
            'Abre el chat con el contenido de esta nota ya referenciado, para preguntar sobre ella, ampliarla o revisar un procedimiento.',
        backToEdit: 'Volver a editar el Markdown',
        showPreview: 'Ver la nota renderizada, con los enlaces navegables',
        deleteTitle:
            'Borra esta nota. Los enlaces que le apuntaban desde otras notas quedan visibles como rotos, no se borran en silencio.',
        corrupt:
            'El checksum de esta nota no coincide con su contenido: puede haberse dañado. Se muestra igual para que puedas rescatar lo que quede — al guardarla, el checksum se recalcula.',
        foldSummary: 'Ver detalle',
        externalChange: 'Un agente reescribió esta nota mientras la editabas. Tus cambios sin guardar siguen acá.',
        viewAgentVersionTitle: 'Descarta lo que escribiste sin guardar y muestra la versión que dejó el agente',
        viewAgentVersion: 'Ver la del agente',
        keepMineTitle:
            'Sigue editando lo tuyo. Al guardar, tu versión reemplaza a la del agente — y la nota pasa a ser tuya: no la va a poder volver a cambiar.',
        keepMine: 'Seguir con lo mío',
        titleFieldTitle:
            'El título es lo que otras notas usan para enlazarla con [[…]]. Cambiarlo deja rotos los enlaces que le apuntaban — se ven marcados en la nota que los tiene.',
        outgoing: 'Enlaces salientes',
        outgoingHint: 'Notas que ESTA menciona con [[…]]',
        uncreated: (n: number) => `Sin crear (${n})`,
        uncreatedTitle:
            'Esta nota enlaza algo que todavía no existe. Hacé clic para crearla — así es como se va armando el grafo.',
        untitledLink: 'nota sin título',
        backlinks: 'Backlinks',
        backlinksHint: 'Notas que apuntan a ESTA',
        none: 'Ninguno',
        privateSuffix: (p: {title: string}) => `${p.title} — privada`,
        linkGroupTitle: (p: {title: string; n: number}) => `${p.title} (${p.n})`,
        backlinkCountTitle:
            'Cuántas notas apuntan a esta con [[…]]. Cero significa que está aislada del resto de tu base de conocimiento.',
        backlinkCount: (p: {n: number; formatted: string}) => `${p.formatted} ${p.n === 1 ? 'backlink' : 'backlinks'}`,
        wordsTitle: 'Palabras del cuerpo de la nota',
        words: (p: {formatted: string}) => `${p.formatted} palabras`,
        linesTitle:
            'Líneas y caracteres. El editor de notas no muestra números de línea al costado —un documento no tiene líneas que referenciar— pero el número sigue estando acá cuando hace falta.',
        linesChars: (p: {lines: string; chars: string}) => `${p.lines} líneas · ${p.chars} caracteres`,
        saving: 'Guardando…',
        unsaved: 'Sin guardar',
        saved: 'Guardado',
        shareConfirmTitle: 'Volver a compartir esta nota con los agentes',
        shareConfirmDescription: (p: {title: string}) =>
            `El contenido completo de «${p.title}» va a poder ser leído por Claude Code, Codex o Antigravity cuando la referencies con @note o cuando la busquen. Las credenciales, claves y datos personales que tenga adentro salen con ella. Podés volver a esconderla en cualquier momento.`,
        share: 'Compartir',
        deleteConfirmTitle: 'Borrar la nota',
        deleteConfirmDescription: (p: {title: string}) =>
            `«${p.title}» se borra del vault. Las notas que la enlazaban van a mostrar el enlace como roto, con la opción de volver a crearla. Esto no se puede deshacer.`,
    },

    toolbar: {
        alignLeft: 'Alinear a la izquierda',
        alignCenter: 'Centrar',
        alignRight: 'Alinear a la derecha',
        alignJustify: 'Justificar',
        alignTitle: (p: {label: string}) =>
            `${p.label}. Es una propiedad de la nota, no del texto: el Markdown queda limpio y se sigue abriendo igual en cualquier otro editor.`,
        h1: 'Título de sección (# en Markdown)',
        h2: 'Subtítulo (## en Markdown)',
        h3: 'Sub-subtítulo (### en Markdown)',
        bold: 'Negrita — seleccioná el texto y apretá acá (Cmd/Ctrl+B)',
        italic: 'Itálica — seleccioná el texto y apretá acá (Cmd/Ctrl+I)',
        strike: 'Tachado',
        inlineCode: 'Código en línea',
        bullets: 'Lista con viñetas',
        numbered: 'Lista numerada',
        checklist: 'Lista de verificación',
        quote: 'Cita',
        webLink: 'Enlace a una página web. Para enlazar OTRA NOTA, escribí [[ y elegila de la lista.',
        noteLink: 'Enlace a otra nota. También se abre escribiendo [[ en el texto.',
        image:
            'Inserta una imagen PNG o JPG. Se guarda CIFRADA dentro del vault, igual que el texto de la nota, y los PNG se recomprimen sin perder un solo píxel. También podés pegarla con Cmd/Ctrl+V.',
        table: 'Tabla de dos columnas',
        tableField: 'Campo',
        tableValue: 'Valor',
        fold: 'Bloque plegable, para el detalle largo',
        markdownTitle:
            'La nota se guarda como Markdown puro: exportada, se abre en Obsidian o en cualquier editor de texto sin perder nada.',
    },

    slash: {
        h1: 'Título de sección',
        h2: 'Subtítulo',
        h3: 'Sub-subtítulo',
        callout: 'Caja resaltada — INFO, WARNING, SECURITY o TIP',
        warning: 'Caja de advertencia',
        security: 'Caja de seguridad — para lo que no hay que hacer nunca',
        table: 'Tabla Markdown de 3 columnas',
        tableHeader: '| Campo | Valor | Notas |',
        toggle: 'Bloque plegable — para el detalle largo que no siempre se mira',
        checklist: 'Lista de verificación — los pasos de un procedimiento',
        sql: 'Bloque SQL EJECUTABLE contra una conexión guardada',
        ssh: 'Bloque de comandos para un servidor guardado',
        mermaid: 'Diagrama (se muestra como código: ver la nota de peso en el plan)',
        code: 'Bloque de código',
    },

    lint: {
        brokenLink: (p: {target: string}) =>
            `La nota «${p.target}» todavía no existe. En un grafo de conocimiento eso es normal: el enlace queda pendiente hasta que la escribas.`,
        createNote: 'Crear la nota',
        headingSpace:
            'Un encabezado necesita un espacio después de las almohadillas. Sin el espacio esto es una ETIQUETA, no un título — es la confusión más común de Markdown.',
        convertToHeading: 'Convertir en título',
        exampleUrl: 'Este enlace todavía tiene la dirección de ejemplo: reemplazá `url` por la real.',
        unclosedFence:
            'Este bloque de código no se cierra, así que todo lo que sigue se muestra como código. Agregá ``` al final.',
        closeAtEnd: 'Cerrarlo al final',
    },

    frontmatterLint: {
        missing:
            'Falta el bloque de frontmatter. Sin él, el CLI no carga este archivo — y no avisa: simplemente no aparece. Tiene que empezar con una línea "---".',
        unclosed: 'El bloque de frontmatter nunca se cierra: falta la línea "---" del final.',
        whyName: 'Sin `name`, el CLI no tiene con qué referirse a esto y lo ignora.',
        whyDescription:
            'Sin `description`, el agente no tiene con qué decidir si esto es relevante para lo que le pediste, así que en la práctica nunca lo usa.',
        missingKey: (p: {key: string; why: string}) => `Falta \`${p.key}\` en el frontmatter. ${p.why}`,
        emptyKey: (p: {key: string; why: string}) => `\`${p.key}\` está vacío. ${p.why}`,
    },

    livePreview: {
        wikiEditing: (p: {target: string}) => `Cmd/Ctrl + clic para abrir «${p.target}». Sin la tecla, el clic edita el enlace.`,
        wikiOpen: (p: {target: string}) => `Abrir «${p.target}». Si todavía no existe, se ofrece crearla.`,
    },

    preview: {
        tagTitle: 'Etiqueta. Buscá «tag:…» en el buscador de notas para encontrar todas las que la tienen.',
        openNote: (p: {target: string}) => `Abrir la nota «${p.target}». Si no existe, se ofrece crearla.`,
        noteRef: (p: {target: string}) => `Nota: ${p.target}`,
        callout: {
            INFO: 'Info',
            TIP: 'Tip',
            WARNING: 'Atención',
            SECURITY: 'Seguridad',
            DANGER: 'Peligro',
            NOTE: 'Nota',
        },
        checkboxTitle: 'Se marca escribiendo en el editor: esta es la vista de lectura.',
        frontmatterTitle: 'Frontmatter: de estos campos depende que el CLI cargue este archivo',
    },

    graph: {
        title: 'Grafo de conocimiento',
        counts: (p: {notes: number; links: number}) => `${p.notes} notas · ${p.links} enlaces`,
        selfLinksTitle:
            'Notas que se enlazan a sí mismas. No se dibujan —una línea de un nodo a sí mismo no dice nada— pero se cuentan acá: si no, el enlace aparece en el panel lateral de la nota y en el grafo no se ve ninguna línea, y el grafo parece roto.',
        selfLinks: (n: number) => `· ${n} a sí misma`,
        brokenLinksTitle:
            'Enlaces que apuntan a notas que todavía no existen. No se dibujan porque no hay a dónde ponerlos, pero se cuentan: son el trabajo pendiente de tu base.',
        brokenLinks: (n: number) => `· ${n} sin destino`,
        hideOrphansTitle: 'Oculta las notas que no enlazan ni son enlazadas por ninguna otra',
        hideOrphans: 'Sin huérfanas',
        hidePrivateTitle:
            'Oculta las notas marcadas como privadas. Solo cambia esta vista: siguen existiendo y siguen sin ser legibles para los agentes.',
        hidePrivate: 'Sin privadas',
        closeTitle: 'Cierra el grafo y vuelve a lo que estabas haciendo (Esc)',
        emptyBefore: 'Todavía no hay notas que graficar. Escribí',
        emptyExample: '[[Otra nota]]',
        emptyAfter: 'dentro de una para empezar a conectarlas.',
        canvasTitle:
            'Arrastrá un nodo para moverlo, el fondo para desplazar el grafo, y la rueda para acercar. Un clic abre la nota.',
    },

    runbook: {
        rowsSummary: (p: {rows: number; ms: number}) => `${p.rows} filas · ${p.ms} ms`,
        cancelled: 'Cancelada',
        unknownError: 'error desconocido',
        connectionGone: (p: {name: string}) => `La conexión «${p.name}» ya no está guardada en este equipo.`,
        sshConnection: (p: {name: string}) => `«${p.name}» es una conexión SSH: este bloque es SQL.`,
        moreStatements: (n: number) => `…y ${n} sentencia(s) más.`,
        executable: 'bloque ejecutable',
        cancelTitle: 'Corta la ejecución en curso',
        runTitle: (p: {name: string}) =>
            `Ejecuta SOLO este bloque contra «${p.name}». Si esa conexión está marcada como producción y la sentencia modifica datos o estructura, se pide la misma confirmación que en el editor SQL.`,
        run: 'Ejecutar',
        resultTitle:
            'El resultado no se guarda dentro de la nota: se muestra acá y se va al cerrar. Una nota con las filas de la última corrida pegadas adentro es documentación que envejece sola.',
        showing: (p: {total: number}) => ` · mostrando 200 de ${p.total}`,
        prodTitle: (p: {name: string}) => `Estás en PRODUCCIÓN — ${p.name}`,
        prodDescription: (p: {detail: string}) =>
            `Este bloque del runbook modifica datos o estructura en una conexión marcada como Producción:\n\n${p.detail}`,
        runAnyway: 'Ejecutar igual',
    },
}
