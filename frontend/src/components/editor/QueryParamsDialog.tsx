import {useEffect, useMemo, useRef, useState} from 'react'
import Icon from '../Icon'
import Select from '../Select'
import {useT} from '../../i18n'
import type {query} from '../../../wailsjs/go/models'

// The dialog that asks for the values of a query's bind placeholders,
// shown between pressing Run and the statement actually going out.
//
// It exists because a query with a ":desde" in it is not a broken query —
// it is a query with a hole in it, and the hole is the reusable part. The
// alternative the editor offered before was to hand-edit the literal every
// time, which is both slower and how a value ends up pasted into the SQL
// permanently by accident.
//
// The values never reach the statement as text: they travel to Go as a
// separate list and are bound as driver arguments (see
// backend/query/params.go). That is a security property, not an
// implementation detail — a value typed into a text box is exactly the
// input SQL injection is made of.

export type ParamType = 'text' | 'number' | 'boolean' | 'null'

// ParamDraft is one row's edit state. Kept separate from query.ParamValue
// because the dialog needs the placeholder's raw spelling to show it, and
// the backend does not.
export interface ParamDraft {
    value: string
    type: ParamType
}

// ParamDraftMap is what the caller remembers between runs, keyed by
// parameter name.
export type ParamDraftMap = Record<string, ParamDraft>

interface QueryParamsDialogProps {
    params: query.Param[]
    // initial pre-fills the form with what was entered last time the same
    // parameters were run in this tab. Values a previous run left behind are
    // a convenience, never a commitment: everything stays editable.
    initial: ParamDraftMap
    onRun: (drafts: ParamDraftMap) => void
    onClose: () => void
}

export default function QueryParamsDialog({params, initial, onRun, onClose}: QueryParamsDialogProps) {
    const t = useT()
    const typeOptions = [
        {value: 'text', label: t.editor.params.types.text, hint: t.editor.params.types.textHint},
        {value: 'number', label: t.editor.params.types.number, hint: t.editor.params.types.numberHint},
        {value: 'boolean', label: t.editor.params.types.boolean, hint: t.editor.params.types.booleanHint},
        {value: 'null', label: 'NULL', hint: t.editor.params.types.nullHint},
    ]
    const [drafts, setDrafts] = useState<ParamDraftMap>(() => {
        const next: ParamDraftMap = {}
        for (const p of params) {
            next[p.name] = initial[p.name] ?? {value: '', type: 'text'}
        }
        return next
    })

    const firstInputRef = useRef<HTMLInputElement>(null)
    useEffect(() => {
        firstInputRef.current?.focus()
        firstInputRef.current?.select()
    }, [])

    // Enter runs, Escape cancels — the two keys anyone types into a form
    // without thinking about it. Enter is handled on the form's submit so a
    // press inside any field works, not only inside the last one.
    const run = () => onRun(drafts)

    const update = (name: string, patch: Partial<ParamDraft>) => {
        setDrafts((prev) => ({...prev, [name]: {...prev[name], ...patch}}))
    }

    // A run with every value still blank is almost always someone hitting
    // Enter past the dialog rather than someone meaning "bind empty
    // strings", so the primary button says so instead of silently doing it.
    const allEmpty = useMemo(
        () => params.every((p) => drafts[p.name]?.type !== 'null' && (drafts[p.name]?.value ?? '') === ''),
        [params, drafts],
    )

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
            <form
                onSubmit={(e) => {
                    e.preventDefault()
                    run()
                }}
                className="flex max-h-[80vh] w-[34rem] flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg"
            >
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Icon name="tune" size={18} className="text-primary" />
                    {t.editor.params.title}
                </h2>
                <p className="text-xs text-on-surface-variant">
                    {t.editor.params.intro(params.length)}
                </p>

                <div className="-mx-1 flex flex-col gap-2 overflow-y-auto px-1 py-1">
                    {params.map((param, index) => {
                        const draft = drafts[param.name] ?? {value: '', type: 'text' as ParamType}
                        const isNull = draft.type === 'null'
                        return (
                            <div key={param.name} className="flex items-center gap-2">
                                <code
                                    className="w-32 shrink-0 truncate font-mono text-xs text-primary"
                                    title={
                                        param.positional
                                            ? t.editor.params.positional({name: param.name})
                                            : t.editor.params.named({raw: param.raw})
                                    }
                                >
                                    {param.raw}
                                    {param.positional ? ` #${param.name}` : ''}
                                </code>
                                <input
                                    ref={index === 0 ? firstInputRef : undefined}
                                    type="text"
                                    value={isNull ? '' : draft.value}
                                    disabled={isNull}
                                    onChange={(e) => update(param.name, {value: e.target.value})}
                                    placeholder={isNull ? 'NULL' : t.editor.params.valuePlaceholder}
                                    title={
                                        isNull
                                            ? t.editor.params.nullDisabled
                                            : t.editor.params.valueTitle({raw: param.raw})
                                    }
                                    className="min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-mono text-sm text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:border-primary disabled:opacity-40"
                                />
                                <Select
                                    value={draft.type}
                                    options={typeOptions}
                                    onChange={(value) => update(param.name, {type: value as ParamType})}
                                    size="sm"
                                    className="w-28 shrink-0"
                                    ariaLabel={t.editor.params.typeAria({raw: param.raw})}
                                    title={t.editor.params.typeTitle}
                                />
                            </div>
                        )
                    })}
                </div>

                <div className="mt-1 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        title={t.editor.params.cancelTitle}
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface"
                    >
                        {t.common.cancel}
                    </button>
                    <button
                        type="submit"
                        title={
                            allEmpty
                                ? t.editor.params.runAllEmpty
                                : t.editor.params.runTitle
                        }
                        className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90"
                    >
                        <Icon name="play_arrow" size={16} />
                        {t.editor.params.run}
                    </button>
                </div>
            </form>
        </div>
    )
}
