import {HighlightStyle, syntaxHighlighting} from '@codemirror/language'
import {EditorView} from '@codemirror/view'
import {tags as t} from '@lezer/highlight'
import type {Extension} from '@codemirror/state'

// Tipografía del editor de notas.
//
// **El problema que resuelve.** Un editor de notas montado con el `basicSetup`
// de CodeMirror se ve como lo que es: un editor de código. Números de línea al
// costado, todo en monoespaciada del mismo cuerpo, un `# Título` que pesa
// igual que un párrafo. Escribir documentación ahí se siente mal y no es un
// capricho estético — cuando todo tiene el mismo peso visual, la estructura del
// documento (que es lo que uno está armando) no se ve.
//
// Acá el Markdown se **muestra con su jerarquía mientras se escribe**: los
// encabezados grandes y en negrita, la negrita en negrita, el código en
// monoespaciada con fondo, las citas en itálica apagada. La sintaxis sigue a la
// vista —esto es un editor de Markdown, no un procesador de texto— pero deja de
// competir con el contenido.
//
// Los colores salen de los tokens del tema (`--color-*`), así que sigue al
// modo claro/oscuro de la app sin una segunda paleta que mantener.

// notesHighlight le da peso tipográfico a cada elemento del Markdown.
//
// Los tamaños son relativos (`em`) a propósito: el cuerpo base del editor se
// define abajo una sola vez, y cambiarlo mueve toda la escala junta.
const notesHighlight = HighlightStyle.define([
    {tag: t.heading1, fontSize: '1.6em', fontWeight: '700', lineHeight: '1.3'},
    {tag: t.heading2, fontSize: '1.35em', fontWeight: '700', lineHeight: '1.3'},
    {tag: t.heading3, fontSize: '1.15em', fontWeight: '600'},
    {tag: [t.heading4, t.heading5, t.heading6], fontWeight: '600'},
    {tag: t.strong, fontWeight: '700', color: 'var(--color-on-surface)'},
    {tag: t.emphasis, fontStyle: 'italic'},
    {tag: t.strikethrough, textDecoration: 'line-through', opacity: '0.6'},
    // El código en línea y los bloques: monoespaciada de verdad, que es el
    // único lugar de una nota donde la monoespaciada aporta.
    {tag: t.monospace, fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: '0.92em'},
    {tag: t.link, color: 'var(--color-primary)', textDecoration: 'underline', textUnderlineOffset: '2px'},
    {tag: t.url, color: 'var(--color-primary)', opacity: '0.75'},
    {tag: t.quote, fontStyle: 'italic', color: 'var(--color-on-surface-variant)'},
    // Los marcadores (`#`, `-`, `>`, los asteriscos de la negrita) se apagan:
    // siguen visibles —hace falta para editarlos— pero dejan de pelear con el
    // texto que marcan.
    {tag: t.processingInstruction, color: 'var(--color-on-surface-variant)', opacity: '0.5'},
    {tag: t.list, color: 'var(--color-on-surface)'},
    {tag: t.meta, color: 'var(--color-on-surface-variant)', opacity: '0.7'},
])

// notesEditorTheme es la disposición: ancho de lectura, aire y sin gutter.
//
// **Sin números de línea ni gutter de plegado.** Una nota no tiene líneas que
// referenciar; el gutter solo roba ancho y le da a un documento el aspecto de
// un archivo de código.
//
// **Ancho de lectura acotado.** Una línea de texto que cruza un monitor de 27"
// no se lee: el ojo pierde el renglón al volver. 68 caracteres es el ancho
// clásico de tipografía, y es el mismo criterio que usan Obsidian y cualquier
// editor de documentos.
const notesEditorTheme = EditorView.theme({
    '&': {
        fontSize: '15px',
        backgroundColor: 'transparent',
        color: 'var(--color-on-surface)',
        height: '100%',
    },
    '.cm-scroller': {
        fontFamily: 'var(--font-sans, ui-sans-serif, system-ui)',
        lineHeight: '1.7',
        padding: '1.5rem 0 6rem',
    },
    // El contenido centrado con ancho máximo, no pegado al borde izquierdo.
    '.cm-content': {
        maxWidth: '46rem',
        margin: '0 auto',
        padding: '0 1.5rem',
        caretColor: 'var(--color-primary)',
    },
    '.cm-line': {padding: '0'},
    '&.cm-focused': {outline: 'none'},
    '.cm-cursor, .cm-dropCursor': {borderLeftWidth: '2px', borderLeftColor: 'var(--color-primary)'},
    // El párrafo respira: sin esto los renglones quedan pegados y un documento
    // largo se lee como un bloque compacto.
    '.cm-activeLine': {backgroundColor: 'transparent'},
    '.cm-selectionBackground, ::selection': {backgroundColor: 'var(--color-primary) !important', opacity: '0.25'},
    '&.cm-focused .cm-selectionBackground': {backgroundColor: 'var(--color-primary) !important', opacity: '0.25'},
    // El desplegable de `[[` y de `/`: la lista de sugerencias tiene que
    // parecerse al resto de la app, no al desplegable por defecto de la
    // librería.
    '.cm-tooltip': {
        border: '1px solid var(--color-outline-variant)',
        backgroundColor: 'var(--color-surface-container-high)',
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        overflow: 'hidden',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--font-sans, ui-sans-serif, system-ui)',
        fontSize: '13px',
        maxHeight: '18rem',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {padding: '4px 10px'},
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--color-primary)',
        color: 'var(--color-on-primary)',
    },
    '.cm-completionDetail': {
        fontStyle: 'normal',
        opacity: '0.6',
        marginLeft: '0.75rem',
        fontSize: '11px',
    },
    '.cm-placeholder': {color: 'var(--color-on-surface-variant)', opacity: '0.5'},
})

// notesEditorExtensions es todo lo tipográfico junto.
export function notesEditorExtensions(): Extension[] {
    return [notesEditorTheme, syntaxHighlighting(notesHighlight)]
}
