import {EditorState} from '@codemirror/state'
import type {Extension} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import type {vault} from '../../wailsjs/go/models'

// Cómo se ve y se comporta cualquier editor de la app.
//
// Había tres editores —el SQL, el de archivos del módulo Git y el de notas—
// y cada uno traía su propio `EditorView.theme` repitiendo el mismo `13px` y
// la misma familia tipográfica. Nadie los había puesto de acuerdo: estaban
// iguales por copiar y pegar, no por compartir nada, así que cambiar de idea
// significaba editar tres archivos y confiar en no olvidarse de ninguno. Acá
// viven una sola vez, y de paso pasan a ser ajustables.

export type EditorFontId = 'jetbrains' | 'system' | 'menlo' | 'consolas' | 'courier' | 'sans'

// Las familias ofrecidas.
//
// **Solo la primera viene con la app.** mini-tools es offline y empaqueta
// JetBrains Mono; el resto son fuentes del sistema, que existen o no según
// en qué máquina se abra. Por eso cada opción dice de dónde sale en vez de
// presentarlas como si fueran todas equivalentes: elegir "Consolas" en macOS
// no falla con un error, cae en silencio a la monoespaciada genérica, y sin
// el rótulo eso parece un bug de la app.
export const EDITOR_FONTS: {id: EditorFontId; label: string; hint: string; stack: string}[] = [
    {
        id: 'jetbrains',
        label: 'JetBrains Mono',
        hint: 'incluida',
        stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
    },
    {id: 'system', label: 'Monoespaciada del sistema', hint: 'la que use tu SO', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'},
    {id: 'menlo', label: 'Menlo', hint: 'macOS', stack: "Menlo, ui-monospace, monospace"},
    {id: 'consolas', label: 'Consolas', hint: 'Windows', stack: "Consolas, ui-monospace, monospace"},
    {id: 'courier', label: 'Courier New', hint: 'todos', stack: "'Courier New', Courier, monospace"},
    {
        id: 'sans',
        label: 'Hanken Grotesk',
        hint: 'incluida · no monoespaciada',
        stack: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
    },
]

export const EDITOR_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24]
export const EDITOR_TAB_SIZES = [2, 4, 8]

// La barra de acciones del editor (Guardar / Ejecutar / Bloque / …).
//
// "compact" deja solo los íconos: los atajos siguen siendo los mismos y las
// etiquetas son lo que más ancho ocupa. "hidden" la saca del todo — no
// desactiva nada, porque todo lo que hay ahí tiene atajo de teclado; es para
// quien ya los sabe y quiere la pantalla entera para el texto.
export type EditorToolbarMode = 'normal' | 'compact' | 'hidden'
export const EDITOR_TOOLBAR_MODES: {id: EditorToolbarMode; label: string; hint: string}[] = [
    {id: 'normal', label: 'Normal', hint: 'Ejecutar con su nombre, el resto solo íconos'},
    {id: 'compact', label: 'Compacta', hint: 'todo solo íconos'},
    {id: 'hidden', label: 'Oculta', hint: 'los atajos siguen funcionando'},
]

// EditorAppearance es el espejo TS de vault.EditorAppearance, con los
// valores ya resueltos: el backend guarda ceros y cadenas vacías para "no
// elegido" justamente para que el default viva acá, en un solo lugar.
export interface EditorAppearance {
    fontFamily: EditorFontId
    fontSize: number
    lineWrap: boolean
    lineNumbers: boolean
    tabSize: number
    toolbar: EditorToolbarMode
}

export const DEFAULT_EDITOR_APPEARANCE: EditorAppearance = {
    fontFamily: 'jetbrains',
    // 13px es lo que los tres editores tenían fijo antes de esto.
    fontSize: 13,
    lineWrap: false,
    lineNumbers: true,
    tabSize: 4,
    toolbar: 'normal',
}

// fromSettings normaliza lo que viene del vault. Cada campo se valida contra
// la lista real de opciones en vez de confiar en la cadena guardada: un id
// de fuente que ya no existe (porque se retiró de EDITOR_FONTS) tiene que
// caer en el default, no dejar el editor sin familia tipográfica.
export function editorAppearanceFromSettings(raw: vault.EditorAppearance | undefined | null): EditorAppearance {
    if (!raw) return DEFAULT_EDITOR_APPEARANCE
    const font = EDITOR_FONTS.find((f) => f.id === raw.fontFamily)
    const toolbar = EDITOR_TOOLBAR_MODES.find((t) => t.id === raw.toolbar)
    return {
        fontFamily: font ? (raw.fontFamily as EditorFontId) : DEFAULT_EDITOR_APPEARANCE.fontFamily,
        fontSize: raw.fontSize && raw.fontSize >= 9 && raw.fontSize <= 32 ? raw.fontSize : DEFAULT_EDITOR_APPEARANCE.fontSize,
        lineWrap: !!raw.lineWrap,
        lineNumbers: !!raw.lineNumbers,
        tabSize: raw.tabSize && raw.tabSize >= 1 && raw.tabSize <= 8 ? raw.tabSize : DEFAULT_EDITOR_APPEARANCE.tabSize,
        toolbar: toolbar ? (raw.toolbar as EditorToolbarMode) : DEFAULT_EDITOR_APPEARANCE.toolbar,
    }
}

export function editorFontStack(id: EditorFontId): string {
    return (EDITOR_FONTS.find((f) => f.id === id) ?? EDITOR_FONTS[0]).stack
}

// editorAppearanceExtension arma las extensiones de CodeMirror para una
// apariencia dada.
//
// `forceLineWrap` existe para las notas: son prosa, y prosa sin ajuste de
// línea se lee desplazándose en horizontal renglón por renglón, que no es
// una preferencia sino una forma de no poder leer. Ahí el ajuste no se
// ofrece, se impone.
//
// La numeración se apaga por CSS y no quitando la extensión: el gutter lo
// arma `basicSetup`, que es un paquete cerrado, y desarmarlo para sacarle
// una pieza significaría reimplementar las otras quince que sí se quieren.
export function editorAppearanceExtension(a: EditorAppearance, opts?: {forceLineWrap?: boolean}): Extension[] {
    const wrap = opts?.forceLineWrap || a.lineWrap
    const ext: Extension[] = [
        EditorView.theme({
            '&': {height: '100%', fontSize: `${a.fontSize}px`},
            '.cm-scroller': {fontFamily: editorFontStack(a.fontFamily), overflow: 'auto'},
            ...(a.lineNumbers ? {} : {'.cm-gutters': {display: 'none'}}),
        }),
        EditorState.tabSize.of(a.tabSize),
    ]
    if (wrap) ext.push(EditorView.lineWrapping)
    return ext
}
