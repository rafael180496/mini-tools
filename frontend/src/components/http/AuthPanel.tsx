import {useState} from 'react'
import {HttpAuthorizeOAuth2, HttpFetchOAuth2Token} from '../../../wailsjs/go/main/App'
import {httpclient} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Editor de autenticación, compartido por la petición, la carpeta y la
// colección — son el mismo formulario en tres niveles de la herencia.
//
// # Los tipos que NO se ejecutan
//
// OAuth 1.0, Hawk, NTLM, Akamai EdgeGrid y ASAP se guardan y se exportan
// pero esta versión no los firma. Aparecen en la lista igual, con un aviso
// claro: una colección importada que los use tiene que poder abrirse y
// volver a exportarse sin perderlos. Ocultarlos daría a entender que se
// perdieron; ofrecerlos sin avisar daría a entender que funcionan.

interface AuthPanelProps {
    auth: httpclient.Auth
    onChange: (auth: httpclient.Auth) => void
    // Qué hereda si elige "heredar": el nombre del nivel de arriba, para
    // poder decirlo en vez de dejar al usuario adivinando.
    inheritsFrom?: string
    // Se llama cuando se obtiene un token de OAuth 2.0, para persistirlo.
    onTokenObtained?: (auth: httpclient.Auth) => void
}

const TYPES: {id: string; label: string; executable: boolean}[] = [
    {id: 'inherit', label: 'Heredar del nivel superior', executable: true},
    {id: 'none', label: 'Sin autenticación', executable: true},
    {id: 'basic', label: 'Basic', executable: true},
    {id: 'bearer', label: 'Bearer Token', executable: true},
    {id: 'apikey', label: 'API Key', executable: true},
    {id: 'jwt', label: 'JWT Bearer', executable: true},
    {id: 'digest', label: 'Digest', executable: true},
    {id: 'oauth2', label: 'OAuth 2.0', executable: true},
    {id: 'awsv4', label: 'AWS Signature v4', executable: true},
    {id: 'oauth1', label: 'OAuth 1.0', executable: false},
    {id: 'hawk', label: 'Hawk', executable: false},
    {id: 'ntlm', label: 'NTLM', executable: false},
    {id: 'edgegrid', label: 'Akamai EdgeGrid', executable: false},
    {id: 'asap', label: 'ASAP (Atlassian)', executable: false},
]

