import Icon from '../Icon'
import {useT} from '../../i18n'
import {requestOpenNote} from '../../lib/appBus'

// Espeja agentchat.ToolCall. Se escribe a mano y no sale de wailsjs/go/models
// por el mismo motivo que ChatEvent en AgentChat.tsx: viaja por un EVENTO de
// Wails, no por el valor de retorno de un binding.
export interface ToolCall {
    name: string
    input: string
    // Línea legible de lo que hizo: la ruta, el comando, el patrón, el título de
    // la nota. Vacía cuando la herramienta no se reconoce: ahí solo el nombre.
    summary: string
    // Efecto medible cuando se puede calcular ("18 líneas" al escribir).
    detail: string
}

// Las herramientas llegan con tres formas de nombre:
//   - las propias de un servidor de modelos (`read_file`, `run_command`,
//     `vault_create_note`),
//   - las de un CLI (`Read`, `Bash`, `Edit`),
//   - las del servidor MCP vistas desde un CLI (`mcp__mini-tools__vault_create_note`).
// Se normalizan a la primera forma para elegir ícono y rótulo en un solo lugar.
const CLI_ALIASES: Record<string, string> = {
    read: 'read_file',
    ls: 'list_dir',
    grep: 'search',
    write: 'write_file',
    edit: 'edit_file',
    multiedit: 'edit_file',
    bash: 'run_command',
}

export function canonicalToolName(name: string): string {
    const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name
    return CLI_ALIASES[bare.toLowerCase()] ?? bare
}

const ICONS: Record<string, string> = {
    read_file: 'description',
    list_dir: 'folder_open',
    search: 'manage_search',
    glob: 'travel_explore',
    skill: 'psychology',
    read_skill_file: 'menu_book',
    write_file: 'edit_document',
    edit_file: 'edit',
    run_command: 'terminal',
    vault_search_notes: 'search',
    vault_read_note: 'menu_book',
    vault_list_folders: 'folder_special',
    vault_list_notes: 'list',
    vault_create_note: 'note_add',
    vault_append_to_note: 'playlist_add',
    vault_update_note: 'edit_note',
    db_list_connections: 'storage',
    db_get_schema: 'schema',
    db_explain_query: 'query_stats',
    ssh_get_recent_logs: 'terminal',
    git_status: 'account_tree',
}

// Herramientas que CAMBIAN algo (archivos, comandos, notas): van en el color de
// las advertencias no destructivas, como el resto de la app, para que de un
// vistazo la secuencia distinga lo que miró de lo que tocó.
const CHANGING = new Set([
    'write_file',
    'edit_file',
    'run_command',
    'vault_create_note',
    'vault_append_to_note',
    'vault_update_note',
])

// Herramientas de skills: `skill` carga las instrucciones de una skill por su
// nombre y `read_skill_file` lee un archivo que esa skill trae al lado. Ninguna
// toca nada: solo leen, pero conviene que la tarjeta diga de qué se trata.
const SKILL_TOOLS = new Set(['skill', 'read_skill_file'])

// Las tres que dejan una nota escrita por el agente: son las que ofrecen abrirla.
const NOTE_WRITERS = new Set(['vault_create_note', 'vault_append_to_note', 'vault_update_note'])

export function toolIcon(name: string): string {
    return ICONS[canonicalToolName(name)] ?? 'build'
}

// Título de la nota sobre la que actuó la herramienta: el resumen que arma el
// backend o, si faltara, el campo `title` del argumento.
function noteTitle(tool: ToolCall): string {
    if (tool.summary.trim()) return tool.summary.trim()
    try {
        const parsed = JSON.parse(tool.input) as {title?: unknown}
        return typeof parsed.title === 'string' ? parsed.title.trim() : ''
    } catch {
        return ''
    }
}

// Nombre de la skill sobre la que actuó la herramienta: el resumen del backend o,
// si faltara, el campo `name` (o `skill`) del argumento.
function skillName(tool: ToolCall): string {
    if (tool.summary.trim()) return tool.summary.trim()
    try {
        const parsed = JSON.parse(tool.input) as {name?: unknown; skill?: unknown}
        const v = typeof parsed.name === 'string' ? parsed.name : typeof parsed.skill === 'string' ? parsed.skill : ''
        return v.trim()
    } catch {
        return ''
    }
}

export default function ToolCallCard({tool}: {tool: ToolCall}) {
    const t = useT()
    const canonical = canonicalToolName(tool.name)
    const changing = CHANGING.has(canonical)
    const title = NOTE_WRITERS.has(canonical) ? noteTitle(tool) : ''
    // Un comando se lee mejor con su prompt: distingue «lo que corrió» de una
    // ruta o un patrón sin tener que mirar el nombre de la herramienta.
    const isSkill = SKILL_TOOLS.has(canonical)
    const summary =
        canonical === 'run_command' && tool.summary ? `$ ${tool.summary}` : canonical === 'skill' ? skillName(tool) : tool.summary
    const toolHint = isSkill
        ? canonical === 'skill'
            ? t.agent.chat.toolCard.skillTitle
            : t.agent.chat.toolCard.skillFileTitle
        : canonical === 'glob'
          ? t.agent.chat.toolCard.globTitle
          : undefined

    return (
        <details className="group/tool mb-1.5 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-ui-11 hover:bg-surface-variant/50">
                <Icon name={toolIcon(tool.name)} size={12} className={`shrink-0 ${changing ? 'text-tertiary' : 'text-primary'}`} />
                <span className="shrink-0 font-mono font-medium text-on-surface" title={toolHint}>
                    {canonical}
                </span>
                {summary && (
                    <span className="min-w-0 flex-1 truncate font-mono text-on-surface-variant" title={summary}>
                        {summary}
                    </span>
                )}
                {!summary && <span className="flex-1" />}
                {tool.detail && (
                    <span className="shrink-0 rounded bg-surface-variant px-1 font-mono text-ui-10 text-on-surface-variant">
                        {tool.detail}
                    </span>
                )}
                {title && (
                    <button
                        type="button"
                        data-open-note
                        onClick={(e) => {
                            // Dentro de <summary>: sin esto el clic también
                            // pliega o despliega la tarjeta.
                            e.preventDefault()
                            e.stopPropagation()
                            requestOpenNote({title})
                        }}
                        title={t.agent.chat.toolCard.openNoteTitle({title})}
                        className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-px text-ui-10 text-primary hover:bg-primary/10"
                    >
                        <Icon name="open_in_new" size={11} />
                        {t.agent.chat.toolCard.openNote}
                    </button>
                )}
                <Icon
                    name="expand_more"
                    size={14}
                    className="shrink-0 text-on-surface-variant transition-transform group-open/tool:rotate-180"
                />
            </summary>
            <pre className="overflow-x-auto border-t border-outline-variant px-2 py-1.5 font-mono text-ui-10 whitespace-pre-wrap break-words text-on-surface-variant">
                {tool.input}
            </pre>
        </details>
    )
}
