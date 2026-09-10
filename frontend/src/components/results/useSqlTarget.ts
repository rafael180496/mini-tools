import {useEffect, useState} from 'react'
import {ResultEditTarget} from '../../../wailsjs/go/main/App'
import type {SqlTarget} from '../../lib/sqlGenerate'

// De qué tabla salieron estas filas, para las sentencias que genera la app:
// "copiar como INSERT", "copiar como UPDATE" y el exporte a SQL.
//
// **Antes se armaban con el nombre de la CONEXIÓN** —`INSERT INTO "Sgctest"`—,
// que no es una tabla de ninguna base: había que corregir a mano la tabla y el
// esquema de cada sentencia antes de poder correrla, que es justo el trabajo
// que la función existía para ahorrar.
//
// Lo resuelve el mismo backend que ya decide si la grilla se puede editar
// (ResultEditTarget en app_dbedit.go): parsea el SELECT, busca la tabla en el
// catálogo y la devuelve CALIFICADA con su esquema y citada, junto con el tipo
// de cada columna —de donde sale que una fecha se escriba con TO_DATE y no
// como texto.
//
// Se usa aunque el resultado NO sea editable: una tabla sin clave primaria no
// se puede editar desde la grilla, pero insertarle filas es perfectamente
// válido y el nombre de la tabla es igual de real. Lo único que deja sin tabla
// es una consulta que no sale de una sola tabla (un JOIN, una vista, una
// subconsulta), y ahí se cae al marcador `tabla` a propósito: que se vea que
// hay que completarlo es mejor que un nombre plausible que no existe.
//
// **Los tipos, en cambio, no dependen del catálogo.** `resultColumns` /
// `resultKinds` son los que declaró el driver para ESTE result set (ver
// Event.ColumnKinds en backend/query/executor.go) y mandan sobre los del
// catálogo: existen siempre —también para un sinónimo, una tabla al otro lado
// de un DB link o una conexión cuyo catálogo todavía no se leyó— y describen
// lo que la consulta realmente devolvió. Sin ellos, una columna DATE salía
// como el texto ISO de serializar un time.Time (`'2026-06-19T16:44:27Z'`) y
// Oracle contestaba ORA-01861 al correr el INSERT generado.
export function useSqlTarget(
    connId: string | undefined,
    sqlText: string | undefined,
    engine: string | undefined,
    resultColumns?: string[],
    resultKinds?: string[],
): SqlTarget {
    const [resolved, setResolved] = useState<{table: string; kinds: Record<string, string>} | null>(null)

    useEffect(() => {
        setResolved(null)
        if (!connId || !sqlText?.trim()) return

        let cancelled = false
        ResultEditTarget(connId, sqlText)
            .then((t) => {
                if (cancelled || !t?.table) return
                const kinds: Record<string, string> = {}
                for (const c of t.columns ?? []) kinds[c.name.toLowerCase()] = c.kind
                setResolved({table: t.table, kinds})
            })
            // Un fallo acá no rompe nada: se sigue pudiendo copiar, con el
            // marcador en lugar de la tabla.
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [connId, sqlText])

    // El catálogo primero (cubre las columnas que la consulta no proyectó) y
    // encima el result set, que es el que describe lo que se está mirando.
    const kinds: Record<string, string> = {...(resolved?.kinds ?? {})}
    resultColumns?.forEach((c, i) => {
        const kind = resultKinds?.[i]
        if (kind) kinds[c.toLowerCase()] = kind
    })

    return resolved
        ? {table: resolved.table, qualified: true, engine, kinds}
        : {table: 'tabla', engine, kinds}
}
