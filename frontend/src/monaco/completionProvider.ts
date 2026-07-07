import {monaco} from './setup'
import {getActiveMetadata} from './metadataStore'

let registered = false

// Table/column autocomplete from the active connection's cached schema
// metadata (metadataStore.ts) — refreshed by Workspace.tsx on connection
// switch or F5, not re-registered here each time.
export function registerSchemaCompletionProvider() {
    if (registered) return
    registered = true

    monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.', ' '],
        provideCompletionItems(model, position) {
            const meta = getActiveMetadata()
            if (!meta) return {suggestions: []}

            const word = model.getWordUntilPosition(position)
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            }

            const tableItems = meta.tables.map((t) => ({
                label: t.name,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: t.name,
                detail: t.schema ? `${t.schema}.${t.name}` : 'tabla',
                range,
            }))

            const columnItems = meta.tables.flatMap((t) =>
                t.columns.map((c) => ({
                    label: c.name,
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: c.name,
                    detail: `${t.name}.${c.name}: ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`,
                    range,
                })),
            )

            return {suggestions: [...tableItems, ...columnItems]}
        },
    })
}
