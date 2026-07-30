// Confirmation before running a destructive command on a server marked as
// production.
//
// Deliberately NOT a security boundary. Anyone with this terminal open can
// already run anything, and could open a real ssh client next to it. What
// this catches is the actual failure mode: the command that was meant for
// the staging tab, pasted into the production one. So it errs toward
// explaining what the command does over trying to be exhaustive — an alarm
// that fires on everything gets dismissed on everything.
//
// It runs here rather than in Go on purpose: it fires on every Enter, and a
// round trip through the bindings to decide whether a keystroke may proceed
// would put IPC latency in front of every command typed into the terminal.
// The detection is a pure function over a string, with nothing to gain from
// the backend.

export interface Risk {
    // What matched, for the dialog's title.
    label: string
    // Why it is dangerous, in plain terms. The dialog shows this instead of
    // the pattern, because "rm -rf" tells the user nothing they did not
    // already know.
    detail: string
}

interface Rule {
    test: RegExp
    label: string
    detail: string
}

// Each pattern is anchored on a command boundary (start of line, or after a
// pipe/semicolon/&&) so a mention inside a longer word or an argument does
// not trigger it: `grep dd file` is not `dd`.
const CMD = String.raw`(?:^|[;&|]\s*|\)\s*)`

const RULES: Rule[] = [
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|` + CMD + String.raw`(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]`),
        label: 'rm -rf',
        detail: 'Borra recursivamente y sin preguntar. No hay papelera: lo que se borra en el servidor no se recupera.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?mkfs(\.\w+)?\b`),
        label: 'mkfs',
        detail: 'Formatea un sistema de archivos. Todo lo que haya en ese dispositivo deja de existir.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?dd\s+.*\bof=`),
        label: 'dd of=',
        detail: 'Escribe directamente sobre un dispositivo o archivo. Un destino equivocado destruye un disco entero sin confirmación.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?systemctl\s+(stop|disable|mask)\b`),
        label: 'systemctl stop/disable',
        detail: 'Detiene o deshabilita un servicio. En producción esto es una caída, y `disable` además sobrevive al próximo reinicio.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(shutdown|reboot|halt|poweroff)\b`),
        label: 'apagado o reinicio',
        detail: 'Apaga o reinicia el servidor. Si no tenés acceso físico o consola fuera de banda, puede no volver.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(kill|pkill|killall)\s+(-9|-KILL)\b`),
        label: 'kill -9',
        detail: 'Mata el proceso sin darle oportunidad de cerrar: transacciones a medias, archivos sin flushear y sockets colgados.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)`),
        label: 'chmod/chown recursivo',
        detail: 'Cambia permisos o dueño de todo un árbol. Aplicado sobre / o sobre el directorio equivocado deja el sistema inutilizable.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(iptables|nft)\s+.*(-F|--flush)\b`),
        label: 'iptables -F',
        detail: 'Vacía las reglas de firewall. Si tu propio acceso SSH depende de una de ellas, la sesión se corta y no vuelve a entrar.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(userdel|groupdel)\b`),
        label: 'userdel',
        detail: 'Elimina una cuenta del sistema. Los procesos y cron de ese usuario dejan de funcionar.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(drop\s+database|truncate\s+table)`, 'i'),
        label: 'DROP/TRUNCATE',
        detail: 'Destruye datos de una base entera. Sin un backup verificado, es irreversible.',
    },
    {
        test: />\s*\/dev\/(sd|nvme|vd|hd)/,
        label: 'escritura a /dev/…',
        detail: 'Redirige salida directamente a un disco. Sobrescribe la tabla de particiones o el sistema de archivos que haya ahí.',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?git\s+push\s+.*(--force\b|(?:^|\s)-f(?:\s|$))`),
        label: 'git push --force',
        detail: 'Reescribe la historia de la rama remota. El trabajo que otro haya subido en el medio se pierde.',
    },
]

// stripStrings blanks out quoted text so a pattern inside a literal does not
// fire: `echo "cuidado con rm -rf"` is not a destructive command.
function stripStrings(cmd: string): string {
    return cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

// inspect reports every rule the command matches. Empty means nothing
// recognised — which is NOT the same as safe, and the dialog never claims it
// is.
export function inspect(command: string): Risk[] {
    const cmd = stripStrings(command.trim())
    if (!cmd) return []
    // A comment is not a command.
    if (cmd.startsWith('#')) return []

    const out: Risk[] = []
    for (const rule of RULES) {
        if (rule.test.test(cmd)) out.push({label: rule.label, detail: rule.detail})
    }
    return out
}

// splitCommandLines breaks a chunk of terminal input into the command lines it
// would execute.
//
// Needed for PASTE, which is the case this whole feature exists for: a pasted
// block arrives as one chunk and every line in it before the last runs
// immediately, with no chance to read it first.
export function splitCommandLines(data: string): string[] {
    return data
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
}
