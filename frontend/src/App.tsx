import {useEffect, useState} from 'react'
import UnlockScreen from './components/lock/UnlockScreen'
import {IsVaultInitialized, InitializeVault, UnlockVault} from '../wailsjs/go/main/App'

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
            />
        )
    }

    return (
        <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100">
            <div className="flex flex-col items-center gap-2">
                <h1 className="text-2xl font-semibold">mini-tools</h1>
                <p className="text-sm text-emerald-400">Vault desbloqueado</p>
            </div>
        </div>
    )
}

export default App
