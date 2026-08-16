import {linter, type Diagnostic} from '@codemirror/lint'
import type {Extension} from '@codemirror/state'
import {NoteTitles} from '../../wailsjs/go/main/App'

// Revisión del texto de una nota.
//
// **Lo que NO es: un corrector ortográfico.** Un diccionario del castellano son
// varios megabytes y esta app pesa 50 — sumarlo por una función que el sistema
// operativo ya ofrece en cualquier campo de texto sería el peor intercambio del
// proyecto. Lo que sí revisa son los errores propios de una base de
// conocimiento, los que ninguna otra herramienta va a marcar:
//
//   - Un `[[enlace]]` a una nota que no existe. No es un error —así se crean
//     las notas en un grafo— pero conviene verlo, y desde acá se puede crear.
//   - `#Titulo` sin espacio cuando era un encabezado. Es la confusión más
//     común de Markdown: con espacio es un título, sin espacio es una
//     etiqueta, y la diferencia de un carácter no se ve.
//   - Un bloque de código sin cerrar, que se come el resto del documento.
//   - Un enlace con el `(url)` de plantilla todavía sin reemplazar.
//
// Cada aviso trae su corrección aplicable: marcar un problema sin ofrecer el
// arreglo obliga a resolverlo a mano justo cuando uno está escribiendo otra
// cosa.

// Títulos existentes, para resolver los enlaces. Se cachean por unos segundos:
// el linter corre con cada pausa de tecleo y pedir la lista en cada una sería
// descifrar todos los títulos por pausa.
let titleCache: {at: number; titles: Set<string>} | null = null
const CACHE_MS = 5000

async function knownTitles(): Promise<Set<string>> {
    if (titleCache && Date.now() - titleCache.at < CACHE_MS) return titleCache.titles
    try {
        const list = await NoteTitles()
        const set = new Set((list ?? []).map((t) => normalize(t.title)))
        titleCache = {at: Date.now(), titles: set}
        return set
    } catch {
        // Sin la lista no se puede saber si un enlace está roto: se devuelve
        // vacío y NO se marca nada, en vez de marcar todos como rotos.
        return new Set()
    }
}

// normalize replica NormalizeTitle del backend (minúsculas, espacios
// colapsados). Tiene que dar el mismo resultado, o el linter marcaría como
// roto un enlace que el backend sí resuelve.
function normalize(t: string): string {
    return t.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function notesLint(onCreateNote: (title: string) => void): Extension {
    return linter(async (view): Promise<Diagnostic[]> => {
        const doc = view.state.doc.toString()
        const out: Diagnostic[] = []
        const titles = await knownTitles()

        // --- enlaces a notas que no existen ---
        const linkRe = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g
        let m: RegExpExecArray | null
        while ((m = linkRe.exec(doc)) !== null) {
            const target = m[1].trim()
            if (!target || titles.has(normalize(target))) continue
            out.push({
                from: m.index,
                to: m.index + m[0].length,
                severity: 'info',
                message: `La nota «${target}» todavía no existe. En un grafo de conocimiento eso es normal: el enlace queda pendiente hasta que la escribas.`,
                actions: [{name: 'Crear la nota', apply: () => onCreateNote(target)}],
            })
        }

        // --- `#Titulo` sin espacio ---
        let pos = 0
        let inFence = false
        for (const line of doc.split('\n')) {
            const trimmed = line.trimStart()
            if (trimmed.startsWith('```')) inFence = !inFence

            if (!inFence) {
                // Solo al principio de la línea y con MAYÚSCULA inicial o
                // varias almohadillas: `#produccion` en minúscula es una
                // etiqueta perfectamente válida y marcarla sería ruido.
                const h = /^(\s*)(#{1,6})([A-ZÁÉÍÓÚÑ][^\s#]*)/.exec(line)
                if (h) {
                    const from = pos + h[1].length
                    out.push({
                        from,
                        to: from + h[2].length + h[3].length,
                        severity: 'warning',
                        message:
                            'Un encabezado necesita un espacio después de las almohadillas. Sin el espacio esto es una ETIQUETA, no un título — es la confusión más común de Markdown.',
                        actions: [
                            {
                                name: 'Convertir en título',
                                apply: (v, a) => {
                                    v.dispatch({changes: {from: a + h[2].length, insert: ' '}})
                                },
                            },
                        ],
                    })
                }

                // --- enlace con la url de plantilla sin reemplazar ---
                const url = line.indexOf('](url)')
                if (url >= 0) {
                    out.push({
                        from: pos + url,
                        to: pos + url + 6,
                        severity: 'warning',
                        message: 'Este enlace todavía tiene la dirección de ejemplo: reemplazá `url` por la real.',
                    })
                }
            }
            pos += line.length + 1
        }

        // --- bloque de código sin cerrar ---
        if (inFence) {
            const last = doc.lastIndexOf('```')
            out.push({
                from: last,
                to: Math.min(last + 3, doc.length),
                severity: 'error',
                message:
                    'Este bloque de código no se cierra, así que todo lo que sigue se muestra como código. Agregá ``` al final.',
                actions: [
                    {
                        name: 'Cerrarlo al final',
                        apply: (v) => {
                            v.dispatch({changes: {from: v.state.doc.length, insert: '\n```\n'}})
                        },
                    },
                ],
            })
        }

        return out
    })
}
