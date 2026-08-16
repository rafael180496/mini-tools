import {useState} from 'react'
import Icon from '../Icon'

// Bloque de código dentro de una respuesta del agente.
//
// **Por qué no alcanzaba el `<pre>` de la vista previa.** Lo que el agente
// devuelve casi siempre es algo para *usar*: una consulta corregida, un
// comando, un fragmento de configuración. Mostrarlo como un párrafo gris
// obliga a seleccionarlo con el mouse sin pasarse de renglón —y una consulta
// de doce líneas no se selecciona bien nunca— para después pegarla a mano en
// el editor. Los dos pasos que faltaban son los dos botones de esta barra.
//
// **Se ajusta a la pantalla en vez de cortar el texto.** El panel del chat es
// angosto y una consulta con `SELECT` de ocho columnas se va de ancho: el
// bloque tiene su propio desplazamiento horizontal, así que la línea larga se
// puede leer entera sin que el panel entero se desarme.

interface Props {
    lang: string
    code: string
    // Manda el código a donde el usuario está trabajando (el editor SQL, la
    // nota). Sin esto el botón no aparece: en un módulo donde no hay dónde
    // insertarlo, ofrecerlo sería prometer algo que no pasa.
    onInsert?: (text: string) => void
    insertLabel?: string
}

export default function ChatCodeBlock({lang, code, onInsert, insertLabel}: Props) {
    const [copied, setCopied] = useState(false)
    const [inserted, setInserted] = useState(false)

    const lines = code.split('\n').length

    return (
        <div className="my-1 overflow-hidden rounded border border-outline-variant bg-surface-container-highest">
            <div className="flex items-center gap-1.5 border-b border-outline-variant bg-surface-container px-1.5 py-0.5 text-[10px]">
                {/* El lenguaje es lo primero: dice de un vistazo si eso es SQL
                    que se puede correr o un pedazo de configuración. */}
                <span className="font-medium uppercase tracking-wider text-on-surface-variant">
                    {lang || 'texto'}
                </span>
                <span className="text-on-surface-variant/50">
                    {lines} {lines === 1 ? 'línea' : 'líneas'}
                </span>

                {onInsert && (
                    <button
                        onClick={() => {
                            onInsert(code)
                            setInserted(true)
                            setCopied(false)
                        }}
                        title={insertLabel ?? 'Inserta este código donde está el cursor, sin pisar lo que ya escribiste'}
                        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name={inserted ? 'check' : 'input'} size={12} />
                        {inserted ? 'Insertado' : 'Al editor'}
                    </button>
                )}

                <button
                    onClick={() => {
                        void navigator.clipboard.writeText(code)
                        setCopied(true)
                        setInserted(false)
                    }}
                    title="Copia el bloque entero al portapapeles"
                    className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${
                        onInsert ? '' : 'ml-auto'
                    }`}
                >
                    <Icon name={copied ? 'check' : 'content_copy'} size={12} />
                    {copied ? 'Copiado' : 'Copiar'}
                </button>
            </div>

            {/* `whitespace-pre` y no `pre-wrap`: en código la sangría ES
                información, y partir una línea larga en dos desalinea todo lo
                que venía debajo. Por eso el bloque se desplaza en horizontal en
                vez de cortar. */}
            <pre className="overflow-x-auto px-2 py-1.5 font-mono text-[11px] leading-5 text-on-surface">
                {code}
            </pre>
        </div>
    )
}
