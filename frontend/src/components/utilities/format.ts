import {formatNumber} from '../../i18n'

// Tamaños y tasas. Las unidades (KB, MB…) son símbolos, iguales en los dos
// idiomas; lo que cambia con el idioma es el separador decimal, que sale de
// formatNumber.
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number): string {
    let v = Math.max(0, n)
    let i = 0
    while (v >= 1024 && i < UNITS.length - 1) {
        v /= 1024
        i++
    }
    // Sin decimales en bytes y en las cifras de tres dígitos: «512 MB» y no
    // «512,0 MB». Una cifra chica sí lleva uno: «1,5 GB».
    const digits = i === 0 || v >= 100 ? 0 : 1
    return `${formatNumber(v, {minimumFractionDigits: digits, maximumFractionDigits: digits})} ${UNITS[i]}`
}

export function formatRate(bytesPerSec: number): string {
    return `${formatBytes(bytesPerSec)}/s`
}

export function formatPercent(v: number, digits = 1): string {
    return formatNumber(v, {minimumFractionDigits: digits, maximumFractionDigits: digits})
}
