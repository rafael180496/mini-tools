import type {Extension} from '@codemirror/state'
import {StreamLanguage} from '@codemirror/language'
import {t} from '../i18n'

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
    | 'powerbuilder'
    | 'cobol'
    | 'vb'
    | 'vbscript'
    | 'cmake'
    | 'nginx'
    | 'protobuf'
    | 'haskell'
    | 'clojure'
    | 'erlang'
    | 'elm'
    | 'julia'
    | 'fortran'
    | 'pascal'
    | 'tcl'
    | 'verilog'
    | 'vhdl'
    | 'crystal'
    | 'd'
    | 'coffeescript'
    | 'lisp'
    | 'scheme'
    | 'stylus'
    | 'pug'
    | 'jinja2'
    | 'http'
    | 'asm'
    | 'smalltalk'
    | 'latex'
    | 'haxe'
    | 'ocaml'
    | 'fsharp'
    | 'nsis'
    | 'rpmspec'
    | 'xquery'
    | 'gherkin'
    | 'cypher'
    | 'sparql'
    | 'turtle'
    | 'octave'
    | 'ignore'

interface LanguageDef {
    id: LanguageId
    // Nombre del lenguaje: es una marca, se escribe igual en todos los idiomas.
    // La excepción es 'plaintext', que se rotula desde el diccionario.
    name: string
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
    {id: 'plaintext', name: '', extensions: ['txt', 'log', 'text']},

