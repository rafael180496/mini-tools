// Parses a pasted connection string (copy-pasted from a .env, a psql/JDBC
// URL, an Oracle Easy Connect string, or a tnsnames.ora descriptor) into the
// same {dbType, oracleMode, params} shape ConnectionDialog.tsx already uses
// to build a ConnectionInput — see backend/db/{sqlite,postgres,oracle}.go's
// BuildDSN for the params each engine actually needs.
//
// Best-effort, not a full DSN grammar: unrecognized formats return null and
// the dialog stays exactly as manually-fillable as before — nothing is lost
// by trying.

export type DBType = 'sqlite' | 'postgres' | 'oracle'
export type OracleMode = 'service_name' | 'easy_connect' | 'sid' | 'tns'

export interface ParsedConnection {
    dbType: DBType
    oracleMode?: OracleMode
    params: Record<string, string>
}

// Strips a leading `KEY=` (.env style, e.g. "DATABASE_URL=postgres://...")
// and surrounding quotes. Only matches SCREAMING_SNAKE_CASE keys (the .env
// convention) — a lowercase key like "host=" is deliberately left alone, it
// almost certainly means a libpq keyword=value string, not an env wrapper.
function stripEnvWrapper(input: string): string {
    let s = input.trim()
    const eq = s.match(/^[A-Z][A-Z0-9_]*\s*=\s*/)
    if (eq) s = s.slice(eq[0].length).trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1)
    }
    return s.trim()
}

function stripSqliteScheme(s: string): string {
    let path = s.replace(/^sqlite3?:\/\//i, '').replace(/^file:\/\//i, '')
    // Drop a query string our own BuildDSN would append (?_pragma=...) — not
    // a real part of the filesystem path.
    path = path.split('?')[0]
    return path
}

function parsePostgresURL(s: string): ParsedConnection | null {
    try {
        const url = new URL(s)
        const params: Record<string, string> = {}
        if (url.hostname) params.host = url.hostname
        if (url.port) params.port = url.port
        if (url.username) params.user = decodeURIComponent(url.username)
        if (url.password) params.password = decodeURIComponent(url.password)
        const dbname = url.pathname.replace(/^\//, '')
        if (dbname) params.dbname = dbname
        const sslmode = url.searchParams.get('sslmode')
        if (sslmode) params.sslmode = sslmode
        return {dbType: 'postgres', params}
    } catch {
        return null
    }
}

// libpq keyword=value form, e.g. "host=localhost port=5432 dbname=mydb
// user=me password=secret sslmode=require" (also accepts "database=" and
// quoted values).
function parsePostgresKeywordValue(s: string): ParsedConnection {
    const params: Record<string, string> = {}
    const re = /(\w+)\s*=\s*('[^']*'|"[^"]*"|\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
        const key = m[1].toLowerCase()
        let value = m[2]
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
            value = value.slice(1, -1)
        }
        switch (key) {
            case 'host':
            case 'hostname':
            case 'server':
                params.host = value
                break
            case 'port':
                params.port = value
                break
            case 'user':
            case 'username':
            case 'uid':
                params.user = value
                break
            case 'password':
            case 'pwd':
                params.password = value
                break
            case 'dbname':
            case 'database':
                params.dbname = value
                break
            case 'sslmode':
                params.sslmode = value
                break
        }
    }
    return {dbType: 'postgres', params}
}

