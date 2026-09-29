import {useState} from 'react'
import {HttpAuthorizeOAuth2, HttpFetchOAuth2Token} from '../../../wailsjs/go/main/App'
import {httpclient} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select from '../Select'
import {rich} from './httpShared'
import {formatDateTime, useT} from '../../i18n'

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

// `name` es el nombre técnico del esquema (Basic, OAuth 2.0…), igual en todos
// los idiomas; los dos primeros son texto de la interfaz y se resuelven al
// dibujar.
const TYPES: {id: string; name: string; executable: boolean}[] = [
    {id: 'inherit', name: '', executable: true},
    {id: 'none', name: '', executable: true},
    {id: 'basic', name: 'Basic', executable: true},
    {id: 'bearer', name: 'Bearer Token', executable: true},
    {id: 'apikey', name: 'API Key', executable: true},
    {id: 'jwt', name: 'JWT Bearer', executable: true},
    {id: 'digest', name: 'Digest', executable: true},
    {id: 'oauth2', name: 'OAuth 2.0', executable: true},
    {id: 'awsv4', name: 'AWS Signature v4', executable: true},
    {id: 'oauth1', name: 'OAuth 1.0', executable: false},
    {id: 'hawk', name: 'Hawk', executable: false},
    {id: 'ntlm', name: 'NTLM', executable: false},
    {id: 'edgegrid', name: 'Akamai EdgeGrid', executable: false},
    {id: 'asap', name: 'ASAP (Atlassian)', executable: false},
]

