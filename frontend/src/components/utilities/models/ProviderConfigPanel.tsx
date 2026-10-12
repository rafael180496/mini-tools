import {useEffect, useState, type ReactNode} from 'react'
import type {main} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import Toggle from '../../Toggle'
import DefaultModelField from '../../DefaultModelField'
import {ProbeResult, type Probe} from '../../ModelServerProbeResult'
import {HealthBadge} from '../../agent/HealthIndicators'
import {useT} from '../../../i18n'
import {cloudPresetOf, providerGroup, providerKind} from '../../../lib/modelServers'
import type {Health} from '../../../lib/modelServerHealth'
import {hostOf} from './modelFormat'

// Pestaña «Configuración» de un proveedor: sus ajustes de un vistazo y las
// acciones que los cambian, sin abrir el formulario salvo para editar.
//
// Es una VISTA: el nombre, la dirección, la API key y las cabeceras se editan en
// el formulario de siempre (`ModelServerForm`, con «Editar»). Lo único que se
// cambia acá mismo es lo que no necesita formulario —encender/apagar y el
// modelo por defecto—. La API key y los valores de las cabeceras no existen en
// el frontend (el backend solo informa que hay una guardada), así que lo que
// muestra esta pantalla es «hay una guardada», nunca el valor.

interface Props {
    server: main.ModelServer
    health: Health | undefined
    probe: Probe | undefined
    // Modelos que informó el proveedor en la última lectura; vacío si no hay.
    modelNames: string[]
    onEdit: () => void
    onTest: () => void
    onDuplicate: () => void
    onDelete: () => void
    onToggleEnabled: (enabled: boolean) => void
    onDefaultModel: (model: string) => Promise<boolean>
}

function Row({label, hint, children}: {label: string; hint?: string; children: ReactNode}) {
    return (
        <div className="grid grid-cols-[8.5rem_1fr] items-baseline gap-x-3 gap-y-0.5 border-b border-outline-variant/40 py-2 last:border-b-0" title={hint}>
            <dt className="text-xs text-on-surface-variant">{label}</dt>
            <dd className="min-w-0 break-words text-xs text-on-surface">{children}</dd>
        </div>
    )
}

