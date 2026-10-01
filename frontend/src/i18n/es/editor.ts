// Textos del área «editor». Ver .claude/specs/i18n.md.
export default {
    // Barra de pestañas del workspace (EditorTabs.tsx).
    tabs: {
        kindHint: {
            editor: 'Editor de consultas',
            redisBrowser: 'Explorador de claves Redis',
            mongoBrowser: 'Explorador de colecciones MongoDB',
            sshTerminal: 'Terminal remota',
            localTerminal: 'Terminal de esta máquina',
            sftp: 'Transferencia de archivos entre hosts',
            sshHybrid: 'Terminal remota con explorador de archivos al lado',
            remoteFile: 'Archivo de un servidor, editado en vivo',
            gitRepo: 'Repositorio',
            note: 'Nota de la base de conocimiento',
            httpRequest: 'Petición HTTP de una colección',
            redisConsole: 'Consola de comandos Redis',
            mongoConsole: 'Consola mongosh',
            utility: 'Utilidad del sistema',
        },
        badgeRemote: 'REMOTO',
        badgeNote: 'NOTA',
        boundTo: (p: {name: string; engine: string}) => `Vinculada a "${p.name}" (${p.engine}) — click para cambiar`,
        unbound: (p: {language: string}) =>
            `Sin conexión vinculada (lenguaje: ${p.language}) — click para vincular una conexión o cambiar el lenguaje. La conexión vinculada se muestra arriba, en la barra de herramientas.`,
        tabTitle: (p: {path: string | null}) =>
            `${p.path ?? 'Pestaña sin guardar'} — arrastrar para reordenar · clic central de la rueda para cerrar`,
        notBindable: (p: {hint: string}) => `${p.hint} — no se vincula a una conexión de base de datos, abrí una pestaña nueva para eso`,
        running: 'Esta pestaña está ejecutando algo ahora mismo',
        closeDirty: 'Cerrar pestaña (hay cambios sin guardar)',
        close: 'Cerrar pestaña',
        connection: 'Conexión',
        noConnection: 'Sin conexión',
        tabConnection: 'Conexión de la pestaña',
        language: 'Lenguaje',
        tabLanguage: 'Lenguaje de la pestaña',
        newTitle: 'Abre una pestaña nueva en blanco para escribir un query sin guardarlo todavía',
        new: 'Nueva',
        openTitle: 'Abre un archivo .sql desde tu disco en una nueva pestaña del editor',
        open: 'Abrir',
    },
    recent: {
        title: 'Muestra los últimos archivos .sql que abriste, para reabrirlos rápido',
        button: 'Recientes',
        empty: 'Sin archivos recientes.',
        clearTitle: 'Borra la lista de archivos recientes (no borra los archivos, solo el historial)',
        clear: 'Limpiar historial',
    },
    // Asistente de consultas (NlPromptBar.tsx).
    nl: {
        context: {
            sql: {
                one: 'tabla',
                many: 'tablas',
                explain: 'Se le pasó el DDL de estas tablas — columnas, tipos y claves, ninguna fila',
                empty: 'No se le pasó el DDL de ninguna tabla: el pedido no mencionaba ninguna que exista en esta conexión.',
            },
            mongodb: {
                one: 'colección',
                many: 'colecciones',
                explain: 'Se le pasaron los nombres de campo y sus tipos de estas colecciones — ningún documento',
                empty: 'No se le pasó el detalle de ninguna colección: el pedido no mencionaba ninguna que exista en esta base.',
            },
            redis: {
                one: 'patrón de clave',
                many: 'patrones de clave',
                explain: 'Se le pasaron estos PATRONES de clave con su tipo — ni claves completas ni ningún valor',
                empty: 'No se pudo muestrear ninguna clave de esta conexión.',
            },
        },
        fixTitle: 'Explicar y corregir',
        writeRedis: 'Escribir comandos',
        writeMongo: 'Escribir una consulta Mongo',
        writeSql: 'Escribir una consulta',
        dialectHint:
            'El agente escribe en el dialecto de ESTE motor: la misma consulta se escribe distinto en Oracle, Postgres o SQL Server, y una escrita para el motor equivocado falla al correrla.',
        closeTitle: 'Cierra el asistente sin aplicar nada (Esc)',
        placeholderChange: 'Qué cambiarle a lo que hay en el editor… (Enter manda)',
        placeholderNew: 'Qué necesitás… (Enter manda, Shift+Enter salta de línea)',
        askTitle: 'Le pide la consulta al agente activo. No la ejecuta: la propone para que la revises.',
        ask: 'Pedir',
        busyFix: 'Leyendo el error y el esquema…',
        busyWrite: 'Escribiendo la consulta…',
        proposal: 'Propuesta',
        lines: 'líneas',
        contextTitle: (p: {explain: string; items: string; total: number; totalOf: number; many: string}) =>
            `${p.explain}:\n${p.items}${p.total > p.totalOf ? `\n\n(de ${p.total} ${p.many} en la conexión)` : ''}`,
        contextLabel: (p: {n: number; noun: string}) => `contexto: ${p.n} ${p.noun}`,
        applyHint:
            'Aplicar solo reemplaza el texto del editor. Ejecutar la consulta sigue siendo el botón de siempre, con la confirmación de producción donde corresponda.',
        applyReplaces: 'Aplicar reemplaza el editor.',
        runsNothing: 'No ejecuta nada.',
        discardTitle: 'Descarta la propuesta y deja el editor como estaba',
        discard: 'Descartar',
        copyTitle: 'Copia la consulta propuesta sin tocar el editor',
        copy: 'Copiar',
        applyTitle: 'Reemplaza el contenido del editor con la consulta propuesta. Podés deshacer con Cmd/Ctrl+Z.',
        apply: 'Aplicar',
    },
    // Parámetros enlazados (QueryParamsDialog.tsx).
    params: {
        types: {
            text: 'Texto',
            textHint: 'Se envía tal cual como string',
            number: 'Número',
            numberHint: 'Se convierte a entero o decimal',
            boolean: 'Booleano',
            booleanHint: 'true / false',
            nullHint: 'Enlaza NULL, ignorando el valor escrito',
        },
        title: 'Parámetros de la consulta',
        intro: (n: number) =>
            n === 1
                ? 'La consulta declara un parámetro. Su valor se envía enlazado, nunca insertado en el texto del SQL.'
                : `La consulta declara ${n} parámetros. Sus valores se envían enlazados, nunca insertados en el texto del SQL.`,
        positional: (p: {name: string}) =>
            `Parámetro posicional ${p.name}: el ${p.name}º "?" de la consulta, contando desde el principio del script`,
        named: (p: {raw: string}) => `Parámetro ${p.raw} tal como aparece en la consulta`,
        valuePlaceholder: 'valor',
        nullDisabled: 'Deshabilitado porque el tipo es NULL: se enlaza NULL sin importar lo que se escriba acá',
        valueTitle: (p: {raw: string}) => `Valor que se enlaza en ${p.raw} al ejecutar`,
        typeAria: (p: {raw: string}) => `Tipo del parámetro ${p.raw}`,
        typeTitle: 'Cómo se convierte el valor antes de enlazarlo: texto tal cual, número, booleano, o NULL',
        cancelTitle: 'Cierra sin ejecutar la consulta; los valores escritos se descartan',
        runAllEmpty: 'Ejecuta enlazando todos los parámetros vacíos — probablemente quieras escribir algún valor primero',
        runTitle: 'Ejecuta la consulta enlazando estos valores',
        run: 'Ejecutar',
    },
    languages: {
        plainText: 'Texto plano',
    },
    lint: {
        selectStar: 'SELECT * puede traer columnas innecesarias — preferí listar las columnas que necesitás.',
        noWhere: 'UPDATE/DELETE sin WHERE afecta todas las filas de la tabla.',
    },
    // Confirmación de producción (lib/sqlProductionGuard.ts).
    sqlGuard: {
        dropDatabase: {
            label: 'DROP DATABASE / SCHEMA',
            detail: 'Elimina la base o el esquema entero con todo lo que contiene. No hay ROLLBACK que lo devuelva.',
        },
        drop: {
            label: 'DROP',
            detail: 'Elimina el objeto y, si es una tabla, sus datos. En Oracle un DDL además hace COMMIT implícito: no se puede deshacer con ROLLBACK.',
        },
        truncate: {
            label: 'TRUNCATE',
            detail: 'Vacía la tabla entera. Es DDL, así que hace COMMIT implícito y no se puede deshacer con ROLLBACK ni queda en el UNDO.',
        },
        noWhere: {
            label: 'DELETE / UPDATE sin WHERE',
            detail: 'Afecta todas las filas de la tabla.',
        },
        alter: {
            label: 'ALTER',
            detail: 'Cambia la estructura o la configuración. En Oracle es DDL con COMMIT implícito.',
        },
        grant: {
            label: 'GRANT / REVOKE',
            detail: 'Cambia permisos de acceso en producción.',
        },
        write: {
            label: 'Escritura de datos',
            detail: 'Modifica datos de producción.',
        },
    },
}
