// Aggregation pipeline construction for the visual builder.
//
// find() runs out of road quickly in MongoDB: anything involving grouping,
// joining another collection, or reshaping documents needs aggregate(). This
// models a pipeline as an ordered list of stages, each one a body of JSON the
// user edits, with a template pre-filled per stage type so nobody has to
// remember whether $group's accumulator goes inside or outside the field.
//
// Bodies are kept as TEXT, not as parsed objects, on purpose: the pipeline is
// halfway edited most of the time, and re-serialising a half-typed object
// would fight the user's cursor. Validity is checked, never enforced.

import {t} from '../i18n'

export interface PipelineStage {
    // op is the stage operator, e.g. "$match".
    op: string
    // body is the stage's argument as (lenient) JSON text.
    body: string
}

export interface StageDef {
    op: string
    label: string
    hint: string
    // template is the starting body inserted when the stage is added.
    template: string
}

// The stages worth offering visually. Deliberately not every stage MongoDB
// has: this is the set that covers ordinary reporting and joining work, and
// a longer list would be a worse menu, not a more capable one. Anything
// exotic is still writable in the editor.
//
// Only the operators live here; each stage's label, hint and starting template
// come from the dictionary (t().mongo.stages['$match']) — the template too,
// since its placeholder field names are words — resolved on every call.
const STAGE_OPS = ['$match', '$group', '$project', '$sort', '$limit', '$skip', '$lookup', '$unwind', '$count', '$addFields']

export function pipelineStages(): StageDef[] {
    const d = t().mongo.stages as Record<string, {label: string; hint: string; template: string}>
    return STAGE_OPS.map((op) => ({op, ...d[op]}))
}

export function stageDef(op: string): StageDef {
    const all = pipelineStages()
    return all.find((s) => s.op === op) ?? all[0]
}

// buildPipelineCommand renders the stages as a db.<coll>.aggregate([...])
// command. Bodies are emitted verbatim (indented), so whatever the user typed
// is what runs — the builder never rewrites their JSON behind their back.
export function buildPipelineCommand(collection: string, stages: PipelineStage[]): string {
    const coll = collection.trim() || t().mongo.pipeline.collectionPlaceholder
    const usable = stages.filter((s) => s.body.trim() !== '')
    if (usable.length === 0) {
        return `db.${coll}.aggregate([])`
    }

    const rendered = usable.map((s) => {
        const body = indentBody(s.body.trim(), 4)
        return `  { "${s.op}": ${body} }`
    })
    return `db.${coll}.aggregate([\n${rendered.join(',\n')}\n])`
}

// indentBody re-indents a multi-line stage body so the emitted pipeline is
// readable. A single-line body is left exactly as typed.
function indentBody(body: string, spaces: number): string {
    if (!body.includes('\n')) return body
    const pad = ' '.repeat(spaces)
    const lines = body.split('\n')
    return lines
        .map((line, i) => (i === 0 ? line : pad + line))
        .join('\n')
}

// validateStages returns a per-stage error message (or "" when fine), so the
// builder can point at the stage that will not parse instead of only
// refusing to run. Uses JSON.parse, which is stricter than what the backend's
// lenient parser accepts — a body it rejects may still run — so the message
// says "revisá", never "es inválido".
export function validateStages(stages: PipelineStage[]): string[] {
    return stages.map((s) => {
        const body = s.body.trim()
        if (body === '') return t().mongo.pipeline.emptyStage
        try {
            JSON.parse(body)
            return ''
        } catch {
            // A bare number or quoted string is valid for $limit/$skip/$count
            // and JSON.parse handles those too, so reaching here means the
            // body really is malformed as strict JSON.
            return t().mongo.pipeline.badJson
        }
    })
}
