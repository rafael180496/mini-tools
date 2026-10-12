// Atajos del formulario «Agregar servidor de modelos»: cada uno completa tipo,
// dirección y nombre con lo que casi siempre se escribe a mano. Solo hay
// DATOS acá —nada que se vea en pantalla—: los rótulos viven en el diccionario
// (`settings.modelServers.presets`) y se buscan por la clave de cada atajo.
//
// Un atajo no recuerda nada: el formulario arranca sin ninguno elegido cada vez
// que se abre, y elegir uno solo rellena campos que después se editan a mano.

import type {Dict} from '../i18n'

export type LocalPresetKey = 'ollamaLocal' | 'ollamaRemote' | 'lmstudio' | 'vllm' | 'llamacpp' | 'openaiOther'
export type CloudPresetKey = 'openrouter' | 'openai' | 'groq' | 'deepseek' | 'mistral' | 'together' | 'xai' | 'gemini' | 'anthropic'
export type PresetKey = LocalPresetKey | CloudPresetKey

// «local»: un servidor propio, en esta máquina o en otra; se arma con una
// dirección. «cloud»: una API alojada que solo pide una API key.
export type PresetGroup = 'local' | 'cloud'

export interface Preset {
    key: PresetKey
    group: PresetGroup
    kind: 'ollama' | 'openai' | 'anthropic'
    // Ícono de Material Symbols (existente: se comprobó contra la fuente). Son
    // íconos genéricos a propósito: la app no lleva logos de marcas.
    icon: string
    // Nombre propio del producto, que no se traduce.
    brand: string
    // Dirección completa cuando el servidor está en esta máquina o es una API
    // alojada; '' si no hay una fija (se arma con host y puerto, o la escribe
    // la persona).
    fixedUrl: string
    // Pide IP/nombre y puerto, y con ellos arma `http://<host>:<puerto><path>`.
    hostPort: boolean
    defaultPort: number
    path: string
    // Solo nube: el host de la API (para reconocer un proveedor ya guardado), la
    // página donde se genera la API key y el modelo con el que arranca, si el
    // proveedor tiene uno recomendado.
    host?: string
    keyUrl?: string
    defaultModel?: string
}

export const PRESETS: Preset[] = [
    {key: 'ollamaLocal', group: 'local', kind: 'ollama', icon: 'computer', brand: 'Ollama', fixedUrl: 'http://localhost:11434', hostPort: false, defaultPort: 11434, path: ''},
    {key: 'ollamaRemote', group: 'local', kind: 'ollama', icon: 'lan', brand: 'Ollama', fixedUrl: '', hostPort: true, defaultPort: 11434, path: ''},
    {key: 'lmstudio', group: 'local', kind: 'openai', icon: 'laptop_mac', brand: 'LM Studio', fixedUrl: 'http://localhost:1234/v1', hostPort: false, defaultPort: 1234, path: '/v1'},
    {key: 'vllm', group: 'local', kind: 'openai', icon: 'dns', brand: 'vLLM', fixedUrl: '', hostPort: true, defaultPort: 8000, path: '/v1'},
    {key: 'llamacpp', group: 'local', kind: 'openai', icon: 'terminal', brand: 'llama.cpp', fixedUrl: 'http://localhost:8080/v1', hostPort: false, defaultPort: 8080, path: '/v1'},
    {key: 'openaiOther', group: 'local', kind: 'openai', icon: 'tune', brand: 'OpenAI', fixedUrl: '', hostPort: false, defaultPort: 0, path: ''},
    // Nube: la API key es obligatoria y la dirección ya viene puesta.
    {key: 'openrouter', group: 'cloud', kind: 'openai', icon: 'alt_route', brand: 'OpenRouter', fixedUrl: 'https://openrouter.ai/api/v1', hostPort: false, defaultPort: 0, path: '', host: 'openrouter.ai', keyUrl: 'https://openrouter.ai/keys'},
    {key: 'openai', group: 'cloud', kind: 'openai', icon: 'auto_awesome', brand: 'OpenAI', fixedUrl: 'https://api.openai.com/v1', hostPort: false, defaultPort: 0, path: '', host: 'api.openai.com', keyUrl: 'https://platform.openai.com/api-keys'},
    {key: 'groq', group: 'cloud', kind: 'openai', icon: 'bolt', brand: 'Groq', fixedUrl: 'https://api.groq.com/openai/v1', hostPort: false, defaultPort: 0, path: '', host: 'api.groq.com', keyUrl: 'https://console.groq.com/keys'},
    {key: 'deepseek', group: 'cloud', kind: 'openai', icon: 'travel_explore', brand: 'DeepSeek', fixedUrl: 'https://api.deepseek.com/v1', hostPort: false, defaultPort: 0, path: '', host: 'api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys'},
    {key: 'mistral', group: 'cloud', kind: 'openai', icon: 'air', brand: 'Mistral', fixedUrl: 'https://api.mistral.ai/v1', hostPort: false, defaultPort: 0, path: '', host: 'api.mistral.ai', keyUrl: 'https://console.mistral.ai/api-keys'},
    {key: 'together', group: 'cloud', kind: 'openai', icon: 'hub', brand: 'Together', fixedUrl: 'https://api.together.xyz/v1', hostPort: false, defaultPort: 0, path: '', host: 'api.together.xyz', keyUrl: 'https://api.together.ai/settings/api-keys'},
    {key: 'xai', group: 'cloud', kind: 'openai', icon: 'rocket_launch', brand: 'xAI', fixedUrl: 'https://api.x.ai/v1', hostPort: false, defaultPort: 0, path: '', host: 'api.x.ai', keyUrl: 'https://console.x.ai'},
    {key: 'gemini', group: 'cloud', kind: 'openai', icon: 'diamond', brand: 'Google Gemini', fixedUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hostPort: false, defaultPort: 0, path: '', host: 'generativelanguage.googleapis.com', keyUrl: 'https://aistudio.google.com/apikey'},
    {key: 'anthropic', group: 'cloud', kind: 'anthropic', icon: 'psychology', brand: 'Anthropic', fixedUrl: 'https://api.anthropic.com', hostPort: false, defaultPort: 0, path: '', host: 'api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-opus-5-5'},
]

