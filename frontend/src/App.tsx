import {useEffect, useState} from 'react'
import UnlockScreen from './components/lock/UnlockScreen'
import Workspace from './components/Workspace'
import {IsVaultInitialized, InitializeVault, UnlockVault, RestoreVaultBackup, TryAutoUnlock} from '../wailsjs/go/main/App'
import {useTheme} from './hooks/useTheme'

function App() {
    const [isInitialized, setIsInitialized] = useState<boolean | null>(null)
    const [unlocked, setUnlocked] = useState(false)
    const {theme, toggleTheme} = useTheme()

    useEffect(() => {
        // isInitialized is only set once TryAutoUnlock (the "Recordar
        // clave" toggle) has already had its chance to run — otherwise
        // UnlockScreen would flash briefly before auto-unlock resolves.
        async function init() {
            const initialized = await IsVaultInitialized()
            if (initialized) {
                const autoUnlocked = await TryAutoUnlock()
                if (autoUnlocked) setUnlocked(true)
            }
            setIsInitialized(initialized)
        }
        void init()
    }, [])

    if (isInitialized === null) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-background font-sans text-sm text-on-surface-variant">
                Cargando…
            </div>
        )
    }

    if (!unlocked) {
        return (
            <UnlockScreen
                isInitialized={isInitialized}
                theme={theme}
                onToggleTheme={toggleTheme}
                onInitialize={async (password) => {
                    await InitializeVault(password)
                    setUnlocked(true)
                }}
                onUnlock={async (password) => {
                    await UnlockVault(password)
                    setUnlocked(true)
                }}
                onRestore={async (password) => {
                    await RestoreVaultBackup(password)
                    setIsInitialized(await IsVaultInitialized())
                }}
            />
        )
    }

    return <Workspace theme={theme} onToggleTheme={toggleTheme} onLocked={() => setUnlocked(false)} />
}

export default App
