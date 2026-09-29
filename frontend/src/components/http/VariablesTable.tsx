import {useState} from 'react'
import Icon from '../Icon'
import {newVariable, type HttpVariable} from './httpShared'
import {useT} from '../../i18n'

// Tabla de variables de un entorno o de una colección.
//
// Es pariente de KeyValueTable pero no la misma: acá cada fila puede
// marcarse como SECRETA, y una secreta se muestra enmascarada. Fusionarlas
// habría metido una columna que no significa nada en Params y en Headers, y
// un enmascarado que no aplica ahí.

interface VariablesTableProps {
    rows: HttpVariable[]
    onChange: (rows: HttpVariable[]) => void
}

function emptyVar(): HttpVariable {
    return newVariable()
}

export default function VariablesTable({rows, onChange}: VariablesTableProps) {
    const t = useT()
    // Qué secretos están revelados, por índice. Se guarda acá y no en la
    // fila porque es estado de la VISTA: revelar un token para copiarlo no
    // puede persistirse ni viajar en un export.
    const [revealed, setRevealed] = useState<Set<number>>(new Set())
    const display = [...rows, emptyVar()]

    function update(i: number, patch: Partial<HttpVariable>) {
        const next = display.map((r, k) => (k === i ? {...r, ...patch} : r))
        onChange(next.filter((r, k) => k < next.length - 1 || r.key.trim() !== '' || r.value.trim() !== ''))
    }

    function remove(i: number) {
        onChange(display.filter((_, k) => k !== i).filter((r) => r.key.trim() !== '' || r.value.trim() !== ''))
    }

    function toggleReveal(i: number) {
        setRevealed((prev) => {
            const next = new Set(prev)
            next.has(i) ? next.delete(i) : next.add(i)
            return next
        })
    }

    return (
        <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[460px] table-fixed border-collapse text-ui-11">
                <thead>
                    <tr className="text-left text-ui-10 uppercase tracking-wider text-on-surface-variant/60">
                        <th className="w-8 px-2 py-1 font-medium"></th>
                        <th className="w-[30%] px-2 py-1 font-medium">{t.http.vars.variable}</th>
                        <th className="px-2 py-1 font-medium">{t.http.vars.value}</th>
                        <th className="w-16 px-1 py-1 text-center font-medium" title={t.http.vars.secretColumnTitle}>
                            {t.http.vars.secret}
                        </th>
                        <th className="w-8 px-1 py-1"></th>
                    </tr>
                </thead>
                <tbody>
                    {display.map((row, i) => {
                        const ghost = i === display.length - 1
                        const hidden = row.secret && !revealed.has(i)
                        return (
                            <tr key={i} className="border-t border-outline-variant/50">
                                <td className="px-2 py-0.5">
                                    {!ghost && (
                                        <input
                                            type="checkbox"
                                            checked={row.enabled}
                                            onChange={(e) => update(i, {enabled: e.target.checked})}
                                            title={row.enabled ? t.http.vars.enabledTitle : t.http.vars.disabledTitle}
                                            className="accent-primary"
                                        />
                                    )}
                                </td>
                                <td className="px-2 py-0.5">
                                    <input
                                        value={row.key}
                                        onChange={(e) => update(i, {key: e.target.value, enabled: true})}
                                        placeholder={ghost ? t.http.vars.namePlaceholder : ''}
                                        title={t.http.vars.nameTitle}
                                        className="w-full bg-transparent font-mono text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/40"
                                    />
                                </td>
                                <td className="px-2 py-0.5">
                                    <div className="flex items-center gap-1">
                                        <input
                                            value={hidden ? '•'.repeat(Math.min(row.value.length, 24)) : row.value}
                                            readOnly={hidden}
                                            onChange={(e) => update(i, {value: e.target.value, enabled: true})}
                                            placeholder={ghost ? t.http.vars.valuePlaceholder : ''}
                                            title={hidden ? t.http.vars.hiddenTitle : undefined}
                                            className="min-w-0 flex-1 bg-transparent font-mono text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/40"
                                        />
                                        {row.secret && !ghost && (
                                            <button
                                                onClick={() => toggleReveal(i)}
                                                title={hidden ? t.http.vars.show : t.http.vars.hide}
                                                className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:text-on-surface"
                                            >
                                                <Icon name={hidden ? 'visibility' : 'visibility_off'} size={12} />
                                            </button>
                                        )}
                                    </div>
                                </td>
                                <td className="px-1 py-0.5 text-center">
                                    {!ghost && (
                                        <input
                                            type="checkbox"
                                            checked={row.secret}
                                            onChange={(e) => update(i, {secret: e.target.checked})}
                                            title={t.http.vars.secretTitle}
                                            className="accent-primary"
                                        />
                                    )}
                                </td>
                                <td className="px-1 py-0.5">
                                    {!ghost && (
                                        <button
                                            onClick={() => remove(i)}
                                            title={t.http.vars.removeTitle}
                                            className="rounded p-0.5 text-on-surface-variant/40 hover:bg-surface-variant hover:text-error"
                                        >
                                            <Icon name="close" size={12} />
                                        </button>
                                    )}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
