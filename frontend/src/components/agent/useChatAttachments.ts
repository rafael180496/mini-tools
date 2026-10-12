import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {DragEvent} from 'react'
import {AgentAttachmentCapabilities, SaveChatFile} from '../../../wailsjs/go/main/App'
import {errorText, useT} from '../../i18n'
import {formatBytes} from '../../lib/formatBytes'
import {
    DEFAULT_LIMITS,
    compatibility,
    guessKind,
    limitFor,
    pastedName,
    readAsDataURL,
    type AttachCaps,
    type AttachmentKind,
    type Compat,
    type SentAttachment,
} from '../../lib/chatAttachments'

// Un adjunto del compositor: desde que se elige hasta que se manda.
//
//   uploading  SaveChatFile está escribiendo el archivo en la carpeta de
//              adjuntos de la app (el frontend lee el archivo y lo manda en
//              base64; la ruta real la decide Go)
//   ready      ya tiene ruta: es lo que viaja en `images` de SendAgentChat
//   error      no se pudo adjuntar (tope local o rechazo de Go); no se manda
export interface AttachItem {
    id: string
    name: string
    kind: AttachmentKind
    size: number
    status: 'uploading' | 'ready' | 'error'
    error?: string
    path?: string
    // Miniatura de una imagen: URL de objeto del propio File, revocada al quitar
    // el adjunto. La del mensaje enviado es otra (ver `takeReady`).
    previewUrl?: string
    file?: File
}

export interface AttachView extends AttachItem {
    compat: Compat
}

let nextId = 0

