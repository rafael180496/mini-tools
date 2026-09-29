// Textos de git.conflicts (GitConflictResolver). Ver .claude/specs/i18n.md.
export default {
    // En un rebase los lados están invertidos respecto de un merge.
    oursRebase: 'La rama sobre la que estás rebasando',
    oursMerge: 'Tu rama (actual)',
    theirsRebase: 'El commit que se está reaplicando',
    theirsMerge: 'La rama que entra',
    withConflicts: (p: {op: string}) => `${p.op} con conflictos`,
    unresolvedFiles: (n: number) => (n === 1 ? '1 archivo sin resolver' : `${n} archivos sin resolver`),
    continuePending: (p: {n: number}) =>
        `Todavía quedan ${p.n} archivo(s) con conflictos. Resolvelos y marcalos para poder continuar.`,
    continueTitle: (p: {op: string}) => `Continúa el ${p.op} con las resoluciones ya marcadas`,
    continueOp: (p: {op: string}) => `Continuar ${p.op}`,
    askTitle:
        'Le pide al agente que explique este conflicto y proponga un criterio para resolverlo. No escribe el archivo: la resolución la elegís y la marcás vos.',
    ask: 'Consultar',
    abortTitle: (p: {op: string}) => `Cancela el ${p.op} y deja el repositorio como estaba antes de empezarlo`,
    abort: 'Abortar',
    closeTitle: 'Cierra el resolutor',
    noneLeft: (p: {op: string}) => `No quedan archivos con conflictos. Ya podés continuar el ${p.op}.`,
    progressTitle: 'Bloques de conflicto resueltos sobre el total de este archivo',
    progress: (p: {current: number; total: number; done: number}) =>
        `Conflicto ${p.current} de ${p.total} · ${p.done} resueltos`,
    prevTitle: 'Conflicto anterior (Alt+P)',
    nextTitle: 'Conflicto siguiente (Alt+N)',
    markResolvedTitle: 'Guarda el archivo resuelto y lo marca como resuelto (lo agrega al stage)',
    markResolvedPending:
        'Todavía quedan bloques sin decidir. Un archivo guardado con marcadores queda roto y git lo sigue viendo como conflictivo.',
    markResolved: 'Marcar como resuelto',
    loadingFile: 'Cargando el archivo…',
    unresolved: 'Sin resolver',
    resolved: 'Resuelto',
    keepMine: 'Quedarme con la mía',
    acceptIncoming: 'Aceptar la entrante',
    applyOnly: (p: {side: string}) => `Aplica solo ${p.side}`,
    both: 'Ambas',
    bothTitle: 'Conserva los dos bloques, primero el tuyo y después el entrante',
    undo: 'Deshacer',
    undoTitle: 'Vuelve a dejar este bloque sin decidir',
    base: 'Ancestro común',
    baseDetail: 'antes de que las dos ramas lo tocaran',
    empty: '(vacío)',
}
