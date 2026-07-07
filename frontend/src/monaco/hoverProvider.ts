import {monaco} from './setup'
import {getActiveMetadata} from './metadataStore'

let registered = false

// Hover tooltip: column type/nullable/FK, or table column count — per spec
// "hover tooltip: tipo columna, nullable, FK".
export function registerSchemaHoverProvider() {
    if (registered) return
    registered = true

    monaco.languages.registerHoverProvider('sql', {
        provideHover(model, position) {
            const meta = getActiveMetadata()
            if (!meta) return null

            const word = model.getWordAtPosition(position)
            if (!word) return null
            const target = word.word.toLowerCase()

            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)

            for (const t of meta.tables) {
                if (t.name.toLowerCase() === target) {
                    return {
                        range,
                        contents: [{value: `**${t.name}** (tabla)`}, {value: `${t.columns.length} columnas`}],
                    }
                }
                for (const c of t.columns) {
                    if (c.name.toLowerCase() === target) {
                        const fk = t.foreignKeys.find((f) => f.column === c.name)
                        const lines = [`**${t.name}.${c.name}**`, `tipo: \`${c.dataType}\` · ${c.nullable ? 'nullable' : 'NOT NULL'}`]
                        if (c.isPrimaryKey) lines.push('PRIMARY KEY')
                        if (fk) lines.push(`FK → ${fk.referencedTable}.${fk.referencedColumn}`)
                        return {range, contents: lines.map((v) => ({value: v}))}
                    }
                }
            }
            return null
        },
    })
}