function parseOracleURL(s: string): ParsedConnection | null {
    try {
        const url = new URL(s)
        const params: Record<string, string> = {}
        if (url.hostname) params.host = url.hostname
        if (url.port) params.port = url.port
        if (url.username) params.user = decodeURIComponent(url.username)
        if (url.password) params.password = decodeURIComponent(url.password)
        const service = url.pathname.replace(/^\//, '')
        if (service) params.service = service
        return {dbType: 'oracle', oracleMode: 'service_name', params}
    } catch {
        return null
    }
}

// Easy Connect / classic slash form: "user/password@host:port/service" or
// "user/password@host:port:sid", also handles a TNS descriptor after the
// '@' ("user/password@(DESCRIPTION=...)").
function parseOracleEasyConnect(s: string): ParsedConnection | null {
    const at = s.indexOf('@')
    if (at === -1) return null
    const credPart = s.slice(0, at)
    const rest = s.slice(at + 1).trim()

    const slash = credPart.indexOf('/')
    const user = slash === -1 ? credPart : credPart.slice(0, slash)
    const password = slash === -1 ? '' : credPart.slice(slash + 1)
    if (!user) return null

    const params: Record<string, string> = {user}
    if (password) params.password = password

    if (/^\(DESCRIPTION\s*=/i.test(rest)) {
        params.connectDescriptor = rest
        return {dbType: 'oracle', oracleMode: 'tns', params}
    }

    const m = rest.match(/^([^:/\s]+)(?::(\d+))?(?:([/:])(.+))?$/)
    if (!m) return null
    const [, host, port, sep, remainder] = m
    params.host = host
    if (port) params.port = port

    if (sep === '/' && remainder) {
        params.service = remainder
        return {dbType: 'oracle', oracleMode: 'easy_connect', params}
    }
    if (sep === ':' && remainder) {
        params.sid = remainder
        return {dbType: 'oracle', oracleMode: 'sid', params}
    }
    return {dbType: 'oracle', oracleMode: 'easy_connect', params}
}

// JDBC thin style: "jdbc:oracle:thin:user/password@host:port:sid",
// "jdbc:oracle:thin:@host:port:sid", "jdbc:oracle:thin:@//host:port/service".
function parseOracleJDBC(s: string): ParsedConnection | null {
    let rest = s.replace(/^jdbc:oracle:thin:/i, '').trim()
    if (!rest.startsWith('@')) {
        return parseOracleEasyConnect(rest)
    }

    rest = rest.slice(1).replace(/^\/\//, '')
    const m = rest.match(/^([^:/\s]+)(?::(\d+))?(?:([/:])(.+))?$/)
    if (!m) return null
    const [, host, port, sep, remainder] = m
    const params: Record<string, string> = {host}
    if (port) params.port = port

    if (sep === '/' && remainder) {
        params.service = remainder
        return {dbType: 'oracle', oracleMode: 'easy_connect', params}
    }
    if (sep === ':' && remainder) {
        params.sid = remainder
        return {dbType: 'oracle', oracleMode: 'sid', params}
    }
    return {dbType: 'oracle', oracleMode: 'easy_connect', params}
}

export function parseConnectionString(raw: string): ParsedConnection | null {
    const s = stripEnvWrapper(raw)
    if (!s) return null

    if (/^postgres(ql)?:\/\//i.test(s)) return parsePostgresURL(s)
    if (/^sqlite3?:\/\//i.test(s)) return {dbType: 'sqlite', params: {path: stripSqliteScheme(s)}}
    if (/^file:\/\//i.test(s)) return {dbType: 'sqlite', params: {path: stripSqliteScheme(s)}}
    if (/^oracle:\/\//i.test(s)) return parseOracleURL(s)
    if (/^jdbc:oracle:thin:/i.test(s)) return parseOracleJDBC(s)
    if (/^\(DESCRIPTION\s*=/i.test(s)) return {dbType: 'oracle', oracleMode: 'tns', params: {connectDescriptor: s}}
    if (/^[^/\s@]+\/[^@\s]*@/.test(s)) return parseOracleEasyConnect(s)
    if (/\b(host|dbname|user)\s*=/i.test(s)) return parsePostgresKeywordValue(s)
    if (/^([./]|[A-Za-z]:\\|~\/)/.test(s) || /\.(db|sqlite3?|db3)$/i.test(s)) {
        return {dbType: 'sqlite', params: {path: s}}
    }

    return null
}
