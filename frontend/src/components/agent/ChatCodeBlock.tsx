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
    // 'terminal': lo insertado cae en una shell, donde un salto de línea es un
    // Enter. Se ofrece solo para bloques de UN comando y se manda sin el salto
    // final: queda escrito y el Enter lo pone el usuario —que es además cuando
    // actúa la guarda de producción de la terminal—. Un bloque de varios
    // comandos se copia: pegarlo de golpe ejecutaría todos menos el último.
    insertTarget?: 'editor' | 'terminal'
}

// Líneas que son comando: sin vacías ni comentarios, y sin el `$ ` de un prompt
// copiado, que el shell rechazaría.
function commandLines(code: string): string[] {
    return code
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/^\$\s+/, ''))
}

export default function ChatCodeBlock({lang, code, onInsert, insertLabel, insertTarget = 'editor'}: Props) {
    const [copied, setCopied] = useState(false)
    const [inserted, setInserted] = useState(false)

    const lines = code.split('\n').length
    const toTerminal = insertTarget === 'terminal'
    const commands = toTerminal ? commandLines(code) : []
    const canInsert = !!onInsert && (!toTerminal || commands.length === 1)

    return (
        <div className="my-1.5 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
            <div className="flex items-center gap-1.5 border-b border-outline-variant bg-surface-container-high px-2 py-1 text-ui-10">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                {/* El lenguaje es lo primero: dice de un vistazo si eso es SQL
                    que se puede correr o un pedazo de configuración. */}
                <span className="font-mono font-medium text-on-surface">
                    {lang || 'texto'}
                </span>
                <span className="text-on-surface-variant/50">
                    {lines} {lines === 1 ? 'línea' : 'líneas'}
                </span>

                {canInsert && (
                    <button
                        onClick={() => {
                            onInsert!(toTerminal ? commands[0] : code)
                            setInserted(true)
                            setCopied(false)
                        }}
                        title={
                            insertLabel ??
                            (toTerminal
                                ? 'Escribe el comando en la terminal SIN ejecutarlo — lo leés y el Enter lo ponés vos'
                                : 'Inserta este código donde está el cursor, sin pisar lo que ya escribiste')
                        }
                        className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                    >
                        <Icon name={inserted ? 'check' : toTerminal ? 'play_arrow' : 'input'} size={12} />
                        {inserted ? 'Insertado' : toTerminal ? 'A la terminal' : 'Al editor'}
                    </button>
                )}

                <button
                    onClick={() => {
                        void navigator.clipboard.writeText(code)
                        setCopied(true)
                        setInserted(false)
                    }}
                    title="Copia el bloque entero al portapapeles"
                    className={`flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:border-primary/60 hover:text-on-surface ${
                        canInsert ? '' : 'ml-auto'
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
            <pre className="overflow-x-auto px-3 py-2 font-mono text-ui-11 leading-5 text-on-surface">
                {code}
            </pre>
        </div>
    )
}
