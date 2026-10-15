// Las fichas que viajan con «Validar con otro agente».
//
// En modo consulta un CLI muchas veces no puede ni correr git, así que decirle
// «mirá el diff» sin dárselo era pedirle que adivinara. Estas dos fichas son lo
// que el revisor necesita para revisar de verdad —qué hizo el primer agente y
// qué quedó cambiado en el árbol de trabajo—, y van ADJUNTAS y a la vista: se
// leen, se despliegan y se quitan antes de enviar. Nada viaja a escondidas.

import type {ChatContextBlock, ChatLastTurn} from '../components/agent/AgentChat'
import {t as i18n} from '../i18n'

// Estructura de `main.ReviewContext` (lo que devuelve `GitReviewContext`). Se
// declara acá y no se importa del modelo generado: el componente que sembraría
// esto en una captura no tiene por qué construir una clase de Wails.
export interface ReviewChanges {
    files: string[]
    diff: string
    truncated: boolean
    insertions: number
    deletions: number
}

// Tope de líneas por lista: una tanda de cientos de herramientas o archivos
// no se lee entera en una ficha, y el aviso «… y N más» dice cuánto se omitió.
const MAX_TOOL_LINES = 60
const MAX_FILE_LINES = 200

export function buildReviewBlocks(lastTurn: ChatLastTurn, changes: ReviewChanges | null): ChatContextBlock[] {
    const r = i18n().git.tab.review
    const blocks: ChatContextBlock[] = []

    const toolLines = lastTurn.tools.slice(0, MAX_TOOL_LINES).map((x) => `- ${x}`)
    if (lastTurn.tools.length > MAX_TOOL_LINES) toolLines.push(`- ${r.andMore({n: lastTurn.tools.length - MAX_TOOL_LINES})}`)
    if (lastTurn.text || toolLines.length > 0) {
        blocks.push({
            label: r.workLabel({agent: lastTurn.agentLabel}),
            text:
                `## ${r.workAnswer}\n\n${lastTurn.text || r.workEmpty}` +
                (toolLines.length > 0 ? `\n\n## ${r.workTools}\n\n${toolLines.join('\n')}` : ''),
            language: 'markdown',
            icon: 'smart_toy',
        })
    }

    if (changes && changes.files.length > 0) {
        const files = changes.files.slice(0, MAX_FILE_LINES)
        if (changes.files.length > MAX_FILE_LINES) files.push(r.andMore({n: changes.files.length - MAX_FILE_LINES}))
        const hasPatch = changes.diff.trim() !== ''
        const parts = [r.changesFiles({n: changes.files.length}), files.join('\n')]
        // El aviso va ANTES del parche: leído al final, después de miles de
        // líneas, es el que nadie ve.
        if (changes.truncated) parts.push('', r.changesTruncated({kb: Math.round(changes.diff.length / 1024)}))
        parts.push('', hasPatch ? r.changesDiff : r.changesNoPatch)
        if (hasPatch) parts.push(changes.diff)
        blocks.push({label: r.changesLabel, text: parts.join('\n'), language: 'diff', icon: 'difference'})
    }
    return blocks
}
