import type {StreamParser, StringStream} from '@codemirror/language'

// PowerScript (fuentes exportados de PowerBuilder: .srw, .srd, .sru…).
//
// No hay un modo de PowerScript en ningún paquete de CodeMirror, y el de Visual
// Basic —el pariente más cercano— se equivoca justo en lo más común: en VB un
// apóstrofo abre un comentario, en PowerScript abre una cadena ('ok'), y los
// comentarios son // y /* */. Este modo chico cubre lo que hace legible un
// fuente: palabras clave sin distinguir mayúsculas, cadenas con las dos
// comillas (~ escapa), comentarios, números y los nombres de tipo.

const KEYWORDS = new Set(
    (
        'if then else elseif end for to step next do loop while until exit continue return choose case ' +
        'is and or not try catch finally throw throws create destroy using within this parent super ' +
        'global shared private protected public prototypes forward type variables subroutine function ' +
        'event on call post halt goto open close commit rollback connect disconnect declare cursor ' +
        'procedure fetch into execute immediate prepare describe select insert update delete from where ' +
        'values set null true false ref readonly constant systemread systemwrite protectedread ' +
        'protectedwrite privateread privatewrite external library alias rpcfunc dynamic static ' +
        'descriptor sqlca sqlda sqlsa autoinstantiate of inherited'
    ).split(' '),
)

const TYPES = new Set(
    (
        'any blob boolean byte char character date datetime dec decimal double int integer long ' +
        'longlong longptr real string time uint ulong unsignedint unsignedinteger unsignedlong ' +
        'window datawindow datastore datawindowchild userobject menu transaction nonvisualobject ' +
        'structure application powerobject graphicobject dragobject'
    ).split(' '),
)

interface State {
    inComment: boolean
}

function readString(stream: StringStream, quote: string): void {
    while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '~') stream.next()
        else if (ch === quote) return
    }
}

export const powerScript: StreamParser<State> = {
    name: 'powerscript',
    startState: () => ({inComment: false}),
    token(stream, state) {
        if (state.inComment) {
            if (stream.skipTo('*/')) {
                stream.match('*/')
                state.inComment = false
            } else stream.skipToEnd()
            return 'comment'
        }
        if (stream.eatSpace()) return null
        if (stream.match('//')) {
            stream.skipToEnd()
            return 'comment'
        }
        if (stream.match('/*')) {
            state.inComment = true
            return 'comment'
        }
        const ch = stream.peek()
        if (ch === '"' || ch === "'") {
            stream.next()
            readString(stream, ch)
            return 'string'
        }
        if (stream.match(/^\d+(\.\d+)?/)) return 'number'
        if (stream.match(/^[A-Za-z_$#%][\w$#%-]*/)) {
            // Los identificadores de PowerScript admiten guion: ls-nombre.
            const word = stream.current().toLowerCase()
            if (KEYWORDS.has(word)) return 'keyword'
            if (TYPES.has(word)) return 'typeName'
            if (stream.peek() === '(') return 'variableName.function'
            return 'variableName'
        }
        stream.next()
        return null
    },
    languageData: {commentTokens: {line: '//', block: {open: '/*', close: '*/'}}},
}
