import type {Messages} from '../../types'
import type es from '../../es/gitparts/search'

const en: Messages<typeof es> = {
    describe: {
        author: (v) => `author "${v}"`,
        message: (v) => `message "${v}"`,
        path: (v) => `touching "${v}"`,
        rev: (v) => `from ${v}`,
        since: (v) => `after ${v}`,
        until: (v) => `before ${v}`,
    },
    help: {
        author: 'author:angelo — commits by that author (also autor:)',
        message: 'message:feat — searches the message (also msg:, mensaje:)',
        file: 'file:AGENTS.md — only commits that touched that file (also archivo:)',
        range: 'since:2024-01-01 · until:"2 weeks ago" — date range (also desde:/hasta:)',
        hash: 'hash:a1b2c3d — history starting from that commit',
        bare: 'Without a prefix it searches the message; a bare hash of 7+ characters is detected automatically.',
    },
}
export default en
