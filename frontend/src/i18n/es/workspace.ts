// Textos del área «workspace». Ver .claude/specs/i18n.md.
export default {
    // Nombres con los que nace cada pestaña.
    tabs: {
        untitledQuery: 'Query sin título',
        quickRequest: 'Petición rápida',
        note: 'Nota',
        redisBrowser: 'Redis Browser',
        mongoBrowser: 'MongoDB Browser',
        mongoQuery: 'Consulta Mongo',
        terminal: (p: {name: string}) => `Terminal — ${p.name}`,
        session: (p: {name: string}) => `Sesión — ${p.name}`,
        sftp: (p: {name: string}) => `SFTP — ${p.name}`,
        git: (p: {name: string}) => `Git — ${p.name}`,
    },
    // Menú master de la barra lateral.
    modules: {
        connections: 'Conexiones',
        connectionsHint: 'bases de datos: explorar el esquema y correr consultas',
        sshHint: 'servidores remotos: abrir una terminal o transferir archivos',
        gitHint: 'repositorios: ver cambios, ramas y trabajar con los agentes',
        notes: 'Notas',
        notesHint: 'tu base de conocimiento cifrada: runbooks y apuntes',
        httpHint: 'colecciones de peticiones: probar y guardar endpoints',
    },
    gitSidebarLabel: 'sidebar Git',
    // Mensajes de la barra de estado.
    status: {
        backupSaved: (p: {path: string}) => `Backup guardado en ${p.path}`,
        backupNotSaved: 'No se guardó ningún backup: se cerró el diálogo sin elegir dónde.',
        txOpened: 'Transacción abierta — auto-commit desactivado',
        committed: 'Commit hecho — auto-commit activado',
        rolledBack: 'Rollback hecho — auto-commit activado',
        refreshingMetadata: 'Actualizando metadata…',
        txBusy: (p: {name: string}) =>
            `"${p.name}" tiene una transacción abierta y ya está ejecutando: las dos corridas compartirían esa transacción. Esperá a que termine, o hacé Commit/Rollback.`,
        unknownError: 'Error desconocido',
        pickMongoDb: 'Elegí una base de datos en el árbol lateral antes de ejecutar comandos MongoDB',
        bindFirst: 'Vinculá esta pestaña a una conexión antes de ejecutar (ícono a la izquierda del título)',
        configExported: (p: {path: string}) => `Config exportada a ${p.path}`,
        disconnected: 'Desconectado',
        connectionDeleted: 'Conexión eliminada',
        schemaDdlExported: (p: {path: string}) => `DDL del schema exportado a ${p.path}`,
        remoteSaved: (p: {path: string; conn: string}) => `Guardado ${p.path} en ${p.conn}`,
        binaryFile: (p: {path: string}) => `"${p.path}" es un archivo binario — no se puede editar como texto.`,
        tooLarge: (p: {path: string}) => `"${p.path}" es demasiado grande para abrirlo en el editor.`,
        catalogUnreadable: 'no se pudo leer el catálogo',
    },
    // Confirmaciones antes de ejecutar SQL.
    confirmRun: {
        prodTitle: (p: {name: string}) => `Estás en PRODUCCIÓN — ${p.name}`,
        prodDescription: (p: {detail: string; more: number}) =>
            `Este script modifica datos o estructura en una conexión marcada como Producción:\n\n${p.detail}${
                p.more > 0 ? `\n\n…y ${p.more} sentencia(s) más.` : ''
            }`,
        lintTitle: 'Advertencias antes de ejecutar',
        lintLine: (p: {line: number; message: string}) => `Línea ${p.line}: ${p.message}`,
    },
    // Lo que deja en la consola una edición de la grilla.
    gridEdit: {
        rolledBack: '-- la transacción se revirtió entera, no quedó ninguna sentencia aplicada',
        origin: 'Edición de la grilla',
        originMany: (n: number) => `Edición de la grilla · ${n} sentencias en una transacción`,
    },
    deletedFiles: {
        title: 'Archivos no encontrados',
        body: 'Estos archivos estaban abiertos la última vez pero ya no existen en disco — no se van a volver a abrir automáticamente:',
        closeTitle: 'Cierra este aviso — las pestañas de archivos que ya no existen en disco quedan como pestañas sin guardar',
        ok: 'Entendido',
    },
    agent: {
        editorQuery: 'Consulta del editor',
        insertNote: 'Inserta el bloque en la nota, donde está el cursor',
        insertEditor: 'Inserta el bloque en el editor, donde está el cursor — no pisa lo que ya escribiste',
    },
    // Barra de acciones del editor.
    toolbar: {
        save: 'Guardar la pestaña en disco (Ctrl+S). Si es una pestaña nueva, te pide dónde guardarla',
        runTitle: 'Ejecutar lo seleccionado, o la sentencia donde está el cursor si no hay selección (Ctrl+Enter)',
        run: 'Ejecutar',
        runAll: 'Ejecutar TODOS los statements del editor en orden, uno por uno (Ctrl+Shift+Enter)',
        cancelDisabled: 'Cancelar: deshabilitado, no hay ninguna consulta corriendo en esta pestaña',
        interruptMany: (n: number) => `Interrumpir las ${n} corridas de esta pestaña. No toca lo que estén ejecutando las demás.`,
        interruptOne: 'Interrumpir la consulta que está corriendo en esta pestaña. No toca lo que estén ejecutando las demás.',
        explain:
            'Explain: muestra el plan de ejecución SIN correr nada. Explica lo que tengas seleccionado; sin selección, la sentencia donde está el cursor — no el archivo entero',
        explainAnalyze:
            'Explain Analyze — EJECUTA la consulta de verdad contra la base y muestra el plan con filas y tiempos reales. Corre lo seleccionado; sin selección, la sentencia donde está el cursor. Si modifica datos se pide confirmación y la ejecución va en una transacción que se revierte',
        refresh: 'Refrescar el catálogo: vuelve a leer tablas y columnas de la base (F5) — usalo si acabás de crear o alterar una tabla',
        txOpen: 'Transacción abierta',
        commit: 'Commit: confirma de forma permanente todos los cambios (INSERT/UPDATE/DELETE) hechos desde que se abrió la transacción, y vuelve a auto-commit',
        rollback: 'Rollback: descarta todos los cambios pendientes de la transacción, vuelve al estado previo a abrirla y reactiva el auto-commit',
        autoCommit:
            'Auto-commit activo: cada statement se aplica solo apenas termina. Clic para pasar a transacción manual — a partir de ahí los cambios quedan pendientes hasta que hagas Commit o Rollback',
        dbmsOn: 'DBMS_OUTPUT activado: se captura el log de DBMS_OUTPUT.PUT_LINE de cada bloque PL/SQL y aparece en su propia solapa. Clic para desactivarlo — en un script con muchos bloques ahorra los round-trips de ENABLE/GET_LINE',
        dbmsOff: 'DBMS_OUTPUT desactivado: los PUT_LINE de tus bloques PL/SQL no se leen ni se muestran. Clic para capturarlos',
        loadingCatalog: 'Leyendo tablas, columnas y rutinas de la conexión para el autocompletado del editor',
        catalogError: (p: {reason: string}) =>
            `El editor no pudo leer el catálogo de esta conexión, así que el autocompletado solo ofrece palabras clave y funciones — sin tablas ni columnas. Motivo: ${p.reason}. Suele ser permisos sobre el diccionario de datos o una conexión que se cayó; reconectar vuelve a intentarlo.`,
        schemaAria: 'Schema activo',
        schemaTitle: 'Schema activo de esta conexión: acota el autocompletado del editor y es el que se asume cuando escribís una tabla sin prefijo',
        mongoPlaceholder: 'elegí una base',
        mongoAria: 'Base de datos activa de MongoDB',
        mongoTitle: 'Base de datos a la que apunta `db` en el editor mongosh — cambiarla acá reapunta todos los comandos de esta pestaña',
        wizard: 'Asistente de consulta: armá un find() visualmente (colección, condiciones, orden, límite) — se abre en una pestaña de editor y se ejecuta',
        wizardDisabled:
            'Asistente de consulta: elegí primero una base de datos, el asistente necesita saber sobre qué colecciones armar el find()',
        boundTitle: (p: {name: string; engine: string}) =>
            `Esta pestaña ejecuta contra la conexión "${p.name}" (${p.engine}). Para cambiarla, usá el selector que está a la izquierda del título de la pestaña.`,
        unboundTitle:
            'Esta pestaña no está vinculada a ninguna conexión, así que todavía no puede ejecutar nada. Vinculala con el ícono que está a la izquierda del título de la pestaña.',
        noConnection: 'Sin conexión',
    },
    // Panel inferior: solapas, paginación y pie.
    bottom: {
        resizeTitle: 'Arrastrar para cambiar el alto del editor — el tamaño queda guardado',
        resultsTitle: 'Resultado de la última ejecución: la grilla de filas devueltas',
        results: 'Resultados',
        consoleTitle:
            'Consola de ejecución: cada statement del último script corrido, con su texto completo y si terminó OK (con duración) o con error — como el output de un cliente SQL de escritorio',
        console: 'Consola',
        dbmsTitle: (n: number) =>
            `Salida de DBMS_OUTPUT.PUT_LINE del último bloque PL/SQL ejecutado — ${n} ${n === 1 ? 'línea' : 'líneas'}, con filtro y copiado`,
        explainTitle: 'Plan de ejecución de la última consulta explicada, con métricas y diagnóstico. Se cierra con la X, como una pestaña de resultados.',
        dbmsOutput: 'DBMS_OUTPUT',
        explain: 'Explain',
        explainAnalyze: 'Explain Analyze',
        criticalIssues: (n: number) => `${n} problema(s) crítico(s) detectado(s) en el plan`,
        closeExplain: 'Cierra el plan de ejecución',
    },
    paging: {
        showing: 'Mostrando',
        rows: 'filas',
        loadMoreTitle: 'Traer las próximas filas del mismo resultado — no vuelve a ejecutar la consulta, sigue leyendo el cursor abierto',
        loadMore: (p: {n: string | null}) => (p.n === null ? 'Cargar todo más' : `Cargar ${p.n} más`),
        loadingMore: 'Cargando más…',
        cancelLoadTitle: 'Cancelar la carga de esta página — las filas ya traídas se conservan',
        otherQuery: 'otra consulta usó esta conexión',
        closedTitle: (p: {reason: string}) =>
            `El cursor que paginaba este resultado se cerró porque ${p.reason}: el motor guarda un solo cursor pausado por conexión (backend/query/paging.go). Volvé a ejecutar la consulta para seguir leyendo desde el principio.`,
        closed: (p: {reason: string}) => `paginación cerrada — ${p.reason}`,
        complete: '— resultado completo',
        pageSizeTitle: "Cuántas filas trae cada página. 'Todas' desactiva la paginación — cuidado con tablas grandes. Se guarda como preferencia.",
        pageSize: 'Filas por página',
        all: 'Todas',
    },
    footer: {
        runningProgress: (p: {current: number; total: number}) => `Ejecutando ${p.current}/${p.total}…`,
        running: 'Ejecutando…',
        liveRunsTitle: (n: number) => `${n} corridas en curso en esta pestaña. El progreso es el de la última; "Cancelar" las corta todas.`,
        liveRuns: (n: number) => `${n} corridas`,
        rows: (p: {rows: string}) => `${p.rows} filas ·`,
        durationMs: (p: {ms: string}) => `${p.ms} ms`,
        cancelled: 'Cancelada',
        fixTitle: 'Le pasa al agente el error, la consulta y el esquema de las tablas que menciona, y propone la versión corregida. No la ejecuta: la aplicás vos.',
        fix: 'Explicar y corregir',
    },
    dialogs: {
        backupTitle: 'Confirmar backup del vault',
        backupDescription:
            'El backup incluye tus conexiones cifradas y puede terminar en otra máquina — reingresá tu clave maestra para confirmar. Sin ella, el backup no sirve de nada aunque alguien lo copie.',
        backupConfirm: 'Guardar backup',
        destructiveTitle: 'Comando destructivo',
        redisDescription: 'Este script incluye FLUSHALL/FLUSHDB, que borra datos de Redis de forma irreversible. ¿Ejecutar de todas formas?',
        mongoDescription:
            'Este script incluye un deleteMany/updateMany con filtro vacío o un drop(), que afecta o elimina datos de forma irreversible. ¿Ejecutar de todas formas?',
        run: 'Ejecutar',
        analyzeTitle: 'Explain Analyze ejecuta la consulta',
        analyzeDescription:
            'Este script modifica datos o estructura (INSERT/UPDATE/DELETE/DDL). EXPLAIN ANALYZE lo ejecuta de verdad para poder medirlo. Se correrá dentro de una transacción que se revierte al terminar, así que no deberían quedar cambios aplicados — pero los disparadores, secuencias y efectos fuera de la transacción sí ocurren.',
        analyzeConfirm: 'Ejecutar y medir',
        runAnyway: 'Ejecutar igual',
        remoteTitle: 'El archivo cambió en el servidor',
        remoteDescription: (p: {path: string; conn: string}) =>
            `"${p.path}" fue modificado en ${p.conn} desde que lo abriste. Si continuás, tus cambios reemplazan los que están ahora en el servidor y esos se pierden. Cancelá si preferís volver a abrirlo y comparar primero.`,
        overwrite: 'Sobrescribir igual',
    },
}
