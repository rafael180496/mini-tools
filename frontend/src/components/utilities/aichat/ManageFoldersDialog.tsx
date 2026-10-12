import {useEffect, useState} from 'react'
import {ListAllAgentChats, RemoveAgentWorkspace} from '../../../../wailsjs/go/main/App'
import type {main} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import ConfirmDialog from '../../ConfirmDialog'
import {errorText, useT} from '../../../i18n'

// Carpetas a las que el usuario le dio acceso a la app para que los agentes
// trabajen en ellas (las que se abren con «Abrir carpeta…»). Los repositorios
// git NO están acá: vienen del módulo Git y se administran allá.
//
// Quitar una carpeta REVOCA el acceso de la app y no toca el disco, pero el
// backend también borra de la base de la app las conversaciones de esa carpeta
// (contexto `ws:<id>`), igual que al quitar un repositorio. Se dice en el propio
// diálogo y otra vez en la confirmación, con la cantidad exacta: «Quitar» sobre
// una carpeta se lee, con razón, como «borrar», y la mitad de la verdad es peor
// que ninguna.

interface Props {
    workspaces: main.AgentWorkspace[]
    // Abre el diálogo nativo para sumar otra carpeta.
    onOpenFolder: () => void
    // Se quitó una: el anfitrión relee la lista.
    onRemoved: (workspace: main.AgentWorkspace) => void
    onClose: () => void
}

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

export default function ManageFoldersDialog({workspaces, onOpenFolder, onRemoved, onClose}: Props) {
    const t = useT()
    const tf = t.utilities.aiChat.folders
    // La carpeta a confirmar y cuántas conversaciones se van con ella.
    const [removing, setRemoving] = useState<{workspace: main.AgentWorkspace; chats: number} | null>(null)
    const [error, setError] = useState('')

    // Esc cierra, salvo que la confirmación esté abierta: ahí Esc no está
    // atendido y cerrar el diálogo de abajo sería perder el contexto.
    useEffect(() => {
        if (removing) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [removing, onClose])

    // El conteo se lee ANTES de abrir la confirmación: el texto tiene que decir
    // cuántas conversaciones se pierden, no suponerlo. Si no se pudo leer, no se
    // abre la confirmación con una cifra inventada.
    function askRemove(w: main.AgentWorkspace) {
        setError('')
        ListAllAgentChats()
            .then((chats) => setRemoving({workspace: w, chats: (chats ?? []).filter((c) => c.contextId === `ws:${w.id}`).length}))
            .catch((e) => setError(errorText(e)))
    }

    function remove(w: main.AgentWorkspace) {
        setError('')
        RemoveAgentWorkspace(w.id)
            .then(() => onRemoved(w))
            .catch((e) => setError(errorText(e)))
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" role="presentation">
            <div
                role="dialog"
                aria-modal="true"
                aria-label={tf.title}
                data-manage-folders
                className="flex max-h-[80vh] w-[min(34rem,calc(100vw-2rem))] flex-col rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
            >
                <div className="flex shrink-0 items-center gap-2 px-5 pt-5">
                    <Icon name="folder_managed" size={18} className="text-primary" />
                    <h2 className="min-w-0 flex-1 text-lg font-semibold">{tf.title}</h2>
                </div>
                <p className="shrink-0 px-5 pt-2 text-xs text-on-surface-variant">{tf.intro}</p>
                <p className="mx-5 mt-2 flex shrink-0 items-start gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-ui-11 text-on-surface-variant">
                    <Icon name="info" size={13} className="mt-px shrink-0 text-primary" />
                    {tf.removeNote}
                </p>

                <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-5">
                    {workspaces.length === 0 ? (
                        <p className="rounded-lg border border-dashed border-outline-variant px-3 py-4 text-center text-xs text-on-surface-variant">
                            {tf.empty}
                        </p>
                    ) : (
                        <ul className="space-y-1.5">
                            {workspaces.map((w) => (
                                <li
                                    key={w.id}
                                    data-folder-row
                                    className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container px-2.5 py-1.5"
                                >
                                    <Icon name={w.exists ? 'folder' : 'folder_off'} size={16} className={`shrink-0 ${w.exists ? 'text-primary' : 'text-on-surface-variant'}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className={`block truncate text-sm ${w.exists ? '' : 'text-on-surface-variant'}`}>{w.name}</span>
                                        <span className="block truncate font-mono text-ui-11 text-on-surface-variant" title={w.path}>
                                            {w.path}
                                        </span>
                                    </span>
                                    {!w.exists && (
                                        <span
                                            className="shrink-0 rounded bg-error-container/40 px-1.5 text-ui-10 text-error"
                                            title={tf.missingTitle({path: w.path})}
                                        >
                                            {tf.missing}
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        data-folder-remove
                                        onClick={() => askRemove(w)}
                                        title={tf.removeTitle({name: w.name})}
                                        aria-label={tf.removeAria({name: w.name})}
                                        className={`shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-error ${FOCUS}`}
                                    >
                                        <Icon name="link_off" size={16} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {error && (
                        <p role="alert" className="mt-2 rounded-lg border border-error/40 bg-error-container/30 px-2 py-1.5 text-xs text-error">
                            {error}
                        </p>
                    )}
                </div>

                <div className="flex shrink-0 items-center justify-between gap-2 px-5 pt-4 pb-5">
                    <button
                        type="button"
                        onClick={onOpenFolder}
                        title={tf.addTitle}
                        className={`flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 text-sm text-primary hover:bg-primary/10 ${FOCUS}`}
                    >
                        <Icon name="create_new_folder" size={15} />
                        {t.utilities.aiChat.project.openFolder}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        title={tf.closeTitle}
                        className={`rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 ${FOCUS}`}
                    >
                        {tf.close}
                    </button>
                </div>
            </div>

            {removing && (
                <ConfirmDialog
                    title={tf.confirmTitle}
                    description={tf.confirmDescription({name: removing.workspace.name, path: removing.workspace.path, chats: removing.chats})}
                    confirmLabel={tf.confirm}
                    onConfirm={() => remove(removing.workspace)}
                    onClose={() => setRemoving(null)}
                />
            )}
        </div>
    )
}
