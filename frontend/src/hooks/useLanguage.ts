import {useCallback} from 'react'
import {GetSettings, SetLanguage} from '../../wailsjs/go/main/App'
import {normalizeLang, setLanguage, useLang, type Lang} from '../i18n'

// Idioma de la interfaz. Ver .claude/specs/i18n.md.
//
// Mismo patrón que useTheme/useUIFontScale: GetSettings y SetLanguage
// funcionan con el vault cerrado, así que el idioma elegido vale también en la
// pantalla de desbloqueo.

// loadLanguage lee el idioma guardado y lo aplica. App.tsx lo espera ANTES de
// dibujar la pantalla de desbloqueo: sin eso, quien eligió español vería un
// instante la pantalla en inglés en cada arranque.
export async function loadLanguage(): Promise<void> {
    try {
        const s = await GetSettings()
        setLanguage(normalizeLang(s.language))
    } catch {
        // Sin settings legibles se queda el idioma por defecto: mejor una
        // interfaz en inglés que una sin arrancar.
    }
}

export function useLanguage() {
    const lang = useLang()
    const changeLanguage = useCallback((next: Lang) => {
        setLanguage(next)
        void SetLanguage(next).catch(() => {})
    }, [])
    return {lang, changeLanguage}
}
