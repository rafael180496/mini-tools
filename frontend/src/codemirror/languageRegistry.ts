import type {Extension} from '@codemirror/state'
import {StreamLanguage} from '@codemirror/language'

// Resolución de lenguaje por nombre de archivo, para el editor de archivos del
// módulo Git.
//
// Por qué es un registro aparte y no una extensión del `TabLanguage` del
// workspace de base de datos (`components/editor/EditorTabs.tsx`): ese tipo es
// una unión cerrada de tres lenguajes, y cada una de esas pestañas arrastra
// `connId`/`dbType`/`schemaMetadata` porque su razón de ser es estar vinculada
// a una conexión. Un archivo `.go` del repositorio no tiene conexión, no tiene
// esquema y no tiene autocompletado por esquema; meterlo en esa unión
// obligaría a que cada pestaña de archivo cargue un aparato que no usa, y a
// que cada pestaña de SQL tolere un lenguaje que no puede ejecutar.
//
// TODO el peso se carga con `import()` dinámico, nunca estático. Es una
// decisión de tamaño, no de estilo: el binario de producción tiene un techo
// duro de 80MB (.claude/rules/technical.md punto 8) y el bundle del frontend
// va embebido adentro. Con imports estáticos, abrir la app cargaría los
// parsers de veinte lenguajes que nadie abrió; así, cada uno entra a su propio
// chunk y solo viaja cuando se abre un archivo de ese tipo.

export type LanguageId =
    | 'plaintext'
    | 'javascript'
    | 'jsx'
    | 'typescript'
    | 'tsx'
    | 'json'
    | 'python'
    | 'go'
    | 'rust'
    | 'java'
    | 'kotlin'
    | 'scala'
    | 'csharp'
    | 'cpp'
    | 'objectivec'
    | 'swift'
    | 'dart'
    | 'php'
    | 'ruby'
    | 'perl'
    | 'lua'
    | 'groovy'
    | 'r'
    | 'html'
    | 'vue'
    | 'css'
    | 'xml'
    | 'markdown'
    | 'yaml'
    | 'toml'
    | 'ini'
    | 'shell'
    | 'powershell'
    | 'dockerfile'
    | 'diff'
    | 'sql'

interface LanguageDef {
    id: LanguageId
    label: string
    // Extensiones sin punto y en minúsculas.
    extensions: string[]
    // Nombres de archivo completos, en minúsculas — Dockerfile, Makefile y
    // compañía no se identifican por extensión.
    filenames?: string[]
    // Ausente solo en 'plaintext', que es la ausencia de lenguaje.
    load?: () => Promise<Extension>
}

