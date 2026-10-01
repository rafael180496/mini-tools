// El catálogo de herramientas del módulo Utilidades.
//
// Una herramienta nueva se agrega en cuatro lugares del mismo cambio: acá (su
// id y su ícono), el diccionario (`utilities.tools.<id>` en es/ y en/), el
// `switch` que monta su pestaña en Workspace.tsx y —si necesita backend— un
// paquete en backend/ con sus bindings en app_utilities.go.
//
// Los textos NO viven acá: un texto guardado en una constante de módulo se
// queda en el idioma con el que arrancó la app. Se leen de
// `t.utilities.tools[id]` al dibujar.
export type UtilityId = 'portKiller' | 'activityMonitor' | 'docker'

export interface UtilityDef {
    id: UtilityId
    // Ligadura de Material Symbols Outlined.
    icon: string
}

export const UTILITIES: UtilityDef[] = [
    {id: 'portKiller', icon: 'lan'},
    {id: 'activityMonitor', icon: 'monitor_heart'},
    {id: 'docker', icon: 'deployed_code'},
]