export default function AuthPanel({auth, onChange, inheritsFrom, onTokenObtained}: AuthPanelProps) {
    const t = useT()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const type = auth.type || 'inherit'
    const meta = TYPES.find((x) => x.id === type)
    const isType = (id: string) => type === id
    const isGrant = (g: string) => auth.grantType === g

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
            setNotice(res.expiresAt ? t.http.auth.tokenObtainedUntil({date: formatDateTime(res.expiresAt)}) : t.http.auth.tokenObtained)
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="px-3 py-2 text-ui-11">
            <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{t.http.auth.type}</label>
            {/* El aviso de «todavía no se firma» va como aclaración de la
                fila y no pegado al rótulo: en un <option> nativo era una línea
                larguísima que tapaba el nombre del tipo, que es lo que se
                busca al abrir la lista. */}
            <Select
                value={type}
                options={TYPES.map((x) => ({
                    value: x.id,
                    label: x.id === 'inherit' ? t.http.auth.typeInherit : x.id === 'none' ? t.http.auth.typeNone : x.name,
                    hint: x.executable ? undefined : t.http.auth.notSignedHint,
                }))}
                onChange={(v) => set({type: v})}
                size="sm"
                ariaLabel={t.http.auth.typeAria}
                title={t.http.auth.typeTitle}
                className="w-full"
            />

            {meta && !meta.executable && (
                <p className="mt-2 rounded bg-surface-container-lowest px-2 py-1.5 text-ui-10 leading-relaxed text-tertiary">
                    {rich(t.http.auth.notSigned)}
                </p>
            )}

            {isType('inherit') && (
                <p className="mt-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                    {inheritsFrom ? t.http.auth.inheritsFrom({from: inheritsFrom}) : t.http.auth.inheritsDefault}
                </p>
            )}

            {(isType('basic') || isType('digest')) && (
                <div className="mt-2 space-y-2">
                    <Field label={t.http.auth.username} value={auth.username ?? ''} onChange={(v) => set({username: v})} />
                    <Field label={t.http.auth.password} value={auth.password ?? ''} onChange={(v) => set({password: v})} secret />
                    {isType('digest') && (
                        <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                            {t.http.auth.digestNote}
                        </p>
                    )}
                </div>
            )}

            {isType('bearer') && (
                <div className="mt-2">
                    <Field label={t.http.auth.token} value={auth.token ?? ''} onChange={(v) => set({token: v})} secret mono />
                    <p className="mt-1 text-ui-10 leading-relaxed text-on-surface-variant/70">
                        {rich(t.http.auth.bearerNote)}
                    </p>
                </div>
            )}

            {isType('apikey') && (
                <div className="mt-2 space-y-2">
                    <Field label={t.http.auth.keyName} value={auth.key ?? ''} onChange={(v) => set({key: v})} mono />
                    <Field label={t.http.auth.keyValue} value={auth.value ?? ''} onChange={(v) => set({value: v})} secret mono />
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{t.http.auth.sendIn}</label>
                        <Select
                            value={auth.in || 'header'}
                            options={[
                                {value: 'header', label: t.http.auth.inHeader},
                                {value: 'query', label: t.http.auth.inQuery, hint: t.http.auth.inQueryHint},
                            ]}
                            onChange={(v) => set({in: v})}
                            size="sm"
                            ariaLabel={t.http.auth.inAria}
                            title={t.http.auth.inTitle}
                            className="w-full"
                        />
                    </div>
                </div>
            )}

            {isType('jwt') && (
                <div className="mt-2 space-y-2">
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{t.http.auth.algorithm}</label>
                        <Select
                            value={auth.algorithm || 'HS256'}
                            options={['HS256', 'HS384', 'HS512'].map((x) => ({value: x, label: x}))}
                            onChange={(v) => set({algorithm: v})}
                            size="sm"
                            ariaLabel={t.http.auth.algorithmAria}
                            title={t.http.auth.algorithmTitle}
                            className="w-full"
                        />
                    </div>
                    <Field label={t.http.auth.secret} value={auth.secret ?? ''} onChange={(v) => set({secret: v})} secret mono />
                    <label className="flex items-center gap-1.5 text-ui-11 text-on-surface-variant">
                        <input
                            type="checkbox"
                            checked={!!auth.secretBase64}
                            onChange={(e) => set({secretBase64: e.target.checked})}
                            title={t.http.auth.secretBase64Title}
                            className="accent-primary"
                        />
                        {t.http.auth.secretBase64}
                    </label>
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{t.http.auth.payload}</label>
                        <textarea
                            value={auth.payload ?? ''}
                            onChange={(e) => set({payload: e.target.value})}
                            rows={4}
                            placeholder={t.http.auth.payloadPlaceholder}
                            className="w-full rounded bg-surface-container-highest px-2 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        />
                    </div>
                </div>
            )}

            {isType('awsv4') && (
                <div className="mt-2 space-y-2">
                    <Field label={t.http.auth.accessKey} value={auth.accessKey ?? ''} onChange={(v) => set({accessKey: v})} mono />
                    <Field label={t.http.auth.secretKey} value={auth.secretKey ?? ''} onChange={(v) => set({secretKey: v})} secret mono />
                    <Field label={t.http.auth.sessionToken} value={auth.sessionToken ?? ''} onChange={(v) => set({sessionToken: v})} secret mono />
                    <Field label={t.http.auth.region} value={auth.region ?? ''} onChange={(v) => set({region: v})} mono placeholder={t.http.auth.regionPlaceholder} />
                    <Field
                        label={t.http.auth.service}
                        value={auth.service ?? ''}
                        onChange={(v) => set({service: v})}
                        mono
                        placeholder={t.http.auth.servicePlaceholder}
                        hint={t.http.auth.serviceHint}
                    />
                </div>
            )}

            {isType('oauth2') && (
                <div className="mt-2 space-y-2">
                    <div>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{t.http.auth.flow}</label>
                        <Select
                            value={auth.grantType || 'client_credentials'}
                            options={[
                                {value: 'client_credentials', label: t.http.auth.grantClientCredentials},
                                {value: 'authorization_code', label: t.http.auth.grantAuthorizationCode, hint: t.http.auth.grantAuthorizationCodeHint},
                                {value: 'password', label: t.http.auth.grantPassword},
                                {value: 'refresh_token', label: t.http.auth.grantRefreshToken},
                            ]}
                            onChange={(v) => set({grantType: v})}
                            size="sm"
                            ariaLabel={t.http.auth.flowAria}
                            title={t.http.auth.flowTitle}
                            className="w-full"
                        />
                    </div>
                    {isGrant('authorization_code') && (
                        <Field label={t.http.auth.authUrl} value={auth.authUrl ?? ''} onChange={(v) => set({authUrl: v})} mono />
                    )}
                    <Field label={t.http.auth.tokenUrl} value={auth.accessTokenUrl ?? ''} onChange={(v) => set({accessTokenUrl: v})} mono />
                    <Field label={t.http.auth.clientId} value={auth.clientId ?? ''} onChange={(v) => set({clientId: v})} mono />
                    <Field label={t.http.auth.clientSecret} value={auth.clientSecret ?? ''} onChange={(v) => set({clientSecret: v})} secret mono />
                    <Field label={t.http.auth.scope} value={auth.scope ?? ''} onChange={(v) => set({scope: v})} mono />
                    {isGrant('password') && (
                        <>
                            <Field label={t.http.auth.username} value={auth.username ?? ''} onChange={(v) => set({username: v})} />
                            <Field label={t.http.auth.password} value={auth.password ?? ''} onChange={(v) => set({password: v})} secret />
                        </>
                    )}
                    {isGrant('refresh_token') && (
                        <Field label={t.http.auth.refreshToken} value={auth.refreshToken ?? ''} onChange={(v) => set({refreshToken: v})} secret mono />
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                            onClick={() => void getToken(isGrant('authorization_code'))}
                            disabled={busy}
                            title={isGrant('authorization_code') ? t.http.auth.authorizeTitle : t.http.auth.fetchTitle}
                            className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                        >
                            {busy ? t.http.auth.requesting : t.http.auth.getToken}
                        </button>
                        {auth.accessToken && (
                            <span
                                className="inline-flex items-center gap-1 text-ui-10 text-secondary"
                                title={auth.expiresAt ? t.http.auth.expiresAt({date: formatDateTime(auth.expiresAt)}) : t.http.auth.noExpiry}
                            >
                                <Icon name="check" size={12} /> {t.http.auth.tokenSaved}
                            </span>
                        )}
                    </div>
                    {isGrant('authorization_code') && (
                        <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                            {rich(t.http.auth.redirectNote)}
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
    const t = useT()
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
                        title={reveal ? t.http.auth.hide : t.http.auth.show}
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