// El orden importa solo para el selector manual; la resolución es por mapa.
const DEFS: LanguageDef[] = [
    {id: 'plaintext', label: 'Texto plano', extensions: ['txt', 'log', 'text']},

    {
        id: 'javascript',
        label: 'JavaScript',
        extensions: ['js', 'mjs', 'cjs'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript(),
    },
    {
        id: 'jsx',
        label: 'JavaScript (JSX)',
        extensions: ['jsx'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({jsx: true}),
    },
    {
        id: 'typescript',
        label: 'TypeScript',
        extensions: ['ts', 'mts', 'cts'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({typescript: true}),
    },
    {
        id: 'tsx',
        label: 'TypeScript (TSX)',
        extensions: ['tsx'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({typescript: true, jsx: true}),
    },
    {
        id: 'json',
        label: 'JSON',
        extensions: ['json', 'jsonc', 'json5', 'webmanifest'],
        filenames: ['.eslintrc', '.babelrc', '.prettierrc'],
        load: async () => (await import('@codemirror/lang-json')).json(),
    },
    {
        id: 'python',
        label: 'Python',
        extensions: ['py', 'pyi', 'pyw'],
        load: async () => (await import('@codemirror/lang-python')).python(),
    },
    {
        id: 'go',
        label: 'Go',
        extensions: ['go'],
        load: async () => (await import('@codemirror/lang-go')).go(),
    },
    {
        id: 'rust',
        label: 'Rust',
        extensions: ['rs'],
        load: async () => (await import('@codemirror/lang-rust')).rust(),
    },
    {
        id: 'java',
        label: 'Java',
        extensions: ['java'],
        load: async () => (await import('@codemirror/lang-java')).java(),
    },
    {
        id: 'cpp',
        label: 'C / C++',
        extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino'],
        load: async () => (await import('@codemirror/lang-cpp')).cpp(),
    },
    {
        id: 'php',
        label: 'PHP',
        extensions: ['php', 'phtml'],
        load: async () => (await import('@codemirror/lang-php')).php(),
    },
    {
        id: 'html',
        label: 'HTML',
        extensions: ['html', 'htm', 'xhtml'],
        load: async () => (await import('@codemirror/lang-html')).html(),
    },
    {
        id: 'vue',
        label: 'Vue',
        extensions: ['vue'],
        load: async () => (await import('@codemirror/lang-vue')).vue(),
    },
    {
        id: 'css',
        label: 'CSS',
        // scss/less/sass entran por acá a propósito: son supersets de CSS y el
        // parser de CSS los resalta de forma razonable. Un modo dedicado por
        // cada preprocesador sería más peso del que justifica la diferencia.
        extensions: ['css', 'scss', 'less', 'sass', 'pcss', 'postcss'],
        load: async () => (await import('@codemirror/lang-css')).css(),
    },
    {
        id: 'xml',
        label: 'XML',
        extensions: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'plist', 'csproj', 'pom'],
        load: async () => (await import('@codemirror/lang-xml')).xml(),
    },
    {
        id: 'markdown',
        label: 'Markdown',
        extensions: ['md', 'markdown', 'mdx', 'mdown'],
        load: async () => (await import('@codemirror/lang-markdown')).markdown(),
    },
    {
        id: 'yaml',
        label: 'YAML',
        extensions: ['yaml', 'yml'],
        load: async () => (await import('@codemirror/lang-yaml')).yaml(),
    },
    {
        id: 'sql',
        label: 'SQL',
        extensions: ['sql', 'ddl', 'pks', 'pkb', 'prc', 'fnc'],
        // Dialecto estándar y sin esquema, a diferencia de las pestañas del
        // workspace: un .sql del repositorio es un archivo, no una consulta
        // atada a una conexión abierta.
        load: async () => (await import('@codemirror/lang-sql')).sql(),
    },

    // --- Modos legacy ------------------------------------------------------
    //
    // Un solo paquete (@codemirror/legacy-modes) cubre decenas de lenguajes
    // que no tienen parser Lezer propio. Son resaltadores por tokens, sin
    // árbol sintáctico: no dan plegado ni indentación inteligente, pero para
    // leer y editar un script de shell o un Dockerfile es exactamente lo que
    // hace falta, y la alternativa es texto plano.
    {
        id: 'shell',
        label: 'Shell',
        extensions: ['sh', 'bash', 'zsh', 'ksh', 'fish', 'bashrc', 'zshrc'],
        filenames: ['.bashrc', '.zshrc', '.bash_profile', '.profile', '.zprofile'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
    },
    {
        id: 'dockerfile',
        label: 'Dockerfile',
        extensions: ['dockerfile'],
        filenames: ['dockerfile', 'containerfile'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
    },
    {
        id: 'toml',
        label: 'TOML',
        extensions: ['toml'],
        filenames: ['cargo.lock'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
    },
    {
        id: 'ini',
        label: 'INI / Properties',
        extensions: ['ini', 'cfg', 'conf', 'properties', 'editorconfig', 'env'],
        filenames: ['.editorconfig', '.env', '.gitconfig', '.npmrc'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties),
    },
    {
        id: 'powershell',
        label: 'PowerShell',
        extensions: ['ps1', 'psm1', 'psd1'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
    },
    {
        id: 'ruby',
        label: 'Ruby',
        extensions: ['rb', 'rake', 'gemspec'],
        filenames: ['gemfile', 'rakefile'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
    },
    {
        id: 'perl',
        label: 'Perl',
        extensions: ['pl', 'pm'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl),
    },
    {
        id: 'lua',
        label: 'Lua',
        extensions: ['lua'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua),
    },
    {
        id: 'r',
        label: 'R',
        extensions: ['r'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/r')).r),
    },
    {
        id: 'swift',
        label: 'Swift',
        extensions: ['swift'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/swift')).swift),
    },
    {
        id: 'csharp',
        label: 'C#',
        extensions: ['cs'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp),
    },
    {
        id: 'kotlin',
        label: 'Kotlin',
        extensions: ['kt', 'kts'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
    },
    {
        id: 'scala',
        label: 'Scala',
        extensions: ['scala', 'sc'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).scala),
    },
    {
        id: 'objectivec',
        label: 'Objective-C',
        extensions: ['m', 'mm'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).objectiveC),
    },
    {
        id: 'dart',
        label: 'Dart',
        extensions: ['dart'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).dart),
    },
    {
        id: 'groovy',
        label: 'Groovy',
        extensions: ['groovy', 'gradle'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/groovy')).groovy),
    },
    {
        id: 'diff',
        label: 'Diff / Patch',
        extensions: ['diff', 'patch'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff),
    },
]

const BY_ID = new Map<LanguageId, LanguageDef>(DEFS.map((d) => [d.id, d]))

const BY_EXTENSION = new Map<string, LanguageId>()
const BY_FILENAME = new Map<string, LanguageId>()
for (const def of DEFS) {
    for (const ext of def.extensions) {
        // El primero gana: si dos lenguajes reclaman la misma extensión, la
        // ambigüedad se resuelve una vez acá y no en cada apertura.
        if (!BY_EXTENSION.has(ext)) BY_EXTENSION.set(ext, def.id)
    }
    for (const name of def.filenames ?? []) {
        if (!BY_FILENAME.has(name)) BY_FILENAME.set(name, def.id)
    }
}

// Opciones para el selector manual de lenguaje de la barra del editor,
// alfabéticas y con "Texto plano" primero por ser el fallback.
export const LANGUAGE_OPTIONS: {id: LanguageId; label: string}[] = [
    {id: 'plaintext', label: 'Texto plano'},
    ...DEFS.filter((d) => d.id !== 'plaintext')
        .map((d) => ({id: d.id, label: d.label}))
        .sort((a, b) => a.label.localeCompare(b.label, 'es')),
]

export function languageLabel(id: LanguageId): string {
    return BY_ID.get(id)?.label ?? 'Texto plano'
}

// languageForPath resuelve el lenguaje de una ruta del repositorio.
//
// Por nombre completo primero y por extensión después: "Dockerfile" y
// ".gitconfig" no tienen extensión, y ".env.production" tiene una que no
// significa nada. Lo que no se reconoce cae en texto plano — abrir el archivo
// igual, sin colores, es siempre mejor que negarse a abrirlo.
export function languageForPath(path: string): LanguageId {
    const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()
    if (!name) return 'plaintext'

    const exact = BY_FILENAME.get(name)
    if (exact) return exact

    // Se prueba de la extensión más larga a la más corta para que
    // "index.d.ts" y "app.blade.php" caigan donde corresponde.
    const parts = name.split('.')
    for (let i = 1; i < parts.length; i++) {
        const candidate = parts.slice(i).join('.')
        const byExt = BY_EXTENSION.get(candidate)
        if (byExt) return byExt
    }

    // Un archivo sin punto puede seguir siendo conocido por su nombre en otra
    // capitalización ("Makefile", "Dockerfile.dev" ya cubierto arriba).
    return BY_EXTENSION.get(name) ?? 'plaintext'
}

// Cache de extensiones ya cargadas y de las que están en vuelo. Sin el segundo
// mapa, abrir cinco archivos .ts de golpe dispararía cinco import() del mismo
// chunk.
const loaded = new Map<LanguageId, Extension>()
const inFlight = new Map<LanguageId, Promise<Extension | null>>()

// loadLanguage devuelve la extensión de CodeMirror del lenguaje, o null si no
// tiene una (texto plano) o si el chunk no se pudo cargar.
//
// Un fallo de carga NO es un error que se propague: el archivo ya está abierto
// y editable, lo único que falta es el resaltado. Se loguea y se sigue.
export async function loadLanguage(id: LanguageId): Promise<Extension | null> {
    const cached = loaded.get(id)
    if (cached) return cached

    const def = BY_ID.get(id)
    if (!def?.load) return null

    const pending = inFlight.get(id)
    if (pending) return pending

    const promise = def
        .load()
        .then((ext) => {
            loaded.set(id, ext)
            return ext
        })
        .catch((e) => {
            console.error(`No se pudo cargar el resaltado de ${def.label}:`, e)
            return null
        })
        .finally(() => {
            inFlight.delete(id)
        })

    inFlight.set(id, promise)
    return promise
}

// languageIfLoaded es la versión síncrona, para el primer render: si el
// lenguaje ya se cargó antes (otra pestaña del mismo tipo), el editor arranca
// con el resaltado puesto en vez de mostrar un parpadeo de texto plano.
export function languageIfLoaded(id: LanguageId): Extension | null {
    return loaded.get(id) ?? null
}
