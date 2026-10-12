import {useEffect, useRef, useState} from 'react'
import type {KeyboardEvent, PointerEvent as ReactPointerEvent} from 'react'

// Tirador para cambiar el ANCHO de una columna arrastrando su borde.
//
// Es el mismo gesto de la barra lateral (`Sidebar`) y del panel de snippets de
// SSH, pero con lo que a esos les faltaba: se maneja con el teclado (el tirador
// es un `separator` con foco, y las flechas lo mueven), anuncia su valor a un
// lector de pantalla y tiene doble clic para volver al ancho original.
//
// Va SUPERPUESTO sobre el borde de la columna y no como una columna más del
// flex: una columna propia correría el contenido y dejaría una franja visible al
// lado del borde, que es justo el píxel que uno intenta agarrar. Por eso el
// padre tiene que ser `relative`.
//
// **Quién guarda el valor.** Este componente no sabe dónde se persiste: avisa
// cada cambio por `onChange` (decenas por segundo mientras se arrastra, que
// alcanza para redibujar) y UNA sola vez por `onCommit` al soltar o al terminar
// una tecla, que es cuando conviene escribir en el almacenamiento.

interface Props {
    value: number
    min: number
    max: number
    defaultValue: number
    // En qué borde de la columna está. En el derecho, arrastrar hacia la
    // derecha agranda; en el izquierdo (una columna pegada a la derecha de la
    // pantalla), al revés.
    edge?: 'right' | 'left'
    onChange: (px: number) => void
    onCommit?: (px: number) => void
    label: string
    title: string
    valueText?: (px: number) => string
}

// Unidad de medida, no prosa: no se traduce.
const PIXEL_UNIT = '\u00a0px'
const STEP = 16
const STEP_FAST = 64

export default function ResizeHandle({value, min, max, defaultValue, edge = 'right', onChange, onCommit, label, title, valueText}: Props) {
    const [dragging, setDragging] = useState(false)
    const cleanupRef = useRef<(() => void) | null>(null)
    const clamp = (px: number) => Math.round(Math.min(max, Math.max(min, px)))

    // Si el tirador desaparece a mitad de un arrastre (el panel se cierra), los
    // oyentes de la ventana no pueden quedar vivos.
    useEffect(() => () => cleanupRef.current?.(), [])

    function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        if (e.button !== 0) return
        e.preventDefault()
        const startX = e.clientX
        const startValue = value
        const sign = edge === 'right' ? 1 : -1
        let last = clamp(startValue)
        setDragging(true)

        const move = (ev: PointerEvent) => {
            last = clamp(startValue + sign * (ev.clientX - startX))
            onChange(last)
        }
        const end = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
            cleanupRef.current = null
            setDragging(false)
            onCommit?.(last)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
        cleanupRef.current = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
        // Mientras se arrastra, ni seleccionar texto por el camino ni perder el
        // cursor de redimensionar al pasar sobre otros controles.
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'
    }

    function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        const step = e.shiftKey ? STEP_FAST : STEP
        // La flecha apunta hacia donde se mueve el BORDE: en el derecho,
        // derecha agranda; en el izquierdo, izquierda agranda.
        const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft'
        const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight'
        let next: number | null = null
        if (e.key === grow) next = value + step
        else if (e.key === shrink) next = value - step
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        else if (e.key === 'Enter') next = defaultValue
        if (next === null) return
        e.preventDefault()
        const px = clamp(next)
        onChange(px)
        onCommit?.(px)
    }

    function reset() {
        const px = clamp(defaultValue)
        onChange(px)
        onCommit?.(px)
    }

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Math.round(value)}
            aria-valuetext={valueText?.(Math.round(value))}
            tabIndex={0}
            data-resize-handle
            data-dragging={dragging ? '' : undefined}
            title={title}
            onPointerDown={onPointerDown}
            onDoubleClick={reset}
            onKeyDown={onKeyDown}
            className={`group absolute inset-y-0 z-20 w-1.5 cursor-col-resize touch-none select-none outline-none ${
                edge === 'right' ? '-right-0.5' : '-left-0.5'
            } ${dragging ? 'bg-primary/50' : 'hover:bg-primary/30 focus-visible:bg-primary/40'}`}
        >
            {dragging && (
                <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-primary px-1.5 py-0.5 text-ui-10 font-medium tabular-nums text-on-primary shadow">
                    {Math.round(value)}
                    {PIXEL_UNIT}
                </span>
            )}
        </div>
    )
}
