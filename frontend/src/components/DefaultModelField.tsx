import {useState} from 'react'
import Select from './Select'
import {useT} from '../i18n'

// Campo «Modelo por defecto» de un proveedor de IA.
//
// Con la lista de modelos del proveedor a mano (la devolvió una prueba de
// conexión o la lectura de la pestaña Modelos) se elige de ahí, que evita el
// error de tipeo en un nombre como `claude-opus-5-5`; sin lista —o con un modelo
// que no figura en ella, o si se pide «Otro»— se escribe a mano. Vacío significa
// «que el proveedor elija»: el primero que informe, o el recomendado si lo tiene.

const CUSTOM = '__custom__'

interface Props {
    value: string
    onChange: (value: string) => void
    // Modelos que informó el proveedor; vacío si todavía no se sabe.
    models: string[]
    placeholder?: string
    disabled?: boolean
}

export default function DefaultModelField({value, onChange, models, placeholder, disabled}: Props) {
    const t = useT()
    const P = t.models.providers
    const [custom, setCustom] = useState(false)
    const known = value === '' || models.includes(value)
    // Se escribe a mano si no hay lista, si se pidió «Otro» o si el valor guardado
    // no está en ella (un modelo retirado o escrito antes de poder listarlos).
    const typing = models.length === 0 || custom || !known

    return (
        <div className="flex flex-col gap-1.5">
            {models.length > 0 && (
                <Select
                    value={custom || !known ? CUSTOM : value}
                    onChange={(v) => {
                        if (v === CUSTOM) {
                            setCustom(true)
                            return
                        }
                        setCustom(false)
                        onChange(v)
                    }}
                    size="sm"
                    disabled={disabled}
                    ariaLabel={P.defaultModel}
                    title={P.defaultModelSelectTitle}
                    menuMinWidth={260}
                    options={[
                        {value: '', label: P.defaultModelNone, separatorAfter: true},
                        ...models.map((m) => ({value: m, label: m})),
                        {value: CUSTOM, label: P.defaultModelCustom, tone: 'text-primary'},
                    ]}
                />
            )}
            {typing && (
                <input
                    data-default-model-input
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={disabled}
                    placeholder={placeholder ?? P.defaultModelPlaceholder}
                    title={P.defaultModelInputTitle}
                    aria-label={P.defaultModel}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    className="w-full rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary disabled:opacity-50"
                />
            )}
        </div>
    )
}
