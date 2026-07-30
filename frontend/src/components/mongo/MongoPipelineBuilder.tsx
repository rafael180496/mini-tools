import Icon from '../Icon'
import {PIPELINE_STAGES, stageDef, validateStages, type PipelineStage} from '../../lib/mongoPipeline'

interface MongoPipelineBuilderProps {
    stages: PipelineStage[]
    onChange: (stages: PipelineStage[]) => void
}

// Visual aggregation pipeline: an ordered list of stages, each one a JSON
// body with a pre-filled template.
//
// Order is the whole point of a pipeline — a $match after a $group filters
// grouped results, not source documents, which is both a different answer
// and a much slower one — so every stage can be moved up and down, and the
// position is shown as a number rather than left implicit.
//
// Bodies stay as text and are never reformatted while typing: re-serialising
// a half-written object would fight the cursor. They are validated (with a
// message per stage) but never rewritten.
export default function MongoPipelineBuilder({stages, onChange}: MongoPipelineBuilderProps) {
    const errors = validateStages(stages)

    function update(i: number, patch: Partial<PipelineStage>) {
        onChange(stages.map((s, idx) => (idx === i ? {...s, ...patch} : s)))
    }

    function move(i: number, delta: number) {
        const target = i + delta
        if (target < 0 || target >= stages.length) return
        const next = [...stages]
        ;[next[i], next[target]] = [next[target], next[i]]
        onChange(next)
    }

    function addStage(op: string) {
        onChange([...stages, {op, body: stageDef(op).template}])
    }

    return (
        <div className="space-y-2">
            {stages.length === 0 && (
                <p className="rounded border border-dashed border-outline-variant px-3 py-4 text-center text-xs text-on-surface-variant">
                    Un pipeline es una secuencia de etapas: cada una recibe lo que produjo la anterior. Empezá con un
                    <span className="font-mono"> $match </span>
                    para filtrar y seguí con <span className="font-mono">$group</span> o{' '}
                    <span className="font-mono">$lookup</span>.
                </p>
            )}

            {stages.map((stage, i) => {
                const def = stageDef(stage.op)
                return (
                    <div key={i} className="rounded border border-outline-variant bg-surface-container-low/40 p-2">
                        <div className="mb-1 flex items-center gap-2">
                            <span
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-variant font-mono text-[10px] text-on-surface-variant"
                                title="Posición en el pipeline: cada etapa recibe la salida de la anterior"
                            >
                                {i + 1}
                            </span>
                            <select
                                value={stage.op}
                                onChange={(e) => update(i, {op: e.target.value, body: stageDef(e.target.value).template})}
                                title={def.hint}
                                className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-1.5 py-1 text-xs text-on-surface"
                            >
                                {PIPELINE_STAGES.map((s) => (
                                    <option key={s.op} value={s.op} title={s.hint}>
                                        {s.label}
                                    </option>
                                ))}
                            </select>
                            <button
                                onClick={() => move(i, -1)}
                                disabled={i === 0}
                                title="Sube esta etapa. El orden importa: filtrar antes de agrupar procesa muchos menos documentos."
                                className="shrink-0 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                            >
                                <Icon name="arrow_upward" size={15} />
                            </button>
                            <button
                                onClick={() => move(i, 1)}
                                disabled={i === stages.length - 1}
                                title="Baja esta etapa en el pipeline"
                                className="shrink-0 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                            >
                                <Icon name="arrow_downward" size={15} />
                            </button>
                            <button
                                onClick={() => onChange(stages.filter((_, idx) => idx !== i))}
                                title="Elimina esta etapa del pipeline"
                                className="shrink-0 text-on-surface-variant hover:text-error"
                            >
                                <Icon name="remove_circle_outline" size={16} />
                            </button>
                        </div>

                        <textarea
                            value={stage.body}
                            onChange={(e) => update(i, {body: e.target.value})}
                            rows={Math.min(8, Math.max(2, stage.body.split('\n').length))}
                            spellCheck={false}
                            title={def.hint}
                            className="w-full resize-y rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                        />
                        <p className="mt-0.5 text-[11px] text-on-surface-variant/70">{def.hint}</p>
                        {errors[i] && (
                            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-tertiary">
                                <Icon name="warning" size={12} />
                                {errors[i]}
                            </p>
                        )}
                    </div>
                )
            })}

            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-on-surface-variant">Agregar etapa:</span>
                {PIPELINE_STAGES.map((s) => (
                    <button
                        key={s.op}
                        onClick={() => addStage(s.op)}
                        title={s.hint}
                        className="rounded border border-outline-variant px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                    >
                        {s.op}
                    </button>
                ))}
            </div>
        </div>
    )
}
