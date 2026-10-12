import type {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import {useT} from '../i18n'

// Resultado de una prueba de conexión de un servidor de modelos, en línea.
// Lo comparten el formulario de alta/edición, la lista de Configuración → IA y la
// columna de servidores de Utilidades → Modelos.

const MODELS_SHOWN = 6

export type Probe = {state: 'testing'} | {state: 'done'; probe: main.ModelServerProbe} | {state: 'error'; error: string}

// Resultado de una prueba de conexión, en línea. La lista de modelos se
// recorta: un servidor con cuarenta modelos no tiene que empujar el resto de
// la pantalla, y el conteo ya dice cuántos hay.
export function ProbeResult({probe}: {probe: Exclude<Probe, {state: 'testing'}>}) {
    const t = useT()
    const m = t.settings.modelServers
    if (probe.state === 'error' || (probe.state === 'done' && !probe.probe.ok)) {
        const error = probe.state === 'error' ? probe.error : probe.probe.error
        return (
            <p className="flex items-start gap-1.5 rounded bg-error-container/40 px-2 py-1.5 text-ui-11 text-error">
                <Icon name="error" size={14} className="mt-px shrink-0" />
                <span className="min-w-0 break-words">{m.testFail({error})}</span>
            </p>
        )
    }
    if (probe.state !== 'done') return null
    const models = probe.probe.models ?? []
    return (
        <div className="flex flex-col gap-0.5 rounded bg-secondary/10 px-2 py-1.5 text-ui-11">
            <p className="flex items-center gap-1.5 text-secondary">
                <Icon name="check_circle" size={14} className="shrink-0" />
                {m.testOk({version: probe.probe.version, models: models.length})}
                {probe.probe.latencyMs > 0 && m.testOkLatency({ms: probe.probe.latencyMs})}
            </p>
            {models.length > 0 && (
                <p className="break-words font-mono text-ui-10 text-on-surface-variant">
                    {m.testOkModels({list: models.slice(0, MODELS_SHOWN).join(', ') + (models.length > MODELS_SHOWN ? ', …' : '')})}
                </p>
            )}
        </div>
    )
}
