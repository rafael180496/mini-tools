import {useCallback, useEffect, useState} from 'react'
import {HttpDocsPreview, HttpPublishDocs, HttpSaveCollection} from '../../../wailsjs/go/main/App'
import {main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {rich} from './httpShared'
import {useT} from '../../i18n'

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
    const t = useT()
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
                    <p className="flex-1 text-sm font-medium text-on-surface">{t.http.docs.title({name: collection.name})}</p>
                    <button
                        onClick={() => void publish()}
                        disabled={publishing || loading}
                        title={t.http.docs.publishTitle}
                        className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {publishing ? t.http.docs.publishing : collection.docsNoteId || result?.noteId ? t.http.docs.regenerate : t.http.docs.publish}
                    </button>
                    <button onClick={onClose} title={t.common.close} className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && (
                    <p className="shrink-0 bg-error-container px-3 py-1 text-ui-11 text-on-error-container" title={error}>
                        {error}
                    </p>
                )}

                {result && (
                    <div
                        className={`flex shrink-0 items-center gap-2 px-3 py-1.5 text-ui-11 ${
                            result.status === 'skipped' ? 'bg-tertiary-container text-on-tertiary-container' : 'bg-secondary-container text-on-secondary-container'
                        }`}
                    >
                        <Icon name={result.status === 'skipped' ? 'edit_note' : 'check_circle'} size={14} />
                        <span className="flex-1 leading-relaxed">
                            {result.status === 'skipped'
                                ? t.http.docs.skipped({title: result.title})
                                : result.status === 'created'
                                  ? t.http.docs.created({title: result.title, requests: result.requests})
                                  : t.http.docs.updated({title: result.title, requests: result.requests})}
                        </span>
                        {result.noteId && onOpenNote && (
                            <button
                                onClick={() => {
                                    onOpenNote(result.noteId)
                                    onClose()
                                }}
                                title={t.http.docs.openNoteTitle}
                                className="rounded border border-current px-2 py-0.5 hover:opacity-80"
                            >
                                {t.http.docs.openNote}
                            </button>
                        )}
                    </div>
                )}

                <div className="flex min-h-0 flex-1">
                    <div className="flex w-72 shrink-0 flex-col border-r border-outline-variant">
                        <p className="shrink-0 px-3 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                            {t.http.docs.description}
                        </p>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onBlur={() => void saveDescription()}
                            placeholder={t.http.docs.descriptionPlaceholder}
                            spellCheck={false}
                            className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-ui-11 leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant/40"
                        />
                        <p className="shrink-0 border-t border-outline-variant p-3 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            {rich(t.http.docs.descriptionNote)}
                        </p>
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col">
                        <p className="shrink-0 px-3 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                            {t.http.docs.published}
                        </p>
                        <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-ui-11 leading-relaxed text-on-surface">
                            {loading ? t.http.docs.generating : markdown}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    )
}
