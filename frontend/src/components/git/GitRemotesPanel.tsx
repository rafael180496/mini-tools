import {useCallback, useEffect, useState} from 'react'
import {
    GitAddRemote,
    GitRemoteURLForCopy,
    GitRemoteURLsForEdit,
    GitRemotes,
    GitRemoveRemote,
    GitRenameRemote,
    GitSaveCredential,
    GitSetRemoteURLs,
} from '../../../wailsjs/go/main/App'
import type {git} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'

// Editor de remotos, al estilo del panel de Sublime Merge: la lista completa
// con su URL, y un formulario que deja cambiarle el nombre, la URL de fetch y
// la de push sin salir a la terminal.
//
// Es un panel y no una ventana propia porque vive como pestaña de
// GitSettingsDialog, junto a la identidad y a los tokens: son las tres mitades
// de "con quién y contra qué servidor habla este repositorio", y separarlas en
// ventanas distintas obligaría a recordar cuál de las tres abre cada cosa.
//
// Hasta ahora lo único que había era "Cambiar URL" en el menú contextual del
// árbol, que abre un prompt de una línea: sirve para pegar una URL nueva, no
// para VER qué hay configurado — que es justo lo que se necesita cuando el
// remoto dejó de funcionar porque el token embebido venció.
//
// Las URLs se muestran TAL CUAL, con el token si lo tienen. Taparlo no protegía
// nada —ya está en texto plano en .git/config y `git remote -v` lo imprime— y
// escondía, en la única pantalla que muestra remotos, el dato sobre el que hay
// que actuar.

interface EmbeddedCredential {
    // Usuario de la URL. Vacío cuando el userinfo es un token suelto
    // (https://ghp_xxx@github.com/…), que es como los pega la mayoría.
    username: string
    secret: string
    host: string
    // La misma URL sin el userinfo, que es lo que queda configurado si el
    // token se muda al vault.
    clean: string
}

// looksLikeSecret decide si un userinfo suelto (https://ALGO@host/…) es un
// token o el nombre de usuario de siempre.
//
// La diferencia importa porque de un lado se ofrece mudarlo al vault y del
// otro no: guardar "rafael" como si fuera un token dejaría el remoto sin
// credencial y con un secreto inventado en el vault. Los prefijos son los de
// GitHub y GitLab; el largo es el que separa un login de un token, ninguno de
// los dos formatos baja de treinta y pico de caracteres.
function looksLikeSecret(v: string): boolean {
    return /^(gh[pousr]_|github_pat_|glpat-|glptt-)/.test(v) || v.length >= 24
}

// readEmbeddedCredential detecta una credencial escrita dentro de la URL.
//
// Solo http(s): en un remoto SSH (git@github.com:u/r.git) el "git@" es el
// nombre de usuario del servidor, no un secreto, y avisar ahí sería una
// advertencia falsa sobre la configuración más común que existe.
function readEmbeddedCredential(raw: string): EmbeddedCredential | null {
    let u: URL
    try {
        u = new URL(raw.trim())
    } catch {
        return null
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.username) return null

    const user = decodeURIComponent(u.username)
    const pass = decodeURIComponent(u.password)
    // Sin password, el userinfo es el token solo (así lo pega todo el mundo) o
    // un usuario suelto, que no es un secreto y no hay nada que mudar.
    if (!pass && !looksLikeSecret(user)) return null

    const clean = `${u.protocol}//${u.host}${u.pathname}${u.search}`
    return {username: pass ? user : '', secret: pass || user, host: u.host, clean}
}

interface Draft {
    // Nombre con el que se abrió el formulario. Vacío = remoto nuevo.
    original: string
    name: string
    fetchUrl: string
    pushUrl: string
}

interface PanelProps {
    repoId: string
    onError: (e: string | null) => void
    // Se llama después de cada escritura, para que quien abrió el panel
    // recargue su propia lista de remotos y ramas.
    onChanged: () => void
}

