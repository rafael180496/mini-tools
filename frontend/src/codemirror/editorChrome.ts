import {EditorState} from '@codemirror/state'
import type {Extension} from '@codemirror/state'
import {EditorView, ViewPlugin} from '@codemirror/view'
import {t} from '../i18n'

// El "cromo" de CodeMirror: lo que el editor dibuja alrededor del texto —
// el panel de buscar/reemplazar, el diálogo de ir a línea, el panel de
// diagnósticos y los tooltips—.
//
// **Por qué existe.** CodeMirror trae esas piezas con su propio estilo base:
// botones con degradé gris, casillas nativas, texto al 70 % y un fondo
// #f5f5f5 / #333338 que no es ningún color de la app. Ningún tema de
// `@uiw/codemirror-theme-*` las toca —solo pintan el texto—, así que en
// cualquier tema se veían como un formulario de 2005 pegado encima del
// editor. Acá se pintan con los tokens del sistema de diseño
// (.claude/specs/design-system.md), igual que el popup de sugerencias
// (sqlIntel.ts), y por eso siguen el claro/oscuro de la app sin una segunda
// definición.
//
// **Especificidad.** El tema base de CodeMirror escribe estas reglas como
// `&light .cm-button`, que compila a TRES clases. Una regla de
// `EditorView.theme` sobre `.cm-button` tiene dos y pierde siempre, sin
// importar el orden. Por eso cada selector de acá cuelga de `&.cm-editor`
// o encadena la clase del panel: no es redundancia, es lo que hace que gane.

const ICON_FONT = "'Material Symbols Outlined'"

// Un botón de solo ícono: el texto queda en el DOM (es el nombre accesible y
// lo que lee un lector de pantalla) pero no ocupa lugar; el glifo sale de la
// ligadura de Material Symbols, igual que <Icon name="…" />. Cada nombre
// está verificado contra la fuente empaquetada: uno inexistente se dibuja
// como la palabra literal, sin ningún error.
function iconOnly(ligature: string) {
    return {
        fontSize: '0',
        width: '26px',
        height: '26px',
        padding: '0',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        '&::before': {
            content: `'${ligature}'`,
            fontFamily: ICON_FONT,
            fontSize: '17px',
            lineHeight: '1',
            fontFeatureSettings: "'liga'",
            fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20",
        },
    }
}

