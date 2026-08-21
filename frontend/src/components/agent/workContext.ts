// Contexto de trabajo del chat unificado: sobre QUÉ se está preguntando.
//
// Hasta 1.3.x el chat era del módulo Git y recibía un `repoId` obligatorio. El
// chat ahora es uno solo para toda la app y se abre desde el editor SQL, una
// terminal SSH o una nota, donde no hay repositorio — así que lo que viaja no
// es un id suelto sino de qué módulo salió y sobre qué recurso.
//
// Es un descriptor, no una referencia viva: `id` es el id opaco del recurso y
// `label` su nombre visible EN ESTE MOMENTO. El label no se persiste (ver
// AgentChat.Module en backend/vault/agent_chats_repo.go) justamente para que
// renombrar una conexión no deje el historial mintiendo.

export type WorkContextKind = 'git' | 'db' | 'ssh' | 'note' | 'http' | 'none'

export interface WorkContext {
    kind: WorkContextKind
    // Id opaco del recurso: id de repositorio, id de conexión, id de conexión
    // SSH, id de nota, id de petición HTTP. Vacío cuando kind es 'none' — y
    // también en una petición rápida, que no tiene ítem guardado: todas
    // comparten entonces una conversación, que es lo correcto para pruebas
    // sueltas que no son "sobre" nada en particular.
    id: string
    // Nombre visible para el encabezado ("mini-tools", "Prod_Analytics"). Es
    // presentación: nunca se manda al agente ni se guarda.
    label: string
}

export const NO_CONTEXT: WorkContext = {kind: 'none', id: '', label: ''}

// CONTEXT_ICONS son los íconos Material Symbols de cada módulo. Los mismos que
// ya usa cada módulo en su propia pestaña, para que el encabezado del chat se
// lea como "esto es la pestaña de al lado" y no como una taxonomía nueva.
export const CONTEXT_ICONS: Record<WorkContextKind, string> = {
    git: 'account_tree',
    db: 'database',
    ssh: 'terminal',
    note: 'description',
    // El mismo ícono que el módulo en la barra lateral: el encabezado del chat
    // tiene que leerse como "esto es la pestaña de al lado".
    http: 'api',
    none: 'smart_toy',
}

// CONTEXT_NOUNS es cómo se nombra el recurso en una frase ("sobre este
// repositorio"). Se usa en el estado vacío del chat y en los tooltips.
export const CONTEXT_NOUNS: Record<WorkContextKind, string> = {
    git: 'repositorio',
    db: 'conexión',
    ssh: 'servidor',
    note: 'nota',
    http: 'petición',
    none: '',
}

// repoIdOf devuelve el id SOLO cuando el contexto es un repositorio.
//
// Existe como función y no como `context.id` a secas porque es exactamente el
// lugar donde se puede colar el error: mandarle a SendAgentChat el id de una
// conexión de base de datos en el parámetro del repositorio haría que el
// backend intente resolverlo como repo y falle con un mensaje que no tiene
// nada que ver con lo que el usuario hizo.
export function repoIdOf(context: WorkContext): string {
    return context.kind === 'git' ? context.id : ''
}

// describeContext arma la línea del encabezado: "Git · mini-tools".
export function describeContext(context: WorkContext): string {
    if (context.kind === 'none' || !context.label) return ''
    const prefix =
        context.kind === 'git'
            ? 'Git'
            : context.kind === 'db'
              ? 'Base'
              : context.kind === 'ssh'
                ? 'SSH'
                : context.kind === 'http'
                  ? 'HTTP'
                  : 'Nota'
    return `${prefix} · ${context.label}`
}

// contextKey identifica una conversación: **hay una por contexto de trabajo**.
//
// Abrir el chat desde una conexión de base de datos trae la conversación de esa
// conexión; desde una terminal SSH, la de ese servidor; desde una nota, la de
// esa nota. No es una sola conversación que se arrastra por toda la app: son
// hilos separados, porque lo que se habla en cada lugar no tiene nada que ver
// con lo de al lado — y mezclarlo hace que el agente arrastre contexto que no
// corresponde.
//
// La nota va por ID y no por módulo, a propósito: "el chat de las notas" no
// existe: existe el de ESTA nota, que es sobre lo que uno pregunta.
export function contextKey(context: WorkContext): string {
    if (context.kind === 'none') return 'none'
    return `${context.kind}:${context.id}`
}
