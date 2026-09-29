// Textos de git.errorBoundary. Ver .claude/specs/i18n.md.
export default {
    title: 'El módulo Git falló al renderizar',
    body: (p: {label: string}) =>
        `Esto es un bug de la app, no de tu repositorio (${p.label}). El resto de mini-tools sigue funcionando: podés cerrar esta pestaña y seguir trabajando.`,
    retryTitle: 'Volver a intentar renderizar el módulo — sirve si el error fue transitorio',
    retry: 'Reintentar',
}
