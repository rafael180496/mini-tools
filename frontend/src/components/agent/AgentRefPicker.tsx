import {useEffect, useMemo, useState} from 'react'
import {AgentRefPolicies, GetSchemaMetadata, ListConnections, NoteTitles} from '../../../wailsjs/go/main/App'
import {agentctx, main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import type {WorkContext} from './workContext'
import {useT, type Dict} from '../../i18n'

// Selector del sistema `@`: qué se puede referenciar y con qué sintaxis.
//
// Dos niveles, como un explorador de archivos. Escribir `@` ofrece los TIPOS
// (`db:`, `explain:`, `file:`…); elegir uno ofrece sus VALORES reales
// —conexiones guardadas, tablas de esa conexión, archivos del repositorio—. Sin
// el primer nivel habría que saberse la sintaxis de memoria, y un sistema de
// referencias que hay que memorizar no lo usa nadie.
//
// El selector NO resuelve nada: arma texto. Lo que cada referencia inyecta lo
// decide el backend (app_refs.go), y lo que se va a mandar se ve en las fichas
// del compositor antes de mandarlo.

// Sugerencia lista para insertarse.
interface Suggestion {
    // insert es el texto completo que reemplaza a lo que se venía escribiendo.
    insert: string
    label: string
    hint: string
    icon: string
    // partial marca las que NO cierran la referencia (elegir un tipo, elegir
    // una conexión antes de la tabla): el selector se queda abierto.
    partial?: boolean
    disabled?: boolean
}

interface Props {
    // Lo escrito después de la última `@`, sin la arroba.
    query: string
    // Rutas del repositorio abierto, para el `@ruta` suelto y para `@file:`.
    paths: string[]
    context: WorkContext
    onPick: (insert: string, partial: boolean) => void
    // La primera sugerencia utilizable, para que Enter la elija desde la caja
    // de texto sin tener que sacar el cursor de ahí. La lista se calcula acá,
    // así que el compositor no puede saberla por su cuenta.
    onFirstChange?: (first: {insert: string; partial: boolean} | null) => void
}

export default function AgentRefPicker({query, paths, context, onPick, onFirstChange}: Props) {
    const t = useT()
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    const [policies, setPolicies] = useState<agentctx.Policy[]>([])
    const [tables, setTables] = useState<Record<string, string[]>>({})
    // Títulos de las notas. La base de conocimiento es el cerebro del usuario:
    // poder referenciarla desde cualquier chat —una consulta SQL, un error de
    // terminal— es justamente para lo que sirve tenerla adentro de la app.
    const [notes, setNotes] = useState<main.NoteTitle[]>([])

    useEffect(() => {
        ListConnections()
            .then((c) => setConnections(c ?? []))
            .catch(() => setConnections([]))
        // La tabla de políticas la sirve el backend y no se duplica acá: es la
        // promesa de seguridad del sistema (qué inyecta y qué nunca), y dos
        // copias se desincronizan justo en lo que no puede estar mal.
        AgentRefPolicies()
            .then((p) => setPolicies(p ?? []))
            .catch(() => setPolicies([]))
        NoteTitles()
            .then((n) => setNotes(n ?? []))
            .catch(() => setNotes([]))
    }, [])

    // Conexión cuya lista de tablas hace falta AHORA (`@db:Prod/` a medio
    // escribir). Se piden solo entonces: el esquema de una base grande es caro
    // y pedirlo al abrir el selector lo pagaría alguien que solo quería
    // referenciar un archivo.
    const pendingConn = useMemo(() => {
        const [kind, rest] = splitKind(query)
        if (kind !== 'db' || !rest?.includes('/')) return null
        const name = rest.slice(0, rest.indexOf('/'))
        return connections.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null
    }, [query, connections])

    useEffect(() => {
        if (!pendingConn || tables[pendingConn.id]) return
        GetSchemaMetadata(pendingConn.id, false)
            .then((meta) =>
                setTables((prev) => ({
                    ...prev,
                    [pendingConn.id]: (meta?.tables ?? []).map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)),
                })),
            )
            // Una conexión que no se puede abrir deja la lista vacía, no un
            // error: el usuario puede escribir el nombre de la tabla igual.
            .catch(() => setTables((prev) => ({...prev, [pendingConn.id]: []})))
    }, [pendingConn, tables])

    const suggestions = useMemo(
        () => buildSuggestions(query, {paths, connections, policies, tables, notes, context}, t),
        [query, paths, connections, policies, tables, notes, context, t],
    )

    const first = suggestions.find((s) => !s.disabled) ?? null
    useEffect(() => {
        onFirstChange?.(first ? {insert: first.insert, partial: !!first.partial} : null)
    }, [first?.insert, first?.partial, onFirstChange])

    if (suggestions.length === 0) return null

    return (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-outline-variant bg-surface-container">
            {suggestions.map((s) => (
                <button
                    key={s.insert + s.label}
                    onClick={() => !s.disabled && onPick(s.insert, !!s.partial)}
                    disabled={s.disabled}
                    title={s.hint}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-ui-11 hover:bg-surface-container-high disabled:opacity-50 disabled:hover:bg-transparent"
                >
                    <Icon name={s.icon} size={12} className="shrink-0 text-on-surface-variant" />
                    <span className="shrink-0 font-medium text-on-surface">{s.label}</span>
                    <span className="min-w-0 flex-1 truncate text-on-surface-variant/70">{s.hint}</span>
                </button>
            ))}
        </div>
    )
}

