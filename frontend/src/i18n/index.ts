import {useSyncExternalStore} from 'react'
import es from './es'
import en from './en'

// Núcleo de i18n. Ver .claude/specs/i18n.md.
//
// **Sin librería.** Los textos son objetos tipados: `t.notes.menu.rename` en
// vez de `t('notes.menu.rename')`. El compilador valida que exista, el editor
// lo autocompleta, y el diccionario inglés tiene que tener la misma forma que
// el español (ver types.ts) — lo que una librería resolvería en runtime acá
// lo resuelve `tsc`.
//
// **Cambio en caliente sin remontar.** Remontar el árbol cerraría las
// terminales SSH y cancelaría las consultas en vuelo; en cambio, cada
// componente que muestra texto se suscribe con useT() y se redibuja solo.

export type Lang = 'en' | 'es'
export type Dict = typeof es

// Inglés mientras no se haya elegido: la primera vez la app habla inglés, y
// desde Configuración se pasa a español (pedido explícito).
export const DEFAULT_LANG: Lang = 'en'

export const LANGUAGES: {id: Lang; label: string}[] = [
    {id: 'en', label: 'English'},
    {id: 'es', label: 'Español'},
]

const dicts: Record<Lang, Dict> = {es, en}

let current: Lang = DEFAULT_LANG
const listeners = new Set<() => void>()

// normalizeLang convierte lo que viene del vault ('' = sin elegir, o un valor
// viejo desconocido) en un idioma con diccionario.
export function normalizeLang(raw: string | null | undefined): Lang {
    return raw === 'es' || raw === 'en' ? raw : DEFAULT_LANG
}

export function getLanguage(): Lang {
    return current
}

// setLanguage cambia el idioma en memoria y redibuja a los suscriptos. No
// persiste: eso lo hace quien llama (SetLanguage del backend), para que el
// núcleo no dependa de los bindings de Wails.
export function setLanguage(lang: Lang) {
    if (lang === current) return
    current = lang
    document.documentElement.lang = lang
    for (const l of listeners) l()
}

function subscribe(cb: () => void) {
    listeners.add(cb)
    return () => listeners.delete(cb)
}

// useT devuelve el diccionario del idioma activo y redibuja el componente
// cuando cambia. Es la forma normal de leer un texto en un componente.
export function useT(): Dict {
    const lang = useSyncExternalStore(subscribe, getLanguage)
    return dicts[lang]
}

// useLang devuelve el idioma activo (para Intl, o para elegir la ayuda).
export function useLang(): Lang {
    return useSyncExternalStore(subscribe, getLanguage)
}

// t() es el diccionario activo fuera de un componente (lib/, callbacks). Leé
// el texto en el momento de usarlo, no lo guardes: un texto guardado en una
// constante de módulo se queda en el idioma con el que arrancó.
export function t(): Dict {
    return dicts[current]
}

// locale es el locale de Intl para el idioma activo.
export function locale(lang: Lang = current): string {
    return lang === 'es' ? 'es-ES' : 'en-US'
}

// formatDateTime formatea un instante (Date o epoch en SEGUNDOS, como los
// guarda el vault) en el idioma activo. No usar con fechas leídas de Oracle en
// hora de pared: esas se muestran tal cual.
export function formatDateTime(v: Date | number, opts: Intl.DateTimeFormatOptions = {dateStyle: 'medium', timeStyle: 'short'}): string {
    const d = typeof v === 'number' ? new Date(v * 1000) : v
    return new Intl.DateTimeFormat(locale(), opts).format(d)
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(locale(), opts).format(n)
}

// Códigos de error del backend (backend/i18n.NewCoded). Viajan al principio del
// mensaje entre dos U+2063 (invisibles), porque un error de Go cruza el
// binding de Wails como string sin tipo. Con esto una pantalla reacciona a UN
// caso puntual —conflicto al guardar, contraseña vencida— sin comparar contra
// un texto que cambia con el idioma.
const CODE_MARK = '⁣'

export function errorCode(e: unknown): string | null {
    const s = String(e)
    const i = s.indexOf(CODE_MARK)
    if (i < 0) return null
    const j = s.indexOf(CODE_MARK, i + 1)
    return j < 0 ? null : s.slice(i + 1, j)
}

// errorText es el mensaje sin el código (y sin el "Error: " que agrega String()
// a un objeto Error), listo para mostrar.
export function errorText(e: unknown): string {
    return String(e)
        .replace(/^Error: /, '')
        .replace(new RegExp(`${CODE_MARK}[^${CODE_MARK}]*${CODE_MARK}`, 'g'), '')
}
