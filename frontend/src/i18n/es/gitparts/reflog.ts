// Textos de git.reflog. Ver .claude/specs/i18n.md.
export default {
    filterPlaceholder: 'Filtrar por mensaje, acción o hash',
    reloadTitle: 'Volver a leer el reflog',
    loading: 'Leyendo…',
    empty: 'Este repositorio todavía no tiene movimientos de HEAD.',
    noMatch: 'Ningún movimiento coincide con el filtro.',
    openCommit: (p: {hash: string}) => `Ver el commit ${p.hash}`,
    destructiveTitle: 'Esta acción reescribió historia: es de las que dejan commits sin referencia',
    branchTitle:
        'Crear una rama en esta posición. Es la forma segura de recuperar: no mueve nada de lo que tenés ahora y le da nombre propio al commit perdido.',
    resetTitle: 'Mover la rama actual a esta posición con reset --hard. Recupera esto, pero descarta lo que tengas sin commitear.',
    // Frase con marcado: el componente pone `strong` en negrita.
    footer: {
        before: 'El reflog es ',
        strong: 'local y temporal',
        after: ': no se clona, no se empuja, y git lo poda solo (90 días lo alcanzable, 30 lo que no). Sirve para recuperar lo de ayer, no como historial.',
    },
    branchDialog: {
        title: 'Crear una rama acá',
        label: 'Nombre de la rama',
        initial: (p: {hash: string}) => `recupero-${p.hash}`,
        confirm: 'Crear',
    },
    resetDialog: {
        title: 'Mover la rama actual acá',
        description: (p: {hash: string; subject: string}) =>
            `La rama actual va a quedar en ${p.hash} («${p.subject}»). Todo lo que tengas sin commitear se pierde, y los commits que queden por delante solo van a ser alcanzables desde este mismo reflog. Si lo único que querés es recuperar ese commit, creá una rama en vez de esto.`,
        confirm: 'Reset --hard',
    },
}
