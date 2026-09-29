// Textos del área «shell». Ver .claude/specs/i18n.md.
export default {
    titleBar: {
        minimize: 'Minimizar',
        minimizeTitle: 'Minimizar la ventana',
        maximize: 'Maximizar',
        maximizeTitle: 'Maximizar la ventana',
        restore: 'Restaurar',
        restoreTitle: 'Restaurar la ventana a su tamaño anterior',
        quit: 'Cerrar',
        quitTitle: 'Cerrar la aplicación',
    },
    masterMenu: {
        title: (p: {label: string; hint: string}) => `${p.label} — ${p.hint}`,
        activeTitle: (p: {label: string; hint: string}) => `${p.label} — ${p.hint} (es el módulo que estás viendo)`,
        matchesTitle: (p: {label: string; hint: string; count: number}) =>
            `${p.label} — ${p.hint}. ${
                p.count === 0
                    ? 'Sin coincidencias con la búsqueda actual'
                    : `${p.count} ${p.count === 1 ? 'coincidencia' : 'coincidencias'} con la búsqueda actual`
            }`,
    },
    sidebar: {
        helpTitle: 'Abrir la documentación en el navegador: qué hace cada módulo, ejemplos de uso y recetas de principio a fin',
        themeToLight: 'Cambiar al tema claro — se guarda y arranca así la próxima vez',
        themeToDark: 'Cambiar al tema oscuro — se guarda y arranca así la próxima vez',
        settingsTitle: 'Configuración: tamaño de letra y tema del editor, backup del vault, terminal y agentes de IA',
        settingsUpdateTitle: (p: {latest: string}) =>
            `Configuración: apariencia, vault, terminal y agentes — y el link para bajar la v${p.latest}, que ya está disponible`,
        updateDownload: (p: {current: string; latest: string; file: string}) =>
            `Estás en la v${p.current} y hay una v${p.latest} disponible — clic para descargar ${p.file}`,
        updatePage: (p: {current: string; latest: string}) =>
            `Estás en la v${p.current} y hay una v${p.latest} disponible — clic para abrir su página de descarga`,
        versionTitle: (p: {version: string}) => `mini-tools ${p.version} — la versión instalada en este equipo`,
        markUpdateDownload: (p: {current: string; latest: string; file: string}) =>
            `mini-tools v${p.current} — hay una v${p.latest} disponible, clic para descargar ${p.file}`,
        markUpdatePage: (p: {current: string; latest: string}) =>
            `mini-tools v${p.current} — hay una v${p.latest} disponible, clic para abrir su página de descarga`,
        expand: 'Mostrar la barra lateral con el árbol de conexiones, servidores, repositorios y notas',
        collapse: 'Ocultar la barra lateral y darle todo el ancho al editor — queda una columna con los íconos de los módulos para volver',
        searchPlaceholder: 'Buscar en todo…',
        searchTitle:
            'Busca a la vez en conexiones de base de datos, servidores SSH, repositorios Git y notas — por nombre del elemento o de la carpeta que lo contiene. Los íconos de arriba muestran cuántas coincidencias tiene cada módulo',
        clearSearch: 'Limpiar la búsqueda y volver a ver el módulo completo',
        resize: 'Arrastrar para cambiar el ancho de la barra lateral — el tamaño queda guardado',
    },
    // Marcas de entorno de una conexión (lib/environments.ts).
    environments: {
        prod: {
            label: 'Producción',
            description: 'Marca la conexión en rojo y pide confirmación antes de ejecutar comandos destructivos en su terminal.',
        },
        staging: {
            label: 'Staging / QA',
            description: 'Marca la conexión en ámbar. Sin confirmaciones extra.',
        },
        dev: {
            label: 'Desarrollo',
            description: 'Marca la conexión en verde. Sin confirmaciones extra.',
        },
    },
}
