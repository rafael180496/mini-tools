import type {ReactNode} from 'react'

// highlightMatch marca, sin distinguir mayúsculas, cada aparición del texto
// del filtro rápido dentro de un valor. Es lo que dice POR QUÉ una fila pasó
// el filtro: la coincidencia puede estar en una columna fuera de la vista.
export function highlightMatch(text: string, needle: string): ReactNode {
    if (!needle) return text
    const lower = text.toLowerCase()
    const parts: ReactNode[] = []
    let from = 0
    let at = lower.indexOf(needle)
    while (at >= 0) {
        if (at > from) parts.push(text.slice(from, at))
        parts.push(
            <mark key={at} className="rounded-sm bg-tertiary/35 text-inherit">
                {text.slice(at, at + needle.length)}
            </mark>,
        )
        from = at + needle.length
        at = lower.indexOf(needle, from)
    }
    if (parts.length === 0) return text
    if (from < text.length) parts.push(text.slice(from))
    return parts
}
