// Atajos del formulario «Agregar servidor de modelos»: cada uno completa tipo,
// dirección y nombre con lo que casi siempre se escribe a mano. Solo hay
// DATOS acá —nada que se vea en pantalla—: los rótulos viven en el diccionario
// (`settings.modelServers.presets`) y se buscan por la clave de cada atajo.
//
// Un atajo no recuerda nada: el formulario arranca sin ninguno elegido cada vez
// que se abre, y elegir uno solo rellena campos que después se editan a mano.

export type PresetKey = 'ollamaLocal' | 'ollamaRemote' | 'lmstudio' | 'vllm' | 'llamacpp' | 'openaiOther'

export interface Preset {
    key: PresetKey
    kind: 'ollama' | 'openai'
    // Ícono de Material Symbols (existente: se comprobó contra la fuente).
    icon: string
    // Nombre propio del producto, que no se traduce.
    brand: string
    // Dirección completa cuando el servidor está en esta máquina; '' si no hay
    // una fija (se arma con host y puerto, o la escribe la persona).
    fixedUrl: string
    // Pide IP/nombre y puerto, y con ellos arma `http://<host>:<puerto><path>`.
    hostPort: boolean
    defaultPort: number
    path: string
}

export const PRESETS: Preset[] = [
    {key: 'ollamaLocal', kind: 'ollama', icon: 'computer', brand: 'Ollama', fixedUrl: 'http://localhost:11434', hostPort: false, defaultPort: 11434, path: ''},
    {key: 'ollamaRemote', kind: 'ollama', icon: 'lan', brand: 'Ollama', fixedUrl: '', hostPort: true, defaultPort: 11434, path: ''},
    {key: 'lmstudio', kind: 'openai', icon: 'laptop_mac', brand: 'LM Studio', fixedUrl: 'http://localhost:1234/v1', hostPort: false, defaultPort: 1234, path: '/v1'},
    {key: 'vllm', kind: 'openai', icon: 'dns', brand: 'vLLM', fixedUrl: '', hostPort: true, defaultPort: 8000, path: '/v1'},
    {key: 'llamacpp', kind: 'openai', icon: 'terminal', brand: 'llama.cpp', fixedUrl: 'http://localhost:8080/v1', hostPort: false, defaultPort: 8080, path: '/v1'},
    {key: 'openaiOther', kind: 'openai', icon: 'tune', brand: 'OpenAI', fixedUrl: '', hostPort: false, defaultPort: 0, path: ''},
]

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
