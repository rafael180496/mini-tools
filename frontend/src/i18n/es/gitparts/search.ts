// Textos de git.search. Ver .claude/specs/i18n.md.
// Los prefijos (autor:, mensaje:…) son sintaxis que entiende el parser en los
// dos idiomas; la ayuda muestra primero los del idioma activo.
export default {
    describe: {
        author: (v: string) => `autor «${v}»`,
        message: (v: string) => `mensaje «${v}»`,
        path: (v: string) => `que tocan «${v}»`,
        rev: (v: string) => `desde ${v}`,
        since: (v: string) => `después de ${v}`,
        until: (v: string) => `antes de ${v}`,
    },
    help: {
        author: 'autor:angelo — commits de ese autor (también author:)',
        message: 'mensaje:feat — busca en el mensaje (también message:, msg:)',
        file: 'archivo:AGENTS.md — solo los commits que tocaron ese archivo (también file:)',
        range: 'desde:2024-01-01 · hasta:"2 weeks ago" — rango de fechas (también since:/until:)',
        hash: 'hash:a1b2c3d — la historia a partir de ese commit',
        bare: 'Sin prefijo busca en el mensaje; un hash suelto de 7+ caracteres se detecta solo.',
    },
}
