import {useCallback, useEffect, useState} from 'react'
import {GetSettings, SetUIFontScale} from '../../wailsjs/go/main/App'

// Tamaño de letra de TODA la interfaz, en porcentaje.
//
// **Qué escala y qué no**: el texto y los íconos de la app —listas, menús,
// diálogos, etiquetas, badges—, en todos los módulos. NO los espaciados, ni el
// editor de código ni las terminales, que ya tienen su propio ajuste de cuerpo
// en Configuración y se eligen para otra cosa (leer código, no leer la
// interfaz).
//
// El mecanismo es una sola variable CSS, `--ui-font-scale`, que multiplica los
// tokens de tamaño de Tailwind, las utilidades `text-ui-*` y el cuerpo de los
// íconos — ver el bloque que la documenta en styles/globals.css. Una variable
// y no mil clases condicionales: son ~1150 tamaños de texto y ~680 de ícono
// repartidos por la app, y ninguno tuvo que enterarse de que existe un ajuste.
//
// Se llama UNA vez, arriba de todo (App.tsx), y se pasa hacia abajo — mismo
// patrón que useTheme, y por el mismo motivo: GetSettings y SetUIFontScale
// funcionan con el vault cerrado, así que el tamaño elegido también vale en la
// pantalla de desbloqueo. Quien no puede leer la app tampoco puede leer el
// formulario que le pide la clave.

// Presets. Un desplegable de cinco opciones y no un campo numérico: la
// pregunta que uno se hace es "¿más grande?", no "¿cuántos por ciento?".
export const UI_FONT_SCALES = [
    {value: 90, label: 'Compacto', hint: 'Entra más información en pantalla'},
    {value: 100, label: 'Normal', hint: 'El tamaño de siempre'},
    {value: 115, label: 'Grande', hint: 'Un poco más de cuerpo, sin cambiar la disposición'},
    {value: 130, label: 'Más grande', hint: 'Para leer sin acercarse a la pantalla'},
    {value: 150, label: 'Máximo', hint: 'El más grande antes de que las barras dejen de entrar'},
] as const

// 100 = el tamaño de siempre. Es también lo que significa el 0 que trae una
// instalación que nunca tocó el ajuste (columna ui_font_scale, migración 50):
// actualizar no cambia el aspecto de nadie.
export const DEFAULT_UI_FONT_SCALE = 100

const MIN_UI_FONT_SCALE = 80
const MAX_UI_FONT_SCALE = 200

function clamp(pct: number): number {
    if (!Number.isFinite(pct) || pct <= 0) return DEFAULT_UI_FONT_SCALE
    return Math.min(MAX_UI_FONT_SCALE, Math.max(MIN_UI_FONT_SCALE, Math.round(pct)))
}

function applyScale(pct: number) {
    // Sin unidad: `calc(11px * 1.15)` necesita un número pelado, no "115%".
    document.documentElement.style.setProperty('--ui-font-scale', String(pct / 100))
}

export function useUIFontScale() {
    const [uiFontScale, setState] = useState(DEFAULT_UI_FONT_SCALE)

    useEffect(() => {
        GetSettings()
            .then((s) => {
                const initial = clamp(s.uiFontScale)
                setState(initial)
                applyScale(initial)
            })
            // Sin preferencia leída se queda en el default, que ya es el valor
            // del CSS: no hace falta hacer nada y no vale interrumpir el
            // arranque por un tamaño de letra.
            .catch(() => {})
    }, [])

    const changeUIFontScale = useCallback((pct: number) => {
        const next = clamp(pct)
        setState(next)
        // Se aplica ANTES de guardar: el cambio tiene que verse en el momento,
        // y que el vault lo registre es lo de después.
        applyScale(next)
        SetUIFontScale(next).catch(() => {})
    }, [])

    return {uiFontScale, changeUIFontScale}
}
