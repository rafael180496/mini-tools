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
export const PIPELINE_STAGES: StageDef[] = [
    {
        op: '$match',
        label: '$match — filtrar',
        hint: 'Filtra documentos. Ponelo lo más arriba posible del pipeline: reduce el volumen que procesan las etapas siguientes y es la única etapa que puede aprovechar un índice.',
        template: '{ "campo": "valor" }',
    },
    {
        op: '$group',
        label: '$group — agrupar',
        hint: '_id es la clave de agrupación (null agrupa todo en una fila). Los demás campos son acumuladores: $sum, $avg, $min, $max, $push, $addToSet.',
        template: '{\n  "_id": "$campo",\n  "total": { "$sum": 1 }\n}',
    },
    {
        op: '$project',
        label: '$project — elegir campos',
        hint: '1 incluye el campo, 0 lo excluye. También sirve para crear campos calculados a partir de otros.',
        template: '{ "campo": 1, "_id": 0 }',
    },
    {
        op: '$sort',
        label: '$sort — ordenar',
        hint: '1 ascendente, -1 descendente. Después de un $group no hay índice que lo respalde, así que ordenar mucho volumen acá cuesta memoria.',
        template: '{ "campo": -1 }',
    },
    {
        op: '$limit',
        label: '$limit — limitar',
        hint: 'Corta el pipeline a N documentos.',
        template: '20',
    },
    {
        op: '$skip',
        label: '$skip — saltar',
        hint: 'Descarta los primeros N documentos. Combinado con $limit permite paginar.',
        template: '0',
    },
    {
        op: '$lookup',
        label: '$lookup — unir con otra colección',
        hint: 'El equivalente a un LEFT JOIN. localField es el campo de esta colección, foreignField el de la otra, y "as" el nombre del array donde caen las coincidencias.',
        template: '{\n  "from": "otra_coleccion",\n  "localField": "campo_local",\n  "foreignField": "_id",\n  "as": "resultado"\n}',
    },
    {
        op: '$unwind',
        label: '$unwind — desarmar array',
        hint: 'Convierte cada elemento de un array en un documento propio. Se suele usar justo después de un $lookup para aplanar las coincidencias.',
        template: '{ "path": "$campo", "preserveNullAndEmptyArrays": true }',
    },
    {
        op: '$count',
        label: '$count — contar',
        hint: 'Reemplaza todo lo que venía por un único documento con el conteo, bajo el nombre que le des.',
        template: '"total"',
    },
    {
        op: '$addFields',
        label: '$addFields — agregar campos',
        hint: 'Suma campos calculados sin descartar los existentes, a diferencia de $project.',
        template: '{ "nuevo": { "$concat": ["$a", " ", "$b"] } }',
    },
]

export function stageDef(op: string): StageDef {
    return PIPELINE_STAGES.find((s) => s.op === op) ?? PIPELINE_STAGES[0]
}

// buildPipelineCommand renders the stages as a db.<coll>.aggregate([...])
// command. Bodies are emitted verbatim (indented), so whatever the user typed
// is what runs — the builder never rewrites their JSON behind their back.
export function buildPipelineCommand(collection: string, stages: PipelineStage[]): string {
    const coll = collection.trim() || 'colección'
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
        if (body === '') return 'Etapa vacía: se omite al generar el pipeline.'
        try {
            JSON.parse(body)
            return ''
        } catch {
            // A bare number or quoted string is valid for $limit/$skip/$count
            // and JSON.parse handles those too, so reaching here means the
            // body really is malformed as strict JSON.
            return 'Revisá el JSON de esta etapa: las comillas dobles y las comas son las que suelen faltar.'
        }
    })
}
