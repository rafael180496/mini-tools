import {useState} from 'react'
import {GitCloneRepo, GitPickFolder} from '../../../wailsjs/go/main/App'
import {git, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'

interface GitCloneDialogProps {
    onClose: () => void
    // Called with the freshly-registered repo so the caller can refresh the
    // list and optionally open it.
    onCloned: (repo: vault.GitRepo) => void
}

// deriveName pulls the repository name out of a clone URL so the destination
// subfolder is pre-filled — "https://github.com/user/my-repo.git" → "my-repo",
// "git@github.com:user/my-repo.git" → "my-repo". Empty when it cannot tell,
// leaving the field for the user.
function deriveName(url: string): string {
    const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
    const lastSlash = trimmed.lastIndexOf('/')
    const lastColon = trimmed.lastIndexOf(':')
    const cut = Math.max(lastSlash, lastColon)
    return cut >= 0 ? trimmed.slice(cut + 1) : ''
}

// Clone dialog: Source URL + Destination + Name, matching the shape of a
// standard Git client's clone panel. The token stored for the URL's host (if
// any) is used automatically by the backend, so private repos clone without a
// separate auth step here.
export default function GitCloneDialog({onClose, onCloned}: GitCloneDialogProps) {
    const t = useT()
    const [url, setUrl] = useState('')
    const [name, setName] = useState('')
    // Whether the user has edited the name — once they have, stop overwriting
    // it from the URL, so a deliberate rename is not clobbered on the next
    // keystroke in the URL field.
    const [nameTouched, setNameTouched] = useState(false)
    const [dest, setDest] = useState('')
    const [cloning, setCloning] = useState(false)
    const [error, setError] = useState<string | null>(null)

    function onUrlChange(v: string) {
        setUrl(v)
        if (!nameTouched) setName(deriveName(v))
    }

    async function pickDest() {
        try {
            const p = await GitPickFolder(t.git.clone.pickDestTitle)
            if (p) setDest(p)
        } catch (e) {
            setError(String(e))
        }
    }

    async function clone() {
        setError(null)
        if (!url.trim()) {
            setError(t.git.clone.missingUrl)
            return
        }
        if (!dest.trim()) {
            setError(t.git.clone.missingDest)
            return
        }
        if (!name.trim()) {
            setError(t.git.clone.missingName)
            return
        }
        // The backend clones into an empty directory, so the final target is
        // destination + name — matching how the fields read ("clonar dentro de
        // esta carpeta, en una subcarpeta con este nombre").
        const sep = dest.includes('\\') ? '\\' : '/'
        const target = dest.replace(/[\\/]+$/, '') + sep + name.trim()

        setCloning(true)
        try {
            const repo = await GitCloneRepo(url.trim(), target, new git.AuthConfig({}))
            onCloned(repo)
            onClose()
        } catch (e) {
            setError(String(e))
        } finally {
            setCloning(false)
        }
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="w-[32rem] rounded-xl border border-outline-variant bg-surface-container-high p-6 shadow-lg">
                <div className="flex items-center gap-2">
                    <Icon name="cloud_download" size={18} className="text-on-surface-variant" />
                    <h2 className="flex-1 text-sm font-medium text-on-surface">{t.git.clone.title}</h2>
                    <button onClick={onClose} title={t.git.clone.closeWithoutCloning} className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                <p className="mt-2 text-ui-11 leading-relaxed text-on-surface-variant">
                    {t.git.clone.intro}
                </p>

                {error && (
                    <div className="mt-3 flex items-start gap-2 rounded bg-error-container/50 p-2 text-ui-11 text-on-error-container">
                        <Icon name="error" size={14} className="mt-px shrink-0" />
                        <span className="min-w-0 flex-1 break-words">{error}</span>
                    </div>
                )}

                <label className="mt-4 block text-ui-11 text-on-surface-variant">{t.git.clone.urlLabel}</label>
                <input
                    autoFocus
                    value={url}
                    onChange={(e) => onUrlChange(e.target.value)}
                    placeholder={t.git.clone.urlPlaceholder}
                    title={t.git.clone.urlTitle}
                    className="mt-1 w-full rounded border-none bg-surface-container-highest px-2 py-1.5 font-mono text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
                />

                <label className="mt-3 block text-ui-11 text-on-surface-variant">{t.git.clone.nameLabel}</label>
                <input
                    value={name}
                    onChange={(e) => {
                        setNameTouched(true)
                        setName(e.target.value)
                    }}
                    placeholder={t.git.clone.namePlaceholder}
                    title={t.git.clone.nameTitle}
                    className="mt-1 w-full rounded border-none bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
                />

                <label className="mt-3 block text-ui-11 text-on-surface-variant">{t.git.clone.destLabel}</label>
                <div className="mt-1 flex gap-2">
                    <input
                        value={dest}
                        onChange={(e) => setDest(e.target.value)}
                        placeholder={t.git.clone.destPlaceholder}
                        title={t.git.clone.destTitle}
                        className="min-w-0 flex-1 rounded border-none bg-surface-container-highest px-2 py-1.5 font-mono text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
                    />
                    <button onClick={pickDest} title={t.git.clone.pickDest} className="shrink-0 rounded bg-surface-variant px-3 text-xs text-on-surface-variant hover:bg-surface-container-highest">
                        …
                    </button>
                </div>
                {dest && name && (
                    <p className="mt-1.5 truncate font-mono text-ui-10 text-on-surface-variant/60" title={t.git.clone.finalPathTitle}>
                        → {dest.replace(/[\\/]+$/, '')}/{name.trim()}
                    </p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <button onClick={onClose} title={t.git.clone.closeWithoutCloning} className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant">
                        {t.common.cancel}
                    </button>
                    <button
                        onClick={clone}
                        disabled={cloning || !url.trim() || !dest.trim() || !name.trim()}
                        title={cloning ? t.git.clone.cloning : t.git.clone.cloneTitle}
                        className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {cloning && <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-on-primary" />}
                        {cloning ? t.git.clone.cloning : t.git.clone.clone}
                    </button>
                </div>
            </div>
        </div>
    )
}