export default function AuthPanel({auth, onChange, inheritsFrom, onTokenObtained}: AuthPanelProps) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const type = auth.type || 'inherit'
    const meta = TYPES.find((t) => t.id === type)

    function set(patch: Partial<httpclient.Auth>) {
        onChange(new httpclient.Auth({...auth, ...patch}))
    }

    async function getToken(interactive: boolean) {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
            const res = interactive ? await HttpAuthorizeOAuth2(auth) : await HttpFetchOAuth2Token(auth)
            if (!res) return
            const updated = new httpclient.Auth({
                ...auth,
                accessToken: res.accessToken,
                refreshToken: res.refreshToken || auth.refreshToken,
                expiresAt: res.expiresAt,
            })
            onChange(updated)
            onTokenObtained?.(updated)
            setNotice(res.expiresAt ? `Token obtenido, vence ${new Date(res.expiresAt * 1000).toLocaleString()}` : 'Token obtenido')
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="px-3 py-2 text-ui-11">
            <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">Tipo</label>
            <select
                value={type}
                onChange={(e) => set({type: e.target.value})}
                title="Cómo se autentica esta petición. «Heredar» usa lo que definan la carpeta o la colección, que es lo que permite cambiar un token en un solo lugar."
                className="w-full rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
            >
                {TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                        {t.label}
                        {t.executable ? '' : ' — se guarda, todavía no se firma'}
                    </option>
                ))}
            </select>

            {meta && !meta.executable && (
                <p className="mt-2 rounded bg-surface-container-lowest px-2 py-1.5 text-ui-10 leading-relaxed text-tertiary">
                    Esta autenticación se <strong>guarda y se exporta intacta</strong>, pero esta versión todavía no la firma: la petición va a salir sin
                    autenticar. Se muestra igual para que una colección importada que la use no pierda su configuración.
                </p>
            )}

            {type === 'inherit' && (
                <p className="mt-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                    {inheritsFrom
                        ? `Usa la autenticación de ${inheritsFrom}. Si ese nivel también hereda, se sigue subiendo hasta la colección.`
                        : 'Usa la autenticación de la carpeta o, si no tiene, la de la colección.'}
                </p>
            )}

            {(type === 'basic' || type === 'digest') && (
                <div className="mt-2 space-y-2">
                    <Field label="Usuario" value={auth.username ?? ''} onChange={(v) => set({username: v})} />
                    <Field label="Contraseña" value={auth.password ?? ''} onChange={(v) => set({password: v})} secret />
                    {type === 'digest' && (
                        <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                            Digest necesita un ida y vuelta: la primera petición sale sin firmar, el servidor responde 401 con su desafío, y recién ahí se
                            calcula la respuesta. Vas a ver una sola petición acá, pero por el cable van dos.
                        </p>
                    )}
                </div>
            )}

            {type === 'bearer' && (
                <div className="mt-2">
                    <Field label="Token" value={auth.token ?? ''} onChange={(v) => set({token: v})} secret mono />
                    <p className="mt-1 text-ui-10 leading-relaxed text-on-surface-variant/70">
                        Podés poner <span className="font-mono">{'{{token}}'}</span> y guardar el valor real como variable secreta del entorno: así queda
                        cifrado, enmascarado y fuera del export.
                    </p>
                </div>
            )}

            {type === 'apikey' && (
                <div className="mt-2 space-y-2">
                    <Field label="Nombre" value={auth.key ?? ''} onChange={(v) => set({key: v})} mono />
                    <Field label="Valor" value={auth.value ?? ''} onChange={(v) => set({value: v})} secret mono />
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">Enviar en</label>
                        <select
                            value={auth.in || 'header'}
                            onChange={(e) => set({in: e.target.value})}
                            title="Header es lo habitual; query pone la clave en la URL, donde queda registrada en los logs del servidor y del proxy."
                            className="w-full rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        >
                            <option value="header">Header</option>
                            <option value="query">Query param</option>
                        </select>
                    </div>
                </div>
            )}

            {type === 'jwt' && (
                <div className="mt-2 space-y-2">
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">Algoritmo</label>
                        <select
                            value={auth.algorithm || 'HS256'}
                            onChange={(e) => set({algorithm: e.target.value})}
                            title="Solo HMAC: RS* y ES* piden manejar claves privadas en PEM, que es otra conversación."
                            className="w-full rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        >
                            {['HS256', 'HS384', 'HS512'].map((x) => (
                                <option key={x}>{x}</option>
                            ))}
                        </select>
                    </div>
                    <Field label="Secreto" value={auth.secret ?? ''} onChange={(v) => set({secret: v})} secret mono />
                    <label className="flex items-center gap-1.5 text-ui-11 text-on-surface-variant">
                        <input
                            type="checkbox"
                            checked={!!auth.secretBase64}
                            onChange={(e) => set({secretBase64: e.target.checked})}
                            title="Marcalo si el secreto que te dieron está en base64 y hay que decodificarlo antes de firmar."
                            className="accent-primary"
                        />
                        El secreto está en base64
                    </label>
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">Payload (JSON)</label>
                        <textarea
                            value={auth.payload ?? ''}
                            onChange={(e) => set({payload: e.target.value})}
                            rows={4}
                            placeholder='{ "sub": "1234", "role": "admin" }'
                            className="w-full rounded bg-surface-container-highest px-2 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        />
                    </div>
                </div>
            )}

            {type === 'awsv4' && (
                <div className="mt-2 space-y-2">
                    <Field label="Access Key" value={auth.accessKey ?? ''} onChange={(v) => set({accessKey: v})} mono />
                    <Field label="Secret Key" value={auth.secretKey ?? ''} onChange={(v) => set({secretKey: v})} secret mono />
                    <Field label="Session Token (opcional)" value={auth.sessionToken ?? ''} onChange={(v) => set({sessionToken: v})} secret mono />
                    <Field label="Región" value={auth.region ?? ''} onChange={(v) => set({region: v})} mono placeholder="us-east-1" />
                    <Field
                        label="Servicio"
                        value={auth.service ?? ''}
                        onChange={(v) => set({service: v})}
                        mono
                        placeholder="se deduce del host"
                        hint="Si el host es de AWS (execute-api.us-east-1.amazonaws.com) el servicio se deduce solo; escribilo solo si no lo es."
                    />
                </div>
            )}

            {type === 'oauth2' && (
                <div className="mt-2 space-y-2">
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">Flujo</label>
                        <select
                            value={auth.grantType || 'client_credentials'}
                            onChange={(e) => set({grantType: e.target.value})}
                            title="«Authorization code» abre el navegador para que autorices vos; los otros tres se resuelven sin salir de la app."
                            className="w-full rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        >
                            <option value="client_credentials">Client Credentials</option>
                            <option value="authorization_code">Authorization Code (abre el navegador)</option>
                            <option value="password">Password</option>
                            <option value="refresh_token">Refresh Token</option>
                        </select>
                    </div>
                    {auth.grantType === 'authorization_code' && (
                        <Field label="URL de autorización" value={auth.authUrl ?? ''} onChange={(v) => set({authUrl: v})} mono />
                    )}
                    <Field label="URL del token" value={auth.accessTokenUrl ?? ''} onChange={(v) => set({accessTokenUrl: v})} mono />
                    <Field label="Client ID" value={auth.clientId ?? ''} onChange={(v) => set({clientId: v})} mono />
                    <Field label="Client Secret" value={auth.clientSecret ?? ''} onChange={(v) => set({clientSecret: v})} secret mono />
                    <Field label="Scope" value={auth.scope ?? ''} onChange={(v) => set({scope: v})} mono />
                    {auth.grantType === 'password' && (
                        <>
                            <Field label="Usuario" value={auth.username ?? ''} onChange={(v) => set({username: v})} />
                            <Field label="Contraseña" value={auth.password ?? ''} onChange={(v) => set({password: v})} secret />
                        </>
                    )}
                    {auth.grantType === 'refresh_token' && (
                        <Field label="Refresh Token" value={auth.refreshToken ?? ''} onChange={(v) => set({refreshToken: v})} secret mono />
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                            onClick={() => void getToken(auth.grantType === 'authorization_code')}
                            disabled={busy}
                            title={
                                auth.grantType === 'authorization_code'
                                    ? 'Abre tu navegador para que autorices. La respuesta vuelve a un puerto local (127.0.0.1) y el intercambio usa PKCE, como manda el estándar para aplicaciones de escritorio.'
                                    : 'Pide un token al servidor sin salir de la aplicación.'
                            }
                            className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                        >
                            {busy ? 'Pidiendo…' : 'Obtener token'}
                        </button>
                        {auth.accessToken && (
                            <span
                                className="inline-flex items-center gap-1 text-ui-10 text-secondary"
                                title={auth.expiresAt ? `Vence ${new Date(auth.expiresAt * 1000).toLocaleString()}` : 'Sin vencimiento informado'}
                            >
                                <Icon name="check" size={12} /> token guardado
                            </span>
                        )}
                    </div>
                    {auth.grantType === 'authorization_code' && (
                        <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                            La redirección se recibe en <span className="font-mono">http://127.0.0.1:&lt;puerto&gt;/callback</span>. Si tu servidor exige
                            registrar la URL de antes, fijala en el campo de arriba del proveedor con ese formato.
                        </p>
                    )}
                </div>
            )}

            {error && (
                <p className="mt-2 rounded bg-error-container px-2 py-1 text-ui-10 leading-relaxed text-on-error-container">{error}</p>
            )}
            {notice && <p className="mt-2 text-ui-10 text-secondary">{notice}</p>}
        </div>
    )
}

