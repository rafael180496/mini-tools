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
export default function Icon({name, className, filled, size}: IconProps) {
    return (
        <span
            className={`material-symbols-outlined${className ? ` ${className}` : ''}`}
            style={{
                fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 20`,
                ...(size ? {fontSize: size} : {}),
            }}
            aria-hidden="true"
        >
            {name}
        </span>
    )
}
