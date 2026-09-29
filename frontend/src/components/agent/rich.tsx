import type {ReactNode} from 'react'

// Dibuja un texto del diccionario con marcas mínimas de formato: `**x**`
// resaltado, `*x*` en cursiva y `` `x` `` en monoespaciada.
//
// Existe para que una frase con una palabra en negrita viva ENTERA en el
// diccionario: partirla en pedazos y pegarlos en el componente fijaría el
// orden de las palabras del español, y en inglés ese orden cambia.
//
// `strong` permite dibujar cada resaltado a medida (el nombre del recurso en
// el estado vacío del chat, por ejemplo, va con otro estilo que una palabra en
// negrita). Recibe el texto y el orden del resaltado dentro de la frase.
export function rich(text: string, strong?: (s: string, i: number) => ReactNode): ReactNode[] {
    const out: ReactNode[] = []
    let n = 0
    text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/).forEach((part, i) => {
        if (!part) return
        if (part.startsWith('**')) {
            const s = part.slice(2, -2)
            out.push(strong ? <span key={i}>{strong(s, n)}</span> : <strong key={i}>{s}</strong>)
            n++
        } else if (part.startsWith('*')) {
            out.push(<em key={i}>{part.slice(1, -1)}</em>)
        } else if (part.startsWith('`')) {
            out.push(
                <span key={i} className="font-mono">
                    {part.slice(1, -1)}
                </span>,
            )
        } else {
            out.push(part)
        }
    })
    return out
}
