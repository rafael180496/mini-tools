import {useEffect, useMemo, useState} from 'react'
import {AgentRefPolicies, GetSchemaMetadata, ListConnections, NoteTitles} from '../../../wailsjs/go/main/App'
import {agentctx, main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import type {WorkContext} from './workContext'

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
        () => buildSuggestions(query, {paths, connections, policies, tables, notes, context}),
        [query, paths, connections, policies, tables, notes, context],
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
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-container-high disabled:opacity-50 disabled:hover:bg-transparent"
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
    return [query.slice(0, i), query.slice(i + 1)]
}

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
): Suggestion[] {
    const {paths, connections, policies, tables, notes, context} = opts
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
                    ? `${p.injects}${p.never ? ` Nunca: ${p.never}` : ''}`
                    : `Todavía no disponible en esta versión. ${p.injects}`,
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
                    insert: '@git:staged ',
                    label: '@git:staged',
                    hint: 'El diff de lo que está preparado para commitear',
                    icon: 'account_tree',
                },
                {
                    insert: '@git:worktree ',
                    label: '@git:worktree',
                    hint: 'El diff de lo modificado y todavía sin preparar',
                    icon: 'account_tree',
                },
            ].filter((s) => s.label.includes(rest))
        case 'explain':
            return [
                {
                    insert: '@explain:last ',
                    label: '@explain:last',
                    hint: 'El último plan de ejecución de la conexión activa',
                    icon: 'query_stats',
                },
                ...connections
                    .filter((c) => c.dbType !== 'ssh' && c.name.toLowerCase().includes(rest.toLowerCase()))
                    .map((c) => ({
                        insert: `@explain:${c.name} `,
                        label: `@explain:${c.name}`,
                        hint: 'El último plan guardado de esa conexión',
                        icon: 'query_stats',
                    })),
            ].slice(0, 12)
        case 'db':
            return dbSuggestions(rest, connections, tables)
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
                        ? 'Marcada como privada: el agente no puede leerla. Abrí el candado en la nota para permitirlo.'
                        : 'Se le manda el Markdown completo de la nota',
                    icon: n.isPrivate ? 'lock' : 'sticky_note_2',
                    disabled: n.isPrivate,
                }))
        case 'ssh':
            return connections
                .filter((c) => c.dbType === 'ssh' && c.name.toLowerCase().includes(rest.toLowerCase()))
                .slice(0, 12)
                .map((c) => ({
                    insert: `@ssh:${c.name}/last_error `,
                    label: c.name,
                    hint: 'Las últimas 50 líneas de esa terminal, con los secretos ocultados',
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
): Suggestion[] {
    const slash = rest.indexOf('/')
    if (slash < 0) {
        return connections
            .filter((c) => c.dbType !== 'ssh' && c.name.toLowerCase().includes(rest.toLowerCase()))
            .map((c) => ({
                insert: `@db:${c.name}/`,
                label: c.name,
                hint: `${c.dbType} — elegí una tabla`,
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
                hint: 'No hay ninguna conexión guardada con ese nombre',
                icon: 'database',
                disabled: true,
            },
        ]
    }
    if (list === undefined) {
        return [{insert: '', label: 'Leyendo el esquema…', hint: conn.name, icon: 'database', disabled: true}]
    }
    return list
        .filter((t) => t.toLowerCase().includes(tableQuery))
        .map((t) => ({
            insert: `@db:${conn.name}/${t} `,
            label: t,
            hint: 'Columnas, tipos, PK y FK — nunca filas',
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
