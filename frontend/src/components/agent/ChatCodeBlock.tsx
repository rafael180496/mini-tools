import {useEffect, useMemo, useState} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {languageForFence, languageLabel} from '../../codemirror/languageRegistry'
import {highlightLines, parserFor, parserIfLoaded} from '../../codemirror/highlightStatic'

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
//
// **Con colores y números de línea.** El lenguaje sale de la etiqueta del
// bloque (```ts, ```bash, ```plsql) y se pinta con el mismo parser del editor
// (ver codemirror/highlightStatic). Los números van en una columna que no se
// selecciona: copiar a mano trae solo el código.

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

// Un bloque más largo que esto arranca plegado: una respuesta con un archivo
// entero adentro empujaría fuera de la vista el texto que lo explica.
const COLLAPSE_LINES = 30
const COLLAPSED_LINES = 14

// Qué papel juega una línea dentro de un diff, para pintarle el fondo entero:
// agregada (`+`), quitada (`-`) o encabezado de bloque (`@@`). Las cabeceras de
// archivo `+++`/`---` no son líneas agregadas ni quitadas y quedan neutras.
function diffKind(line: string): 'ins' | 'del' | 'hunk' | '' {
    if (line.startsWith('@@')) return 'hunk'
    if (line.startsWith('+') && !line.startsWith('+++')) return 'ins'
    if (line.startsWith('-') && !line.startsWith('---')) return 'del'
    return ''
}

// Los números de línea solo aportan cuando hay a qué referirse: en un comando
// de una línea serían ruido.
const NUMBER_FROM_LINES = 4

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
    const t = useT()
    const [copied, setCopied] = useState(false)
    const [inserted, setInserted] = useState(false)

    const langId = languageForFence(lang)
    const [parser, setParser] = useState(() => parserIfLoaded(langId))
    useEffect(() => {
        let alive = true
        void parserFor(langId).then((p) => {
            if (alive) setParser(() => p)
        })
        return () => {
            alive = false
        }
    }, [langId])
    const highlighted = useMemo(() => highlightLines(code, parser), [code, parser])
    const lines = highlighted.length
    const collapsible = lines > COLLAPSE_LINES
    const [expanded, setExpanded] = useState(false)
    const shown = collapsible && !expanded ? highlighted.slice(0, COLLAPSED_LINES) : highlighted
    // Solo un bloque ```diff pinta el fondo de cada línea. Se mira el texto
    // crudo y no los tokens: el parser agrupa tramos, pero la primera letra de
    // la línea es lo que dice si se agregó o se quitó.
    const kinds = useMemo(() => (langId === 'diff' ? code.split('\n').map(diffKind) : null), [langId, code])
    const numbered = lines >= NUMBER_FROM_LINES
    const gutter = String(lines).length
    // Nombre del lenguaje como se escribe (TypeScript, no ts); una etiqueta que
    // no se reconoce se muestra tal cual.
    const langName = langId === 'plaintext' ? lang || t.agent.codeBlock.text : languageLabel(langId)
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
                    {langName}
                </span>
                <span className="text-on-surface-variant/50">
                    {t.agent.codeBlock.lines({n: lines})}
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
                                ? t.agent.codeBlock.toTerminalTitle
                                : t.agent.codeBlock.toEditorTitle)
                        }
                        className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                    >
                        <Icon name={inserted ? 'check' : toTerminal ? 'play_arrow' : 'input'} size={12} />
                        {inserted ? t.agent.codeBlock.inserted : toTerminal ? t.agent.codeBlock.toTerminal : t.agent.codeBlock.toEditor}
                    </button>
                )}

                <button
                    onClick={() => {
                        void navigator.clipboard.writeText(code)
                        setCopied(true)
                        setInserted(false)
                    }}
                    title={t.agent.codeBlock.copyTitle}
                    className={`flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:border-primary/60 hover:text-on-surface ${
                        canInsert ? '' : 'ml-auto'
                    }`}
                >
                    <Icon name={copied ? 'check' : 'content_copy'} size={12} />
                    {copied ? t.agent.codeBlock.copied : t.agent.codeBlock.copy}
                </button>
            </div>

            {/* `whitespace-pre` y no `pre-wrap`: en código la sangría ES
                información, y partir una línea larga en dos desalinea todo lo
                que venía debajo. Por eso el bloque se desplaza en horizontal en
                vez de cortar. */}
            <pre className="syn overflow-x-auto py-2 font-mono text-ui-11 leading-5 text-on-surface">
                <code className="block min-w-max">
                    {shown.map((line, i) => (
                        // min-h-5: una línea vacía conserva su alto sin meter un
                        // carácter que después se copiaría.
                        // syn-diff-*: el fondo cubre el ancho entero del
                        // renglón, incluido lo que queda fuera de la vista
                        // al desplazar (el <code> es min-w-max).
                        <div key={i} className={`flex min-h-5 pr-3${kinds?.[i] ? ` syn-diff-${kinds[i]}` : ''}`}>
                            {numbered && (
                                <span
                                    aria-hidden
                                    className="syn-gutter sticky left-0 shrink-0 select-none bg-surface-container-lowest pr-3 pl-3 text-right text-on-surface-variant/50"
                                    style={{width: `${gutter + 3}ch`}}
                                >
                                    {i + 1}
                                </span>
                            )}
                            <span className={numbered ? '' : 'pl-3'}>
                                {line.map((tok, j) =>
                                          tok.cls ? (
                                              <span key={j} className={tok.cls}>
                                                  {tok.text}
                                              </span>
                                          ) : (
                                              tok.text
                                          ),
                                )}
                            </span>
                        </div>
                    ))}
                </code>
            </pre>
            {collapsible && (
                <button
                    onClick={() => setExpanded((v) => !v)}
                    className="flex w-full items-center justify-center gap-1 border-t border-outline-variant bg-surface-container-high py-1 text-ui-10 text-on-surface-variant hover:text-on-surface"
                >
                    <Icon name={expanded ? 'expand_less' : 'expand_more'} size={14} />
                    {expanded ? t.agent.codeBlock.collapse : t.agent.codeBlock.expand({n: lines - COLLAPSED_LINES})}
                </button>
            )}
        </div>
    )
}
