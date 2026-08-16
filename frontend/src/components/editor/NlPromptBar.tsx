import {useEffect, useMemo, useRef, useState} from 'react'
import {AgentFixSQL, AgentGenerateSQL} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MarkdownPreview from '../MarkdownPreview'
import {countChanges, diffLines} from './lineDiff'

// Asistente de consultas del editor: se abre con Cmd/Ctrl+I, se le pide algo en
// castellano y devuelve una consulta EN EL DIALECTO del motor de la conexión
// vinculada a la pestaña.
//
// **Tres cosas que no hace, y son las que la vuelven usable sobre una base de
// verdad:**
//
//  1. **No ejecuta nada.** Devuelve texto. Correr la consulta sigue siendo el
//     mismo botón de siempre, con el Production Guard donde corresponde.
//  2. **No pisa el editor.** Muestra la propuesta como un diff contra lo que ya
//     había y espera que la aceptes. Un reemplazo directo obliga a releer la
//     consulta entera para saber qué cambió — y es donde se cuela lo que el
//     agente cambió sin que nadie se lo pidiera.
//  3. **No manda tus datos.** Lo que viaja es el DDL de las tablas que el
//     pedido menciona: columnas, tipos, claves. Ninguna fila. La barra dice
//     cuáles fueron, porque "¿qué le mandaste de mi base?" tiene que poder
//     contestarse.

type Mode = 'generate' | 'fix'

interface Props {
    connId: string
    connName: string
    // Motor de la conexión, solo para nombrar bien lo que se pide: en Mongo y
    // en Redis "consulta" no es la palabra. El dialecto real lo decide el
    // backend con este mismo dato, no la interfaz.
    dbType: string
    // SQL actual de la pestaña: es el que se modifica cuando el pedido dice
    // "agregale…", y contra el que se compara la propuesta.
    currentSql: string
    // Cuando se abre para corregir un error, el texto que devolvió el motor.
    // Su presencia es lo que cambia el modo de la barra.
    errorText?: string
    onApply: (code: string) => void
    onClose: () => void
}