function Field({
    label,
    value,
    onChange,
    secret,
    mono,
    placeholder,
    hint,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    secret?: boolean
    mono?: boolean
    placeholder?: string
    hint?: string
}) {
    // Los campos secretos arrancan ocultos pero se pueden revelar: hay que
    // poder comprobar un token pegado, y un campo que nunca se ve obliga a
    // borrarlo y repegarlo ante cualquier duda.
    const [reveal, setReveal] = useState(false)
    return (
        <div>
            <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{label}</label>
            <div className="flex items-center gap-1">
                <input
                    type={secret && !reveal ? 'password' : 'text'}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    title={hint}
                    className={`min-w-0 flex-1 rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary ${
                        mono ? 'font-mono' : ''
                    }`}
                />
                {secret && (
                    <button
                        onClick={() => setReveal((v) => !v)}
                        title={reveal ? 'Ocultar' : 'Mostrar'}
                        className="shrink-0 rounded p-1 text-on-surface-variant/50 hover:text-on-surface"
                    >
                        <Icon name={reveal ? 'visibility_off' : 'visibility'} size={13} />
                    </button>
                )}
            </div>
            {hint && <p className="mt-0.5 text-ui-10 leading-relaxed text-on-surface-variant/60">{hint}</p>}
        </div>
    )
}
