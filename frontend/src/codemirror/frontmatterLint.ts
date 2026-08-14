import {linter, type Diagnostic} from '@codemirror/lint'
import type {EditorState, Extension} from '@codemirror/state'

// Lint del frontmatter de los archivos agénticos (SKILL.md, subagentes,
// comandos slash).
//
// Por qué existe: estos archivos fallan EN SILENCIO. Un `SKILL.md` sin
// frontmatter, o sin `name`, o sin `description`, el CLI simplemente no lo
// carga — no hay error, no hay aviso, el skill sencillamente no está cuando lo
// necesitás, y averiguar por qué lleva un rato largo. Es exactamente el tipo
// de fallo que un linter tiene que atajar en el momento de escribirlo.
//
// El alcance es deliberadamente chico: se comprueba que el bloque exista, que
// esté cerrado, y que estén las dos claves que deciden si el archivo se carga.
// NO se valida YAML en general — para eso haría falta un parser, y un linter
// que se equivoca marcando en rojo algo correcto es peor que no tenerlo.

// FRONTMATTER_FILES son los nombres cuyo frontmatter importa. Se comprueba por
// nombre y no por extensión porque un `.md` cualquiera del repositorio no
// necesita frontmatter y marcarlo sería ruido en cada README.
export function needsFrontmatter(path: string): boolean {
    const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()
    if (name === 'skill.md') return true
    // Subagentes y comandos slash viven en directorios propios; cualquier .md
    // de ahí adentro lleva frontmatter.
    const dir = path.toLowerCase().replace(/\\/g, '/')
    return /\.claude\/(agents|commands)\//.test(dir) && name.endsWith('.md')
}

function diagnostics(state: EditorState): Diagnostic[] {
    const doc = state.doc
    const firstLine = doc.line(1)

    if (firstLine.text.trim() !== '---') {
        return [
            {
                from: firstLine.from,
                to: firstLine.to,
                severity: 'warning',
                message:
                    'Falta el bloque de frontmatter. Sin él, el CLI no carga este archivo — y no avisa: simplemente no aparece. Tiene que empezar con una línea "---".',
            },
        ]
    }

    // Buscar el cierre y juntar las claves de primer nivel.
    let closeLine = 0
    const keys = new Map<string, number>()
    for (let n = 2; n <= doc.lines; n++) {
        const line = doc.line(n)
        const text = line.text
        if (text.trim() === '---') {
            closeLine = n
            break
        }
        if (text === '' || text.startsWith(' ') || text.startsWith('\t')) continue
        const idx = text.indexOf(':')
        if (idx > 0) keys.set(text.slice(0, idx).trim().toLowerCase(), n)
    }

    if (closeLine === 0) {
        return [
            {
                from: firstLine.from,
                to: firstLine.to,
                severity: 'warning',
                message: 'El bloque de frontmatter nunca se cierra: falta la línea "---" del final.',
            },
        ]
    }

    const out: Diagnostic[] = []
    const close = doc.line(closeLine)

    for (const [key, why] of [
        ['name', 'Sin `name`, el CLI no tiene con qué referirse a esto y lo ignora.'],
        [
            'description',
            'Sin `description`, el agente no tiene con qué decidir si esto es relevante para lo que le pediste, así que en la práctica nunca lo usa.',
        ],
    ] as const) {
        const at = keys.get(key)
        if (at === undefined) {
            out.push({from: close.from, to: close.to, severity: 'warning', message: `Falta \`${key}\` en el frontmatter. ${why}`})
            continue
        }
        const line = doc.line(at)
        const value = line.text.slice(line.text.indexOf(':') + 1).trim()
        if (value === '') {
            out.push({from: line.from, to: line.to, severity: 'warning', message: `\`${key}\` está vacío. ${why}`})
        }
    }
    return out
}

// frontmatterLint es la extensión para un archivo que lleva frontmatter.
export function frontmatterLint(): Extension {
    return linter((view) => diagnostics(view.state))
}
