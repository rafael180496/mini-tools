// Los servidores de modelos (Ollama, compatibles con OpenAI) aparecen en el
// catálogo de agentes con id `llm:<serverId>`, al lado de los CLIs. No son un
// programa de terminal: no tienen comando que abrir, API key por variable de
// entorno, login propio, sesión en una terminal, límites que consultar ni
// conversaciones guardadas por un CLI. Todo lo que solo tiene sentido para un
// CLI se apaga preguntando esto, en un solo lugar.
export const MODEL_SERVER_PREFIX = 'llm:'

export function isModelServerAgent(agentId: string): boolean {
    return agentId.startsWith(MODEL_SERVER_PREFIX)
}

// Dirección que nunca sale de esta máquina: lo que se le manda a un servidor
// así no viaja por ninguna red.
export function isLoopbackUrl(url: string): boolean {
    try {
        const host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase()
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
    } catch {
        return false
    }
}

// «Usá las cabeceras guardadas del servidor» para `TestModelServer`: el backend
// distingue un mapa nil (null en el JSON) de uno vacío —vacío significa «probá
// sin cabeceras»—. El generador de Wails tipa todo mapa de Go como
// `Record<string, string>` sin admitir null, así que el null se declara acá,
// una vez, en vez de repartir casts por las pantallas.
export const STORED_HEADERS = null as unknown as Record<string, string>
