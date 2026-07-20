import {useEffect, useState} from 'react'
import UnlockScreen from './components/lock/UnlockScreen'
import Workspace from './components/Workspace'
import {IsVaultInitialized, InitializeVault, UnlockVault, RestoreVaultBackupFirstRun, TryAutoUnlock, CheckForUpdate} from '../wailsjs/go/main/App'
import {updatecheck} from '../wailsjs/go/models'
import {useTheme} from './hooks/useTheme'

function App() {
    const [isInitialized, setIsInitialized] = useState<boolean | null>(null)
    const [unlocked, setUnlocked] = useState(false)
    const [updateInfo, setUpdateInfo] = useState<updatecheck.Info | null>(null)
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

    useEffect(() => {
        // Lives here (not inside Workspace) on purpose: Workspace unmounts
        // every time the vault gets locked (onLocked below), so a check
        // placed there would really run once per unlock, not once per app
        // session. App never unmounts while the process is alive, so this
        // truly runs once. A slow/absent network must never delay
        // UnlockScreen/Workspace — this effect is independent of the
        // init() one above.
        CheckForUpdate()
            .then(setUpdateInfo)
            .catch(() => {})
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
                onRestore={async (path, backupPassword) => {
                    await RestoreVaultBackupFirstRun(path, backupPassword)
                    setIsInitialized(await IsVaultInitialized())
                }}
            />
        )
    }

    return <Workspace theme={theme} onToggleTheme={toggleTheme} onLocked={() => setUnlocked(false)} updateInfo={updateInfo} />
}

export default App
