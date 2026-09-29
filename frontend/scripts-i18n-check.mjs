// Chequeo de textos de interfaz escritos a mano (ver .claude/specs/i18n.md).
//
// Recorre el AST de TypeScript —no regex— de cada .tsx/.ts del frontend y
// cuenta los textos que tendrían que venir del diccionario:
//   - texto entre etiquetas JSX;
//   - strings en atributos de texto (title, placeholder, aria-label, label,
//     alt, description, confirmLabel, hint), también dentro de un {cond ? 'a' : 'b'};
//   - strings en propiedades de objeto de texto (label, hint, title,
//     description, placeholder, text, message): los ítems de menú.
// Un string "es texto" si tiene al menos dos letras seguidas. Las claves
// técnicas (nombres de ícono, clases) no caen porque viven en otros atributos.
//
// Uso: node scripts-i18n-check.mjs [--update] [--list archivo]
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, 'src')
const baselinePath = path.resolve(import.meta.dirname, '../scripts/i18n-baseline.txt')
const TEXT_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'label', 'alt', 'description', 'confirmLabel', 'hint', 'emptyText', 'tooltip'])
const TEXT_PROPS = new Set(['label', 'hint', 'title', 'description', 'placeholder', 'text', 'message', 'tooltip'])
// Archivos que no son interfaz: los diccionarios, los bindings generados y el
// banco de capturas (sus datos de prueba son contenido, no interfaz).
const SKIP = [/^i18n\//, /^uishot\.tsx$/, /\.d\.ts$/, /\.test\.tsx?$/]

// Nombres técnicos y marcas que se escriben igual en los dos idiomas: no son
// texto a traducir. Las siglas en mayúsculas cortas (GET, SQL, JSON) tampoco.
const SAME_IN_ALL = new Set(['mini-tools', 'Git', 'GitHub', 'Redis', 'MongoDB', 'Oracle', 'PostgreSQL', 'Postgres', 'SQLite', 'SQL Server', 'Claude', 'Claude Code', 'Codex', 'Gemini', 'Obsidian', 'Postman', 'cURL', 'Markdown', 'OK', 'Wails', 'macOS', 'Windows', 'Linux', 'Docker', 'SFTP', 'SSH', 'MCP', 'Git Flow', 'origin', 'HEAD', 'main', 'master', 'develop'])
const isText = (s) => {
    const v = s.replace(/\s+/g, ' ').trim()
    if (!/\p{L}{2,}/u.test(v)) return false
    if (SAME_IN_ALL.has(v)) return false
    if (/^[A-Z0-9_./:+-]{2,6}$/.test(v)) return false
    return true
}
// Un nombre de prop/parámetro "de texto": label, title, hint, … y cualquier
// variante con ese sufijo (rootLabel, confirmTitle, emptyText).
const TEXTY_NAME = /(label|title|hint|placeholder|description|text|message|tooltip)$/i

function walkFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walkFiles(p, out)
        else if (/\.(tsx|ts)$/.test(e.name)) out.push(p)
    }
    return out
}

