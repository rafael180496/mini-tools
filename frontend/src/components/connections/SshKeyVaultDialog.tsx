import {useEffect, useState} from 'react'
import {DeleteSSHKey, ListSSHKeys, RenameSSHKey, SSHKeyUsage, SaveSSHKey} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'

interface SshKeyVaultDialogProps {
    onClose: () => void
    // Called after any change so the caller can refresh its own key list.
    onChanged: () => void
}

// Central manager for SSH private keys.
//
// The keys live encrypted under the vault's master key, same as every saved
// DSN, and connections reference them by id. What this replaces is pasting
// the same key into six connections: there, rotating it meant editing six,
// and nothing told you which connections shared a key.
export default function SshKeyVaultDialog({onClose, onChanged}: SshKeyVaultDialogProps) {
    const [keys, setKeys] = useState<vault.SSHKeySummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const [saving, setSaving] = useState(false)
    const [name, setName] = useState('')
    const [material, setMaterial] = useState('')
    const [passphrase, setPassphrase] = useState('')
    const [renaming, setRenaming] = useState<{id: string; name: string} | null>(null)
    // A delete waiting on confirmation, carrying the connections it would
    // break — the question is meaningless without them.
    const [pendingDelete, setPendingDelete] = useState<{key: vault.SSHKeySummary; usedBy: string[]} | null>(null)

    function reload() {
        ListSSHKeys()
            .then(setKeys)
            .catch((err) => setError(String(err)))
    }

    useEffect(reload, [])

    function add() {
        setSaving(true)
        setError(null)
        SaveSSHKey(name, material, passphrase)
            .then(() => {
                // Cleared immediately: there is no reason for key material to
                // stay in a form field after it is stored.
                setName('')
                setMaterial('')
                setPassphrase('')
                setAdding(false)
                reload()
                onChanged()
            })
            .catch((err) => setError(String(err)))
            .finally(() => setSaving(false))
    }

    function askDelete(key: vault.SSHKeySummary) {
        setError(null)
        SSHKeyUsage(key.id)
            .then((usedBy) => setPendingDelete({key, usedBy: usedBy ?? []}))
            .catch((err) => setError(String(err)))
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-4 py-3">
                    <Icon name="key" size={18} className="text-primary" />
                    <h2 className="text-sm font-medium text-on-surface">Llaves SSH guardadas</h2>
                    <button onClick={onClose} title="Cerrar" className="ml-auto rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && (
                    <div className="flex shrink-0 items-start gap-2 border-b border-error/40 bg-error-container/40 px-4 py-2 text-xs text-on-error-container">
                        <Icon name="error" size={15} className="mt-0.5 shrink-0" />
                        <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word">{error}</span>
                    </div>
                )}

                <div className="min-h-0 flex-1 overflow-auto">
                    {keys.length === 0 && !adding && (
                        <p className="px-4 py-6 text-center text-xs text-on-surface-variant">
                            Todavía no hay llaves guardadas. Agregá una para vincularla a varias conexiones sin repetir el archivo.
                        </p>
                    )}
                    {keys.map((k) => (
                        <div key={k.id} className="flex items-center gap-2 border-b border-outline-variant/50 px-4 py-2 text-xs">
                            <Icon name="vpn_key" size={16} className="shrink-0 text-on-surface-variant" />
                            <div className="min-w-0 flex-1">
                                {renaming?.id === k.id ? (
                                    <input
                                        autoFocus
                                        value={renaming.name}
                                        onChange={(e) => setRenaming({id: k.id, name: e.target.value})}
                                        onBlur={() => setRenaming(null)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                RenameSSHKey(k.id, renaming.name)
                                                    .then(() => {
                                                        setRenaming(null)
                                                        reload()
                                                        onChanged()
                                                    })
                                                    .catch((err) => {
                                                        setError(String(err))
                                                        setRenaming(null)
                                                    })
                                            }
                                            if (e.key === 'Escape') setRenaming(null)
                                        }}
                                        className="w-full rounded border border-outline bg-surface px-1.5 py-0.5 text-xs text-on-surface"
                                    />
                                ) : (
                                    <div className="truncate font-medium text-on-surface">{k.name}</div>
                                )}
                                <div className="truncate font-mono text-[10px] text-on-surface-variant" title={k.fingerprint}>
                                    {k.keyType} · {k.fingerprint}
                                </div>
                            </div>
                            {k.hasPassphrase && (
                                <span
                                    title="Esta llave está protegida por passphrase, y la passphrase también quedó guardada cifrada — por eso conecta sin pedirla."
                                    className="shrink-0 rounded bg-surface-container-highest px-1.5 py-0.5 text-[10px] text-on-surface-variant"
                                >
                                    passphrase
                                </span>
                            )}
                            <button
                                onClick={() => setRenaming({id: k.id, name: k.name})}
                                title="Renombrar"
                                className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                            >
                                <Icon name="edit" size={14} />
                            </button>
                            <button
                                onClick={() => askDelete(k)}
                                title="Eliminar esta llave"
                                className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-error-container/40 hover:text-error"
                            >
                                <Icon name="delete" size={14} />
                            </button>
                        </div>
                    ))}

                    {adding && (
                        <div className="space-y-2 border-t border-outline-variant bg-surface-container-low px-4 py-3">
                            <label className="block text-xs text-on-surface-variant">
                                Nombre
                                <input
                                    autoFocus
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="deploy prod"
                                    className="mt-1 w-full rounded-lg border border-outline bg-surface px-2 py-1.5 text-sm text-on-surface"
                                />
                            </label>
                            <label className="block text-xs text-on-surface-variant">
                                Contenido de la llave privada
                                <textarea
                                    value={material}
                                    onChange={(e) => setMaterial(e.target.value)}
                                    rows={5}
                                    placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
                                    title="El contenido completo del archivo (.pem, id_rsa, id_ed25519), no su ruta: se guarda cifrado acá y el archivo original deja de hacer falta."
                                    className="mt-1 w-full rounded-lg border border-outline bg-surface px-2 py-1.5 font-mono text-xs text-on-surface"
                                />
                            </label>
                            <label className="block text-xs text-on-surface-variant">
                                Passphrase (si la llave tiene)
                                <input
                                    type="password"
                                    value={passphrase}
                                    onChange={(e) => setPassphrase(e.target.value)}
                                    className="mt-1 w-full rounded-lg border border-outline bg-surface px-2 py-1.5 text-sm text-on-surface"
                                />
                            </label>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={add}
                                    disabled={saving || !name.trim() || !material.trim()}
                                    className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                                >
                                    {saving ? 'Guardando…' : 'Guardar llave'}
                                </button>
                                <button
                                    onClick={() => setAdding(false)}
                                    className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant"
                                >
                                    Cancelar
                                </button>
                                <span className="ml-auto text-[11px] text-on-surface-variant">
                                    Se valida antes de guardarla: una llave truncada se rechaza acá y no en medio de una conexión.
                                </span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-4 py-3">
                    {!adding && (
                        <button
                            onClick={() => setAdding(true)}
                            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                        >
                            <Icon name="add" size={14} />
                            Agregar llave
                        </button>
                    )}
                    <span className="ml-auto text-[11px] text-on-surface-variant">
                        Cifradas con la clave maestra del vault, igual que las contraseñas de las conexiones.
                    </span>
                </div>
            </div>

            {pendingDelete && (
                <ConfirmDialog
                    title={`Eliminar la llave "${pendingDelete.key.name}"`}
                    description={
                        pendingDelete.usedBy.length > 0
                            ? `La usan ${pendingDelete.usedBy.length} ${
                                  pendingDelete.usedBy.length === 1 ? 'conexión' : 'conexiones'
                              }: ${pendingDelete.usedBy.join(', ')}. Si la borrás, esas conexiones dejan de autenticarse y hay que volver a cargar la llave. No se puede deshacer.`
                            : 'Ninguna conexión la está usando. Igual, no se puede deshacer: si no tenés el archivo original, la llave se pierde.'
                    }
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => {
                        const id = pendingDelete.key.id
                        setPendingDelete(null)
                        DeleteSSHKey(id)
                            .then(() => {
                                reload()
                                onChanged()
                            })
                            .catch((err) => setError(String(err)))
                    }}
                    onClose={() => setPendingDelete(null)}
                />
            )}
        </div>
    )
}
