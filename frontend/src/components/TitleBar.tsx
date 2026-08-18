import {useEffect, useState} from 'react'
import type {CSSProperties} from 'react'
import Icon from './Icon'

// La barra de título de la ventana, dibujada por la app.
//
// La nativa era la única parte de la ventana que no seguía el tema: una
// franja gris del sistema arriba de una app que por lo demás es oscura de
// punta a punta. Esto la reemplaza — con una diferencia importante entre
// sistemas que NO es un detalle de implementación sino una decisión:
//
//   - **macOS conserva sus semáforos.** No son decoración del marco, son el
//     control estándar de la ventana: el usuario los busca ahí, el sistema
//     les da su menú contextual, el atajo de pantalla completa y el
//     comportamiento de arrastrar entre escritorios. Redibujarlos sería
//     imitar peor algo que el sistema ya hace bien. Lo que se sacó es la
//     barra gris de alrededor (main.go usa TitleBarHidden), y acá se
//     les reserva el hueco.
//
//   - **Windows y Linux la dibujan entera.** Ahí los botones de ventana son
//     parte del marco, así que la ventana va sin marco (Frameless) y los
//     tres botones —minimizar, maximizar/restaurar, cerrar— son de la app,
//     con los tamaños y el hover rojo del cierre que espera cada sistema.
//
// Arrastrar la ventana funciona por la propiedad CSS de Wails
// `--wails-draggable`, no por JavaScript: la barra entera es zona de
// arrastre y cada control se marca como `no-drag` para que un clic sobre un
// botón no arranque a mover la ventana.

// Cuánto hay que dejar libre a la izquierda para los semáforos de macOS.
//
// Con TitleBarHidden (ver main.go) el sistema los pone donde los pone en
// cualquier ventana: el primero arranca a 13px del borde y los tres ocupan
// unos 54px. 72 deja un respiro después del último sin abrir un hueco que se
// lea como desalineación.
const TITLE_BAR_MAC_INSET = 72

const DRAG: CSSProperties = {'--wails-draggable': 'drag'} as CSSProperties
const NO_DRAG: CSSProperties = {'--wails-draggable': 'no-drag'} as CSSProperties

// Runtime de Wails, cargado a demanda y tolerante a que no exista.
//
// El banco de capturas (src/uishot.tsx) monta estos componentes en un
// Chrome normal, donde `window.runtime` no está: sin esta guarda, la barra
// de título tiraría al montar y se llevaría puesta la captura entera de
// cualquier vista. Un `catch` que devuelve undefined deja la barra dibujada
// y sin controles, que es exactamente lo que corresponde fuera de la app.
async function wailsRuntime() {
    try {
        return await import('../../wailsjs/runtime/runtime')
    } catch {
        return undefined
    }
}

export default function TitleBar() {
    // "" mientras no se sabe. Los controles solo se dibujan una vez que el
    // sistema está confirmado: dibujarlos por defecto y esconderlos después
    // haría parpadear tres botones en cada arranque de macOS.
    const [platform, setPlatform] = useState('')
    const [maximised, setMaximised] = useState(false)

    useEffect(() => {
        let alive = true
        void (async () => {
            const rt = await wailsRuntime()
            if (!rt || !alive) return
            try {
                const env = await rt.Environment()
                if (alive) setPlatform(env.platform)
                const max = await rt.WindowIsMaximised()
                if (alive) setMaximised(max)
            } catch {
                // Sin runtime no hay controles; la barra sigue sirviendo
                // como identidad y como zona de arrastre.
            }
        })()
        return () => {
            alive = false
        }
    }, [])

    const isMac = platform === 'darwin'
    const showControls = platform !== '' && !isMac

    async function call(fn: 'WindowMinimise' | 'WindowToggleMaximise' | 'Quit') {
        const rt = await wailsRuntime()
        if (!rt) return
        rt[fn]()
        if (fn === 'WindowToggleMaximise') {
            // El estado no llega por evento, así que se relee: es lo que
            // decide si el botón del medio muestra "maximizar" o
            // "restaurar", y un ícono que miente sobre lo que va a hacer es
            // peor que no tenerlo.
            try {
                setMaximised(await rt.WindowIsMaximised())
            } catch {
                setMaximised((v) => !v)
            }
        }
    }

    return (
        <header
            style={DRAG}
            onDoubleClick={() => void call('WindowToggleMaximise')}
            // select-none: sin esto, arrastrar la ventana selecciona el
            // título como si fuera texto de la página.
            className="flex h-[34px] shrink-0 select-none items-center gap-2 border-b border-outline-variant bg-surface-container-low px-3 text-on-surface"
        >
            {/* La barra queda deliberadamente vacía. El logo y el nombre
                estuvieron acá un rato, pero la identidad de la app tiene UN
                lugar y ese es el pie de la barra lateral, junto a la versión
                (components/sidebar/Sidebar.tsx) — repetirla a 40px de
                distancia es lo mismo que ya pasaba cuando estaba en el
                encabezado del sidebar. Lo que queda es lo que una barra de
                título tiene que hacer: dar dónde agarrar la ventana, y en
                Windows y Linux dónde cerrarla.

                El hueco de macOS se sigue reservando: es donde el sistema
                dibuja los semáforos. */}
            <div className="min-w-0 flex-1" style={{paddingLeft: isMac ? TITLE_BAR_MAC_INSET : 0}} />

            {showControls && (
                <div className="flex shrink-0 items-center" style={NO_DRAG}>
                    <button
                        onClick={() => void call('WindowMinimise')}
                        title="Minimizar la ventana"
                        aria-label="Minimizar"
                        className="flex h-[34px] w-11 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="remove" size={16} />
                    </button>
                    <button
                        onClick={() => void call('WindowToggleMaximise')}
                        title={maximised ? 'Restaurar la ventana a su tamaño anterior' : 'Maximizar la ventana'}
                        aria-label={maximised ? 'Restaurar' : 'Maximizar'}
                        className="flex h-[34px] w-11 items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name={maximised ? 'filter_none' : 'crop_square'} size={maximised ? 13 : 15} />
                    </button>
                    {/* El único control con color propio, y el mismo rojo que
                        usa el sistema en Windows: cerrar es la acción de la
                        que no se vuelve, y es la que está pegada al borde
                        donde el mouse aterriza sin apuntar. */}
                    <button
                        onClick={() => void call('Quit')}
                        title="Cerrar la aplicación"
                        aria-label="Cerrar"
                        className="flex h-[34px] w-11 items-center justify-center text-on-surface-variant transition-colors hover:bg-error hover:text-on-error"
                    >
                        <Icon name="close" size={16} />
                    </button>
                </div>
            )}
        </header>
    )
}
