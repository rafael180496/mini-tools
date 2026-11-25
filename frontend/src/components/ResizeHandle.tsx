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
    // Orientación del separador:
    //   - 'vertical' (default): barra vertical para cambiar el ANCHO de una columna.
    //   - 'horizontal': barra horizontal para cambiar el ALTO de un panel/fila.
    orientation?: 'vertical' | 'horizontal'
    // En qué borde del panel está.
    //   - vertical: 'right' (default, arrastrar derecha agranda) | 'left' (al revés).
    //   - horizontal: 'bottom' (arrastrar abajo agranda) | 'top' (default para dock inferior, arrastrar arriba agranda).
    edge?: 'right' | 'left' | 'top' | 'bottom'
    // Indica si el panel está actualmente en modo `auto size`. Si se pasa
    // `onResetAuto`, doble clic o Enter vuelve a `auto` en vez de solo fijar `defaultValue`.
    isAuto?: boolean
    onResetAuto?: () => void
    // Unidad mostrada en el badge mientras se arrastra (default: px).
    unit?: string
    onChange: (value: number) => void
    onCommit?: (value: number) => void
    label: string
    title: string
    valueText?: (value: number) => string
}

// Unidad de medida, no prosa: no se traduce.
const PIXEL_UNIT = '\u00a0px'
const STEP = 16
const STEP_FAST = 64

export default function ResizeHandle({
    value,
    min,
    max,
    defaultValue,
    orientation = 'vertical',
    edge,
    isAuto,
    onResetAuto,
    unit = PIXEL_UNIT,
    onChange,
    onCommit,
    label,
    title,
    valueText,
}: Props) {
    const [dragging, setDragging] = useState(false)
    const cleanupRef = useRef<(() => void) | null>(null)
    const isHorizontal = orientation === 'horizontal'
    const resolvedEdge = edge ?? (isHorizontal ? 'top' : 'right')
    const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)))

    // Si el tirador desaparece a mitad de un arrastre (el panel se cierra), los
    // oyentes de la ventana no pueden quedar vivos.
    useEffect(() => () => cleanupRef.current?.(), [])

    function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        if (e.button !== 0) return
        e.preventDefault()
        const startPos = isHorizontal ? e.clientY : e.clientX
        const startValue = value
        const sign = resolvedEdge === 'right' || resolvedEdge === 'bottom' ? 1 : -1
        let last = clamp(startValue)
        setDragging(true)

        const move = (ev: PointerEvent) => {
            const currentPos = isHorizontal ? ev.clientY : ev.clientX
            last = clamp(startValue + sign * (currentPos - startPos))
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
        document.body.style.cursor = isHorizontal ? 'row-resize' : 'col-resize'
    }

    function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (e.key === 'Enter') {
            e.preventDefault()
            reset()
            return
        }
        const step = e.shiftKey ? STEP_FAST : STEP
        // La flecha apunta hacia donde se mueve el BORDE.
        const grow = isHorizontal
            ? resolvedEdge === 'bottom'
                ? 'ArrowDown'
                : 'ArrowUp'
            : resolvedEdge === 'right'
              ? 'ArrowRight'
              : 'ArrowLeft'
        const shrink = isHorizontal
            ? resolvedEdge === 'bottom'
                ? 'ArrowUp'
                : 'ArrowDown'
            : resolvedEdge === 'right'
              ? 'ArrowLeft'
              : 'ArrowRight'
        let next: number | null = null
        if (e.key === grow) next = value + step
        else if (e.key === shrink) next = value - step
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        if (next === null) return
        e.preventDefault()
        const nextClamped = clamp(next)
        onChange(nextClamped)
        onCommit?.(nextClamped)
    }

    function reset() {
        if (onResetAuto) {
            onResetAuto()
            return
        }
        const nextClamped = clamp(defaultValue)
        onChange(nextClamped)
        onCommit?.(nextClamped)
    }

    const posClass = isHorizontal
        ? `inset-x-0 h-1.5 cursor-row-resize ${resolvedEdge === 'bottom' ? '-bottom-0.5' : '-top-0.5'}`
        : `inset-y-0 w-1.5 cursor-col-resize ${resolvedEdge === 'right' ? '-right-0.5' : '-left-0.5'}`

    const badgePosClass = isHorizontal ? 'right-3 top-1/2 -translate-y-1/2' : 'left-1/2 top-3 -translate-x-1/2'

    return (
        <div
            role="separator"
            aria-orientation={orientation}
            aria-label={label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Math.round(value)}
            aria-valuetext={valueText?.(Math.round(value))}
            tabIndex={0}
            data-resize-handle
            data-orientation={orientation}
            data-size-mode={isAuto ? 'auto' : 'custom'}
            data-dragging={dragging ? '' : undefined}
            title={title}
            onPointerDown={onPointerDown}
            onDoubleClick={reset}
            onKeyDown={onKeyDown}
            className={`group absolute z-20 touch-none select-none outline-none ${posClass} ${
                dragging ? 'bg-primary/50' : 'hover:bg-primary/30 focus-visible:bg-primary/40'
            }`}
        >
            {dragging && (
                <span
                    className={`pointer-events-none absolute whitespace-nowrap rounded bg-primary px-1.5 py-0.5 text-ui-10 font-medium tabular-nums text-on-primary shadow ${badgePosClass}`}
                >
                    {Math.round(value)}
                    {unit}
                </span>
            )}
        </div>
    )
}
