// Textos de git.stash. Ver .claude/specs/i18n.md.
export default {
    title: 'Stashes',
    pushTitle: 'Guarda los cambios sin commitear en un stash y deja el working tree limpio',
    push: 'Guardar cambios',
    closeTitle: 'Cierra el panel de stashes',
    empty: 'No hay stashes guardados. Un stash aparta los cambios sin commitear para retomarlos después.',
    itemTitle: (p: {ref: string; branch: string; date: string}) => `${p.ref} — guardado sobre "${p.branch}" el ${p.date}`,
    applyTitle: 'Aplica el stash al working tree y lo DEJA guardado — si algo sale mal, el stash sigue ahí',
    apply: 'Aplicar',
    popTitle:
        'Aplica el stash y lo ELIMINA de la lista (pop). Si la aplicación termina en conflicto, el stash ya no está para reintentar: usá Aplicar si no estás seguro.',
    pop: 'Aplicar y quitar',
    dropTitle: 'Elimina el stash sin aplicarlo. Es irreversible.',
    drop: 'Eliminar',
    loading: 'Cargando el contenido del stash…',
    noChanges: 'Este stash no tiene cambios que mostrar.',
    confirmTitle: 'Eliminar stash',
    confirmBody: (p: {message: string}) =>
        `Se elimina «${p.message}» sin aplicarlo. A diferencia de un commit, esto no queda en el reflog de la rama: no hay forma de recuperarlo.`,
}
