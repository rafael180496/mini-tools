// Textos del área «terminal». Ver .claude/specs/i18n.md.
export default {
    // Paletas de color de las terminales (local y SSH).
    theme: {
        autoFull: 'Automático (sigue el tema de la app)',
        auto: 'Automático',
        menuTooltip: 'Cambiar la paleta de colores de las terminales. Se aplica al instante y a todas las terminales abiertas (local y SSH), y queda guardada.',
        autoTooltip: 'Sigue el modo claro/oscuro de la app: la terminal se aclara y se oscurece con el resto de la ventana',
        useInAll: (p: {name: string}) => `Usar la paleta ${p.name} en todas las terminales`,
        pickerTitle: 'Tema de terminal',
        closePanel: 'Cierra este panel',
        useInThis: (p: {name: string}) => `Usar el tema "${p.name}" en esta terminal — aplica a todas las sesiones SSH abiertas`,
        sampleUser: 'usuario@host',
    },
    // Pestaña «Terminal local» del módulo SSH.
    local: {
        title: 'Terminal local',
        titleTooltip: 'Corre en ESTA máquina, no en un servidor: lo que ejecutes acá pasa en tu equipo, con tus permisos.',
        snippetsTooltip: 'Snippets — los MISMOS que usás en las terminales SSH. Ejecutar los manda a esta shell local; Pegar los deja escritos para revisarlos antes.',
        historyTooltip: (p: {shell: string}) => `Comandos que ya ejecutaste en ${p.shell}, guardados cifrados en el vault. Se puede apagar el registro y borrar lo guardado desde el mismo panel.`,
        thisShell: 'esta shell',
        themeTooltip: 'Colores de la terminal. Es un ajuste de TODAS las terminales de la app, no solo de esta pestaña.',
        historyScope: 'la terminal local',
        historyKeepsNote: 'El historial del propio shell de tu máquina (~/.zsh_history, el de PowerShell y compañía) no se toca: eso vive afuera de la app y se limpia afuera.',
    },
    // Widget de terminal del sistema (compartido con el módulo Git).
    panel: {
        shellEnded: '[la shell terminó — usá Reiniciar para abrir otra]',
        unknownError: 'desconocido',
        running: 'La sesión está corriendo',
        notRunning: 'No hay ningún proceso corriendo en esta sesión',
        yourShell: 'tu shell',
        agentTooltip: (p: {agent: string; shell: string}) =>
            `Sesión de ${p.agent} corriendo dentro de ${p.shell}, en la raíz del repositorio. El agente corre DENTRO del shell: si lo cortás con Ctrl+C te queda la terminal viva en el mismo directorio.`,
        shellTooltip: (p: {shell: string}) =>
            `Intérprete en uso: ${p.shell}. Se cambia en Configuración → Terminal; cambiarlo reinicia esta sesión, porque no se puede cambiar el intérprete de un proceso que ya está corriendo.`,
        startTooltip: (p: {agent: string}) =>
            `Arranca ${p.agent} en esta sesión. No se lanzó solo porque la sesión viene restaurada del layout guardado, y un asistente consume cuota: arrancarlo es una decisión tuya, no un efecto de reabrir la app.`,
        start: 'Iniciar',
        clearTooltip: 'Borra lo que hay en pantalla y el historial de scroll. No cancela lo que esté corriendo ni cierra la sesión — para eso, Ctrl+C.',
        restartTooltip: 'Cierra esta sesión y abre una nueva en la raíz del repositorio — se pierde el directorio en el que estabas y todo lo que esté corriendo',
        restartAgentTooltip: (p: {agent: string}) =>
            `Cierra esta sesión y abre una nueva en la raíz del repositorio, con ${p.agent} de nuevo — se pierde el directorio en el que estabas y todo lo que esté corriendo`,
        reopenTooltip: 'Abre una sesión nueva: la anterior terminó (con exit, o porque el proceso murió)',
    },
    // Mosaico multi-agente de terminales PTY (Fase 4 ADE — modo Terminales).
    grid: {
        title: 'Mosaico de terminales',
        spaceLabel: 'Espacio',
        spaceHome: 'Carpeta personal (~)',
        spaceTitle: 'Directorio/repositorio donde se abrirán las nuevas terminales y agentes',
        launchAgent: (p: {name: string}) => `Abrir una terminal nueva corriendo ${p.name}`,
        newShell: 'Shell',
        newShellTitle: 'Abrir una terminal local nueva en el espacio elegido',
        layoutAuto: 'Auto',
        layoutAutoTitle: 'Distribución automática según la cantidad de terminales abiertas',
        layoutColsTitle: (p: {cols: number}) => `Fijar el mosaico a ${p.cols} ${p.cols === 1 ? 'columna' : 'columnas'}`,
        maximizeTile: 'Maximizar esta terminal a pantalla completa (las demás siguen vivas)',
        restoreTile: 'Volver a la vista en mosaico con todas las terminales',
        duplicateTile: 'Abrir otra terminal igual al lado',
        closeTile: 'Cerrar esta terminal y terminar su proceso',
        confirmCloseAgentTitle: '¿Cerrar el agente?',
        confirmCloseAgent: (p: {name: string}) =>
            `Se termina el proceso de ${p.name}. Si está a mitad de una tarea, la corta: lo que no haya guardado se pierde.`,
        confirmCloseAgentButton: 'Cerrar y terminar',
        emptyTitle: 'Lanza uno o varios agentes CLI en paralelo',
        emptyHint: 'Cada celda corre su propia terminal PTY real y sobrevive aunque cambies de modo.',
        activeCount: (p: {count: number}) => `${p.count} ${p.count === 1 ? 'sesión' : 'sesiones'}`,
    },
}
