import {useEffect, useRef} from 'react'
import {EditorState, Compartment, type Extension} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {basicSetup} from 'codemirror'
import {loadLanguage, type LanguageId} from '../../codemirror/languageRegistry'
import {resolveEditorTheme} from '../../codemirror/themes'
import {editorAppearanceExtension, type EditorAppearance} from '../../codemirror/editorAppearance'
import type {Theme} from '../../hooks/useTheme'

// Un panel de CodeMirror chico y controlado, para el cuerpo de la petición y
// para el visor de la respuesta.
//
// No reusa CodeMirrorTabbedEditor porque ese resuelve otro problema: una
// vista compartida con un EditorState por pestaña, historial de deshacer
// preservado entre cambios de pestaña y compartimentos de lenguaje atados a
// una conexión de base de datos. Acá cada panel es independiente y de vida
// corta. Lo que sí comparte es lo que tiene que verse igual en toda la app:
// el tema de colores y la apariencia (fuente, cuerpo, ajuste de línea).
//
// El lenguaje se carga con import() dinámico desde el registro compartido,
// así que traer JSON no arrastra los treinta lenguajes del editor de
// archivos de Git — la misma regla de tamaño de binario que el resto.

interface CodePaneProps {
    value: string
    onChange?: (value: string) => void
    language: LanguageId
    readOnly?: boolean
    editorThemeId: string
    appTheme: Theme
    appearance: EditorAppearance
    placeholder?: string
}

export default function CodePane({
    value,
    onChange,
    language,
    readOnly,
    editorThemeId,
    appTheme,
    appearance,
    placeholder,
}: CodePaneProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const langCompartment = useRef(new Compartment()).current
    const lookCompartment = useRef(new Compartment()).current
    // El callback se lee por ref para que cambiarlo no recree el editor —
    // recrearlo en cada render perdería el cursor con cada tecla.
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange

    useEffect(() => {
        if (!containerRef.current) return
        const view = new EditorView({
            parent: containerRef.current,
            state: EditorState.create({
                doc: value,
                extensions: [
                    basicSetup,
                    langCompartment.of([]),
                    lookCompartment.of([]),
                    EditorView.editable.of(!readOnly),
                    EditorState.readOnly.of(!!readOnly),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString())
                    }),
                ],
            }),
        })
        viewRef.current = view
        return () => {
            view.destroy()
            viewRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readOnly])

    // Tema y apariencia: se reconfiguran en vez de recrear el estado, que es
    // lo que evita perder el texto y el cursor al cambiar el tema con el
    // panel abierto.
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
            effects: lookCompartment.reconfigure([resolveEditorTheme(editorThemeId, appTheme), ...editorAppearanceExtension(appearance)]),
        })
    }, [editorThemeId, appTheme, appearance, lookCompartment])

    useEffect(() => {
        let alive = true
        void loadLanguage(language).then((ext: Extension | null) => {
            const view = viewRef.current
            // El import es asíncrono: para cuando resuelve, el panel puede
            // estar desmontado o el lenguaje puede haber cambiado otra vez.
            if (!alive || !view) return
            view.dispatch({effects: langCompartment.reconfigure(ext ?? [])})
        })
        return () => {
            alive = false
        }
    }, [language, langCompartment])

    // Texto empujado desde afuera (formatear el cuerpo, una respuesta nueva).
    // La comparación hace que esto sea un no-op en cada tecla, donde el
    // editor ya es la fuente del cambio.
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        if (view.state.doc.toString() === value) return
        view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: value}})
    }, [value])

    return (
        <div className="relative h-full w-full">
            <div ref={containerRef} className="h-full w-full" />
            {placeholder && value === '' && (
                <p className="pointer-events-none absolute left-10 top-1.5 text-ui-11 text-on-surface-variant/40">{placeholder}</p>
            )}
        </div>
    )
}