// Estado de los adjuntos de un chat: selección, subida, compatibilidad con el
// agente y modelo elegidos, y arrastrar/soltar. Vive aparte de AgentChat porque
// ese componente ya es enorme y esto no depende de nada de la conversación.
export function useChatAttachments({agentId, model, enabled}: {agentId: string; model: string; enabled: boolean}) {
    const t = useT()
    const [items, setItems] = useState<AttachItem[]>([])
    const itemsRef = useRef<AttachItem[]>([])
    const apply = useCallback((fn: (prev: AttachItem[]) => AttachItem[]) => {
        itemsRef.current = fn(itemsRef.current)
        setItems(itemsRef.current)
    }, [])

    // --- Capacidades del destino -------------------------------------------
    //
    // Se piden al elegir agente o modelo, no por tecla: puede ser una consulta
    // HTTP al proveedor (Go la cachea 10 minutos). Si la consulta falla se
    // sigue sin ella —topes por defecto y nada bloqueado— porque Go vuelve a
    // validar todo al enviar.
    const [caps, setCaps] = useState<AttachCaps | null>(null)
    const capsRef = useRef<AttachCaps | null>(null)
    capsRef.current = caps
    const capsAgentRef = useRef('')
    useEffect(() => {
        if (!enabled || !agentId) return
        // Otro proveedor: lo que se sabía del anterior no vale. Cambiar solo de
        // modelo conserva lo último hasta que llegue la respuesta nueva.
        if (capsAgentRef.current !== agentId) {
            capsAgentRef.current = agentId
            setCaps(null)
        }
        let cancelled = false
        AgentAttachmentCapabilities(agentId, model)
            .then((c) => !cancelled && setCaps(c ? {...c} : null))
            .catch(() => !cancelled && setCaps(null))
        return () => {
            cancelled = true
        }
    }, [agentId, model, enabled])

    const limits = useMemo(() => ({...DEFAULT_LIMITS, ...(caps ?? {})}), [caps])

    // --- URLs de objeto -------------------------------------------------------
    // Las de las miniaturas del compositor las revoca quitar el adjunto; las de
    // los mensajes enviados viven lo que la sesión y se sueltan al desmontar.
    const sessionUrls = useRef(new Set<string>())
    const revoke = useCallback((url?: string) => {
        if (!url) return
        URL.revokeObjectURL(url)
        sessionUrls.current.delete(url)
    }, [])
    const makeUrl = useCallback((file: Blob) => {
        const url = URL.createObjectURL(file)
        sessionUrls.current.add(url)
        return url
    }, [])
    useEffect(() => {
        const urls = sessionUrls.current
        return () => {
            for (const u of urls) URL.revokeObjectURL(u)
            urls.clear()
        }
    }, [])

    // --- Alta ------------------------------------------------------------------
    const upload = useCallback(
        (item: AttachItem) => {
            const file = item.file
            if (!file) return
            readAsDataURL(file)
                .then((data) => SaveChatFile(item.name, data))
                .then((att) => {
                    const kind = att.kind === 'image' || att.kind === 'pdf' || att.kind === 'text' ? att.kind : null
                    apply((prev) =>
                        prev.map((x) => {
                            if (x.id !== item.id) return x
                            if (!kind) return {...x, status: 'error', error: t.agent.chat.attach.errors.unsupported({name: x.name})}
                            // Go clasifica por contenido y puede contradecir a la
                            // extensión (un .txt que es un PNG): manda su veredicto.
                            let previewUrl = x.previewUrl
                            if (kind === 'image' && !previewUrl && x.file) previewUrl = makeUrl(x.file)
                            if (kind !== 'image' && previewUrl) {
                                revoke(previewUrl)
                                previewUrl = undefined
                            }
                            return {...x, status: 'ready', path: att.path, name: att.name || x.name, kind, size: att.size || x.size, previewUrl}
                        }),
                    )
                })
                .catch((err) => {
                    apply((prev) => prev.map((x) => (x.id === item.id ? {...x, status: 'error', error: errorText(err)} : x)))
                })
        },
        [apply, makeUrl, revoke, t],
    )

    const addFiles = useCallback(
        (files: File[], opts?: {pasted?: boolean}) => {
            if (!enabled || files.length === 0) return
            const a = t.agent.chat.attach
            const lim = {...DEFAULT_LIMITS, ...(capsRef.current ?? {})}
            let live = itemsRef.current.filter((i) => i.status !== 'error').length
            const created: AttachItem[] = []
            files.forEach((file, n) => {
                const name = opts?.pasted ? pastedName(file, n) : file.name || `file-${n + 1}`
                const base = {id: `att-${++nextId}`, name, size: file.size, file}
                const fail = (kind: AttachmentKind, error: string) => created.push({...base, kind, status: 'error', error, file: undefined})
                const guess = guessKind(file)
                if (guess === 'image-unsupported') return fail('image', a.errors.unsupportedImage({name}))
                if (file.size === 0) return fail('text', a.errors.empty({name}))
                const kind: AttachmentKind = guess === 'unknown' ? 'text' : guess
                const max = limitFor(kind, capsRef.current)
                if (file.size > max) {
                    return fail(
                        kind,
                        guess === 'unknown'
                            ? a.errors.unknownBig({name, size: formatBytes(file.size), max: formatBytes(max)})
                            : a.errors.tooBig({name, size: formatBytes(file.size), kind: a.kindPlural[kind], max: formatBytes(max)}),
                    )
                }
                if (live >= lim.maxCount) return fail(kind, a.errors.tooMany({name, max: lim.maxCount}))
                live++
                created.push({
                    ...base,
                    kind,
                    status: 'uploading',
                    previewUrl: kind === 'image' ? makeUrl(file) : undefined,
                })
            })
            if (created.length === 0) return
            apply((prev) => [...prev, ...created])
            for (const it of created) if (it.status === 'uploading') upload(it)
        },
        [apply, enabled, makeUrl, t, upload],
    )

    // Archivos que trae un portapapeles o un arrastre. Devuelve si había
    // alguno, para que el llamador corte el pegado de texto: si no, además del
    // chip quedaría el nombre del archivo escrito en la caja.
    const addFromTransfer = useCallback(
        (data: DataTransfer | null, opts?: {pasted?: boolean}): boolean => {
            if (!data || !enabled) return false
            const files: File[] = []
            for (const item of Array.from(data.items ?? [])) {
                if (item.kind !== 'file') continue
                const f = item.getAsFile()
                if (f) files.push(f)
            }
            if (files.length === 0) files.push(...Array.from(data.files ?? []))
            if (files.length === 0) return false
            addFiles(files, opts)
            return true
        },
        [addFiles, enabled],
    )

    const remove = useCallback(
        (id: string) => {
            const it = itemsRef.current.find((x) => x.id === id)
            revoke(it?.previewUrl)
            apply((prev) => prev.filter((x) => x.id !== id))
        },
        [apply, revoke],
    )

    // Lo que va en el mensaje: las rutas para SendAgentChat y las fichas para
    // dibujarlo. La miniatura del mensaje es una URL NUEVA del mismo File: la
    // del chip se revoca cuando el chip desaparece y el mensaje tiene que
    // seguir mostrándola.
    const takeReady = useCallback(() => {
        const ready = itemsRef.current.filter((x) => x.status === 'ready' && x.path)
        return {
            ids: ready.map((x) => x.id),
            paths: ready.map((x) => x.path as string),
            sent: ready.map(
                (x): SentAttachment => ({
                    name: x.name,
                    kind: x.kind,
                    size: x.size,
                    previewUrl: x.kind === 'image' && x.file ? makeUrl(x.file) : undefined,
                }),
            ),
        }
    }, [makeUrl])

    const removeMany = useCallback(
        (ids: string[]) => {
            for (const id of ids) revoke(itemsRef.current.find((x) => x.id === id)?.previewUrl)
            apply((prev) => prev.filter((x) => !ids.includes(x.id)))
        },
        [apply, revoke],
    )

    const releaseSent = useCallback(
        (sent: SentAttachment[]) => {
            for (const s of sent) revoke(s.previewUrl)
        },
        [revoke],
    )

    // --- Qué impide enviar ------------------------------------------------------
    const view = useMemo<AttachView[]>(() => items.map((i) => ({...i, compat: compatibility(i.kind, caps)})), [items, caps])
    const uploading = view.some((i) => i.status === 'uploading')
    const blockedCount = view.filter((i) => i.status === 'ready' && i.compat === 'blocked').length
    const readyCount = view.filter((i) => i.status === 'ready').length
    const reason = uploading ? t.agent.chat.attach.uploadingReason : blockedCount > 0 ? t.agent.chat.attach.blockedReason({n: blockedCount}) : ''

    // --- Arrastrar y soltar -------------------------------------------------------
    const [dragging, setDragging] = useState(false)
    const [cancelNote, setCancelNote] = useState(false)
    const depth = useRef(0)
    const cancelled = useRef(false)
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const dragProps = {
        onDragEnter: (e: DragEvent) => {
            if (!enabled || !hasFiles(e)) return
            e.preventDefault()
            depth.current++
            cancelled.current = false
            setCancelNote(false)
            setDragging(true)
        },
        onDragOver: (e: DragEvent) => {
            if (!enabled || !hasFiles(e)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = cancelled.current ? 'none' : 'copy'
        },
        onDragLeave: (e: DragEvent) => {
            if (!hasFiles(e)) return
            depth.current = Math.max(0, depth.current - 1)
            if (depth.current === 0) setDragging(false)
        },
        onDrop: (e: DragEvent) => {
            if (!enabled || !hasFiles(e)) return
            e.preventDefault()
            depth.current = 0
            setDragging(false)
            if (cancelled.current) {
                cancelled.current = false
                return
            }
            addFromTransfer(e.dataTransfer)
        },
    }

    // Escape suelta el aviso de arrastre; si igual se suelta, no adjunta. El
    // arrastre del sistema sigue en pie, pero lo que el usuario pidió fue
    // olvidarse de adjuntar. `dragend`/`blur` evitan que el velo se quede
    // pegado cuando el arrastre termina fuera de la ventana.
    useEffect(() => {
        if (!dragging) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            cancelled.current = true
            depth.current = 0
            setDragging(false)
            setCancelNote(true)
        }
        const end = () => {
            depth.current = 0
            setDragging(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('dragend', end)
        window.addEventListener('blur', end)
        return () => {
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('dragend', end)
            window.removeEventListener('blur', end)
        }
    }, [dragging])

    return {
        items: view,
        caps,
        limits,
        addFiles,
        addFromTransfer,
        remove,
        removeMany,
        takeReady,
        releaseSent,
        uploading,
        blockedCount,
        readyCount,
        reason,
        // Enviar no puede salir mientras algo se sube o no lo lee el modelo.
        sendBlocked: uploading || blockedCount > 0,
        dragging,
        cancelNote,
        dragProps,
    }
}
