import {useCallback, useEffect, useState} from 'react'
import {HttpDocsPreview, HttpPublishDocs, HttpSaveCollection} from '../../../wailsjs/go/main/App'
import {main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Documentación de una colección: la descripción general a la izquierda, y a la
// derecha lo que se va a publicar como nota del vault.
//
// **Publicar y no exportar.** La nota vive en la base de conocimiento: se busca
// desde el buscador de notas, se enlaza desde un runbook con `[[…]]` y el agente
// la puede leer. Un panel de documentación encerrado dentro del cliente HTTP no
// tendría nada de eso.
//
// **Regenerar no pisa lo que editó una persona.** Es el mismo trato que tiene el
// agente por MCP: si alguien mejoró la nota a mano, la regeneración se detiene y
// lo dice, en vez de borrar el trabajo ajeno y avisar después.

interface HttpDocsDialogProps {
    collection: vault.HTTPCollection
    onClose: () => void
    onChanged: () => void
    onOpenNote?: (noteId: string) => void
}

export default function HttpDocsDialog({collection, onClose, onChanged, onOpenNote}: HttpDocsDialogProps) {
    const [description, setDescription] = useState(collection.description ?? '')
    // Lo último que se guardó, para saber si hay algo pendiente sin depender de
    // la prop, que no vuelve a llegar mientras el diálogo está abierto.
    const [savedDescription, setSavedDescription] = useState(collection.description ?? '')
    const [markdown, setMarkdown] = useState('')
    const [loading, setLoading] = useState(true)
    const [publishing, setPublishing] = useState(false)
    const [result, setResult] = useState<main.HttpDocsResult | null>(null)
    const [error, setError] = useState<string | null>(null)

    const preview = useCallback(async () => {
        try {
            setMarkdown((await HttpDocsPreview(collection.id)) ?? '')
        } catch (e) {
            setError(String(e))
        } finally {
            setLoading(false)
        }
    }, [collection.id])

    useEffect(() => {
        void preview()
    }, [preview])

    // La descripción se guarda al salir del campo, y ahí se regenera la vista
    // previa. Sin esto, el panel de la derecha mostraría el documento sin el
    // párrafo que el usuario acaba de escribir, que es exactamente el momento
    // en que uno mira la vista previa.
    const saveDescription = useCallback(async () => {
        if (description === savedDescription) return
        try {
            await HttpSaveCollection(new vault.HTTPCollection({...collection, description}))
            setSavedDescription(description)
            onChanged()
            await preview()
        } catch (e) {
            setError(String(e))
        }
    }, [collection, description, savedDescription, onChanged, preview])

    const publish = useCallback(async () => {
        setPublishing(true)
        setError(null)
        try {
            // Guardar antes de publicar: publicar lo que hay en la base y no lo
            // que el usuario tiene en pantalla sería publicar otra cosa.
            if (description !== savedDescription) {
                await HttpSaveCollection(new vault.HTTPCollection({...collection, description}))
                setSavedDescription(description)
                onChanged()
            }
            const res = await HttpPublishDocs(collection.id)
            if (res) {
                setResult(res)
                setMarkdown(res.markdown)
            }
            onChanged()
        } catch (e) {
            setError(String(e))
        } finally {
            setPublishing(false)
        }
    }, [collection, description, savedDescription, onChanged])

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
            <div
                className="flex h-[34rem] w-[56rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="menu_book" size={16} className="text-on-surface-variant" />
                    <p className="flex-1 text-sm font-medium text-on-surface">Documentación de «{collection.name}»</p>
                    <button
                        onClick={() => void publish()}
                        disabled={publishing || loading}
                        title="Escribir esta documentación como una nota del vault, para poder buscarla, enlazarla desde otras notas y consultarla desde el agente."
                        className="rounded bg-primary px-3 py-1 text-[11px] text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {publishing ? 'Publicando…' : collection.docsNoteId || result?.noteId ? 'Regenerar la nota' : 'Publicar como nota'}
                    </button>
                    <button onClick={onClose} title="Cerrar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && (
                    <p className="shrink-0 bg-error-container px-3 py-1 text-[11px] text-on-error-container" title={error}>
                        {error}
                    </p>
                )}

                {result && (
                    <div
                        className={`flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11px] ${
                            result.status === 'skipped' ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-secondary-container text-on-secondary-container'
                        }`}
                    >
                        <Icon name={result.status === 'skipped' ? 'edit_note' : 'check_circle'} size={14} />
                        <span className="flex-1 leading-relaxed">
                            {result.status === 'skipped' ? (
                                <>
                                    «{result.title}» la editó una persona, así que no se toca. Lo que se habría escrito está a la derecha: copiá lo que
                                    quieras de ahí, o borrá la nota para volver a generarla desde cero.
                                </>
                            ) : (
                                <>
                                    {result.status === 'created' ? 'Nota creada' : 'Nota actualizada'}: «{result.title}», con {result.requests}{' '}
                                    {result.requests === 1 ? 'petición' : 'peticiones'}.
                                </>
                            )}
                        </span>
                        {result.noteId && onOpenNote && (
                            <button
                                onClick={() => {
                                    onOpenNote(result.noteId)
                                    onClose()
                                }}
                                title="Abrir la nota en el módulo de notas"
                                className="rounded border border-current px-2 py-0.5 hover:opacity-80"
                            >
                                Ver la nota
                            </button>
                        )}
                    </div>
                )}

                <div className="flex min-h-0 flex-1">
                    <div className="flex w-72 shrink-0 flex-col border-r border-outline-variant">
                        <p className="shrink-0 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">
                            Descripción de la colección
                        </p>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onBlur={() => void saveDescription()}
                            placeholder={'Qué es esta API, contra qué entorno se usa, a quién preguntarle.\n\nEs Markdown, y acepta [[enlaces]] a otras notas.'}
                            spellCheck={false}
                            className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[11px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant/40"
                        />
                        <p className="shrink-0 border-t border-outline-variant p-3 text-[10px] leading-relaxed text-on-surface-variant/70">
                            La documentación de cada petición se escribe en su pestaña <span className="font-medium">Docs</span>. Ninguna credencial sale
                            acá: de la autenticación se documenta su forma —el tipo, el usuario, la URL del token—, nunca su valor.
                        </p>
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col">
                        <p className="shrink-0 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/60">
                            Lo que se publica
                        </p>
                        <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-on-surface">
                            {loading ? 'Generando…' : markdown}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    )
}
