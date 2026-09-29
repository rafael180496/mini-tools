// Textos del área «results». Ver .claude/specs/i18n.md.
export default {
    // Marcador de tabla en el SQL generado cuando no se sabe de qué tabla sale
    // el resultado: tiene que verse que hay que reemplazarlo.
    placeholderTable: 'tabla',
    // Comentario que encabeza un UPDATE generado desde la grilla: va dentro del
    // SQL, así que cada línea empieza con `-- `.
    updateReviewComment: (p: {table: string}) =>
        `-- Revisá el WHERE antes de ejecutar: por defecto matchea todas las columnas de la fila,\n-- ajustalo a la primary key real de ${p.table} si la tiene.\n`,
    grid: {
        empty: 'Sin resultados todavía.',
        sortTitle: 'Ordenar por esta columna — click de nuevo para invertir el orden',
        resizeTitle: 'Arrastrá para cambiar el ancho de la columna — doble clic lo ajusta al contenido',
        rowTitle:
            'Click para seleccionar la fila — Ctrl/Cmd+click suma filas sueltas, Shift+click marca un rango (con Ctrl/Cmd lo suma), Ctrl/Cmd+A marca todo y Esc limpia — habilita copiarlas como texto, CSV, INSERT o UPDATE',
        editCellTitle: (p: {dataType: string}) =>
            `Doble clic para editar. ${p.dataType} — el cambio queda pendiente hasta que lo mandes.`,
        pendingCount: (n: number) => (n === 1 ? '1 cambio sin guardar' : `${n} cambios sin guardar`),
        previewSql: 'Ver el SQL',
        previewSqlTitle: 'Muestra exactamente el UPDATE que se va a ejecutar, con su WHERE, antes de tocar la base.',
        save: 'Guardar en la base',
        saving: 'Guardando…',
        saveTitle:
            'Ejecuta los UPDATE en UNA transacción. Cada uno tiene que afectar exactamente una fila: si alguno afecta otra cantidad, se revierte el lote entero. (Cmd/Ctrl + Enter)',
        discard: 'Descartar',
        discardTitle: 'Descarta los cambios pendientes. La base no se tocó, así que no hay nada que deshacer.',
        readOnly: (p: {reason: string}) => `Solo lectura: ${p.reason}`,
        previewHeading: 'Esto es lo que se va a ejecutar',
        previewNoteBefore: 'Los valores se muestran escritos adentro de la sentencia para poder leerla. Al ejecutar viajan como ',
        previewNoteParams: 'parámetros',
        previewNoteAfter: ', aparte del texto — que es lo que hace que un valor con comillas no pueda cambiar el sentido del UPDATE.',
        execute: 'Ejecutar',
        selectedRows: (n: number) => `${n} filas`,
        rowsCopied: (n: number): string => (n === 1 ? 'Fila copiada' : 'Filas copiadas'),
        csvCopied: 'CSV copiado',
        insertCopied: 'INSERT copiado',
        updateCopied: 'UPDATE copiado',
        copyRows: (n: number): string => (n === 1 ? 'Copiar fila' : 'Copiar filas'),
        copyRowsTitle: 'Copia los valores de la(s) fila(s) separados por tab (una por línea), listos para pegar en una planilla',
        copyCsv: 'Copiar como CSV',
        copyCsvTitle:
            'Copia la(s) fila(s) seleccionadas como CSV (con encabezado), listo para pegar en Excel/Sheets sin pasar por el diálogo de exportar',
        copyInsert: 'Copiar como INSERT',
        copyInsertTitle: 'Copia la(s) fila(s) seleccionadas como sentencias INSERT listas para pegar en el editor',
        copyUpdate: 'Copiar como UPDATE',
        copyUpdateTitle:
            'Copia la(s) fila(s) seleccionadas como sentencias UPDATE (con WHERE por todas las columnas — revisalas antes de ejecutar) listas para editar y pegar en el editor',
        deselectTitle: 'Deselecciona todas las filas',
    },
    rowEditing: {
        missingKeys: (p: {keys: string}) =>
            `para editar hace falta ${p.keys} en el SELECT: es la clave que identifica cada fila`,
        // Se anexa a la línea de valores de la consola.
        before: (p: {line: string; value: string}) => `${p.line}   (antes ${p.value})`,
    },
    cellEditor: {
        nullTitle: 'Deja la celda sin dato (NULL). Es distinto de dejarla vacía: la base guarda esa diferencia.',
        commitTitle: 'Guarda el cambio como PENDIENTE. Todavía no toca la base: se manda con el botón de arriba.',
        cancelTitle: 'Descarta este cambio (Esc)',
    },
    dbmsOutput: {
        lineCount: (n: number) => (n === 1 ? '1 línea' : `${n} líneas`),
        filteredCount: (p: {visible: number; total: number}) => `${p.visible} de ${p.total} líneas`,
        filterPlaceholder: 'Filtrar líneas…',
        filterTitle:
            'Deja solo las líneas que contienen ese texto — para encontrar el ERROR en un log de trescientas líneas sin leerlo entero',
        clearFilterTitle: 'Quitar el filtro y volver a ver todo el log',
        wrapOnTitle:
            'Las líneas largas se ajustan al ancho del panel. Desactivalo para que no se corten y aparezca scroll horizontal — necesario cuando la salida son columnas alineadas con espacios.',
        wrapOffTitle: 'Las líneas largas se salen a la derecha y hay scroll horizontal. Activalo para ajustarlas al ancho del panel.',
        copyFilteredTitle: 'Copiar solo las líneas que muestra el filtro',
        copyAllTitle: 'Copiar toda la salida al portapapeles',
        copy: 'Copiar',
        copied: 'Copiado',
        noMatch: (p: {filter: string}) => `Ninguna línea contiene «${p.filter}».`,
    },
    console: {
        cancelled: 'cancelado',
        unknownError: 'Error desconocido',
        // Van seguidos de la duración: «3 filas obtenidas en 12ms».
        rowsFetchedIn: (n: number): string => (n === 1 ? 'fila obtenida en' : 'filas obtenidas en'),
        completed: 'completado',
        completedIn: 'en',
        rowsAffected: (n: number) => (n === 1 ? ' (1 fila afectada)' : ` (${n} filas afectadas)`),
        noStatements: 'Sin statements ejecutados todavía.',
        statementCount: (n: number) => (n === 1 ? '1 statement ejecutado' : `${n} statements ejecutados`),
        errorCountTitle: (n: number) =>
            `${n} de los statements de esta consola terminó con error — tienen el borde y el mensaje en rojo`,
        errorCount: (n: number) => `${n} con error`,
        running: 'ejecutando…',
        clear: 'Limpiar consola',
        clearTitle: 'Borra el log de esta consola — no cancela nada ni deshace lo que ya se ejecutó, solo vacía lo que se ve acá',
        emptyHint:
            'Ejecutá un script con "Bloque" para ver acá el detalle de cada statement — texto completo, si terminó OK (con duración) o con error.',
        statementHeader: (p: {n: number; total: number}) => `Statement ${p.n}/${p.total}`,
    },
    export: {
        exportedTo: (p: {dest: string}) => `Exportado a ${p.dest}`,
        error: (p: {error: string}) => `Error: ${p.error}`,
        insertsCopied: (n: number) => `${n} INSERT(s) copiados al portapapeles`,
        button: 'Exportar',
        buttonTitle: 'Exporta las filas del resultado actual a un archivo, o cópialas como sentencias SQL',
        csvTitle: 'Guarda el resultado como archivo .csv (valores separados por coma)',
        jsonTitle: 'Guarda el resultado como archivo .json (un array de objetos, una fila por objeto)',
        xlsxTitle: 'Guarda el resultado como archivo Excel (.xlsx)',
        xlsx: 'Excel (.xlsx)',
        copyInsert: 'Copiar como INSERT',
        copyInsertTitle: 'Copia el resultado al portapapeles como sentencias INSERT listas para pegar en otro editor SQL',
    },
    json: {
        dblClickFilterTitle: (p: {key: string}) => `Doble-click para filtrar por ${p.key}`,
        filterByTitle: (p: {key: string}) => `Filtrar por ${p.key}`,
    },
    mongo: {
        empty: 'Sin resultados todavía — ejecutá un comando MongoDB.',
        jsonTitle: 'Ver los documentos como JSON con color',
        table: 'Tabla',
        tableTitle: 'Ver los documentos como tabla (una columna por campo de nivel superior)',
        filterPlaceholder: 'Filtrar documentos por texto…',
        filterTitle: 'Muestra solo los documentos que contienen este texto (búsqueda en el JSON del documento)',
        cancelled: 'Cancelado.',
        running: 'Ejecutando…',
        noDocuments: 'Sin documentos.',
        noMatch: 'Ningún documento coincide con el filtro.',
    },
    redis: {
        empty: 'Sin resultados todavía — ejecutá un comando.',
        binary: (n: number) => `contenido binario / no imprimible (${n} caracteres)`,
        cancelled: 'Cancelado',
        running: 'Ejecutando…',
        emptyArray: '(vacío)',
        matched: (n: number) => `Matched: ${n}`,
        matchedNoRows: (n: number) => `Matched: ${n} (sin resultados en esta página)`,
    },
    tabs: {
        label: (n: number) => `Resultado ${n}`,
        selectTitle: (p: {n: number; count: number; hint: string}) =>
            `Ver el resultado del statement ${p.n} de ${p.count} — cada statement de un bloque tiene su propia pestaña de resultados${p.hint}`,
        closeTitle: (n: number) => `Cerrar la pestaña "Resultado ${n}" — solo oculta este resultado, no cancela ni reejecuta nada`,
        closeAll: 'Cerrar todos',
        closeAllTitle: 'Cerrar todas las pestañas de resultados de este script',
    },
}
