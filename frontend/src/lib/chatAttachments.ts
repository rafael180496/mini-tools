// Adjuntos del chat: clasificación, topes y compatibilidad.
//
// Espeja backend/agentchat/attachments.go (qué es cada archivo y cuánto puede
// pesar) y backend/llm/attachcaps.go (qué admite cada destino). Se repite acá
// SOLO para decidir antes de subir: el backend vuelve a clasificar por el
// CONTENIDO del archivo y es quien manda. Un desacuerdo se resuelve a favor de
// Go (el chip toma el `kind` que devuelve SaveChatFile).

export type AttachmentKind = 'image' | 'pdf' | 'text'

// Lo que informa AgentAttachmentCapabilities. Estructural y no el tipo
// generado: el hook lo usa también en las capturas del banco.
export interface AttachCaps {
    images: boolean
    pdf: boolean
    text: boolean
    known: boolean
    maxImageBytes: number
    maxPdfBytes: number
    maxTextBytes: number
    maxCount: number
    note: string
}

// Topes por defecto mientras la consulta de capacidades no contesta (puede
// tardar: es una llamada HTTP al proveedor). Son los mismos que fija Go.
export const DEFAULT_LIMITS = {
    maxImageBytes: 20 * 1024 * 1024,
    maxPdfBytes: 24 * 1024 * 1024,
    maxTextBytes: 512 * 1024,
    maxCount: 10,
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

// Extensiones de texto y código habituales. No es una lista cerrada: un archivo
// con otra extensión se sube igual (con el tope de texto) y Go decide por su
// contenido; la lista sirve para el selector de archivos y para clasificar sin
// subir.
const TEXT_EXTS = [
    'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
    'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte', 'astro',
    'go', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'rs',
    'lua', 'pl', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'gql', 'proto', 'tf', 'hcl', 'properties', 'diff', 'patch', 'tex', 'rst', 'mod', 'sum', 'lock',
]
const TEXT_EXT_SET = new Set(TEXT_EXTS)
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'procfile', 'gemfile', 'rakefile'])
const TEXT_MIME_APPS = /^application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql|toml|x-ndjson)/

// `accept` del selector de archivos: imágenes que acepta Go, PDF y las
// extensiones de texto de arriba. Sin esto el diálogo ofrecería también
// binarios que van a rechazarse.
export const ATTACH_ACCEPT = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/*',
    ...TEXT_EXTS.map((e) => `.${e}`),
].join(',')

function extOf(name: string): string {
    const i = name.lastIndexOf('.')
    return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export type GuessedKind = AttachmentKind | 'image-unsupported' | 'unknown'

// guessKind decide qué es un archivo SIN leerlo. `image-unsupported` son las
// imágenes que Go rechaza (BMP, ICO, TIFF, HEIC…): decirlo antes ahorra subir
// megabytes para recibir el mismo "no". `unknown` no se descarta: se sube con
// el tope de texto y que decida Go.
export function guessKind(file: Pick<File, 'name' | 'type'>): GuessedKind {
    const mime = (file.type || '').toLowerCase()
    const ext = extOf(file.name)
    if (IMAGE_MIMES.has(mime) || (!mime && IMAGE_EXTS.has(ext))) return 'image'
    if (mime.startsWith('image/')) return mime === 'image/svg+xml' ? 'text' : 'image-unsupported'
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
    if (mime.startsWith('text/') || TEXT_MIME_APPS.test(mime) || TEXT_EXT_SET.has(ext) || TEXT_NAMES.has(file.name.toLowerCase())) {
        return 'text'
    }
    if (IMAGE_EXTS.has(ext)) return 'image'
    if (['bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'avif'].includes(ext)) return 'image-unsupported'
    return 'unknown'
}

export function limitFor(kind: AttachmentKind, caps: Pick<AttachCaps, 'maxImageBytes' | 'maxPdfBytes' | 'maxTextBytes'> | null): number {
    const l = {...DEFAULT_LIMITS, ...(caps ?? {})}
    return kind === 'image' ? l.maxImageBytes : kind === 'pdf' ? l.maxPdfBytes : l.maxTextBytes
}

// Cómo se lleva un adjunto con el destino elegido.
//   ok       lo lee
//   maybe    no se pudo confirmar (known=false): se manda igual y contesta el
//            proveedor
//   blocked  Go lo va a rechazar: se deshabilita Enviar
//
// Un PDF a un destino sin lectura de PDF es `blocked` AUNQUE known sea false:
// el envío lo rechaza siempre (no hay extracción de texto), a diferencia de una
// imagen, donde known=false significa "supongo que sí".
export type Compat = 'ok' | 'maybe' | 'blocked'

export function compatibility(kind: AttachmentKind, caps: AttachCaps | null): Compat {
    if (!caps || kind === 'text') return 'ok'
    if (kind === 'pdf') {
        if (!caps.pdf) return 'blocked'
        return caps.known ? 'ok' : 'maybe'
    }
    if (!caps.images) return caps.known ? 'blocked' : 'maybe'
    return caps.known ? 'ok' : 'maybe'
}

// Nombre para una captura pegada: el navegador le pone `image.png` a todas, y
// dos chips con el mismo nombre no se distinguen.
export function pastedName(file: File, n: number): string {
    const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name)
    if (!generic) return file.name
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
    const d = new Date()
    const hhmmss = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('')
    return `screenshot-${hhmmss}${n > 0 ? `-${n + 1}` : ''}.${ext}`
}

export function readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error ?? new DOMException('', 'NotReadableError'))
        reader.readAsDataURL(file)
    })
}

// Ficha de un adjunto ya enviado (lo que dibuja el mensaje del usuario). La URL
// de vista previa solo existe en la sesión que lo mandó.
export interface SentAttachment {
    name: string
    kind: string
    size: number
    previewUrl?: string
}
