import {useEffect, useRef} from 'react'
import {EditorState, Compartment, type Extension} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {indentWithTab} from '@codemirror/commands'
import {search} from '@codemirror/search'
import {basicSetup} from 'codemirror'
import {db} from '../../../wailsjs/go/models'
import type {EditorTab, TabLanguage} from './EditorTabs'
import {sqlLanguageExtension, sqlSchemaHover} from '../../codemirror/sqlSchema'
import {redisCli} from '../../codemirror/redisLanguage'
import {lintExtension} from '../../codemirror/lintAdapter'
import {resolveEditorTheme} from '../../codemirror/themes'
import type {Theme} from '../../hooks/useTheme'

// Shared across every tab's independent EditorState — a Compartment is
// just an addressable slot within a state's extension list, so the same
// instance can be reconfigured per-state without states interfering with
// each other (see frontend/src/codemirror's module docs / the migration
// plan's "Hallazgo clave").
const languageCompartment = new Compartment()
const themeCompartment = new Compartment()

const baseTheme = EditorView.theme({
    '&': {height: '100%', fontSize: '13px'},
    '.cm-scroller': {fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", overflow: 'auto'},
})

function languageExtensions(language: TabLanguage, dbType: string | null, meta: db.SchemaMetadata | null): Extension[] {
    if (language === 'redis-cli') return [redisCli(), lintExtension(language)]
    return [sqlLanguageExtension(dbType, meta), sqlSchemaHover(meta), lintExtension(language)]
}

interface CodeMirrorTabbedEditorProps {
    tabs: EditorTab[]
    activeTabId: string
    onChangeContent: (tabId: string, value: string) => void
    onMount?: (view: EditorView) => void
    // The active tab's bound connection dbType/metadata — mirrors what
    // Workspace.tsx used to push into the retired monaco/metadataStore.ts +
    // activeDbTypeStore.ts singletons, now consumed directly as props
    // instead (no global mutable store, see the module comment above).
    dbType: string | null
    schemaMetadata: db.SchemaMetadata | null
    editorThemeId: string
    appTheme: Theme
}

// One shared CodeMirror EditorView for the whole workspace, with one
// EditorState per tab (created lazily on first visit, kept alive across
// tab switches) — same "one editor, N models" shape as the retired
// MonacoTabbedEditor.tsx, ported to CM6's immutable-state API:
// view.setState(state) instead of editor.setModel(model), and
// Compartment.reconfigure() instead of monaco.editor.setModelLanguage()/
// global provider stores. Every tab's own EditorState carries an
// EditorView.updateListener that writes the latest state back into
// statesRef on EVERY update (typing, or a Compartment reconfigure) — since
// EditorState is immutable, without this a background tab's cached state
// would go stale (losing edits or a schema/theme reconfigure) the moment
// it stops being the visible one.
export default function CodeMirrorTabbedEditor({
    tabs,
    activeTabId,
    onChangeContent,
    onMount,
    dbType,
    schemaMetadata,
    editorThemeId,
    appTheme,
}: CodeMirrorTabbedEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const statesRef = useRef<Map<string, EditorState>>(new Map())
    const onChangeContentRef = useRef(onChangeContent)
    onChangeContentRef.current = onChangeContent
    const tabsRef = useRef(tabs)
    tabsRef.current = tabs

    function createStateForTab(tab: EditorTab, theme: Extension): EditorState {
        return EditorState.create({
            doc: tab.content,
            extensions: [
                basicSetup,
                baseTheme,
                search(),
                keymap.of([indentWithTab]),
                languageCompartment.of(languageExtensions(tab.language, dbType, schemaMetadata)),
                themeCompartment.of(theme),
                EditorView.updateListener.of((update) => {
                    statesRef.current.set(tab.id, update.state)
                    if (update.docChanged) {
                        onChangeContentRef.current(tab.id, update.state.doc.toString())
                    }
                }),
            ],
        })
    }

    // Mount once: create the shared view with whatever tab is active at
    // that moment.
    useEffect(() => {
        if (!containerRef.current) return
        const tab = tabsRef.current.find((t) => t.id === activeTabId) ?? tabsRef.current[0]
        const state = tab ? createStateForTab(tab, resolveEditorTheme(editorThemeId, appTheme)) : EditorState.create({extensions: [basicSetup, baseTheme]})
        if (tab) statesRef.current.set(tab.id, state)

        const view = new EditorView({parent: containerRef.current, state})
        viewRef.current = view
        onMount?.(view)

        return () => {
            view.destroy()
            statesRef.current.clear()
            viewRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Drop states for tabs that no longer exist — unlike Monaco's
    // ITextModel, EditorState needs no explicit dispose, just dereferencing.
    useEffect(() => {
        const liveIds = new Set(tabs.map((t) => t.id))
        for (const id of statesRef.current.keys()) {
            if (!liveIds.has(id)) statesRef.current.delete(id)
        }
    }, [tabs])

    // Switch the shared view to the active tab's state, creating it on
    // first visit. Deliberately keyed ONLY on activeTabId (via tabsRef for
    // the tab's data) — keying on `tabs` too would re-run this on every
    // keystroke (tabs' reference changes whenever content updates) and
    // reset the editor's view state each time.
    useEffect(() => {
        const view = viewRef.current
        const tab = tabsRef.current.find((t) => t.id === activeTabId)
        if (!view || !tab) return

        let state = statesRef.current.get(tab.id)
        if (!state) {
            state = createStateForTab(tab, resolveEditorTheme(editorThemeId, appTheme))
            statesRef.current.set(tab.id, state)
        }
        view.setState(state)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabId])

    // Reconfigure the active tab's language/schema/lint whenever the bound
    // connection, its cached metadata, or the tab's own language changes —
    // covers both a newly bound/unbound connection and F5 metadata
    // refresh, same triggers the retired setActiveMetadata/setActiveDbType
    // effects in Workspace.tsx used to react to.
    const activeLanguage = tabs.find((t) => t.id === activeTabId)?.language
    useEffect(() => {
        const view = viewRef.current
        if (!view || !activeLanguage) return
        view.dispatch({effects: languageCompartment.reconfigure(languageExtensions(activeLanguage, dbType, schemaMetadata))})
    }, [activeTabId, dbType, schemaMetadata, activeLanguage])

    // Theme changes are app-wide, not per-tab — reconfigure every cached
    // state (not just the active one) so a tab switched back to later
    // doesn't briefly show a stale theme.
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const themeExt = resolveEditorTheme(editorThemeId, appTheme)
        for (const [id, state] of statesRef.current) {
            statesRef.current.set(id, state.update({effects: themeCompartment.reconfigure(themeExt)}).state)
        }
        const activeState = statesRef.current.get(activeTabId)
        if (activeState) view.setState(activeState)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editorThemeId, appTheme])

    // Push content set from OUTSIDE the editor (e.g. double-click a
    // table/key auto-filling a query, or opening a file) into the active
    // tab's document. The equality check makes this a no-op on every
    // ordinary keystroke (the editor was the source of that change in the
    // first place) — same round-trip the Monaco version already relied on.
    const activeTabContent = tabs.find((t) => t.id === activeTabId)?.content
    useEffect(() => {
        const view = viewRef.current
        if (!view || activeTabContent === undefined) return
        if (view.state.doc.toString() !== activeTabContent) {
            view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: activeTabContent}})
        }
    }, [activeTabId, activeTabContent])

    return <div ref={containerRef} className="h-full w-full" />
}
