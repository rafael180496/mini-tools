interface IconProps {
    name: string
    className?: string
    filled?: boolean
    size?: number
}

// Wrapper for the self-hosted Material Symbols Outlined font (see
// globals.css's .material-symbols-outlined rule + @font-face) — `name` is
// the icon's ligature name (e.g. "search", "close", "power_settings_new"),
// looked up at https://fonts.google.com/icons. Every icon in the app should
// go through this component instead of writing the <span> by hand, so the
// FILL/size defaults stay consistent.
//
// `size` es el cuerpo BASE en píxeles, no el final: se multiplica por
// --ui-font-scale, la escala de texto de la interfaz (ver globals.css). Un
// ícono es una fuente y acompaña a una palabra: dejarlo fijo mientras el texto
// de al lado crece lo deja diminuto y descalzado, que es de dónde salía la
// impresión de que los íconos eran chicos. Que el multiplicador viva acá y no
// en cada llamador es justamente el motivo por el que este componente existe:
// son ~680 usos con su tamaño escrito a mano.
export default function Icon({name, className, filled, size}: IconProps) {
    return (
        <span
            className={`material-symbols-outlined${className ? ` ${className}` : ''}`}
            style={{
                fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 20`,
                ...(size ? {fontSize: `calc(${size}px * var(--ui-font-scale))`} : {}),
            }}
            aria-hidden="true"
        >
            {name}
        </span>
    )
}