const chromeTheme = EditorView.theme({
    // --- Paneles (contenedor de búsqueda, diagnósticos) ---
    '&.cm-editor .cm-panels': {
        backgroundColor: 'var(--color-surface-container)',
        color: 'var(--color-on-surface)',
    },
    '&.cm-editor .cm-panels.cm-panels-top': {
        borderBottom: '1px solid var(--color-outline-variant)',
    },
    '&.cm-editor .cm-panels.cm-panels-bottom': {
        borderTop: '1px solid var(--color-outline-variant)',
    },

    // --- Controles comunes (búsqueda y diálogo de ir a línea) ---
    '&.cm-editor .cm-panel .cm-textfield, &.cm-editor .cm-dialog .cm-textfield': {
        height: '26px',
        boxSizing: 'border-box',
        padding: '0 8px',
        fontSize: '12px',
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        color: 'var(--color-on-surface)',
        backgroundColor: 'var(--color-surface-container-lowest)',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '6px',
        outline: 'none',
        verticalAlign: 'middle',
    },
    '&.cm-editor .cm-panel .cm-textfield:focus, &.cm-editor .cm-dialog .cm-textfield:focus': {
        borderColor: 'var(--color-primary)',
        boxShadow: '0 0 0 1px var(--color-primary)',
    },
    '&.cm-editor .cm-panel .cm-textfield::placeholder': {
        color: 'var(--color-on-surface-variant)',
        opacity: '0.7',
    },
    '&.cm-editor .cm-panel .cm-button, &.cm-editor .cm-dialog .cm-button': {
        height: '26px',
        boxSizing: 'border-box',
        padding: '0 10px',
        fontSize: '12px',
        fontFamily: 'inherit',
        color: 'var(--color-on-surface)',
        backgroundImage: 'none',
        backgroundColor: 'transparent',
        border: '1px solid transparent',
        borderRadius: '6px',
        cursor: 'pointer',
        verticalAlign: 'middle',
    },
    '&.cm-editor .cm-panel .cm-button:hover, &.cm-editor .cm-dialog .cm-button:hover': {
        backgroundColor: 'color-mix(in srgb, var(--color-on-surface) 8%, transparent)',
    },
    '&.cm-editor .cm-panel .cm-button:active, &.cm-editor .cm-dialog .cm-button:active': {
        backgroundImage: 'none',
        backgroundColor: 'color-mix(in srgb, var(--color-on-surface) 14%, transparent)',
    },
    '&.cm-editor .cm-panel .cm-button:focus-visible, &.cm-editor .cm-dialog .cm-button:focus-visible': {
        outline: '2px solid var(--color-primary)',
        outlineOffset: '1px',
    },

    // --- Buscar / reemplazar ---
    '&.cm-editor .cm-panel.cm-search': {
        padding: '6px 40px 6px 8px',
        fontSize: '12px',
        lineHeight: '1',
    },
    '&.cm-editor .cm-panel.cm-search input, &.cm-editor .cm-panel.cm-search button, &.cm-editor .cm-panel.cm-search label': {
        margin: '2px 4px 2px 0',
    },
    '&.cm-editor .cm-panel.cm-search .cm-textfield': {
        width: 'min(22em, 45vw)',
    },
    '&.cm-editor .cm-panel.cm-search [name=next]': iconOnly('arrow_downward'),
    '&.cm-editor .cm-panel.cm-search [name=prev]': iconOnly('arrow_upward'),
    '&.cm-editor .cm-panel.cm-search [name=select]': iconOnly('select_all'),
    // `button[…]` y no `[name=replace]` a secas: el campo de reemplazo se
    // llama igual que su botón.
    // Reemplazar se queda con texto: las dos acciones escriben en el
    // documento, y distinguirlas por un ícono es justo donde no conviene
    // equivocarse. Van tonales, un escalón más visibles que la navegación.
    '&.cm-editor .cm-panel.cm-search button[name=replace], &.cm-editor .cm-panel.cm-search button[name=replaceAll]': {
        backgroundColor: 'var(--color-secondary-container)',
        color: 'var(--color-on-secondary-container)',
    },
    '&.cm-editor .cm-panel.cm-search button[name=replace]:hover, &.cm-editor .cm-panel.cm-search button[name=replaceAll]:hover': {
        backgroundColor: 'color-mix(in srgb, var(--color-secondary-container) 80%, var(--color-on-secondary-container))',
    },
    '&.cm-editor .cm-panel.cm-search [name=close]': {
        ...iconOnly('close'),
        position: 'absolute',
        top: '8px',
        right: '8px',
        margin: '0',
        color: 'var(--color-on-surface-variant)',
        backgroundColor: 'transparent',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
    },
    '&.cm-editor .cm-panel.cm-search [name=close]:hover': {
        backgroundColor: 'color-mix(in srgb, var(--color-on-surface) 8%, transparent)',
        color: 'var(--color-on-surface)',
    },
    // Las tres opciones (mayúsculas, regex, palabra) son casillas nativas
    // dentro de un <label>. Se dibujan como interruptores de ícono —como en
    // cualquier editor actual— y la casilla queda invisible pero viva: sigue
    // recibiendo el foco y el clic del label la alterna, así que el teclado y
    // el lector de pantalla funcionan igual que antes.
    '&.cm-editor .cm-panel.cm-search label': {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        fontSize: '0',
        verticalAlign: 'middle',
        whiteSpace: 'nowrap',
        borderRadius: '6px',
        border: '1px solid transparent',
        color: 'var(--color-on-surface-variant)',
        cursor: 'pointer',
        '&::before': {
            fontFamily: ICON_FONT,
            fontSize: '17px',
            lineHeight: '1',
            fontFeatureSettings: "'liga'",
            fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20",
        },
    },
    '&.cm-editor .cm-panel.cm-search label:hover': {
        backgroundColor: 'color-mix(in srgb, var(--color-on-surface) 8%, transparent)',
    },
    '&.cm-editor .cm-panel.cm-search label:has(input[name=case])::before': {content: "'match_case'"},
    '&.cm-editor .cm-panel.cm-search label:has(input[name=re])::before': {content: "'regular_expression'"},
    '&.cm-editor .cm-panel.cm-search label:has(input[name=word])::before': {content: "'match_word'"},
    '&.cm-editor .cm-panel.cm-search label:has(input:checked)': {
        color: 'var(--color-on-primary-container)',
        backgroundColor: 'var(--color-primary-container)',
        borderColor: 'color-mix(in srgb, var(--color-primary) 45%, transparent)',
    },
    '&.cm-editor .cm-panel.cm-search label:has(input:focus-visible)': {
        outline: '2px solid var(--color-primary)',
        outlineOffset: '1px',
    },
    '&.cm-editor .cm-panel.cm-search label input[type=checkbox]': {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        margin: '0',
        opacity: '0',
        cursor: 'pointer',
    },

    // Coincidencias en el texto. Los colores por defecto (amarillo, cian,
    // magenta) no salen de ningún tema; estos sí, y la seleccionada se
    // distingue además con un borde, que se ve aunque el tema del editor
    // tenga un fondo parecido al tinte.
    '&.cm-editor .cm-content .cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--color-tertiary) 28%, transparent)',
        borderRadius: '2px',
    },
    '&.cm-editor .cm-content .cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 40%, transparent)',
        outline: '1px solid var(--color-primary)',
    },

    // --- Ir a la línea (showDialog) ---
    '&.cm-editor .cm-dialog': {
        padding: '6px 36px 6px 8px',
        fontSize: '12px',
    },
    '&.cm-editor .cm-dialog label': {
        fontSize: '12px',
        color: 'var(--color-on-surface-variant)',
        marginRight: '6px',
    },
    '&.cm-editor .cm-dialog .cm-textfield': {
        width: '8em',
        margin: '0 6px',
    },
    '&.cm-editor .cm-dialog .cm-button': {
        backgroundColor: 'var(--color-primary)',
        color: 'var(--color-on-primary)',
    },
    '&.cm-editor .cm-dialog .cm-button:hover': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 88%, var(--color-on-primary))',
    },
    '&.cm-editor .cm-dialog .cm-dialog-close': {
        ...iconOnly('close'),
        top: '6px',
        right: '6px',
        color: 'var(--color-on-surface-variant)',
        borderRadius: '6px',
        cursor: 'pointer',
    },

    // --- Tooltips (hover, diagnósticos, firma) ---
    // Un solo marco para todos: el contenido de cada uno ya no trae borde
    // ni fondo propios, que era lo que dejaba un recuadro dentro de otro.
    '&.cm-editor .cm-tooltip': {
        backgroundColor: 'var(--color-surface-container-high)',
        color: 'var(--color-on-surface)',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgb(0 0 0 / 0.28)',
    },
    '&.cm-editor .cm-tooltip .cm-tooltip-arrow:before': {
        borderTopColor: 'var(--color-outline-variant)',
        borderBottomColor: 'var(--color-outline-variant)',
    },
    '&.cm-editor .cm-tooltip .cm-tooltip-arrow:after': {
        borderTopColor: 'var(--color-surface-container-high)',
        borderBottomColor: 'var(--color-surface-container-high)',
    },
    '&.cm-editor .cm-tooltip-lint .cm-diagnostic': {
        padding: '5px 9px',
        fontSize: '12px',
        lineHeight: '1.45',
    },

    // --- Panel de diagnósticos (Mod-Shift-m) ---
    '&.cm-editor .cm-panel.cm-panel-lint ul [aria-selected]': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 18%, transparent)',
        color: 'var(--color-on-surface)',
    },
    '&.cm-editor .cm-panel.cm-panel-lint ul:focus [aria-selected]': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 28%, transparent)',
        color: 'var(--color-on-surface)',
    },
    '&.cm-editor .cm-panel.cm-panel-lint [name=close]': {
        ...iconOnly('close'),
        color: 'var(--color-on-surface-variant)',
        backgroundColor: 'transparent',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
    },
})