export const LOCAL_PRESETS = PRESETS.filter((p) => p.group === 'local')
export const CLOUD_PRESETS = PRESETS.filter((p) => p.group === 'cloud')

export function isCloudPreset(p: Preset): p is Preset & {key: CloudPresetKey} {
    return p.group === 'cloud'
}

// El proveedor alojado al que apunta una dirección, o null si es un servidor
// propio. Reconoce el host exacto y sus subdominios.
export function cloudPresetForUrl(url: string): Preset | null {
    let host = ''
    try {
        host = new URL(url.trim()).hostname.toLowerCase()
    } catch {
        return null
    }
    return CLOUD_PRESETS.find((p) => p.host && (host === p.host || host.endsWith('.' + p.host))) ?? null
}

export function presetByKey(key: PresetKey): Preset {
    return PRESETS.find((p) => p.key === key) ?? PRESETS[0]
}

// Puerto TCP válido (1–65535), solo dígitos.
export function validPort(port: string): boolean {
    if (!/^\d{1,5}$/.test(port.trim())) return false
    const n = Number(port)
    return n >= 1 && n <= 65535
}

// ¿El host que se escribió está mal formado? Vacío NO cuenta (es un campo que
// falta llenar, no un error). Un host es solo la IP o el
// nombre: con esquema, barras, espacios o un puerto pegado la URL que se arma
// quedaría rota sin que se note.
export function hostProblem(host: string): boolean {
    const h = host.trim()
    if (h === '') return false
    if (/\s|\/|@|\?|#/.test(h)) return true
    // IPv6 entre corchetes o sin ellos (varios «:»), o un nombre/IPv4 sin «:».
    if (/^\[[0-9a-fA-F:.]+\]$/.test(h)) return false
    if ((h.match(/:/g) ?? []).length >= 2) return !/^[0-9a-fA-F:.]+$/.test(h)
    return !/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(h)
}

function hostForUrl(host: string): string {
    const h = host.trim()
    return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
}

// `http://<host>:<puerto><path>`, o '' si falta algo o algo no es válido.
export function composeUrl(p: Preset, host: string, port: string): string {
    if (host.trim() === '' || hostProblem(host) || !validPort(port)) return ''
    return `http://${hostForUrl(host)}:${Number(port)}${p.path}`
}

// Inversa de `composeUrl`: si la dirección tiene exactamente esa forma, devuelve
// su host y puerto. Sirve para que editar la URL a mano mantenga sincronizados
// los dos campos mientras siga siendo la misma clase de dirección.
export function parseHostPortUrl(p: Preset, url: string): {host: string; port: string} | null {
    let rest = url.trim()
    if (p.path) {
        if (!rest.endsWith(p.path)) return null
        rest = rest.slice(0, -p.path.length)
    }
    const m = /^http:\/\/(\[[0-9a-fA-F:.]+\]|[^/:@\s?#]+):(\d{1,5})$/.exec(rest)
    if (!m || !validPort(m[2])) return null
    return {host: m[1].replace(/^\[|\]$/g, ''), port: m[2]}
}

// Host y puerto de una dirección cualquiera, para que la guía hable del
// servidor que de verdad se va a guardar aunque no venga de un atajo.
export function hostPortOf(url: string): {host: string; port: string} {
    try {
        const u = new URL(url.trim())
        return {host: u.hostname, port: u.port}
    } catch {
        return {host: '', port: ''}
    }
}

// Nombre, pista y tooltip de un atajo. Los locales tienen su texto en el
// diccionario (cada uno dice algo distinto); los de la nube comparten forma y
// solo cambian la marca y el host, que son nombres propios y no se traducen.
export function presetTexts(texts: Dict['settings']['modelServers']['presets'], p: Preset): {name: string; hint: string; title: string} {
    if (p.group === 'cloud') return {name: p.brand, hint: p.host ?? '', title: texts.cloudTitle({brand: p.brand, host: p.host ?? ''})}
    const key = p.key as LocalPresetKey
    return {name: texts[key], hint: texts[`${key}Hint` as const], title: texts[`${key}Title` as const]}
}