// splitKind separa `db:Prod/tabla` en ['db', 'Prod/tabla']. Sin `:` devuelve
// [null, query]: todavía no se eligió un tipo.
function splitKind(query: string): [string | null, string] {
    const i = query.indexOf(':')
    if (i < 0) return [null, query]
    // Un valor entre comillas a medio escribir (`@db:"Mi base/`) se lee sin la
    // comilla de apertura: el resto del selector trabaja con el nombre pelado.
    return [query.slice(0, i), query.slice(i + 1).replace(/^"/, '')]
}

// needsQuotes: el parser de Go (agentctx.scanValue) corta el valor en el primer
// espacio, coma o paréntesis. Una conexión llamada "Prod Facturación" sin
// comillas se resolvía como `@db:Prod` — que no existe — y la ficha decía
// "no encontrada" sobre un nombre que el propio selector había escrito.
function needsQuotes(name: string): boolean {
    return /[\s,()[\]"]/.test(name)
}

// refValue arma el valor completo de una referencia, entre comillas si hace falta.
function refValue(value: string): string {
    return needsQuotes(value) ? `"${value}"` : value
}

// Referencias fijas: son sintaxis que el usuario escribe y el backend
// interpreta (backend/agentctx), no texto de interfaz — no se traducen.
const REF_GIT_STAGED = '@git:staged'
const REF_GIT_WORKTREE = '@git:worktree'
const REF_EXPLAIN_LAST = '@explain:last'
const explainRef = (name: string) => `@explain:${name}`

const KIND_ICONS: Record<string, string> = {
    file: 'description',
    db: 'database',
    explain: 'query_stats',
    ssh: 'terminal',
    git: 'account_tree',
    note: 'sticky_note_2',
}

function buildSuggestions(
    query: string,
    opts: {
        paths: string[]
        connections: vault.ConnectionSummary[]
        policies: agentctx.Policy[]
        tables: Record<string, string[]>
        notes: main.NoteTitle[]
        context: WorkContext
    },
    t: Dict,
): Suggestion[] {
    const {paths, connections, policies, tables, notes, context} = opts
    const r = t.agent.refPicker
    const [kind, rest] = splitKind(query)

    // Nivel 1: todavía sin tipo. Se ofrecen los tipos Y las rutas sueltas.
    if (kind === null) {
        const q = query.toLowerCase()
        const out: Suggestion[] = []
        for (const p of policies) {
            if (q && !p.kind.startsWith(q)) continue
            out.push({
                insert: `@${p.kind}:`,
                label: `@${p.kind}:`,
                hint: p.available
                    ? r.kindHint({injects: p.injects, never: p.never ?? ''})
                    : r.kindUnavailable({injects: p.injects}),
                icon: KIND_ICONS[p.kind] ?? 'alternate_email',
                partial: true,
                disabled: !p.available,
            })
        }
        // El `@ruta` suelto del módulo Git sigue existiendo y va después de los
        // tipos: manda la RUTA y deja que el agente abra el archivo, que gasta
        // mucho menos contexto que pegarlo entero.
        out.push(...filePathSuggestions(paths, query, '@'))
        return out.slice(0, 14)
    }

    switch (kind) {
        case 'file':
            return filePathSuggestions(paths, rest, '@file:')
        case 'git':
            return [
                {
                    insert: `${REF_GIT_STAGED} `,
                    label: REF_GIT_STAGED,
                    hint: r.gitStaged,
                    icon: 'account_tree',
                },
                {
                    insert: `${REF_GIT_WORKTREE} `,
                    label: REF_GIT_WORKTREE,
                    hint: r.gitWorktree,
                    icon: 'account_tree',
                },
            ].filter((s) => s.label.includes(rest))
        case 'explain':
            return [
                {
                    insert: `${REF_EXPLAIN_LAST} `,
                    label: REF_EXPLAIN_LAST,
                    hint: r.explainLast,
                    icon: 'query_stats',
                },
                ...connections
                    .filter((c) => c.dbType !== 'ssh' && c.name.toLowerCase().includes(rest.toLowerCase()))
                    .map((c) => ({
                        insert: `@explain:${refValue(c.name)} `,
                        label: explainRef(c.name),
                        hint: r.explainConn,
                        icon: 'query_stats',
                    })),
            ].slice(0, 12)
        case 'db':
            return dbSuggestions(rest, connections, tables, t)
        case 'note':
            // Solo las notas VISIBLES para la IA se pueden usar. Una privada se
            // ofrece igual pero deshabilitada y diciendo por qué: esconderla de
            // la lista haría parecer que no existe, y el usuario la ve en su
            // propio módulo — el que no puede leerla es el agente.
            return notes
                .filter((n) => n.title.toLowerCase().includes(rest.toLowerCase()))
                .slice(0, 12)
                .map((n) => ({
                    insert: `@note:"${n.title}" `,
                    label: n.title,
                    hint: n.isPrivate
                        ? r.notePrivate
                        : r.noteFull,
                    icon: n.isPrivate ? 'lock' : 'sticky_note_2',
                    disabled: n.isPrivate,
                }))
        case 'ssh':
            return connections
                .filter((c) => c.dbType === 'ssh' && c.name.toLowerCase().includes(rest.toLowerCase()))
                .slice(0, 12)
                .map((c) => ({
                    insert: `@ssh:${refValue(`${c.name}/last_error`)} `,
                    label: c.name,
                    hint: r.sshLast,
                    icon: 'terminal',
                }))
    }

    // Un tipo desconocido no es un error: es texto, y el selector se calla.
    void context
    return []
}

function dbSuggestions(
    rest: string,
    connections: vault.ConnectionSummary[],
    tables: Record<string, string[]>,
    t: Dict,
): Suggestion[] {
    const r = t.agent.refPicker
    const slash = rest.indexOf('/')
    if (slash < 0) {
        return connections
            .filter((c) => c.dbType !== 'ssh' && c.name.toLowerCase().includes(rest.toLowerCase()))
            .map((c) => ({
                // Con comillas se abre acá y se cierra al elegir la tabla.
                insert: needsQuotes(c.name) ? `@db:"${c.name}/` : `@db:${c.name}/`,
                label: c.name,
                hint: r.dbPickTable({dbType: c.dbType}),
                icon: 'database',
                partial: true,
            }))
            .slice(0, 12)
    }

    const connName = rest.slice(0, slash)
    const tableQuery = rest.slice(slash + 1).toLowerCase()
    const conn = connections.find((c) => c.name.toLowerCase() === connName.toLowerCase())
    const list = conn ? tables[conn.id] : undefined
    if (!conn) {
        return [
            {
                insert: '',
                label: connName,
                hint: r.dbNoConn,
                icon: 'database',
                disabled: true,
            },
        ]
    }
    if (list === undefined) {
        return [{insert: '', label: r.dbReading, hint: conn.name, icon: 'database', disabled: true}]
    }
    return list
        .filter((t) => t.toLowerCase().includes(tableQuery))
        .map((t) => ({
            insert: `@db:${refValue(`${conn.name}/${t}`)} `,
            label: t,
            hint: r.dbTable,
            icon: 'table_chart',
        }))
        .slice(0, 12)
}

function filePathSuggestions(paths: string[], query: string, prefix: string): Suggestion[] {
    if (paths.length === 0) return []
    const q = query.toLowerCase()

    // Las carpetas se derivan de las rutas porque referenciar un directorio
    // entero es una forma normal de darle contexto a un agente.
    const dirs = new Set<string>()
    for (const p of paths) {
        const parts = p.split('/')
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/')
    }

    const all = [...dirs, ...paths]
    const matched = q ? all.filter((p) => p.toLowerCase().includes(q)) : all
    return matched
        .sort((a, b) => a.length - b.length)
        .slice(0, 10)
        .map((p) => ({
            insert: `${prefix}${p} `,
            label: p.split('/').filter(Boolean).pop() ?? p,
            hint: p,
            icon: p.endsWith('/') ? 'folder' : 'description',
        }))
}
