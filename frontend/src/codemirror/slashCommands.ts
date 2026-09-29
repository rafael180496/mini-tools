import type {Completion, CompletionContext, CompletionResult} from '@codemirror/autocomplete'
import {t} from '../i18n'

// Menú `/slash` del editor de notas: bloques listos, al estilo Notion.
//
// **Todo lo que inserta es Markdown válido.** No hay un formato de bloques
// propietario guardado en la columna cifrada: una nota exportada a `.md` se
// abre en Obsidian sin pérdida. Guardar un formato propio dentro de un vault
// crearía documentación que solo esta app puede leer, y el usuario ya tiene
// una app así para credenciales — no para su documentación.
//
// Es un `CompletionSource` de CodeMirror y no un widget flotante propio: es el
// mismo mecanismo que ya usan `sqlIntel.ts` y el autocompletado de `[[`, así
// que hereda su navegación con flechas, su Escape y su comportamiento con
// Enter sin escribir ninguna de las tres cosas.

// SlashCommand es un bloque insertable.
interface SlashCommand {
    // cmd es lo que se escribe (`/callout`). No se traduce: es lo que se teclea.
    cmd: string
    // detail es la clave del texto de ayuda en notes.slash.
    detail: SlashDetail
    // snippet es el texto que reemplaza al comando. `|` marca dónde queda el
    // cursor: sin eso, después de insertar una tabla hay que ir a buscar la
    // primera celda a mano.
    snippet: string
}

type SlashDetail = keyof ReturnType<typeof t>['notes']['slash']

const COMMANDS: SlashCommand[] = [
    {cmd: '/h1', detail: 'h1', snippet: '# |'},
    {cmd: '/h2', detail: 'h2', snippet: '## |'},
    {cmd: '/h3', detail: 'h3', snippet: '### |'},
    {
        cmd: '/callout',
        detail: 'callout',
        snippet: '> [!INFO]\n> |',
    },
    {
        cmd: '/warning',
        detail: 'warning',
        snippet: '> [!WARNING]\n> |',
    },
    {
        cmd: '/security',
        detail: 'security',
        snippet: '> [!SECURITY]\n> |',
    },
    {
        cmd: '/table',
        detail: 'table',
        // La cabecera sale del diccionario al insertar (ver apply).
        snippet: '\n|---|---|---|\n| | | |\n',
    },
    {
        cmd: '/toggle',
        detail: 'toggle',
        snippet: '<details>\n<summary>|</summary>\n\n\n\n</details>\n',
    },
    {
        cmd: '/checklist',
        detail: 'checklist',
        snippet: '- [ ] |\n- [ ] \n',
    },
    {
        cmd: '/sql',
        detail: 'sql',
        snippet: '```sql connection="|"\n\n```\n',
    },
    {
        cmd: '/ssh',
        detail: 'ssh',
        snippet: '```ssh server="|"\n\n```\n',
    },
    {
        cmd: '/mermaid',
        detail: 'mermaid',
        snippet: '```mermaid\nflowchart TD\n    A[|] --> B[ ]\n```\n',
    },
    {
        cmd: '/code',
        detail: 'code',
        snippet: '```\n|\n```\n',
    },
]

// slashCommandSource ofrece los bloques cuando la línea empieza con `/`.
//
// **Solo al principio de una línea.** Una barra en medio de una frase es una
// ruta (`/export/env/sgc`) o una fecha, y abrir un menú ahí convertiría
// escribir una ruta —algo que en documentación técnica pasa todo el tiempo— en
// una pelea con el autocompletado.
export function slashCommandSource(ctx: CompletionContext): CompletionResult | null {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const before = line.text.slice(0, ctx.pos - line.from)
    const match = /^\s*(\/[a-z0-9]*)$/i.exec(before)
    if (!match) return null

    const typed = match[1].toLowerCase()
    const slash = t().notes.slash
    const options: Completion[] = COMMANDS.filter((c) => c.cmd.startsWith(typed)).map((c) => ({
        label: c.cmd,
        detail: slash[c.detail],
        type: 'keyword',
        apply: (view, _completion, from, to) => {
            const snippet = c.detail === 'table' ? slash.tableHeader + c.snippet : c.snippet
            const caret = c.snippet === snippet ? snippet.indexOf('|') : -1
            const text = caret >= 0 ? snippet.replace('|', '') : snippet
            view.dispatch({
                changes: {from, to, insert: text},
                selection: {anchor: from + (caret >= 0 ? caret : text.length)},
            })
        },
    }))
    if (options.length === 0) return null
    return {from: ctx.pos - typed.length, options}
}
