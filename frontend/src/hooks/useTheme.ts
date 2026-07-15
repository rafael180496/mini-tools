import {useCallback, useEffect, useState} from 'react'
import {GetSettings, SetTheme} from '../../wailsjs/go/main/App'

export type Theme = 'dark' | 'light'

function applyTheme(theme: Theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark')
}

// Single source of truth for the theme, meant to be called once at the top
// (App.tsx) and passed down — GetSettings/SetTheme work even while the
// vault is locked (see app.go), so the theme applies on the unlock screen
// too, before there's anything else to fetch.
export function useTheme() {
    const [theme, setThemeState] = useState<Theme>('dark')

    useEffect(() => {
        GetSettings()
            .then((s) => {
                const initial: Theme = s.theme === 'light' ? 'light' : 'dark'
                setThemeState(initial)
                applyTheme(initial)
            })
            .catch(() => {})
    }, [])

    const toggleTheme = useCallback(() => {
        setThemeState((prev) => {
            const next: Theme = prev === 'dark' ? 'light' : 'dark'
            applyTheme(next)
            SetTheme(next).catch(() => {})
            return next
        })
    }, [])

    return {theme, toggleTheme}
}
