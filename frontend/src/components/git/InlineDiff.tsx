import {useMemo} from 'react'
import {parsePatch} from '../../lib/gitPatch'
import Icon from '../Icon'

// El diff de un archivo, desplegado DENTRO de la lista de cambios.
//
// Por qué existe teniendo ya el panel de diff a la derecha: son dos preguntas
// distintas. El panel derecho es para trabajar sobre UN archivo —stagear por
// bloques, por líneas, editar—; esto es para revisar el commit entero de arriba
// hacia abajo sin ir y volver de la lista, que es exactamente lo que se hace
// antes de apretar Commit. Los clientes de Git de escritorio (Fork, Sublime
// Merge) resuelven ese repaso así, con la lista desplegable.
//
// Es de solo lectura a propósito: acá no hay stage por bloque ni edición. Todo
// lo que modifica el índice sigue estando en un solo lugar —el panel de la
// derecha— en vez de existir dos veces con dos comportamientos parecidos.

// MAX_LINES es cuántas líneas se dibujan antes de cortar.
//
// No es una limitación técnica sino de para qué sirve esta vista: un archivo
// generado de diez mil líneas no se repasa acá, se abre en el panel de diff. El
// corte se avisa y ofrece justamente eso, en vez de trabar la lista entera
// dibujando lo que nadie va a leer.
const MAX_LINES = 400

export interface InlineDiffState {
    loading: boolean
    patch: string
    isBinary: boolean
    error: string | null
}

interface Props {
    state: InlineDiffState
    // Abre el archivo en el panel de diff, que es donde se puede stagear por
    // bloques y editar. Es la salida cuando el diff se cortó por tamaño.
    onOpenFull: () => void
}

type Row = {kind: 'hunk' | 'add' | 'del' | 'context'; oldNo: number | null; newNo: number | null; text: string; section?: string}

export default function InlineDiff({state, onOpenFull}: Props) {
    // Se reusa el mismo parser que usa el stage por líneas del panel derecho:
    // dos lectores del mismo parche terminan, tarde o temprano, discrepando en
    // qué línea es cuál.
    const rows = useMemo<Row[]>(() => {
        if (!state.patch) return []
        const out: Row[] = []
        for (const hunk of parsePatch(state.patch).hunks) {
            // El `@@` trae dos cosas distintas: los rangos, que sirven para
            // ubicarse, y —cuando git la encuentra— la firma de la función o
            // sección donde cae el bloque, que es lo que de verdad dice DÓNDE
            // está uno parado. Se separan para poder mostrarlas distinto.
            const m = /^(@@ [^@]*@@)\s?(.*)$/.exec(hunk.header)
            out.push({kind: 'hunk', oldNo: null, newNo: null, text: m ? m[1] : hunk.header, section: m ? m[2] : ''})
            let oldNo = hunk.oldStart
            let newNo = hunk.newStart
            for (const line of hunk.lines) {
                if (line.kind === '\\') continue
                if (line.kind === '+') out.push({kind: 'add', oldNo: null, newNo: newNo++, text: line.text})
                else if (line.kind === '-') out.push({kind: 'del', oldNo: oldNo++, newNo: null, text: line.text})
                else out.push({kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line.text})
            }
        }
        return out
    }, [state.patch])

    if (state.loading) {
        return (
            <p className="flex items-center gap-1.5 bg-surface-container-lowest px-3 py-1.5 text-ui-11 text-on-surface-variant">
                <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                Leyendo el diff…
            </p>
        )
    }
    if (state.error) {
        return <p className="bg-surface-container-lowest px-3 py-1.5 text-ui-11 text-error">{state.error}</p>
    }
    if (state.isBinary) {
        return (
            <p className="flex items-center gap-1.5 bg-surface-container-lowest px-3 py-1.5 text-ui-11 text-on-surface-variant">
                <Icon name="data_object" size={12} className="shrink-0" />
                Archivo binario: git no produce un diff de texto para esto.
            </p>
        )
    }
    if (rows.length === 0) {
        return (
            <p className="bg-surface-container-lowest px-3 py-1.5 text-ui-11 text-on-surface-variant">
                Sin cambios de contenido — puede ser solo un cambio de permisos o un renombrado.
            </p>
        )
    }

    const shown = rows.slice(0, MAX_LINES)
    const hidden = rows.length - shown.length

    return (
        <div className="max-h-96 overflow-auto border-y border-outline-variant bg-surface-container-lowest">
            <table className="w-full border-collapse font-mono text-[10.5px] leading-[1.45]">
                <tbody>
                    {shown.map((r, i) =>
                        r.kind === 'hunk' ? (
                            <tr key={i} className={rowClass(r.kind)}>
                                <td colSpan={4} className="px-2 py-0.5">
                                    <span className="text-on-surface-variant/60">{r.text}</span>
                                    {r.section && <span className="ml-2 italic text-on-surface-variant">{r.section}</span>}
                                </td>
                            </tr>
                        ) : (
                        <tr key={i} className={rowClass(r.kind)}>
                            {/* Los dos números son los de git, no un contador
                                propio: en un archivo con varios bloques, contar
                                desde arriba daría líneas que no existen. */}
                            <td className="w-9 select-none border-r border-outline-variant/40 px-1 text-right align-top text-on-surface-variant/50">
                                {r.oldNo ?? ''}
                            </td>
                            <td className="w-9 select-none border-r border-outline-variant/40 px-1 text-right align-top text-on-surface-variant/50">
                                {r.newNo ?? ''}
                            </td>
                            <td className="w-3 select-none px-1 text-center align-top text-on-surface-variant/60">
                                {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
                            </td>
                            <td className="whitespace-pre px-1 align-top">{r.text || ' '}</td>
                        </tr>
                        ),
                    )}
                </tbody>
            </table>

            {hidden > 0 && (
                <button
                    onClick={onOpenFull}
                    title="Abre el archivo en el panel de diff, donde se ve completo y se puede stagear por bloques o por líneas"
                    className="flex w-full items-center justify-center gap-1.5 border-t border-outline-variant px-2 py-1 text-ui-11 text-primary hover:bg-primary-container/40"
                >
                    <Icon name="unfold_more" size={12} />
                    {hidden} líneas más — ver el archivo completo
                </button>
            )}
        </div>
    )
}

// rowClass tiñe la línea por lo que git dijo que es. Verde y rojo salen de los
// roles del sistema de diseño (secondary/error), no de colores sueltos, así que
// siguen al tema claro y oscuro.
function rowClass(kind: Row['kind']): string {
    switch (kind) {
        case 'hunk':
            return 'bg-surface-variant/60 text-on-surface-variant'
        case 'add':
            return 'bg-secondary/15 text-on-surface'
        case 'del':
            return 'bg-error/15 text-on-surface'
        default:
            return 'text-on-surface-variant'
    }
}
