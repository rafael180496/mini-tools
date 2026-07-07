import {useEffect, useState} from 'react'
import UnlockScreen from './components/lock/UnlockScreen'
import Workspace from './components/Workspace'
import {IsVaultInitialized, InitializeVault, UnlockVault, RestoreVaultBackup} from '../wailsjs/go/main/App'

function App() {
    const [isInitialized, setIsInitialized] = useState<boolean | null>(null)
    const [unlocked, setUnlocked] = useState(false)

    useEffect(() => {
        IsVaultInitialized().then(setIsInitialized)
    }, [])

    if (isInitialized === null) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-sm text-neutral-500">
                Cargando…
            </div>
        )
    }

    if (!unlocked) {
        return (
            <UnlockScreen
                isInitialized={isInitialized}
                onInitialize={async (password) => {
                    await InitializeVault(password)
                    setUnlocked(true)
                }}
                onUnlock={async (password) => {
                    await UnlockVault(password)
                    setUnlocked(true)
                }}
                onRestore={async () => {
                    await RestoreVaultBackup()
                    setIsInitialized(await IsVaultInitialized())
                }}
            />
        )
    }

    return <Workspace />
}

export default App
