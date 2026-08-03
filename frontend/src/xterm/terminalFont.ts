// Límites del cuerpo de fuente de las terminales, espejo de
// vault.MinTerminalFontSize/MaxTerminalFontSize (backend/vault/settings_repo.go).
//
// Existen del lado del frontend además de en Go porque el backend ACOTA al
// guardar en silencio: sin estos, un botón "+" seguiría clickeable después
// del máximo sin que pasara nada, que es la peor forma de comunicar un
// límite. Con ellos el botón se deshabilita y el tooltip explica por qué.
//
// Por debajo de 8px el texto deja de leerse; por encima de 32 entran tan
// pocas columnas que cualquier salida tabulada se rompe sola.
export const TERMINAL_FONT_MIN = 8
export const TERMINAL_FONT_MAX = 32
export const TERMINAL_FONT_DEFAULT = 13
