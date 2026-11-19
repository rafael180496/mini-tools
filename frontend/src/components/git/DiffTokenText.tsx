import type {Token} from '../../codemirror/highlightStatic'

// Texto de una línea del diff con los colores del lenguaje (diffSyntax.ts).
// Sin tramos, el texto tal cual: un lenguaje desconocido se lee como antes.
export default function TokenText({tokens, text}: {tokens: Token[] | null; text: string}) {
    if (!tokens) return <>{text}</>
    return (
        <>
            {tokens.map((t, i) =>
                t.cls ? (
                    <span key={i} className={t.cls}>
                        {t.text}
                    </span>
                ) : (
                    t.text
                ),
            )}
        </>
    )
}