    {
        id: 'javascript',
        name: 'JavaScript',
        extensions: ['js', 'mjs', 'cjs'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript(),
    },
    {
        id: 'jsx',
        name: 'JavaScript (JSX)',
        extensions: ['jsx'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({jsx: true}),
    },
    {
        id: 'typescript',
        name: 'TypeScript',
        extensions: ['ts', 'mts', 'cts', 'prisma', 'graphql', 'gql'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({typescript: true}),
    },
    {
        id: 'tsx',
        name: 'TypeScript (TSX)',
        extensions: ['tsx'],
        load: async () => (await import('@codemirror/lang-javascript')).javascript({typescript: true, jsx: true}),
    },
    {
        id: 'json',
        name: 'JSON',
        extensions: ['json', 'jsonc', 'json5', 'webmanifest'],
        filenames: [
            '.eslintrc',
            '.babelrc',
            '.prettierrc',
            '.all-contributorsrc',
            '.swcrc',
            '.stylelintrc',
            '.commitlintrc',
            '.lintstagedrc',
            '.hintrc',
        ],
        load: async () => (await import('@codemirror/lang-json')).json(),
    },
    {
        id: 'python',
        name: 'Python',
        extensions: ['py', 'pyi', 'pyw'],
        load: async () => (await import('@codemirror/lang-python')).python(),
    },
    {
        id: 'go',
        name: 'Go',
        extensions: ['go'],
        filenames: ['go.mod', 'go.work'],
        load: async () => (await import('@codemirror/lang-go')).go(),
    },
    {
        id: 'rust',
        name: 'Rust',
        extensions: ['rs', 'zig'],
        load: async () => (await import('@codemirror/lang-rust')).rust(),
    },
    {
        id: 'java',
        name: 'Java',
        extensions: ['java'],
        load: async () => (await import('@codemirror/lang-java')).java(),
    },
    {
        id: 'cpp',
        name: 'C / C++',
        // .pc es Pro*C: C con SQL embebido.
        extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'pc', 'cu', 'cuh'],
        load: async () => (await import('@codemirror/lang-cpp')).cpp(),
    },
    {
        id: 'php',
        name: 'PHP',
        extensions: ['php', 'phtml'],
        load: async () => (await import('@codemirror/lang-php')).php(),
    },
    {
        id: 'html',
        name: 'HTML',
        extensions: ['html', 'htm', 'xhtml', 'erb', 'html.erb', 'svelte', 'astro', 'ejs', 'hbs', 'handlebars', 'twig', 'liquid', 'njk'],
        load: async () => (await import('@codemirror/lang-html')).html(),
    },
    {
        id: 'vue',
        name: 'Vue',
        extensions: ['vue'],
        load: async () => (await import('@codemirror/lang-vue')).vue(),
    },
    {
        id: 'css',
        name: 'CSS',
        // scss/less/sass entran por acá a propósito: son supersets de CSS y el
        // parser de CSS los resalta de forma razonable. Un modo dedicado por
        // cada preprocesador sería más peso del que justifica la diferencia.
        extensions: ['css', 'scss', 'less', 'sass', 'pcss', 'postcss'],
        load: async () => (await import('@codemirror/lang-css')).css(),
    },
    {
        id: 'xml',
        name: 'XML',
        extensions: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'plist', 'csproj', 'pom'],
        load: async () => (await import('@codemirror/lang-xml')).xml(),
    },
    {
        id: 'markdown',
        name: 'Markdown',
        extensions: ['md', 'markdown', 'mdx', 'mdown'],
        load: async () => (await import('@codemirror/lang-markdown')).markdown(),
    },
    {
        id: 'yaml',
        name: 'YAML',
        extensions: ['yaml', 'yml'],
        load: async () => (await import('@codemirror/lang-yaml')).yaml(),
    },
    {
        id: 'sql',
        name: 'SQL',
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
        name: 'Shell',
        // Makefile no tiene modo propio en CodeMirror: comparte con shell los
        // comentarios '#', las variables $(…) y las recetas, que son comandos.
        // .unx son los scripts de los batches del SGC.
        extensions: ['sh', 'bash', 'zsh', 'ksh', 'fish', 'bashrc', 'zshrc', 'mk', 'make', 'unx', 'command'],
        filenames: ['.bashrc', '.zshrc', '.bash_profile', '.profile', '.zprofile', 'makefile', 'gnumakefile', 'bsdmakefile', '.envrc'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell),
    },
    {
        id: 'dockerfile',
        name: 'Dockerfile',
        extensions: ['dockerfile'],
        filenames: ['dockerfile', 'containerfile'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
    },
    {
        id: 'toml',
        name: 'TOML',
        extensions: ['toml'],
        filenames: ['cargo.lock'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml),
    },
    {
        id: 'ini',
        name: 'INI / Properties',
        extensions: ['ini', 'cfg', 'conf', 'properties', 'editorconfig', 'env'],
        filenames: ['.editorconfig', '.env', '.gitconfig', '.npmrc'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties),
    },
    {
        id: 'powershell',
        name: 'PowerShell',
        extensions: ['ps1', 'psm1', 'psd1'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
    },
    {
        id: 'ruby',
        name: 'Ruby',
        extensions: ['rb', 'rake', 'gemspec', 'ru', 'jb', 'jbuilder', 'rbi', 'thor', 'podspec'],
        filenames: ['gemfile', 'rakefile', 'brewfile', 'podfile', 'vagrantfile', 'fastfile', 'appfile', 'guardfile', 'capfile', 'dangerfile'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby),
    },
    {
        id: 'perl',
        name: 'Perl',
        extensions: ['pl', 'pm'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl),
    },
    {
        id: 'lua',
        name: 'Lua',
        extensions: ['lua'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua),
    },
    {
        id: 'r',
        name: 'R',
        extensions: ['r'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/r')).r),
    },
    {
        id: 'swift',
        name: 'Swift',
        extensions: ['swift'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/swift')).swift),
    },
    {
        id: 'csharp',
        name: 'C#',
        extensions: ['cs'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).csharp),
    },
    {
        id: 'kotlin',
        name: 'Kotlin',
        extensions: ['kt', 'kts'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).kotlin),
    },
    {
        id: 'scala',
        name: 'Scala',
        extensions: ['scala', 'sc'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).scala),
    },
    {
        id: 'objectivec',
        name: 'Objective-C',
        extensions: ['m', 'mm'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).objectiveC),
    },
    {
        id: 'dart',
        name: 'Dart',
        extensions: ['dart'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clike')).dart),
    },
    {
        id: 'groovy',
        name: 'Groovy',
        extensions: ['groovy', 'gradle'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/groovy')).groovy),
    },
    // Fuentes exportados de PowerBuilder: modo propio (./powerscript.ts),
    // porque el de Visual Basic toma el apóstrofo de una cadena como comentario.
    {
        id: 'powerbuilder',
        name: 'PowerBuilder (PowerScript)',
        extensions: ['srw', 'srd', 'sru', 'srf', 'srs', 'srm', 'srj', 'srq', 'srp', 'srx', 'srt', 'sra', 'pbg', 'pbt'],
        load: async () => StreamLanguage.define((await import('./powerscript')).powerScript),
    },
    // .pco es Pro*COBOL: COBOL con SQL embebido.
    {
        id: 'cobol',
        name: 'COBOL',
        extensions: ['cbl', 'cob', 'cpy', 'cobol', 'pco'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/cobol')).cobol),
    },
    {
        id: 'vb',
        name: 'Visual Basic',
        extensions: ['vb', 'bas', 'frm', 'cls'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/vb')).vb),
    },
    {
        id: 'vbscript',
        name: 'VBScript',
        extensions: ['vbs'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/vbscript')).vbScript),
    },
    {
        id: 'cmake',
        name: 'CMake',
        extensions: ['cmake'],
        filenames: ['cmakelists.txt'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/cmake')).cmake),
    },
    {
        id: 'nginx',
        name: 'Nginx',
        extensions: ['nginx'],
        filenames: ['nginx.conf'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/nginx')).nginx),
    },
    {
        id: 'protobuf',
        name: 'Protocol Buffers',
        extensions: ['proto'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
    },
    {
        id: 'haskell',
        name: 'Haskell',
        extensions: ['hs', 'lhs'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/haskell')).haskell),
    },
    {
        id: 'clojure',
        name: 'Clojure',
        extensions: ['clj', 'cljs', 'cljc', 'edn'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/clojure')).clojure),
    },
    {
        id: 'erlang',
        name: 'Erlang',
        extensions: ['erl', 'hrl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/erlang')).erlang),
    },
    {
        id: 'elm',
        name: 'Elm',
        extensions: ['elm'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/elm')).elm),
    },
    {
        id: 'julia',
        name: 'Julia',
        extensions: ['jl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/julia')).julia),
    },
    {
        id: 'fortran',
        name: 'Fortran',
        extensions: ['f', 'for', 'f77', 'f90', 'f95', 'f03'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/fortran')).fortran),
    },
    {
        id: 'pascal',
        name: 'Pascal / Delphi',
        extensions: ['pas', 'dpr', 'lpr'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/pascal')).pascal),
    },
    {
        id: 'tcl',
        name: 'Tcl',
        extensions: ['tcl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/tcl')).tcl),
    },
    {
        id: 'verilog',
        name: 'Verilog / SystemVerilog',
        extensions: ['v', 'sv', 'svh', 'vh'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/verilog')).verilog),
    },
    {
        id: 'vhdl',
        name: 'VHDL',
        extensions: ['vhd', 'vhdl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/vhdl')).vhdl),
    },
    {
        id: 'crystal',
        name: 'Crystal',
        extensions: ['cr'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/crystal')).crystal),
    },
    {
        id: 'd',
        name: 'D',
        extensions: ['d', 'di'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/d')).d),
    },
    {
        id: 'coffeescript',
        name: 'CoffeeScript',
        extensions: ['coffee'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/coffeescript')).coffeeScript),
    },
    {
        id: 'lisp',
        name: 'Common Lisp / Emacs Lisp',
        extensions: ['lisp', 'lsp', 'el', 'cl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/commonlisp')).commonLisp),
    },
    {
        id: 'scheme',
        name: 'Scheme / Racket',
        extensions: ['scm', 'ss', 'rkt'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/scheme')).scheme),
    },
    {
        id: 'stylus',
        name: 'Stylus',
        extensions: ['styl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/stylus')).stylus),
    },
    {
        id: 'pug',
        name: 'Pug',
        extensions: ['pug', 'jade'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/pug')).pug),
    },
    {
        id: 'jinja2',
        name: 'Jinja / Twig',
        extensions: ['j2', 'jinja', 'jinja2', 'twig', 'njk'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/jinja2')).jinja2),
    },
    {
        id: 'http',
        name: 'HTTP',
        extensions: ['http', 'rest'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/http')).http),
    },
    {
        id: 'asm',
        name: 'Assembler (GAS)',
        extensions: ['s', 'asm'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/gas')).gas),
    },
    {
        id: 'smalltalk',
        name: 'Smalltalk',
        extensions: ['st'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/smalltalk')).smalltalk),
    },
    {
        id: 'latex',
        name: 'LaTeX',
        extensions: ['tex', 'sty', 'ltx', 'bib'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/stex')).stex),
    },
    {
        id: 'haxe',
        name: 'Haxe',
        extensions: ['hx'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/haxe')).haxe),
    },
    {
        id: 'ocaml',
        name: 'OCaml',
        extensions: ['ml', 'mli'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/mllike')).oCaml),
    },
    {
        id: 'fsharp',
        name: 'F#',
        extensions: ['fs', 'fsi', 'fsx'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/mllike')).fSharp),
    },
    {
        id: 'nsis',
        name: 'NSIS',
        extensions: ['nsi', 'nsh'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/nsis')).nsis),
    },
    {
        id: 'rpmspec',
        name: 'RPM spec',
        extensions: ['spec'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/rpm')).rpmSpec),
    },
    {
        id: 'xquery',
        name: 'XQuery',
        extensions: ['xq', 'xquery', 'xqy'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/xquery')).xQuery),
    },
    {
        id: 'gherkin',
        name: 'Gherkin',
        extensions: ['feature'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/gherkin')).gherkin),
    },
    {
        id: 'cypher',
        name: 'Cypher',
        extensions: ['cypher', 'cql'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/cypher')).cypher),
    },
    {
        id: 'sparql',
        name: 'SPARQL',
        extensions: ['rq', 'sparql'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/sparql')).sparql),
    },
    {
        id: 'turtle',
        name: 'Turtle (RDF)',
        extensions: ['ttl'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/turtle')).turtle),
    },
    // Sin extensión: .m ya es Objective-C. Se elige a mano o por bloque ```matlab.
    {
        id: 'octave',
        name: 'Octave / MATLAB',
        extensions: [],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/octave')).octave),
    },
    // Listas de patrones con comentarios '#': el modo de properties colorea
    // los comentarios y deja el resto como texto, que es lo que hace falta.
    {
        id: 'ignore',
        name: 'Ignore / atributos',
        extensions: ['gitignore', 'dockerignore', 'npmignore', 'eslintignore', 'prettierignore', 'gitattributes', 'hgignore'],
        filenames: ['.gitignore', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore', '.gitattributes', '.gitmodules', '.helmignore', '.vscodeignore', 'codeowners'],
        load: async () => StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties),
    },
    {
        id: 'diff',
        name: 'Diff / Patch',
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
export const LANGUAGE_OPTIONS: {id: LanguageId; readonly label: string}[] = [
    {
        id: 'plaintext',
        get label() {
            return t().editor.languages.plainText
        },
    },
    ...DEFS.filter((d) => d.id !== 'plaintext')
        .map((d) => ({id: d.id, label: d.name}))
        .sort((a, b) => a.label.localeCompare(b.label, 'es')),
]

export function languageLabel(id: LanguageId): string {
    const def = BY_ID.get(id)
    return def && def.id !== 'plaintext' ? def.name : t().editor.languages.plainText
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

    // .env.local, .env.production, .env.example…: la parte después de .env
    // es el entorno, no una extensión.
    if (name === '.env' || name.startsWith('.env.')) return 'ini'

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
            console.error(`No se pudo cargar el resaltado de ${def.name}:`, e)
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

// Nombres con los que los modelos etiquetan un bloque de código (```js) que no
// son ni el id del registro ni una extensión de archivo.
const FENCE_ALIASES: Record<string, LanguageId> = {
    js: 'javascript',
    node: 'javascript',
    ts: 'typescript',
    py: 'python',
    python3: 'python',
    golang: 'go',
    rs: 'rust',
    kt: 'kotlin',
    cs: 'csharp',
    'c#': 'csharp',
    'c++': 'cpp',
    c: 'cpp',
    rb: 'ruby',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    console: 'shell',
    terminal: 'shell',
    ps: 'powershell',
    ps1: 'powershell',
    pwsh: 'powershell',
    yml: 'yaml',
    md: 'markdown',
    docker: 'dockerfile',
    patch: 'diff',
    // Los dialectos SQL comparten el parser genérico: alcanza para colorear.
    plsql: 'sql',
    psql: 'sql',
    pgsql: 'sql',
    postgres: 'sql',
    postgresql: 'sql',
    mysql: 'sql',
    sqlite: 'sql',
    oracle: 'sql',
    tsql: 'sql',
    make: 'shell',
    makefile: 'shell',
    matlab: 'octave',
    cobol: 'cobol',
    powerscript: 'powerbuilder',
    vba: 'vb',
    proto: 'protobuf',
    tex: 'latex',
    gitignore: 'ignore',
}

// languageForFence resuelve la etiqueta de un bloque de código de markdown
// (```ts, ```bash, ```plsql). Lo que no se reconoce es texto plano.
export function languageForFence(tag: string): LanguageId {
    const name = tag.trim().toLowerCase()
    if (!name) return 'plaintext'
    const alias = FENCE_ALIASES[name]
    if (alias) return alias
    if (BY_ID.has(name as LanguageId)) return name as LanguageId
    return BY_EXTENSION.get(name) ?? 'plaintext'
}
