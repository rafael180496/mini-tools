import {useEffect, useState} from 'react'
import {cachedNoteImage, loadNoteImage} from '../../lib/noteImages'

// Una imagen de una nota en la vista de lectura.
//
// El Markdown la referencia como `![alt](nota:ID)` y el archivo real vive
// CIFRADO dentro del vault, así que no hay una URL que el navegador pueda
// pedir: hay que descifrarla y pasarla como data URL. La caché es la misma que
// usa el editor en vivo (lib/noteImages), así que alternar entre escribir y
// leer no vuelve a descifrar nada.

export default function NoteImage({assetId, alt}: {assetId: string; alt: string}) {
    // Si ya está en la caché se pinta en el primer render: pasar por el estado
    // de carga teniendo la imagen a mano haría parpadear la nota entera cada
    // vez que se cambia de vista.
    const [src, setSrc] = useState(() => cachedNoteImage(assetId))
    const [failed, setFailed] = useState(false)

    useEffect(() => {
        if (src) return
        let alive = true
        loadNoteImage(assetId)
            .then((url) => alive && setSrc(url))
            .catch(() => alive && setFailed(true))
        return () => {
            alive = false
        }
    }, [assetId, src])

    if (failed) {
        return (
            <span className="inline-block rounded border border-dashed border-error/60 px-2 py-1 text-ui-11 text-error">
                {alt || 'imagen'} — no se pudo cargar
            </span>
        )
    }
    if (!src) {
        // Marco del mismo aire que la imagen, no un hueco: que el texto no
        // salte cuando termina de descifrarse.
        return (
            <span className="inline-block rounded border border-dashed border-outline-variant px-8 py-6 text-ui-11 text-on-surface-variant">
                {alt || 'imagen'}
            </span>
        )
    }
    return <img src={src} alt={alt} title={alt || undefined} className="my-2 max-w-full rounded border border-outline-variant" />
}