export default function ProviderConfigPanel({server, health, probe, modelNames, onEdit, onTest, onDuplicate, onDelete, onToggleEnabled, onDefaultModel}: Props) {
    const t = useT()
    const P = t.models.providers
    const C = P.config
    const [draft, setDraft] = useState(server.defaultModel ?? '')
    const [savingModel, setSavingModel] = useState(false)
    useEffect(() => setDraft(server.defaultModel ?? ''), [server.id, server.defaultModel])

    const group = providerGroup(server)
    const kind = providerKind(server.kind)
    const cloud = cloudPresetOf(server)
    const host = hostOf(server.baseUrl)
    const headers = server.headerNames ?? []
    const dirty = draft.trim() !== (server.defaultModel ?? '')
    const testing = probe?.state === 'testing'

    async function saveModel() {
        setSavingModel(true)
        try {
            await onDefaultModel(draft.trim())
        } finally {
            setSavingModel(false)
        }
    }

    const btn = 'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50'

    return (
        <div data-provider-config className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
                <section aria-label={C.stateTitle} className="flex items-start gap-3 rounded-lg border border-outline-variant bg-surface-container-low p-3">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-semibold">{C.stateTitle}</h3>
                        <p className="mt-0.5 text-ui-11 text-on-surface-variant">{server.enabled ? C.enabledBody : C.disabledBody}</p>
                    </div>
                    <Toggle
                        checked={server.enabled}
                        onChange={onToggleEnabled}
                        ariaLabel={P.switchLabel({name: server.name})}
                        title={server.enabled ? P.switchOnTitle({name: server.name}) : P.switchOffTitle({name: server.name})}
                    />
                </section>

                <section aria-label={C.connectionTitle}>
                    <h3 className="mb-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">{C.connectionTitle}</h3>
                    <dl className="rounded-lg border border-outline-variant px-3">
                        <Row label={C.name}>{server.name}</Row>
                        <Row label={C.kind} hint={P.kindTitles[kind]}>
                            {P.kindLong[kind]}
                        </Row>
                        <Row label={C.where} hint={P.groupTitles[group]}>
                            <span className="flex flex-wrap items-center gap-1.5">
                                <span className={`rounded-full px-2 py-0.5 text-ui-10 ${group === 'local' ? 'bg-secondary/15 text-secondary' : 'bg-tertiary/15 text-tertiary'}`}>{P.groups[group]}</span>
                                {cloud && <span className="text-on-surface-variant">{C.cloudOf({brand: cloud.brand})}</span>}
                            </span>
                        </Row>
                        <Row label={C.address}>
                            <span className="font-mono">{server.baseUrl}</span>
                            <span className="sr-only"> ({host})</span>
                        </Row>
                        <Row label={group === 'cloud' ? C.apiKey : C.token} hint={C.tokenHint}>
                            {server.hasToken ? (
                                <span className="inline-flex items-center gap-1.5 text-secondary">
                                    <Icon name="key" size={13} />
                                    {C.tokenSaved}
                                </span>
                            ) : (
                                <span className={group === 'cloud' ? 'inline-flex items-center gap-1.5 text-error' : 'text-on-surface-variant'}>
                                    {group === 'cloud' && <Icon name="key_off" size={13} />}
                                    {group === 'cloud' ? C.apiKeyMissing : C.noToken}
                                </span>
                            )}
                        </Row>
                        {headers.length > 0 && (
                            <Row label={C.headers} hint={C.headersHint}>
                                <span className="flex flex-wrap gap-1">
                                    {headers.map((h) => (
                                        <span key={h} className="rounded bg-surface-variant px-1.5 py-0.5 font-mono text-ui-10">
                                            {h}
                                        </span>
                                    ))}
                                </span>
                            </Row>
                        )}
                        {server.insecureTls && (
                            <Row label={C.tls}>
                                <span className="inline-flex items-center gap-1.5 text-tertiary">
                                    <Icon name="lock_open" size={13} />
                                    {C.tlsInsecure}
                                </span>
                            </Row>
                        )}
                        {kind === 'ollama' && (
                            <Row label={C.context} hint={C.contextHint}>
                                {server.contextTokens > 0 ? C.contextTokens({n: server.contextTokens.toLocaleString()}) : C.contextServer}
                            </Row>
                        )}
                        <Row label={C.health}>{health ? <HealthBadge health={health} server={server.name} /> : <span className="text-on-surface-variant">{C.healthUnknown}</span>}</Row>
                    </dl>
                </section>

                <section aria-label={P.defaultModel}>
                    <h3 className="mb-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">{P.defaultModel}</h3>
                    <div className="flex flex-col gap-1.5 rounded-lg border border-outline-variant p-3">
                        <p className="text-ui-11 text-on-surface-variant">{P.defaultModelBody}</p>
                        <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                                <DefaultModelField value={draft} onChange={setDraft} models={modelNames} />
                            </div>
                            <button
                                type="button"
                                data-default-model-save
                                onClick={() => void saveModel()}
                                disabled={!dirty || savingModel}
                                title={dirty ? C.saveModelTitle({name: server.name}) : C.saveModelNothing}
                                className="shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                {C.saveModel}
                            </button>
                        </div>
                    </div>
                </section>

                {probe && probe.state !== 'testing' && <ProbeResult probe={probe} />}

                <div className="flex flex-wrap items-center gap-2">
                    <button type="button" data-config-action="edit" onClick={onEdit} title={t.models.servers.actions.editTitle({name: server.name})} className={`${btn} bg-primary font-medium text-on-primary hover:opacity-90`}>
                        <Icon name="edit" size={14} />
                        {t.models.servers.actions.edit}
                    </button>
                    <button
                        type="button"
                        data-config-action="test"
                        onClick={onTest}
                        disabled={testing}
                        title={t.models.servers.actions.testTitle({name: server.name})}
                        className={`${btn} border border-outline-variant text-on-surface hover:bg-surface-variant`}
                    >
                        <Icon name="network_check" size={14} className={testing ? 'animate-spin' : ''} />
                        {testing ? t.models.servers.actions.testing : t.models.servers.actions.test}
                    </button>
                    <button
                        type="button"
                        data-config-action="duplicate"
                        onClick={onDuplicate}
                        title={t.models.servers.actions.duplicateTitle({name: server.name})}
                        className={`${btn} border border-outline-variant text-on-surface hover:bg-surface-variant`}
                    >
                        <Icon name="content_copy" size={14} />
                        {t.models.servers.actions.duplicate}
                    </button>
                    <button
                        type="button"
                        data-config-action="delete"
                        onClick={onDelete}
                        title={t.models.servers.actions.deleteTitle({name: server.name})}
                        className={`${btn} ml-auto text-error hover:bg-error-container/40`}
                    >
                        <Icon name="delete" size={14} />
                        {t.models.servers.actions.delete}
                    </button>
                </div>
            </div>
        </div>
    )
}
