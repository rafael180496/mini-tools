import type {Completion, CompletionContext, CompletionResult} from '@codemirror/autocomplete'

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
    // label es lo que se escribe (`/callout`).
    label: string
    detail: string
    // snippet es el texto que reemplaza al comando. `|` marca dónde queda el
    // cursor: sin eso, después de insertar una tabla hay que ir a buscar la
    // primera celda a mano.
    snippet: string
}

const COMMANDS: SlashCommand[] = [
    {label: '/h1', detail: 'Título de sección', snippet: '# |'},
    {label: '/h2', detail: 'Subtítulo', snippet: '## |'},
    {label: '/h3', detail: 'Sub-subtítulo', snippet: '### |'},
    {
        label: '/callout',
        detail: 'Caja resaltada — INFO, WARNING, SECURITY o TIP',
        snippet: '> [!INFO]\n> |',
    },
    {
        label: '/warning',
        detail: 'Caja de advertencia',
        snippet: '> [!WARNING]\n> |',
    },
    {
        label: '/security',
        detail: 'Caja de seguridad — para lo que no hay que hacer nunca',
        snippet: '> [!SECURITY]\n> |',
    },
    {
        label: '/table',
        detail: 'Tabla Markdown de 3 columnas',
        snippet: '| Campo | Valor | Notas |\n|---|---|---|\n| | | |\n',
    },
    {
        label: '/toggle',
        detail: 'Bloque plegable — para el detalle largo que no siempre se mira',
        snippet: '<details>\n<summary>|</summary>\n\n\n\n</details>\n',
    },
    {
        label: '/checklist',
        detail: 'Lista de verificación — los pasos de un procedimiento',
        snippet: '- [ ] |\n- [ ] \n',
    },
    {
        label: '/sql',
        detail: 'Bloque SQL EJECUTABLE contra una conexión guardada',
        snippet: '```sql connection="|"\n\n```\n',
    },
    {
        label: '/ssh',
        detail: 'Bloque de comandos para un servidor guardado',
        snippet: '```ssh server="|"\n\n```\n',
    },
    {
        label: '/mermaid',
        detail: 'Diagrama (se muestra como código: ver la nota de peso en el plan)',
        snippet: '```mermaid\nflowchart TD\n    A[|] --> B[ ]\n```\n',
    },
    {
        label: '/code',
        detail: 'Bloque de código',
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
    const options: Completion[] = COMMANDS.filter((c) => c.label.startsWith(typed)).map((c) => ({
        label: c.label,
        detail: c.detail,
        type: 'keyword',
        apply: (view, _completion, from, to) => {
            const caret = c.snippet.indexOf('|')
            const text = c.snippet.replace('|', '')
            view.dispatch({
                changes: {from, to, insert: text},
                selection: {anchor: from + (caret >= 0 ? caret : text.length)},
            })
        },
    }))
    if (options.length === 0) return null
    return {from: ctx.pos - typed.length, options}
}
