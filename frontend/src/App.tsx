import {useCallback, useEffect, useState, type ReactNode} from 'react'
import TitleBar, {type TitleBarAdeProps} from './components/TitleBar'
import UnlockScreen from './components/lock/UnlockScreen'
import Workspace from './components/Workspace'
import {IsVaultInitialized, InitializeVault, UnlockVault, RestoreVaultBackupFirstRun, TryAutoUnlock, CheckForUpdate} from '../wailsjs/go/main/App'
import {updatecheck, vault} from '../wailsjs/go/models'
import {useTheme} from './hooks/useTheme'
import {useUIFontScale} from './hooks/useUIFontScale'
import {useLayoutMode} from './hooks/useLayoutMode'
import {loadLanguage} from './hooks/useLanguage'
import {useT} from './i18n'

function App() {
    const [isInitialized, setIsInitialized] = useState<boolean | null>(null)
    const [unlocked, setUnlocked] = useState(false)
    const [updateInfo, setUpdateInfo] = useState<updatecheck.Info | null>(null)
    const {theme, toggleTheme} = useTheme()
    const {uiFontScale, changeUIFontScale} = useUIFontScale()
    const {layout, setMode, toggleGridFiles, toggleGridChanges} = useLayoutMode()
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [topBarContext, setTopBarContext] = useState<{label: string; icon: string; hasGitContext?: boolean; activeRepoId?: string | null}>({
        label: '',
        icon: 'workspaces',
        hasGitContext: false,
        activeRepoId: null,
    })
    const [pendingOpenRepo, setPendingOpenRepo] = useState<{repo: vault.GitRepo; token: number} | null>(null)
    const t = useT()

    const handleTopBarContext = useCallback((ctx: {label: string; icon: string; hasGitContext?: boolean; activeRepoId?: string | null}) => {
        setTopBarContext((prev) =>
            prev.label === ctx.label &&
            prev.icon === ctx.icon &&
            prev.hasGitContext === ctx.hasGitContext &&
            prev.activeRepoId === ctx.activeRepoId
                ? prev
                : ctx,
        )
    }, [])

    useEffect(() => {
        // isInitialized is only set once TryAutoUnlock (the "Recordar
        // clave" toggle) has already had its chance to run — otherwise
        // UnlockScreen would flash briefly before auto-unlock resolves.
        async function init() {
            // El idioma primero: todo lo que se dibuje después ya tiene que
            // salir en el elegido (ver hooks/useLanguage.ts).
            await loadLanguage()
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

    const adeTopBar: TitleBarAdeProps | undefined = unlocked
        ? {
              mode: layout.mode,
              onChangeMode: setMode,
              contextLabel: topBarContext.label,
              contextIcon: topBarContext.icon,
              activeRepoId: topBarContext.activeRepoId,
              hasGitContext: topBarContext.hasGitContext,
              onSelectRepo: (repo) => setPendingOpenRepo({repo, token: Date.now()}),
              onOpenPalette: () => setPaletteOpen((o) => !o),
              gridFilesOpen: layout.gridFilesOpen,
              gridChangesOpen: layout.gridChangesOpen,
              onToggleGridFiles: toggleGridFiles,
              onToggleGridChanges: toggleGridChanges,
          }
        : undefined

    const frame = (children: ReactNode) => (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-background font-sans text-on-background">
            <TitleBar ade={adeTopBar} />
            <div className="min-h-0 flex-1">{children}</div>
        </div>
    )

    if (isInitialized === null) {
        return frame(
            <div className="flex h-full w-full items-center justify-center text-sm text-on-surface-variant">{t.common.loading}</div>,
        )
    }

    if (!unlocked) {
        return frame(
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
            />,
        )
    }

    return frame(
        <Workspace
            theme={theme}
            onToggleTheme={toggleTheme}
            onLocked={() => {
                setPaletteOpen(false)
                setUnlocked(false)
            }}
            updateInfo={updateInfo}
            uiFontScale={uiFontScale}
            onChangeUIFontScale={changeUIFontScale}
            adeMode={layout.mode}
            onChangeAdeMode={setMode}
            paletteOpen={paletteOpen}
            onTogglePalette={() => setPaletteOpen((o) => !o)}
            onClosePalette={() => setPaletteOpen(false)}
            onTopBarContextChange={handleTopBarContext}
            openRepoRequest={pendingOpenRepo}
        />,
    )
}

export default App
