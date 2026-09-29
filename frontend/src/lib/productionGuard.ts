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

import {t} from '../i18n'

export interface Risk {
    // What matched, for the dialog's title.
    label: string
    // Why it is dangerous, in plain terms. The dialog shows this instead of
    // the pattern, because "rm -rf" tells the user nothing they did not
    // already know.
    detail: string
}

// El texto de cada regla vive en el diccionario (t().ssh.guard.rules) y se
// resuelve en inspect(), al usarlo: guardarlo acá lo congelaría en el idioma
// con el que arrancó la app.
type RuleKey = keyof ReturnType<typeof t>['ssh']['guard']['rules']

interface Rule {
    test: RegExp
    key: RuleKey
}

// Each pattern is anchored on a command boundary (start of line, or after a
// pipe/semicolon/&&) so a mention inside a longer word or an argument does
// not trigger it: `grep dd file` is not `dd`.
const CMD = String.raw`(?:^|[;&|]\s*|\)\s*)`

const RULES: Rule[] = [
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|` + CMD + String.raw`(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]`),
        key: 'rmRf',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?mkfs(\.\w+)?\b`),
        key: 'mkfs',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?dd\s+.*\bof=`),
        key: 'dd',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?systemctl\s+(stop|disable|mask)\b`),
        key: 'systemctl',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(shutdown|reboot|halt|poweroff)\b`),
        key: 'shutdown',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(kill|pkill|killall)\s+(-9|-KILL)\b`),
        key: 'kill9',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(chmod|chown)\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)`),
        key: 'chmodR',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(iptables|nft)\s+.*(-F|--flush)\b`),
        key: 'iptables',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(userdel|groupdel)\b`),
        key: 'userdel',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?(drop\s+database|truncate\s+table)`, 'i'),
        key: 'drop',
    },
    {
        test: />\s*\/dev\/(sd|nvme|vd|hd)/,
        key: 'devWrite',
    },
    {
        test: new RegExp(CMD + String.raw`(?:sudo\s+)?git\s+push\s+.*(--force\b|(?:^|\s)-f(?:\s|$))`),
        key: 'forcePush',
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
        if (rule.test.test(cmd)) out.push({...t().ssh.guard.rules[rule.key]})
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
