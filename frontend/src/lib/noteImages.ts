import {GetNoteImage} from '../../wailsjs/go/main/App'

// Caché de las imágenes de una nota, ya descifradas y en data URL.
//
// Vive fuera de los componentes porque la MISMA imagen la dibujan dos lugares
// —el editor en vivo (widget de CodeMirror) y la vista de lectura— y descifrar
// un asset del vault no es gratis: sin caché compartida, alternar entre las dos
// vistas volvía a pedir y descifrar cada imagen de la nota.
//
// La caché es por id de asset y los ids son inmutables (una imagen editada es
// un asset nuevo), así que no hay invalidación que hacer.
const cache = new Map<string, string>()

// En vuelo: sin esto, cinco widgets de la misma imagen disparan cinco
// descifrados idénticos en el mismo frame.
const pending = new Map<string, Promise<string>>()

// cachedNoteImage devuelve la imagen si ya está descifrada. Sirve para dibujar
// sin parpadeo: quien la tiene la pinta de una, y solo quien no la tiene pide.
export function cachedNoteImage(assetId: string): string | undefined {
    return cache.get(assetId)
}

// loadNoteImage descifra la imagen del vault y la deja cacheada.
export function loadNoteImage(assetId: string): Promise<string> {
    const hit = cache.get(assetId)
    if (hit) return Promise.resolve(hit)

    const inflight = pending.get(assetId)
    if (inflight) return inflight

    const p = GetNoteImage(assetId)
        .then((asset) => {
            const url = `data:${asset.mime};base64,${asset.data}`
            cache.set(assetId, url)
            return url
        })
        .finally(() => pending.delete(assetId))
    pending.set(assetId, p)
    return p
}
