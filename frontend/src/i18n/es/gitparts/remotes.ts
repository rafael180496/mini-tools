// Textos de git.remotes. Ver .claude/specs/i18n.md.
export default {
    // El texto rodea un fragmento de código (`git remote set-url`) que el
    // componente pinta en monoespaciado: por eso va partido en dos.
    introBefore: 'Un remoto es a dónde apuntan fetch, pull y push. Cambiar la URL acá es lo mismo que',
    introAfter: ': no toca nada en el servidor y no vuelve a bajar el repositorio, solo cambia el destino.',
    closeNote: 'Cerrar este aviso',
    empty: 'Este repositorio no tiene remotos: es local y no hay a dónde hacer push hasta que agregues uno.',
    editTitle: (p: {name: string}) => `Ver y cambiar la URL de "${p.name}" — se abre con la URL real, token incluido si lo tiene`,
    copyTitle: (p: {name: string}) => `Copiar la URL de "${p.name}" al portapapeles, tal cual está configurada`,
    removeTitle: (p: {name: string}) => `Quitar el remoto "${p.name}" de este repositorio — no borra nada en el servidor`,
    fetchUrlTitle: 'URL de fetch, tal cual está en .git/config — con el token a la vista si lo tiene embebido',
    pushDiffersTitle: 'Este remoto pushea a una URL distinta de la que usa para fetch',
    pushArrow: (p: {url: string}) => `push → ${p.url}`,
    addTitle: 'Agregar otro remoto a este repositorio (un fork, un espejo, un servidor de respaldo)',
    add: 'Agregar remoto',
    editHeading: (p: {name: string}) => `Editar "${p.name}"`,
    newHeading: 'Remoto nuevo',
    nameLabel: 'Nombre',
    nameTitle:
        'Cómo se llama el remoto en los comandos: `git push origin main`. Cambiarlo renombra el remoto y las ramas de seguimiento que cuelgan de él',
    fetchLabel: 'URL (fetch)',
    fetchPlaceholder: 'https://github.com/usuario/repo.git',
    fetchTitle:
        'A dónde van fetch y pull, y también push si no completás la URL de push. Se muestra tal cual está guardada, con el token adentro si lo tiene',
    pushLabel: 'URL de push (opcional)',
    pushPlaceholder: 'Vacío = pushea a la misma URL de arriba',
    pushTitle:
        'Solo hace falta cuando se lee de un lado y se escribe en otro (un espejo de solo lectura, un fork). Vaciarla borra el override y el push vuelve a la URL de fetch',
    tokenHeading: 'Esta URL lleva un token adentro',
    // Párrafo partido alrededor de tres fragmentos monoespaciados:
    // .git/config, git remote -v y el host.
    tokenBody1: 'Funciona, pero queda en texto plano en',
    tokenBody2: 'y lo ve cualquiera que abra la carpeta o mire',
    tokenBody3: '. Podés dejarlo así —se respeta lo que escribas— o moverlo al vault: se guarda cifrado para',
    tokenBody4: 'y la app se lo pasa a git igual, sin que aparezca en ningún lado.',
    moveTokenTitle: (p: {host: string}) =>
        `Guardar el token cifrado en el vault para ${p.host} y dejar la URL sin credenciales (después hay que guardar el remoto)`,
    moveToken: 'Mover el token al vault',
    fillRequired: 'Completá el nombre y la URL de fetch',
    saveEditTitle: 'Guardar los cambios en la configuración local del repositorio',
    saveNewTitle: 'Agregar este remoto al repositorio',
    saving: 'Guardando…',
    save: 'Guardar',
    cancelTitle: 'Descartar los cambios de este formulario — no se escribe nada',
    cancel: 'Cancelar',
    deleteTitle: 'Eliminar remoto',
    deleteDescription: (p: {name: string}) =>
        `Esto elimina el remoto "${p.name}" de la configuración local del repositorio. No borra nada en el servidor, pero las ramas remotas que lo seguían dejan de estar disponibles hasta que lo vuelvas a agregar.`,
    deleteConfirm: 'Eliminar',
    saved: (p: {name: string}) => `Remoto "${p.name}" guardado.`,
    tokenSaved: (p: {host: string}) =>
        `Token guardado en el vault para ${p.host}. Guardá el remoto para que la URL quede sin el token.`,
    copied: (p: {name: string}) => `URL de "${p.name}" copiada.`,
}
