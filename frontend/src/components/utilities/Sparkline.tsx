// Una serie corta dibujada como línea con relleno, sin ejes ni leyenda: de un
// vistazo dice si algo sube, baja o está plano. El número exacto va en texto al
// lado (un gráfico no es la única forma de saberlo), por eso el SVG es
// decorativo para los lectores de pantalla.
//
// `max` fija el techo del eje: la CPU usa 100 para que 5 % se vea como poco y no
// como el máximo de una escala que se auto-ajusta; la red lo deja libre.
interface SparklineProps {
    // Puntos, del más viejo al más nuevo.
    values: number[]
    max: number
    // Cuántos puntos caben de ancho: la serie se alinea a la DERECHA, así una
    // historia corta crece desde el borde en vez de estirarse a todo el ancho.
    capacity: number
    className?: string
    // Línea secundaria (la subida de la red) sobre la misma escala.
    secondary?: number[]
    secondaryClassName?: string
}

const W = 120
const H = 32

function path(values: number[], max: number, capacity: number): {line: string; area: string} {
    if (values.length < 2 || max <= 0) return {line: '', area: ''}
    const step = W / (capacity - 1)
    const x0 = W - (values.length - 1) * step
    const pts = values.map((v, i) => [x0 + i * step, H - 1 - Math.min(1, Math.max(0, v / max)) * (H - 2)] as const)
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
    return {line, area: `${line} L${W} ${H} L${x0.toFixed(1)} ${H} Z`}
}

export default function Sparkline({values, max, capacity, className = 'text-primary', secondary, secondaryClassName = 'text-tertiary'}: SparklineProps) {
    const a = path(values, max, capacity)
    const b = secondary ? path(secondary, max, capacity) : null
    return (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className="h-8 w-full">
            {/* La base: sin ella, una serie sin datos deja un hueco en blanco. */}
            <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} className="stroke-outline-variant" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {a.line && (
                <>
                    <path d={a.area} className={`fill-current opacity-15 ${className}`} />
                    <path d={a.line} fill="none" className={`stroke-current ${className}`} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </>
            )}
            {b?.line && (
                <path d={b.line} fill="none" className={`stroke-current ${secondaryClassName}`} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            )}
        </svg>
    )
}
