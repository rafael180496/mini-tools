// Los servidores de modelos (Ollama, compatibles con OpenAI) aparecen en el
// catálogo de agentes con id `llm:<serverId>`, al lado de los CLIs. No son un
// programa de terminal: no tienen comando que abrir, API key por variable de
// entorno, login propio, sesión en una terminal, límites que consultar ni
// conversaciones guardadas por un CLI. Todo lo que solo tiene sentido para un
// CLI se apaga preguntando esto, en un solo lugar.
import {cloudPresetForUrl, type Preset} from './modelServerPresets'

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

// ¿El fallo de una prueba es de los que explica un Ollama que no escucha en la
// red? Conexión rechazada, tiempo agotado o red/host inalcanzable.
//
// Es una heurística sobre el texto y se dice: el backend devuelve el error ya
// traducido y sin un código aparte (`ModelServerProbe.error` es un string), así
// que no hay otra señal. Reconoce solo las dos frases de `llm.ConnError` (en los
// dos idiomas) y los mensajes del sistema que cuelgan de ellas. Un error de
// certificado, de nombre o un 401 no entra: el consejo no les sirve.
const UNREACHABLE_RE =
    /rechazad|refused|agot[oó] el tiempo|timed out|timeout|no route to host|network is unreachable|host is unreachable|inalcanzable/i

export function looksUnreachable(error: string): boolean {
    return UNREACHABLE_RE.test(error)
}

// Tipo de API de un proveedor. El backend guarda el texto; cualquier valor que
// no sea «openai» ni «anthropic» se trata como Ollama, que es lo que había antes.
export type ProviderKind = 'ollama' | 'openai' | 'anthropic'

export function providerKind(kind: string): ProviderKind {
    return kind === 'openai' ? 'openai' : kind === 'anthropic' ? 'anthropic' : 'ollama'
}

// Dónde corre un proveedor, para agrupar la lista de «Proveedores de IA»:
// «local» (esta máquina), «remote» (un servidor propio en otra máquina) o
// «cloud» (una API alojada que se paga con API key: OpenRouter, OpenAI,
// Anthropic…). Anthropic es siempre nube; el resto se reconoce por el host de
// su dirección, no por el tipo: un servidor «compatible con OpenAI» puede ser
// LM Studio en esta máquina o api.openai.com.
export type ProviderGroup = 'local' | 'remote' | 'cloud'

interface ProviderLike {
    kind: string
    baseUrl: string
    isLocal: boolean
}

export function cloudPresetOf(s: ProviderLike): Preset | null {
    return cloudPresetForUrl(s.baseUrl)
}

export function providerGroup(s: ProviderLike): ProviderGroup {
    if (s.kind === 'anthropic' || cloudPresetForUrl(s.baseUrl)) return 'cloud'
    return s.isLocal ? 'local' : 'remote'
}

// Ícono genérico de Material Symbols del proveedor (la app no lleva logos de
// marcas): el del atajo si es un proveedor alojado conocido; si no, el del tipo.
export function providerIcon(s: ProviderLike): string {
    const cloud = cloudPresetForUrl(s.baseUrl)
    if (cloud) return cloud.icon
    if (s.kind === 'anthropic') return 'psychology'
    return s.kind === 'openai' ? 'api' : 'neurology'
}
