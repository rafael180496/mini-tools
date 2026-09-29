// Textos de git.commandLog. Ver .claude/specs/i18n.md.
export default {
    countTitle: 'Cuántos comandos git ejecutó la app desde que se abrió',
    count: (n: number) => `${n} comandos`,
    failedTitle: 'Comandos que terminaron con error',
    failed: (n: number) => `${n} con error`,
    onlyFailedTitle: 'Muestra solo los comandos que fallaron',
    onlyFailed: 'solo errores',
    reloadTitle: 'Vuelve a leer el log',
    clearTitle: 'Vacía el log. No afecta al repositorio.',
    clear: 'Limpiar',
    noneFailed: 'Ningún comando falló.',
    empty: 'Todavía no se ejecutó ningún comando en esta sesión.',
    commandTitle: (p: {command: string; dir: string}) => `${p.command}\n\nen ${p.dir}`,
    duration: (ms: number) => `${ms} ms`,
    askTitle: 'Le pasa este comando y su error al agente, en el chat, para que explique qué pasó y cómo salir',
    copyTitle: 'Copia el comando para pegarlo en una terminal tal cual se ejecutó',
}