function scan(file) {
    const src = fs.readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const hits = []
    const add = (node, text) => {
        const {line} = sf.getLineAndCharacterOfPosition(node.getStart())
        hits.push({line: line + 1, text: text.replace(/\s+/g, ' ').trim().slice(0, 80)})
    }
    const strings = (node, cb) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) cb(node, node.text)
        else if (ts.isTemplateExpression(node)) cb(node, node.head.text + node.templateSpans.map((s) => s.literal.text).join(' '))
        else if (ts.isConditionalExpression(node)) {
            strings(node.whenTrue, cb)
            strings(node.whenFalse, cb)
        } else if (ts.isBinaryExpression(node)) {
            // Solo lo que PUEDE terminar en pantalla: una concatenación, el
            // lado derecho de `cond && 'texto'` y los dos de `a || b` / `a ?? b`.
            // Una comparación (`section === 'params'`) es código, no texto.
            const op = node.operatorToken.kind
            const K = ts.SyntaxKind
            if (op === K.PlusToken || op === K.BarBarToken || op === K.QuestionQuestionToken) {
                strings(node.left, cb)
                strings(node.right, cb)
            } else if (op === K.AmpersandAmpersandToken) {
                strings(node.right, cb)
            }
        } else if (ts.isParenthesizedExpression(node)) strings(node.expression, cb)
    }
    const visit = (node) => {
        if (ts.isJsxText(node)) {
            if (isText(node.text)) add(node, node.text)
        } else if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent) || (ts.isJsxExpression(node) && node.expression && ts.isJsxFragment(node.parent))) {
            strings(node.expression, (n, t) => isText(t) && add(n, t))
        } else if (ts.isJsxAttribute(node)) {
            const name = node.name.getText(sf)
            if ((TEXT_ATTRS.has(name) || TEXTY_NAME.test(name)) && node.initializer) {
                const init = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
                if (init) strings(init, (n, t) => isText(t) && add(n, t))
            }
        } else if (ts.isPropertyAssignment(node)) {
            const name = node.name.getText(sf).replace(/['"]/g, '')
            if (TEXT_PROPS.has(name) || TEXTY_NAME.test(name)) strings(node.initializer, (n, t) => isText(t) && add(n, t))
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            // Mensajes que terminan en pantalla: setError('…'), setNotice('…'),
            // new Error('…') (se muestra con String(e)).
            const callee = node.expression.getText(sf)
            if (/^set(Error|Notice|Message|Status|Info|Warning|Hint)$/.test(callee) || (ts.isNewExpression(node) && callee === 'Error')) {
                for (const a of node.arguments ?? []) strings(a, (n, t) => isText(t) && add(n, t))
            }
        } else if ((ts.isBindingElement(node) || ts.isParameter(node)) && node.initializer && ts.isIdentifier(node.name)) {
            // Valor por defecto de una prop: `confirmLabel = 'Guardar'`.
            if (TEXTY_NAME.test(node.name.text)) strings(node.initializer, (n, t) => isText(t) && add(n, t))
        }
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return hits
}

const args = process.argv.slice(2)
const files = walkFiles(root)
    .map((f) => path.relative(root, f))
    .filter((f) => !SKIP.some((re) => re.test(f)))
    .sort()

if (args[0] === '--list') {
    for (const h of scan(path.join(root, args[1]))) console.log(`${args[1]}:${h.line}  ${h.text}`)
    process.exit(0)
}

const counts = {}
for (const f of files) {
    const n = scan(path.join(root, f)).length
    if (n > 0) counts[f] = n
}

const baseline = {}
if (fs.existsSync(baselinePath)) {
    for (const line of fs.readFileSync(baselinePath, 'utf8').split('\n')) {
        const m = line.match(/^(\d+)\s+(.+)$/)
        if (m) baseline[m[2]] = Number(m[1])
    }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)
if (args[0] === '--update') {
    const body = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `${n} ${f}`)
        .join('\n')
    fs.writeFileSync(
        baselinePath,
        `# Textos de interfaz que todavía no pasan por i18n, por archivo.\n# Generado por scripts/i18n-check.sh --update. Solo puede bajar.\n${body}\n`,
    )
    console.log(`i18n: línea base actualizada — ${total} textos pendientes en ${Object.keys(counts).length} archivos`)
    process.exit(0)
}

const worse = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0))
if (worse.length) {
    console.error('i18n: texto de interfaz nuevo sin pasar por el diccionario (ver .claude/rules/conventions.md, «Textos de la interfaz»):')
    for (const [f, n] of worse) {
        console.error(`  ${f}: ${n} (línea base ${baseline[f] ?? 0})`)
        for (const h of scan(path.join(root, f)).slice(0, 8)) console.error(`    ${h.line}: ${h.text}`)
    }
    process.exit(1)
}
const better = Object.keys(baseline).filter((f) => (counts[f] ?? 0) < baseline[f])
console.log(`i18n: ${total} textos pendientes en ${Object.keys(counts).length} archivos` + (better.length ? ` — bajaron ${better.length}; corré con --update` : ''))