export default function GitRemotesPanel({repoId, onError, onChanged}: PanelProps) {
    const [remotes, setRemotes] = useState<git.Remote[]>([])
    const [draft, setDraft] = useState<Draft | null>(null)
    const [busy, setBusy] = useState(false)
    const [note, setNote] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<git.Remote | null>(null)

    const load = useCallback(async () => {
        try {
            setRemotes(await GitRemotes(repoId))
        } catch (e) {
            onError(String(e))
        }
    }, [repoId, onError])

    useEffect(() => {
        void load()
    }, [load])

    // Abre el formulario con lo que hay configurado. Se pide aparte de la
    // lista por una sola diferencia: acá la URL de push vuelve VACÍA cuando el
    // remoto no tiene override, mientras que la lista siempre trae una (git
    // repite la de fetch). Guardar el duplicado escribiría un override que
    // nadie pidió.
    async function edit(remote: git.Remote) {
        onError(null)
        setNote(null)
        try {
            const real = await GitRemoteURLsForEdit(repoId, remote.name)
            setDraft({original: remote.name, name: real.name, fetchUrl: real.fetchUrl, pushUrl: real.pushUrl})
        } catch (e) {
            onError(String(e))
        }
    }

    function startAdd() {
        onError(null)
        setNote(null)
        setDraft({original: '', name: remotes.length === 0 ? 'origin' : '', fetchUrl: '', pushUrl: ''})
    }

    async function save() {
        if (!draft) return
        const name = draft.name.trim()
        const fetchUrl = draft.fetchUrl.trim()
        if (!name || !fetchUrl) return
        setBusy(true)
        onError(null)
        try {
            if (!draft.original) {
                await GitAddRemote(repoId, name, fetchUrl)
                // Solo si hay override: `remote add` ya dejó la URL de fetch,
                // y una llamada de más sería una línea de más en el log de
                // comandos por un cambio que no existe.
                if (draft.pushUrl.trim()) await GitSetRemoteURLs(repoId, name, fetchUrl, draft.pushUrl.trim())
            } else {
                // El rename va primero: después de cambiarle el nombre, las
                // URLs hay que escribirlas con el nombre nuevo o git no
                // encuentra el remoto.
                if (name !== draft.original) await GitRenameRemote(repoId, draft.original, name)
                await GitSetRemoteURLs(repoId, name, fetchUrl, draft.pushUrl.trim())
            }
            setDraft(null)
            setNote(`Remoto "${name}" guardado.`)
            await load()
            onChanged()
        } catch (e) {
            onError(String(e))
        } finally {
            setBusy(false)
        }
    }

    // Mueve el token de la URL al vault: lo guarda cifrado para ese host y
    // deja la URL limpia. El token sigue usándose en fetch/pull/push (la app
    // se lo pasa a git por askpass), pero deja de estar en texto plano en
    // .git/config, que es donde lo lee cualquiera con acceso a la carpeta.
    async function moveTokenToVault() {
        if (!draft) return
        const cred = readEmbeddedCredential(draft.fetchUrl)
        if (!cred) return
        setBusy(true)
        onError(null)
        try {
            await GitSaveCredential(cred.host, cred.username, cred.secret)
            const push = readEmbeddedCredential(draft.pushUrl)
            setDraft({...draft, fetchUrl: cred.clean, pushUrl: push ? push.clean : draft.pushUrl})
            setNote(`Token guardado en el vault para ${cred.host}. Guardá el remoto para que la URL quede sin el token.`)
        } catch (e) {
            onError(String(e))
        } finally {
            setBusy(false)
        }
    }

    async function copy(remote: git.Remote) {
        onError(null)
        try {
            await navigator.clipboard.writeText(await GitRemoteURLForCopy(repoId, remote.name))
            setNote(`URL de "${remote.name}" copiada.`)
        } catch (e) {
            onError(String(e))
        }
    }

    const embedded = draft ? readEmbeddedCredential(draft.fetchUrl) : null

    return (
        <div className="space-y-3">
            <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3 text-ui-10 leading-relaxed text-on-surface-variant">
                Un remoto es a dónde apuntan fetch, pull y push. Cambiar la URL acá es lo mismo que{' '}
                <span className="font-mono">git remote set-url</span>: no toca nada en el servidor y no vuelve a bajar el repositorio, solo cambia el destino.
            </div>

            {note && (
                <div className="flex items-start gap-2 rounded bg-secondary-container/50 p-2 text-ui-11 text-on-secondary-container">
                    <Icon name="check" size={14} className="mt-px shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{note}</span>
                    <button onClick={() => setNote(null)} title="Cerrar este aviso">
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            {remotes.length === 0 && !draft && (
                <p className="text-ui-11 text-on-surface-variant/60">
                    Este repositorio no tiene remotos: es local y no hay a dónde hacer push hasta que agregues uno.
                </p>
            )}

            {remotes.map((r) => (
                <div key={r.name} className="group rounded-lg border border-outline-variant bg-surface-container-lowest p-2.5">
                    <div className="flex items-center gap-2">
                        <Icon name="cloud" size={14} className="shrink-0 text-on-surface-variant/70" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface">{r.name}</span>
                        <button
                            onClick={() => void edit(r)}
                            title={`Ver y cambiar la URL de "${r.name}" — se abre con la URL real, token incluido si lo tiene`}
                            className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="edit" size={14} />
                        </button>
                        <button
                            onClick={() => void copy(r)}
                            title={`Copiar la URL de "${r.name}" al portapapeles, tal cual está configurada`}
                            className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="content_copy" size={14} />
                        </button>
                        <button
                            onClick={() => setConfirmDelete(r)}
                            title={`Quitar el remoto "${r.name}" de este repositorio — no borra nada en el servidor`}
                            className="shrink-0 rounded p-1 text-error hover:bg-error-container/40"
                        >
                            <Icon name="delete" size={14} />
                        </button>
                    </div>
                    <p className="mt-1 break-all pl-6 font-mono text-ui-10 text-on-surface-variant" title="URL de fetch, tal cual está en .git/config — con el token a la vista si lo tiene embebido">
                        {r.fetchUrl}
                    </p>
                    {/* Una URL de push distinta es exactamente el caso que
                        pasa desapercibido: se cambia la de fetch, todo parece
                        andar, y el push sigue yendo al servidor viejo. */}
                    {r.pushUrl && r.pushUrl !== r.fetchUrl && (
                        <p className="mt-0.5 break-all pl-6 font-mono text-ui-10 text-tertiary" title="Este remoto pushea a una URL distinta de la que usa para fetch">
                            push → {r.pushUrl}
                        </p>
                    )}
                </div>
            ))}

            {!draft && (
                <button
                    onClick={startAdd}
                    title="Agregar otro remoto a este repositorio (un fork, un espejo, un servidor de respaldo)"
                    className="flex items-center gap-1.5 rounded bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant"
                >
                    <Icon name="add" size={14} /> Agregar remoto
                </button>
            )}

            {draft && (
                <div className="space-y-3 rounded-lg border border-primary/40 bg-surface-container-lowest p-3">
                    <p className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                        {draft.original ? `Editar "${draft.original}"` : 'Remoto nuevo'}
                    </p>

                    <Field
                        label="Nombre"
                        value={draft.name}
                        onChange={(v) => setDraft({...draft, name: v})}
                        placeholder="origin"
                        title="Cómo se llama el remoto en los comandos: `git push origin main`. Cambiarlo renombra el remoto y las ramas de seguimiento que cuelgan de él"
                    />
                    <Field
                        label="URL (fetch)"
                        value={draft.fetchUrl}
                        onChange={(v) => setDraft({...draft, fetchUrl: v})}
                        placeholder="https://github.com/usuario/repo.git"
                        mono
                        title="A dónde van fetch y pull, y también push si no completás la URL de push. Se muestra tal cual está guardada, con el token adentro si lo tiene"
                    />
                    <Field
                        label="URL de push (opcional)"
                        value={draft.pushUrl}
                        onChange={(v) => setDraft({...draft, pushUrl: v})}
                        placeholder="Vacío = pushea a la misma URL de arriba"
                        mono
                        title="Solo hace falta cuando se lee de un lado y se escribe en otro (un espejo de solo lectura, un fork). Vaciarla borra el override y el push vuelve a la URL de fetch"
                    />

                    {embedded && (
                        <div className="rounded border border-outline-variant bg-surface-container p-2.5 text-ui-10 leading-relaxed text-on-surface-variant">
                            <p className="flex items-center gap-1.5 font-medium text-tertiary">
                                <Icon name="key" size={13} /> Esta URL lleva un token adentro
                            </p>
                            <p className="mt-1">
                                Funciona, pero queda en texto plano en <span className="font-mono">.git/config</span> y lo ve cualquiera que abra la carpeta o mire{' '}
                                <span className="font-mono">git remote -v</span>. Podés dejarlo así —se respeta lo que escribas— o moverlo al vault: se guarda cifrado para{' '}
                                <span className="font-mono">{embedded.host}</span> y la app se lo pasa a git igual, sin que aparezca en ningún lado.
                            </p>
                            <button
                                onClick={() => void moveTokenToVault()}
                                disabled={busy}
                                title={`Guardar el token cifrado en el vault para ${embedded.host} y dejar la URL sin credenciales (después hay que guardar el remoto)`}
                                className="mt-2 rounded bg-surface-container-highest px-2.5 py-1 text-ui-11 text-on-surface hover:bg-surface-variant disabled:opacity-40"
                            >
                                Mover el token al vault
                            </button>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => void save()}
                            disabled={busy || !draft.name.trim() || !draft.fetchUrl.trim()}
                            title={
                                !draft.name.trim() || !draft.fetchUrl.trim()
                                    ? 'Completá el nombre y la URL de fetch'
                                    : draft.original
                                      ? 'Guardar los cambios en la configuración local del repositorio'
                                      : 'Agregar este remoto al repositorio'
                            }
                            className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                        >
                            {busy ? 'Guardando…' : 'Guardar'}
                        </button>
                        <button
                            onClick={() => {
                                setDraft(null)
                                onError(null)
                            }}
                            title="Descartar los cambios de este formulario — no se escribe nada"
                            className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant"
                        >
                            Cancelar
                        </button>
                    </div>
                </div>
            )}

            {confirmDelete && (
                <ConfirmDialog
                    title="Eliminar remoto"
                    description={`Esto elimina el remoto "${confirmDelete.name}" de la configuración local del repositorio. No borra nada en el servidor, pero las ramas remotas que lo seguían dejan de estar disponibles hasta que lo vuelvas a agregar.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={async () => {
                        try {
                            await GitRemoveRemote(repoId, confirmDelete.name)
                            if (draft?.original === confirmDelete.name) setDraft(null)
                            await load()
                            onChanged()
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
    mono,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    title: string
    mono?: boolean
}) {
    return (
        <div>
            <label className="block text-ui-11 text-on-surface-variant" title={title}>
                {label}
            </label>
            <input
                value={value}
                placeholder={placeholder}
                title={title}
                onChange={(e) => onChange(e.target.value)}
                className={`mt-1 w-full rounded border-none bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary ${mono ? 'font-mono' : ''}`}
            />
        </div>
    )
}
