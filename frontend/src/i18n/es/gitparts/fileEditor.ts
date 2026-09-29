// Textos de git.fileEditor. Ver .claude/specs/i18n.md.
export default {
    status: {
        added: 'Agregado',
        untracked: 'Sin rastrear — todavía no está en git',
        modified: 'Modificado',
        renamed: 'Renombrado',
        deleted: 'Borrado',
        conflicted: 'En conflicto',
    },
    title: 'Archivos',
    saving: 'Guardando…',
    reloadTitle: 'Vuelve a listar los archivos del repositorio — útil después de que un agente o un checkout cree archivos nuevos',
    closeTitle: 'Cierra el editor de archivos',
    filterPlaceholder: 'Filtrar archivos',
    filterTitle: 'Filtra por cualquier parte de la ruta',
    noFiles: 'No hay archivos editables en este repositorio.',
    noMatch: 'Ningún archivo coincide con el filtro.',
    dirChanges: (p: {n: number}) => `${p.n} archivo(s) con cambios acá adentro`,
    unsaved: 'Sin guardar en el disco',
    moreFiles: (p: {n: number}) => `${p.n} archivos más. Refiná el filtro para verlos.`,
    truncated: 'El repositorio supera el tope del listado; puede faltar algún archivo.',
    closeDirty: 'Cerrar (los cambios sin guardar se pierden)',
    close: 'Cerrar',
    languageTitle: (p: {language: string}) =>
        `Resaltado de sintaxis. Se eligió ${p.language} por el nombre del archivo; cambialo si este archivo es otra cosa.`,
    mdView: {
        code: 'Editar el texto',
        split: 'El texto y el resultado, lado a lado',
        preview: 'Solo el documento formateado',
    },
    askPrompt: (p: {about: string}) => `Mirá ${p.about} en este repositorio y `,
    askTitle:
        'Le pasa este archivo (o las líneas seleccionadas) a una sesión de agente y deja el prompt escrito para que lo completes. No lo envía solo: enviar es un gesto tuyo, igual que en el historial de la terminal.',
    ask: 'Preguntar',
    saveTitle: 'Guarda el archivo en el disco (Cmd/Ctrl+S). Si cambió abajo mientras lo editabas, se avisa antes de pisarlo.',
    save: 'Guardar',
    pickFile: 'Elegí un archivo de la lista para abrirlo y editarlo.',
    binary: 'Este archivo es binario y no se puede editar como texto.',
    tooLarge: 'Este archivo supera el tamaño máximo editable (4 MiB).',
    conflict: {
        title: 'El archivo cambió en el disco',
        description: (p: {path: string}) =>
            `"${p.path}" fue modificado por fuera del editor desde que lo abriste — puede haber sido un agente, un checkout u otro programa. Si guardás igual, ese cambio se pierde.`,
        confirm: 'Guardar igual',
    },
}
