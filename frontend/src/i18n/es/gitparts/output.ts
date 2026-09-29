// Textos de git.output. Ver .claude/specs/i18n.md.
export default {
    kind: {
        added: 'Nuevo',
        deleted: 'Borrado',
        renamed: 'Renombrado',
        modified: 'Modificado',
    },
    // Conteo por tipo en el resumen: «3 modificados · 1 nuevo».
    kindCount: {
        added: (n: number) => `${n} ${n === 1 ? 'nuevo' : 'nuevos'}`,
        deleted: (n: number) => `${n} ${n === 1 ? 'borrado' : 'borrados'}`,
        renamed: (n: number) => `${n} ${n === 1 ? 'renombrado' : 'renombrados'}`,
        modified: (n: number) => `${n} ${n === 1 ? 'modificado' : 'modificados'}`,
    },
    copyTitle: 'Copiar la salida completa de git',
    closeTitle: 'Cerrar este mensaje',
    hideFiles: 'Ocultar la lista de archivos',
    showFiles: 'Ver los archivos que cambiaron',
    filesUpdated: (n: number) => (n === 1 ? `${n} archivo actualizado` : `${n} archivos actualizados`),
    fastForward: 'fast-forward',
    revealTitle: (p: {hash: string}) => `Ir a ${p.hash} en el grafo`,
    filterPlaceholder: (n: number) => `Filtrar ${n} archivos…`,
    filterCount: (p: {visible: number; total: number}) => `${p.visible} de ${p.total}`,
    noMatch: (p: {filter: string}) => `Ningún archivo coincide con «${p.filter}».`,
    hideRaw: 'Ocultar salida de git',
    showRaw: 'Ver salida de git',
    openTitle: (p: {path: string}) => `Abrir ${p.path}`,
    binDetail: (p: {detail: string}) => `bin ${p.detail}`,
    binary: 'binario',
}