// Las frases de CodeMirror en el idioma activo. Las claves son el texto
// inglés EXACTO que la librería pide (`state.phrase("match case")`); una
// clave mal escrita no falla, simplemente deja la frase en inglés.
function phrases(): Extension {
    const p = t().editor.codemirror.phrases
    return EditorState.phrases.of({
        Find: p.find,
        Replace: p.replace,
        next: p.next,
        previous: p.previous,
        all: p.all,
        'match case': p.matchCase,
        regexp: p.regexp,
        'by word': p.byWord,
        replace: p.replaceOne,
        'replace all': p.replaceAll,
        close: p.close,
        'Go to line': p.gotoLine,
        go: p.go,
        Diagnostics: p.diagnostics,
        'No diagnostics': p.noDiagnostics,
        'folded code': p.foldedCode,
        unfold: p.unfold,
        'current match': p.currentMatch,
        'on line': p.onLine,
        Completions: p.completions,
        'Control character': p.controlCharacter,
    })
}

// El panel de búsqueda de CodeMirror no pone `title` en nada, y con los
// botones dibujados como íconos un usuario no tiene cómo saber qué hace cada
// uno ni qué atajo tiene. La clase del panel no se exporta, así que en vez de
// reimplementarlo entero se le agregan los títulos al aparecer: una consulta
// por actualización mientras el panel existe, y nada mientras no.
const searchPanelTitles = ViewPlugin.fromClass(
    class {
        constructor(readonly view: EditorView) {
            this.decorate()
        }

        update() {
            this.decorate()
        }

        decorate() {
            const panel = this.view.dom.querySelector<HTMLElement>('.cm-search:not([data-mt-titled])')
            if (!panel) return
            panel.setAttribute('data-mt-titled', '')
            const titles = t().editor.codemirror.titles
            const set = (selector: string, title: string) => {
                const el = panel.querySelector<HTMLElement>(selector)
                if (el) el.title = title
            }
            set('[name=next]', titles.next)
            set('[name=prev]', titles.previous)
            set('[name=select]', titles.all)
            set('button[name=replace]', titles.replace)
            set('[name=replaceAll]', titles.replaceAll)
            set('[name=close]', titles.close)
            const labelOf = (name: string, title: string) => {
                const input = panel.querySelector<HTMLInputElement>(`input[name=${name}]`)
                const label = input?.closest('label')
                if (label) label.title = title
                if (input) input.setAttribute('aria-label', title)
            }
            labelOf('case', titles.matchCase)
            labelOf('re', titles.regexp)
            labelOf('word', titles.byWord)
        }
    },
)

// editorChrome es lo que se suma a cualquier editor CodeMirror de la app
// (lo agrega editorAppearanceExtension, que usan todos).
export function editorChrome(): Extension {
    return [chromeTheme, phrases(), searchPanelTitles]
}