export default function NlPromptBar({connId, connName, dbType, currentSql, errorText, onApply, onClose}: Props) {
    const mode: Mode = errorText ? 'fix' : 'generate'
    const noun = dbType === 'redis' ? 'comandos' : dbType === 'mongodb' ? 'una consulta Mongo' : 'una consulta'
    const [request, setRequest] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [result, setResult] = useState<main.SQLSuggestion | null>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    // En modo corrección no hay nada que escribir: el pedido es el error, así
    // que se dispara solo al abrir. Esperar a que el usuario apriete un botón
    // más sería pedirle que confirme lo que ya pidió.
    useEffect(() => {
        if (mode !== 'fix' || !errorText) return
        let cancelled = false
        setBusy(true)
        setError('')
        AgentFixSQL(connId, currentSql, errorText)
            .then((r) => !cancelled && setResult(r))
            .catch((e) => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setBusy(false))
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, errorText, connId])

    const submit = () => {
        const q = request.trim()
        if (!q || busy) return
        setBusy(true)
        setError('')
        setResult(null)
        AgentGenerateSQL(connId, q, currentSql)
            .then(setResult)
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
    }

    const diff = useMemo(() => (result?.code ? diffLines(currentSql, result.code) : []), [result?.code, currentSql])
    const changes = useMemo(() => countChanges(diff), [diff])

    return (
        <div
            className="absolute left-1/2 top-3 z-20 w-[min(46rem,92%)] -translate-x-1/2 rounded-xl border border-outline-variant bg-surface-container-high shadow-lg"
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    onClose()
                }
            }}
        >
            <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-[11px]">
                <Icon name={mode === 'fix' ? 'healing' : 'auto_awesome'} size={14} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">
                    {mode === 'fix' ? 'Explicar y corregir' : `Escribir ${noun}`}
                </span>
                <span
                    className="truncate text-on-surface-variant"
                    title="El agente escribe en el dialecto de ESTE motor: la misma consulta se escribe distinto en Oracle, Postgres o SQL Server, y una escrita para el motor equivocado falla al correrla."
                >
                    · {connName}
                </span>
                <button
                    onClick={onClose}
                    title="Cierra el asistente sin aplicar nada (Esc)"
                    className="ml-auto shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={14} />
                </button>
            </div>

            {mode === 'generate' && (
                <div className="flex items-end gap-2 p-2">
                    <textarea
                        ref={inputRef}
                        value={request}
                        onChange={(e) => setRequest(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                submit()
                            }
                        }}
                        rows={2}
                        placeholder={
                            currentSql.trim()
                                ? 'Qué cambiarle a lo que hay en el editor… (Enter manda)'
                                : `Qué necesitás… (Enter manda, Shift+Enter salta de línea)`
                        }
                        className="min-w-0 flex-1 resize-none rounded border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface outline-none focus:border-primary"
                    />
                    <button
                        onClick={submit}
                        disabled={!request.trim() || busy}
                        title="Le pide la consulta al agente activo. No la ejecuta: la propone para que la revises."
                        className="shrink-0 rounded bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
                    >
                        {busy ? '…' : 'Pedir'}
                    </button>
                </div>
            )}

            {busy && (
                <p className="flex items-center gap-2 px-3 pb-2 text-[11px] text-on-surface-variant">
                    <span aria-hidden className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                    {mode === 'fix' ? 'Leyendo el error y el esquema…' : 'Escribiendo la consulta…'}
                </p>
            )}

            {error && (
                <p className="mx-2 mb-2 rounded bg-error-container/40 px-2 py-1 text-[11px] text-error">{error}</p>
            )}

            {result && (
                <div className="flex max-h-[26rem] flex-col overflow-y-auto border-t border-outline-variant">
                    {/* La explicación primero: sin ella hay que leer la
                        consulta entera para entender qué hizo. */}
                    <div className="px-3 py-2 text-xs text-on-surface">
                        <MarkdownPreview source={stripCode(result.answer)} />
                    </div>

                    {result.code && (
                        <div className="mx-2 mb-2 overflow-hidden rounded border border-outline-variant">
                            <div className="flex items-center gap-2 bg-surface-container px-2 py-1 text-[10px] text-on-surface-variant">
                                <Icon name="difference" size={11} className="shrink-0" />
                                {currentSql.trim() ? (
                                    <span>
                                        Propuesta ·{' '}
                                        <span className="text-primary">+{changes.added}</span>{' '}
                                        <span className="text-error">−{changes.removed}</span> líneas
                                    </span>
                                ) : (
                                    <span>Propuesta</span>
                                )}
                                <span
                                    className="ml-auto truncate"
                                    title={
                                        result.tables.length > 0
                                            ? `Se le pasó el DDL de estas tablas — columnas, tipos y claves, ninguna fila:\n${result.tables.join('\n')}${
                                                  result.totalTables > result.tables.length
                                                      ? `\n\n(de ${result.totalTables} tablas en la conexión)`
                                                      : ''
                                              }`
                                            : 'No se le pasó el DDL de ninguna tabla: el pedido no mencionaba ninguna que exista en esta conexión.'
                                    }
                                >
                                    contexto: {result.tables.length} tabla{result.tables.length === 1 ? '' : 's'}
                                </span>
                            </div>
                            <pre className="max-h-56 overflow-auto bg-surface p-2 font-mono text-[11px] leading-5">
                                {diff.map((l, i) => (
                                    <div
                                        key={i}
                                        className={
                                            l.kind === 'added'
                                                ? 'bg-primary/15 text-on-surface'
                                                : l.kind === 'removed'
                                                  ? 'bg-error-container/30 text-on-surface-variant line-through'
                                                  : 'text-on-surface-variant'
                                        }
                                    >
                                        <span className="mr-2 select-none opacity-50">
                                            {l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '}
                                        </span>
                                        {l.text || ' '}
                                    </div>
                                ))}
                            </pre>
                        </div>
                    )}

                    <div className="flex items-center gap-2 border-t border-outline-variant px-2 py-1.5">
                        <span
                            className="min-w-0 flex-1 truncate text-[10px] text-on-surface-variant"
                            title="Aplicar solo reemplaza el texto del editor. Ejecutar la consulta sigue siendo el botón de siempre, con la confirmación de producción donde corresponda."
                        >
                            Aplicar reemplaza el editor. <strong>No ejecuta nada.</strong>
                        </span>
                        <button
                            onClick={onClose}
                            title="Descarta la propuesta y deja el editor como estaba"
                            className="shrink-0 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            Descartar
                        </button>
                        <button
                            onClick={() => {
                                void navigator.clipboard.writeText(result.code)
                            }}
                            disabled={!result.code}
                            title="Copia la consulta propuesta sin tocar el editor"
                            className="shrink-0 rounded border border-outline-variant px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                        >
                            Copiar
                        </button>
                        <button
                            onClick={() => {
                                onApply(result.code)
                                onClose()
                            }}
                            disabled={!result.code}
                            title="Reemplaza el contenido del editor con la consulta propuesta. Podés deshacer con Cmd/Ctrl+Z."
                            className="shrink-0 rounded bg-primary px-3 py-1 text-xs text-on-primary disabled:opacity-40"
                        >
                            Aplicar
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

// stripCode saca el bloque de código de la respuesta para que la explicación no
// muestre dos veces la misma consulta: el bloque ya se dibuja abajo, con su
// diff y sus botones.
function stripCode(answer: string): string {
    const start = answer.indexOf('```')
    if (start < 0) return answer
    const end = answer.indexOf('```', start + 3)
    if (end < 0) return answer.slice(0, start).trim()
    return (answer.slice(0, start) + answer.slice(end + 3)).trim()
}
