import {useEffect, useState} from 'react'
import {languageForPath} from '../../codemirror/languageRegistry'
import {highlightLines, parserFor, parserIfLoaded, type Token} from '../../codemirror/highlightStatic'

// Resaltado de sintaxis de un diff, compartido por las tres vistas del módulo
// Git (unificada, lado a lado y el diff desplegado en la lista de cambios).
//
// Un parche no es código: cada línea lleva un prefijo (+, -, espacio) y los
// bloques `@@` cortan el archivo en pedazos. Pasarle el parche entero al parser
// del lenguaje daría basura. Lo que se hace es reconstruir los dos lados —el
// archivo de antes (contexto + borradas) y el de después (contexto +
// agregadas)— con el texto SIN prefijo, resaltar cada lado con el parser del
// lenguaje y devolver los tramos indexados por número de línea del archivo, que
// es lo que las tres vistas ya conocen de cada renglón.
//
// Los bloques se concatenan uno tras otro: entre dos bloques faltan las líneas
// que git no mandó, así que un comentario de bloque o una cadena que empieza en
// un bloque y termina en otro puede colorearse mal. Es el mismo compromiso que
// toman los visores de diff de GitHub o GitLab, y para leer un cambio alcanza.
//
// Lenguaje desconocido = sin resaltado: el diff se ve como texto, como antes.

export interface DiffSyntaxLine {
    kind: 'add' | 'del' | 'ctx'
    oldNo: number | null
    newNo: number | null
    // Texto de la línea SIN el prefijo del parche.
    text: string
}

export interface DiffSyntax {
    old: Map<number, Token[]>
    new: Map<number, Token[]>
}

type Parser = NonNullable<ReturnType<typeof parserIfLoaded>>

function side(lines: {no: number; text: string}[], parser: Parser): Map<number, Token[]> {
    const out = new Map<number, Token[]>()
    if (lines.length === 0) return out
    const hl = highlightLines(lines.map((l) => l.text).join('\n'), parser)
    lines.forEach((l, i) => {
        const tokens = hl[i] ?? []
        // Una línea sin ningún tramo con color no aporta nada: las vistas la
        // dibujan como texto y se ahorra el DOM.
        if (tokens.some((t) => t.cls)) out.set(l.no, tokens)
    })
    return out
}

export function buildDiffSyntax(lines: DiffSyntaxLine[], parser: Parser | null): DiffSyntax | null {
    if (!parser || lines.length === 0) return null
    const oldLines: {no: number; text: string}[] = []
    const newLines: {no: number; text: string}[] = []
    for (const l of lines) {
        if (l.kind !== 'add' && l.oldNo != null) oldLines.push({no: l.oldNo, text: l.text})
        if (l.kind !== 'del' && l.newNo != null) newLines.push({no: l.newNo, text: l.text})
    }
    return {old: side(oldLines, parser), new: side(newLines, parser)}
}

// tokensFor devuelve los tramos de una línea del diff: las borradas se leen del
// archivo de antes, las agregadas y el contexto del de después.
export function tokensFor(syntax: DiffSyntax | null, kind: DiffSyntaxLine['kind'], oldNo: number | null, newNo: number | null): Token[] | null {
    if (!syntax) return null
    if (kind === 'del') return oldNo != null ? (syntax.old.get(oldNo) ?? null) : null
    return newNo != null ? (syntax.new.get(newNo) ?? null) : null
}

// useDiffParser carga el parser del lenguaje de la ruta. Arranca con el que ya
// esté cargado (otro archivo del mismo tipo) para no parpadear sin color, y
// devuelve null para un lenguaje desconocido o un chunk que no cargó.
export function useDiffParser(path: string): Parser | null {
    const lang = languageForPath(path)
    const [state, setState] = useState<{lang: string; parser: Parser | null}>(() => ({lang, parser: parserIfLoaded(lang)}))
    useEffect(() => {
        let cancelled = false
        if (state.lang !== lang) setState({lang, parser: parserIfLoaded(lang)})
        void parserFor(lang).then((p) => {
            if (!cancelled) setState((prev) => (prev.lang === lang && prev.parser === p ? prev : {lang, parser: p}))
        })
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lang])
    return state.lang === lang ? state.parser : parserIfLoaded(lang)
}
