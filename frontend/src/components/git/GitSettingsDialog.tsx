import {useCallback, useEffect, useState} from 'react'
import {
    GitCredentialHelper,
    GitDeleteCredential,
    GitIdentity,
    GitListCredentials,
    GitSaveCredential,
    GitSetCredentialHelper,
    GitSetIdentity,
} from '../../../wailsjs/go/main/App'
import type {git, vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import GitRemotesPanel from './GitRemotesPanel'

interface GitSettingsDialogProps {
    repoId: string
    repoName: string
    // Pestaña con la que abre. Quien la abre desde la lista de remotos ya sabe
    // qué venía a hacer; hacerle cruzar la de identidad primero sería pedirle
    // que repita lo que ya dijo con el click.
    initialTab?: Tab
    onClose: () => void
    // Called after a save that could change what a commit will be stamped with,
    // so the tab can refresh.
    onChanged: () => void
}

type Tab = 'identity' | 'remotes' | 'tokens'

// Git configuration for one repository: the author identity commits get
// stamped with, the remotes it talks to, and the stored access tokens used for
// network operations.
//
// Los remotos viven acá y no solo en el menú contextual del árbol porque es la
// misma pregunta que las otras dos pestañas —con qué identidad y con qué
// credencial hablo con este servidor— y porque un menú contextual hay que
// saber que existe: nadie hace click derecho para averiguar si se puede.
export default function GitSettingsDialog({repoId, repoName, initialTab, onClose, onChanged}: GitSettingsDialogProps) {
    const [tab, setTab] = useState<Tab>(initialTab ?? 'identity')
    const [error, setError] = useState<string | null>(null)

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex max-h-[85vh] w-[560px] flex-col rounded-xl border border-outline-variant bg-surface-container-high shadow-lg">
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-5 py-3">
                    <Icon name="settings" size={18} className="text-on-surface-variant" />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">Configuración de Git — {repoName}</h2>
                    <button onClick={onClose} title="Cerrar esta ventana" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                <div className="flex shrink-0 gap-0.5 border-b border-outline-variant px-3 py-2">
                    <TabButton active={tab === 'identity'} onClick={() => setTab('identity')} icon="person" label="Identidad" title="Configurar el nombre y el email con el que se firman tus commits" />
                    <TabButton active={tab === 'remotes'} onClick={() => setTab('remotes')} icon="cloud" label="Remotos" title="Ver y cambiar a qué servidor apuntan fetch, pull y push de este repositorio" />
                    <TabButton active={tab === 'tokens'} onClick={() => setTab('tokens')} icon="key" label="Tokens" title="Guardar tokens de acceso (PAT) por servidor, para push y pull por HTTPS" />
                </div>

                {error && (
                    <div className="mx-5 mt-3 flex items-start gap-2 rounded bg-error-container/50 p-2 text-ui-11 text-on-error-container">
                        <Icon name="error" size={14} className="mt-px shrink-0" />
                        <span className="min-w-0 flex-1 break-words">{error}</span>
                        <button onClick={() => setError(null)} title="Cerrar este error">
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto p-5">
                    {tab === 'identity' && <IdentityPanel repoId={repoId} onError={setError} onChanged={onChanged} />}
                    {tab === 'remotes' && <GitRemotesPanel repoId={repoId} onError={setError} onChanged={onChanged} />}
                    {tab === 'tokens' && <TokensPanel repoId={repoId} onError={setError} />}
                </div>
            </div>
        </div>
    )
}

function TabButton({active, onClick, icon, label, title}: {active: boolean; onClick: () => void; icon: string; label: string; title: string}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${
                active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
            }`}
        >
            <Icon name={icon} size={15} />
            {label}
        </button>
    )
}

function IdentityPanel({repoId, onError, onChanged}: {repoId: string; onError: (e: string | null) => void; onChanged: () => void}) {
    const [identity, setIdentity] = useState<git.Identity | null>(null)
    // Which config file the save targets. Defaulting to local is the safe
    // choice: a wrong local value affects one project, a wrong global one
    // affects every project on the machine.
    const [scope, setScope] = useState<'local' | 'global'>('local')
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)

    const load = useCallback(async () => {
        try {
            const id = await GitIdentity(repoId)
            setIdentity(id)
            setName(scope === 'local' ? id.localName : id.globalName)
            setEmail(scope === 'local' ? id.localEmail : id.globalEmail)
        } catch (e) {
            onError(String(e))
        }
    }, [repoId, scope, onError])

    useEffect(() => {
        void load()
    }, [load])

    async function save() {
        setSaving(true)
        setSaved(false)
        onError(null)
        try {
            await GitSetIdentity(repoId, name, email, scope === 'global')
            await load()
            onChanged()
            setSaved(true)
        } catch (e) {
            onError(String(e))
        } finally {
            setSaving(false)
        }
    }

    if (!identity) return <p className="text-xs text-on-surface-variant/70">Cargando…</p>

    return (
        <div className="space-y-4">
            {/* What git would actually stamp right now, and where it comes
                from. This is the whole point of the panel: an unexpected author
                email is almost always a global value being inherited invisibly. */}
            <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3">
                <p className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Se usará en tus commits</p>
                {identity.effectiveName || identity.effectiveEmail ? (
                    <>
                        <p className="mt-1 font-mono text-xs text-on-surface">
                            {identity.effectiveName || '(sin nombre)'} &lt;{identity.effectiveEmail || '(sin email)'}&gt;
                        </p>
                        <p className="mt-1 text-ui-10 text-on-surface-variant">
                            {identity.usingGlobal
                                ? 'Heredado de tu configuración global (~/.gitconfig). Este repositorio no tiene una identidad propia.'
                                : 'Definido localmente en este repositorio, pisa la configuración global.'}
                        </p>
                    </>
                ) : (
                    <p className="mt-1 text-ui-11 text-error">
                        No hay identidad configurada en ningún nivel. Git va a rechazar el commit hasta que completes al menos el email.
                    </p>
                )}
            </div>

            <div>
                <p className="mb-1.5 text-ui-11 text-on-surface-variant">Editar</p>
                <div className="flex gap-1">
                    <ScopeButton
                        active={scope === 'local'}
                        onClick={() => setScope('local')}
                        label="Solo este repositorio"
                        title="Guarda en .git/config — afecta únicamente a este proyecto y pisa la configuración global"
                    />
                    <ScopeButton
                        active={scope === 'global'}
                        onClick={() => setScope('global')}
                        label="Global (todos)"
                        title="Guarda en ~/.gitconfig — afecta a todos los repositorios de esta máquina que no tengan identidad propia"
                    />
                </div>
            </div>

            <Field label="Nombre" value={name} onChange={setName} placeholder="Rafael" title="El nombre que aparece como autor de cada commit" />
            <Field label="Email" value={email} onChange={setEmail} placeholder="rafael@ejemplo.com" title="El email del autor. Tiene que coincidir con uno verificado en tu forge para que los commits te sean atribuidos" />

            <p className="text-ui-10 text-on-surface-variant/70">
                Dejar un campo vacío <strong>borra</strong> esa clave en vez de guardarla en blanco
                {scope === 'local' ? ', así el repositorio vuelve a heredar el valor global.' : '.'}
            </p>

            <div className="flex items-center gap-2">
                <button
                    onClick={save}
                    disabled={saving}
                    title={scope === 'global' ? 'Guardar en ~/.gitconfig, afectando a todos tus repositorios' : 'Guardar solo en este repositorio'}
                    className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                >
                    {saving ? 'Guardando…' : 'Guardar'}
                </button>
                {saved && (
                    <span className="flex items-center gap-1 text-ui-11 text-secondary">
                        <Icon name="check" size={14} /> Guardado
                    </span>
                )}
            </div>
        </div>
    )
}

function ScopeButton({active, onClick, label, title}: {active: boolean; onClick: () => void; label: string; title: string}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={`flex-1 rounded px-2 py-1.5 text-ui-11 ${
                active ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-highest text-on-surface-variant hover:bg-surface-variant'
            }`}
        >
            {label}
        </button>
    )
}

// Cómo recuerda GIT las contraseñas HTTPS, que es otra cosa que cómo las
// recuerda esta app.
//
// Van juntos en la misma pestaña justamente porque son las dos mitades de la
// misma pregunta y elegir mal se paga: el token del vault lo usa la app, el
// credential helper lo usa git — o sea la terminal, los hooks, y esta app
// cuando no hay token guardado. Alguien que clona acá y hace pull desde una
// shell necesita el segundo, y hasta ahora no había forma de verlo ni de
// cambiarlo sin editar .gitconfig a mano.
function CredentialHelperPanel({repoId, onError}: {repoId: string; onError: (e: string | null) => void}) {
    const [cache, setCache] = useState<git.CredentialCache | null>(null)
    const [scope, setScope] = useState<'local' | 'global'>('global')
    const [saving, setSaving] = useState(false)

    const load = useCallback(async () => {
        try {
            const c = await GitCredentialHelper(repoId)
            setCache(c)
            // Arranca mostrando el ámbito donde el valor ya vive, para que
            // apagarlo apague lo que se está viendo y no cree un override
            // local encima de un global que sigue activo.
            setScope(c.helper && !c.global ? 'local' : 'global')
        } catch (e) {
            onError(String(e))
        }
    }, [repoId, onError])

    useEffect(() => {
        void load()
    }, [load])

    async function apply(helper: string) {
        setSaving(true)
        onError(null)
        try {
            await GitSetCredentialHelper(repoId, helper, scope === 'global')
            await load()
        } catch (e) {
            onError(String(e))
        } finally {
            setSaving(false)
        }
    }

    if (!cache) return null

    const current = cache.helper ?? ''
    const known = cache.available.some((o) => o.value === current)

    return (
        <div>
            <p className="mb-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Contraseñas recordadas por git</p>

            <div className="mb-2 rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-ui-10 leading-relaxed text-on-surface-variant">
                Esto <strong>no</strong> es el vault de arriba: es la configuración del propio git (<span className="font-mono">credential.helper</span>), la que usan la terminal, los hooks y esta app cuando no hay token guardado para ese servidor. Solo aplica a remotos HTTPS — con SSH quien decide es el ssh-agent.
            </div>

            <div className="mb-2 flex gap-1">
                <ScopeButton
                    active={scope === 'local'}
                    onClick={() => setScope('local')}
                    label="Este repositorio"
                    title="Guarda en .git/config: solo afecta a este proyecto y pisa la configuración global"
                />
                <ScopeButton
                    active={scope === 'global'}
                    onClick={() => setScope('global')}
                    label="Todos"
                    title="Guarda en ~/.gitconfig: afecta a todos tus repositorios que no tengan un valor propio"
                />
            </div>

            <select
                value={known ? current : ''}
                disabled={saving}
                onChange={(e) => void apply(e.target.value)}
                title="Cómo va a recordar git tu contraseña la próxima vez que un remoto HTTPS te la pida. «Preguntar siempre» borra la configuración y vuelve al comportamiento por defecto."
                className="w-full rounded bg-surface-container-highest px-2 py-1.5 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            >
                <option value="">Preguntar siempre (sin recordar)</option>
                {cache.available.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                        {o.secure ? '' : ' — sin cifrar'}
                    </option>
                ))}
            </select>

            {current !== '' && !known && (
                <p className="mt-1.5 text-ui-10 text-tertiary">
                    Configurado a mano como <span className="font-mono">{current}</span>. No lo toco desde acá: elegir una opción de la lista lo reemplaza.
                </p>
            )}
            {current !== '' && known && cache.global && scope === 'local' && (
                <p className="mt-1.5 text-ui-10 text-tertiary">
                    El valor actual viene de tu configuración global. Si elegís algo con «Este repositorio» seleccionado, vas a crear un valor propio que la pisa solo acá.
                </p>
            )}
            {current === '' && (
                <p className="mt-1.5 text-ui-10 text-on-surface-variant/70">
                    Hoy git no recuerda nada: cada operación HTTPS sin token guardado en el vault te va a pedir la contraseña.
                </p>
            )}
        </div>
    )
}

function TokensPanel({repoId, onError}: {repoId: string; onError: (e: string | null) => void}) {
    const [creds, setCreds] = useState<vault.GitCredential[]>([])
    const [host, setHost] = useState('')
    const [username, setUsername] = useState('')
    const [token, setToken] = useState('')
    const [saving, setSaving] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState<vault.GitCredential | null>(null)

    const load = useCallback(async () => {
        try {
            setCreds(await GitListCredentials())
        } catch (e) {
            onError(String(e))
        }
    }, [onError])

    useEffect(() => {
        void load()
    }, [load])

    async function save() {
        setSaving(true)
        onError(null)
        try {
            await GitSaveCredential(host, username, token)
            // Cleared immediately after the call: the token has no reason to
            // stay in React state once it is in the vault, and it is never
            // read back — the list below intentionally has no token column.
            setHost('')
            setUsername('')
            setToken('')
            await load()
        } catch (e) {
            onError(String(e))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-4">
            <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-ui-10 leading-relaxed text-on-surface-variant">
                Los tokens se guardan cifrados en el vault y se usan automáticamente en fetch, pull y push contra ese servidor. Nunca viajan por la línea de comandos ni quedan en la URL del remoto, y no se pueden volver a leer desde acá — si perdés uno, generá otro en tu forge y reemplazalo.
                <br />
                <br />
                Si no guardás ninguno, git resuelve las credenciales como siempre (llavero del sistema, credential helper, ssh-agent).
            </div>

            <CredentialHelperPanel repoId={repoId} onError={onError} />

            <div>
                <p className="mb-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Guardados</p>
                {creds.length === 0 && <p className="text-ui-11 text-on-surface-variant/60">Ninguno todavía.</p>}
                {creds.map((c) => (
                    <div key={c.id} className="group flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-surface-variant/50">
                        <Icon name="key" size={14} className="shrink-0 text-on-surface-variant/70" />
                        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">{c.host}</span>
                        <span className="shrink-0 text-ui-10 text-on-surface-variant">{c.username}</span>
                        <button
                            onClick={() => setConfirmDelete(c)}
                            title={`Borrar el token guardado para ${c.host}`}
                            className="shrink-0 rounded p-0.5 text-error opacity-0 hover:bg-error-container/40 group-hover:opacity-100"
                        >
                            <Icon name="delete" size={14} />
                        </button>
                    </div>
                ))}
            </div>

            <div className="space-y-3 border-t border-outline-variant pt-4">
                <p className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Agregar o reemplazar</p>
                <Field
                    label="Servidor"
                    value={host}
                    onChange={setHost}
                    placeholder="github.com"
                    title="El host del remoto. Podés pegar la URL completa del repositorio — se queda solo con el host, así un token sirve para todos tus repos de ese servidor"
                />
                <Field
                    label="Usuario"
                    value={username}
                    onChange={setUsername}
                    placeholder="tu-usuario"
                    title="Tu nombre de usuario en el servidor. La mayoría de los forges lo ignoran cuando se usa un token, pero git igual lo pide"
                />
                <Field
                    label="Token (PAT)"
                    value={token}
                    onChange={setToken}
                    password
                    placeholder="ghp_…"
                    title="El Personal Access Token generado en tu forge. Se guarda cifrado y no se puede volver a ver desde la app"
                />
                <button
                    onClick={save}
                    disabled={saving || !host.trim() || !token.trim()}
                    title={!host.trim() || !token.trim() ? 'Completá el servidor y el token' : 'Guardar el token cifrado en el vault'}
                    className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                >
                    {saving ? 'Guardando…' : 'Guardar token'}
                </button>
            </div>

            {confirmDelete && (
                <ConfirmDialog
                    title="Borrar token"
                    description={`Esto borra el token guardado para "${confirmDelete.host}". Las operaciones contra ese servidor van a volver a depender del llavero del sistema o del credential helper de git. El token en sí sigue siendo válido en tu forge — si querés invalidarlo de verdad, revocalo ahí.`}
                    confirmLabel="Borrar"
                    danger
                    onConfirm={async () => {
                        try {
                            await GitDeleteCredential(confirmDelete.id)
                            await load()
                        } catch (e) {
                            onError(String(e))
                        }
                    }}
                    onClose={() => setConfirmDelete(null)}
                />
            )}
        </div>
    )
}

function Field({
    label,
    value,
    onChange,
    placeholder,
    title,
    password,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    title: string
    password?: boolean
}) {
    return (
        <div>
            <label className="block text-ui-11 text-on-surface-variant" title={title}>
                {label}
            </label>
            <input
                type={password ? 'password' : 'text'}
                value={value}
                placeholder={placeholder}
                title={title}
                onChange={(e) => onChange(e.target.value)}
                className="mt-1 w-full rounded border-none bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
            />
        </div>
    )
}
