// Textos de git.rebase. Ver .claude/specs/i18n.md.
export default {
    actions: {
        pick: {label: 'pick — dejarlo como está', hint: 'Aplica el commit sin cambios'},
        reword: {label: 'reword — cambiar el mensaje', hint: 'Aplica el commit y frena para que edites su mensaje'},
        edit: {label: 'edit — frenar para editarlo', hint: 'Aplica el commit y frena el rebase para que modifiques el contenido'},
        squash: {label: 'squash — combinar con el anterior', hint: 'Funde este commit en el de arriba, conservando los dos mensajes'},
        fixup: {label: 'fixup — combinar y descartar el mensaje', hint: 'Como squash, pero tira el mensaje de este commit'},
        drop: {label: 'drop — eliminarlo', hint: 'Descarta el commit por completo'},
    },
    title: 'Reordenar y combinar commits',
    closeTitle: 'Cierra sin cambiar nada',
    // Frase con marcado: el componente intercala <strong> y el nombre de la base.
    rewrite: {
        before: 'Esto ',
        strong: 'reescribe la historia',
        middle: ' desde ',
        after: ' en adelante: cada commit recibe un hash nuevo. Si la rama ya está publicada, después vas a necesitar un push forzado.',
    },
    order: {
        before: 'La lista va del ',
        strong: 'más viejo al más nuevo',
        after: ', igual que el archivo de git — al revés que el grafo. «Combinar con el anterior» se refiere al de arriba.',
    },
    loading: 'Cargando los commits…',
    empty: (p: {base: string}) => `No hay commits entre ${p.base} y la rama actual.`,
    moveUp: 'Mover este commit más arriba (más viejo)',
    moveDown: 'Mover este commit más abajo (más nuevo)',
    firstIsFold: 'El primero de la lista no puede combinarse con el anterior: no hay ninguno arriba.',
    willStop: 'Con «reword» o «edit» el rebase va a frenar en ese commit para que hagas el cambio y después continúes.',
    kept: (p: {kept: number; total: number}) => `${p.kept} de ${p.total} commits quedan`,
    applyTitle: 'Aplica el rebase con esta lista. Si aparece un conflicto, se abre el resolutor.',
    applying: 'Aplicando…',
    apply: 'Aplicar',
}
