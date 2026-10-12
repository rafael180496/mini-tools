// Preferencias del Chat de IA POR PROYECTO: el último modo elegido, qué modos
// permisivos ya se aprobaron para ese proyecto y si se descartó la sugerencia del
// modo Automático.
//
// Viven en localStorage y no en el vault por el mismo motivo que la disposición
// del chat (aichat/layoutPrefs.ts): son de este equipo, no datos de la cuenta, y
// si el almacenamiento no está (ventana privada, bloqueado) todo sigue
// funcionando — solo que sin memoria. Por eso cada acceso va envuelto.
//
// La clave es el id del contexto de trabajo: el de un repositorio, o `ws:<id>`
// para una carpeta. Un proyecto quitado deja su entrada huérfana; pesa unos
// bytes y no se limpia.

const PREFIX = 'mini-tools:aiChat:project:'

export interface ProjectPrefs {
    // Último modo elegido a mano en este proyecto ('' = solo consulta).
    mode?: string
    // Modos permisivos cuya confirmación ya se aceptó para este proyecto: la
    // advertencia se muestra la primera vez, no en cada chat.
    acked?: string[]
    // El usuario descartó la sugerencia «usar Automático».
    autoHintDismissed?: boolean
}

export function readProjectPrefs(projectId: string): ProjectPrefs {
    if (!projectId) return {}
    try {
        const raw = localStorage.getItem(PREFIX + projectId)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as ProjectPrefs
        return {
            mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
            acked: Array.isArray(parsed.acked) ? parsed.acked.filter((m) => typeof m === 'string') : undefined,
            autoHintDismissed: parsed.autoHintDismissed === true,
        }
    } catch {
        return {}
    }
}

export function writeProjectPrefs(projectId: string, patch: ProjectPrefs): void {
    if (!projectId) return
    try {
        const next = {...readProjectPrefs(projectId), ...patch}
        localStorage.setItem(PREFIX + projectId, JSON.stringify(next))
    } catch {
        // no se pudo recordar; la sesión sigue con el valor en memoria
    }
}

// Marca un modo permisivo como aprobado para el proyecto.
export function ackProjectMode(projectId: string, mode: string): void {
    const acked = readProjectPrefs(projectId).acked ?? []
    if (acked.includes(mode)) return
    writeProjectPrefs(projectId, {acked: [...acked, mode]})
}

export function isProjectModeAcked(projectId: string, mode: string): boolean {
    return (readProjectPrefs(projectId).acked ?? []).includes(mode)
}
