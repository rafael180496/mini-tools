// Nombres de las conversaciones del chat de IA.
//
// Dos reglas que viven en el frontend y en Go (`chatTitleFrom` y
// `RenameAgentChat` en app_chatrecord.go / app_localterm.go): la fila de una
// conversación la puede crear cualquiera de los dos lados, y el título no puede
// depender de quién llegue primero. Si se cambia un número o una regla acá, se
// cambia allá en el mismo cambio.

// Largo máximo de un nombre puesto a mano.
export const MAX_CHAT_TITLE = 120
// Largo (aprox.) del título que sale del primer mensaje.
export const AUTO_TITLE_MAX = 60

// Referencias `@tipo:valor` del compositor (`@note:"Título"`): son contexto que
// se expande al mandar, no lo que el usuario quiso decir. Mismo criterio que
// agentctx.ParseRefs: tienen que abrir al principio o tras un separador.
const REF_RE = /(^|[\s(\[,])@(?:file|db|explain|ssh|git|note):(?:"[^"]*"|[^\s,]+)/g
const FENCE_RE = /```[\s\S]*?(?:```|$)/g

const firstLine = (s: string): string => {
    for (const line of s.split('\n')) {
        const f = line.split(/\s+/).filter(Boolean).join(' ')
        if (f) return f
    }
    return ''
}

// Valida un nombre que escribió el usuario: lo recorta, colapsa los espacios y lo
// limita a MAX_CHAT_TITLE. null = vacío (el llamador vuelve al nombre anterior).
export function cleanChatTitle(raw: string): string | null {
    const t = raw.split(/\s+/).filter(Boolean).join(' ')
    if (!t) return null
    return Array.from(t).slice(0, MAX_CHAT_TITLE).join('').trim()
}

// Título de una conversación nueva, sacado del primer mensaje: su primera línea
// con texto, sin referencias ni bloques de código, recortada a AUTO_TITLE_MAX.
// '' si no hay nada que mostrar (el llamador pone su propio rótulo).
export function chatTitleFromMessage(text: string): string {
    let line = firstLine(text.replace(REF_RE, '$1 ').replace(FENCE_RE, ' '))
    if (!line) line = firstLine(text)
    const chars = Array.from(line)
    if (chars.length > AUTO_TITLE_MAX) line = chars.slice(0, AUTO_TITLE_MAX - 1).join('').trimEnd() + '…'
    return line
}
