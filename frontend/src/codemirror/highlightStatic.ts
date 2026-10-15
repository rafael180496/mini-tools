import {Language, LanguageSupport} from '@codemirror/language'
import type {Extension} from '@codemirror/state'
import {highlightCode, tagHighlighter, tags} from '@lezer/highlight'
import {loadLanguage, type LanguageId} from './languageRegistry'

// El tipo del parser sale de Language: @lezer/common no es dependencia directa.
type Parser = Language['parser']

// Resaltado de código de SOLO LECTURA, sin montar un editor: los bloques de
// código de las respuestas de la IA.
//
// Un EditorView por bloque sería un editor entero (estado, extensiones, DOM
// propio) para mostrar texto que nadie va a editar, multiplicado por cada bloque
// de cada respuesta. Acá se usa solo el parser del mismo registro de lenguajes
// del editor —el chunk se carga una vez y lo comparten los dos— y Lezer devuelve
// los tramos con su clase; el color lo pone la hoja de estilos (`.syn-*` en
// globals.css), así que sigue al tema claro u oscuro sin volver a pintar.

export interface Token {
    text: string
    // Clases `syn-*` del tramo; vacío = texto sin estilo.
    cls: string
}

// Tokens agrupados en líneas, para poder numerarlas.
export type HighlightedLines = Token[][]

// Las etiquetas de Lezer se reducen a pocas familias: más colores que estos
// no se distinguen a simple vista en un bloque de diez líneas.
const highlighter = tagHighlighter([
    {tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], class: 'syn-keyword'},
    {tag: [tags.string, tags.special(tags.string), tags.character, tags.docString], class: 'syn-string'},
    {tag: [tags.regexp, tags.escape, tags.url], class: 'syn-regexp'},
    {tag: [tags.number, tags.integer, tags.float], class: 'syn-number'},
    {tag: [tags.bool, tags.null, tags.atom, tags.self, tags.constant(tags.variableName)], class: 'syn-atom'},
    {tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'syn-comment'},
    {tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName)), tags.macroName], class: 'syn-function'},
    {tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], class: 'syn-definition'},
    {tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], class: 'syn-type'},
    {tag: [tags.propertyName, tags.attributeName, tags.labelName], class: 'syn-property'},
    {tag: [tags.tagName, tags.heading], class: 'syn-tag'},
    {tag: [tags.meta, tags.processingInstruction, tags.annotation], class: 'syn-meta'},
    {tag: tags.inserted, class: 'syn-inserted'},
    {tag: tags.deleted, class: 'syn-deleted'},
    {tag: tags.invalid, class: 'syn-invalid'},
])

// Un bloque gigante (un volcado de log que el modelo puso entre ```) se muestra
// sin colores: parsearlo bloquearía el hilo de la interfaz por algo que se lee
// de corrido igual.
const MAX_HIGHLIGHT_CHARS = 200_000

function parserOf(ext: Extension | null): Parser | null {
    if (ext instanceof LanguageSupport) return ext.language.parser
    if (ext instanceof Language) return ext.parser
    if (Array.isArray(ext)) {
        for (const e of ext) {
            const p = parserOf(e)
            if (p) return p
        }
    }
    return null
}

const parsers = new Map<LanguageId, Parser | null>()

// parserFor carga (una vez) el parser de un lenguaje. null = sin resaltado,
// sea texto plano o un chunk que no cargó.
export async function parserFor(id: LanguageId): Promise<Parser | null> {
    if (parsers.has(id)) return parsers.get(id) ?? null
    const p = id === 'plaintext' ? null : parserOf(await loadLanguage(id))
    parsers.set(id, p)
    return p
}

// parserIfLoaded es la versión síncrona, para el primer render: un bloque del
// mismo lenguaje que otro ya pintado sale con color sin parpadear.
export function parserIfLoaded(id: LanguageId): Parser | null {
    return parsers.get(id) ?? null
}

// plainLines parte el código en líneas sin estilo.
export function plainLines(code: string): HighlightedLines {
    return code.split('\n').map((l) => (l ? [{text: l, cls: ''}] : []))
}

export function highlightLines(code: string, parser: Parser | null): HighlightedLines {
    if (!parser || code.length > MAX_HIGHLIGHT_CHARS) return plainLines(code)
    const lines: HighlightedLines = [[]]
    try {
        highlightCode(
            code,
            parser.parse(code),
            highlighter,
            (text, cls) => lines[lines.length - 1].push({text, cls}),
            () => lines.push([]),
        )
    } catch {
        // Un parser que se rompe con una entrada rara no puede dejar el bloque
        // vacío: se muestra sin colores.
        return plainLines(code)
    }
    return lines
}
