import type {KeyboardEvent} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {formatBytes} from '../../lib/formatBytes'
import type {AttachCaps, SentAttachment} from '../../lib/chatAttachments'
import type {AttachView} from './useChatAttachments'

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

function kindIcon(kind: string): string {
    return kind === 'pdf' ? 'picture_as_pdf' : kind === 'image' ? 'image' : 'description'
}

function Thumb({kind, url, px, busy}: {kind: string; url?: string; px: number; busy?: boolean}) {
    return (
        <span
            className="relative flex shrink-0 items-center justify-center overflow-hidden rounded bg-surface-container-highest text-primary"
            style={{width: `calc(${px}px * var(--ui-font-scale))`, height: `calc(${px}px * var(--ui-font-scale))`}}
        >
            {url ? (
                // La miniatura es decoración: el nombre del archivo ya está al lado.
                <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />
            ) : (
                <Icon name={kindIcon(kind)} size={Math.round(px * 0.6)} />
            )}
            {busy && (
                <span className="absolute inset-0 flex items-center justify-center bg-surface/70" aria-hidden>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
                </span>
            )}
        </span>
    )
}

// Fichas de lo que viaja con el próximo mensaje, sobre la caja de texto.
//
// Cada ficha dice en qué está: subiéndose, lista, con aviso del modelo
// (ámbar: puede que no lo lea; rojo: no lo va a leer y no deja enviar) o con
// error (no se pudo adjuntar). Los motivos de un error se escriben debajo, no
// solo en el tooltip: un tooltip no se ve con el teclado.
export function ComposerAttachments({
    items,
    caps,
    onRemove,
}: {
    items: AttachView[]
    caps: AttachCaps | null
    onRemove: (id: string) => void
}) {
    const t = useT()
    const a = t.agent.chat.attach
    if (items.length === 0) return null

    const hintFor = (it: AttachView): string => {
        if (it.compat === 'ok') return ''
        const note = caps?.note ? `${caps.note}\n` : ''
        if (it.compat === 'maybe') return note + a.hint.maybe
        return note + (it.kind === 'pdf' ? a.hint.pdfBlocked : a.hint.imageBlocked)
    }
    const problems = items.filter((i) => i.status === 'error' && i.error)

    return (
        <div className="px-2 pt-2">
            <ul role="list" aria-label={a.listLabel} className="flex flex-wrap gap-1">
                {items.map((it) => {
                    const failed = it.status === 'error'
                    const blocked = !failed && it.status === 'ready' && it.compat === 'blocked'
                    const maybe = !failed && it.status === 'ready' && it.compat === 'maybe'
                    const kindLabel = a.kinds[it.kind]
                    const short = failed
                        ? a.short.failed
                        : it.status === 'uploading'
                          ? a.uploading
                          : blocked
                            ? it.kind === 'pdf'
                              ? a.short.noPdf
                              : a.short.noVision
                            : maybe
                              ? a.short.maybe
                              : formatBytes(it.size)
                    const hint = failed ? it.error ?? '' : hintFor(it)
                    const title = [a.chipTitle({name: it.name, kind: kindLabel, size: formatBytes(it.size)}), hint].filter(Boolean).join('\n')
                    const tone = failed || blocked
                        ? 'border-error/50 bg-error-container/30 text-error'
                        : maybe
                          ? 'border-tertiary/50 bg-tertiary/10 text-tertiary'
                          : 'border-outline-variant bg-surface-container text-on-surface-variant'
                    const onKey = (e: KeyboardEvent) => {
                        if ((e.key === 'Delete' || e.key === 'Backspace') && e.target === e.currentTarget) {
                            e.preventDefault()
                            onRemove(it.id)
                        }
                    }
                    return (
                        <li
                            key={it.id}
                            tabIndex={0}
                            title={title}
                            aria-label={`${it.name}, ${kindLabel}, ${short}${hint ? `. ${hint.replace(/\n/g, ' ')}` : ''}`}
                            data-attach-chip={failed ? 'error' : blocked ? 'blocked' : maybe ? 'maybe' : it.status}
                            onKeyDown={onKey}
                            className={`flex max-w-full items-center gap-1.5 rounded-md border py-0.5 pl-0.5 pr-1 text-ui-10 sm:max-w-[15rem] ${tone} ${FOCUS}`}
                        >
                            <Thumb kind={it.kind} url={failed ? undefined : it.previewUrl} px={28} busy={it.status === 'uploading'} />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-on-surface">{it.name}</span>
                                <span className="flex items-center gap-0.5 truncate tabular-nums">
                                    {(failed || blocked) && <Icon name={failed ? 'error' : 'block'} size={10} className="shrink-0" />}
                                    {maybe && <Icon name="warning" size={10} className="shrink-0" />}
                                    <span className="truncate">{short}</span>
                                </span>
                            </span>
                            <button
                                type="button"
                                onClick={() => onRemove(it.id)}
                                title={a.removeTitle({name: it.name})}
                                aria-label={a.removeTitle({name: it.name})}
                                className={`shrink-0 rounded p-0.5 hover:text-error ${FOCUS}`}
                            >
                                <Icon name="close" size={12} />
                            </button>
                        </li>
                    )
                })}
            </ul>
            {problems.length > 0 && (
                <ul role="alert" className="mt-1 space-y-0.5 text-ui-10 text-error">
                    {problems.map((p) => (
                        <li key={p.id} className="flex items-start gap-1">
                            <Icon name="error" size={11} className="mt-px shrink-0" />
                            <span className="min-w-0 break-words">{p.error}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

// Adjuntos de un mensaje ya enviado. Con la miniatura cuando el archivo se
// mandó en esta sesión; si se retomó el chat, solo el ícono: el historial
// guarda nombre, tipo y tamaño, nunca el contenido.
export function MessageAttachments({attachments}: {attachments: SentAttachment[]}) {
    const t = useT()
    const a = t.agent.chat.attach
    if (attachments.length === 0) return null
    return (
        <ul role="list" aria-label={a.sent.listLabel} className="mb-1 flex max-w-[85%] flex-wrap justify-end gap-1">
            {attachments.map((att, i) => {
                const kind = att.kind === 'image' || att.kind === 'pdf' ? att.kind : 'text'
                const note = a.sent[kind]
                const title = [a.chipTitle({name: att.name, kind: a.kinds[kind], size: formatBytes(att.size)}), note].join('\n')
                return (
                    <li
                        key={`${att.name}-${i}`}
                        tabIndex={0}
                        title={title}
                        aria-label={`${att.name}, ${a.kinds[kind]}, ${formatBytes(att.size)}. ${note}`}
                        data-sent-attachment={kind}
                        className={`flex max-w-full items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 py-0.5 pl-0.5 pr-2 text-ui-10 text-on-surface-variant ${FOCUS}`}
                    >
                        <Thumb kind={kind} url={att.previewUrl} px={att.previewUrl ? 40 : 28} />
                        <span className="min-w-0">
                            <span className="block max-w-[11rem] truncate font-medium text-on-surface">{att.name}</span>
                            <span className="block truncate tabular-nums">
                                {a.kinds[kind]} · {formatBytes(att.size)}
                            </span>
                        </span>
                    </li>
                )
            })}
        </ul>
    )
}

// Velo que tapa el chat mientras se arrastra un archivo por encima. No captura
// el puntero: los eventos de arrastre tienen que seguir llegando al panel de
// abajo, que es quien cuenta entradas y salidas.
export function DropOverlay({limits}: {limits: string}) {
    const t = useT()
    return (
        <div
            aria-hidden
            data-attach-drop
            className="pointer-events-none absolute inset-1 z-30 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary bg-surface/85 px-4 text-center backdrop-blur-[2px]"
        >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Icon name="upload_file" size={26} />
            </span>
            <p className="text-sm font-semibold text-on-surface">{t.agent.chat.attach.dropTitle}</p>
            <p className="text-ui-11 text-on-surface-variant">{t.agent.chat.attach.dropHint}</p>
            <p className="max-w-xs text-ui-10 text-on-surface-variant/80">{limits}</p>
        </div>
    )
}
