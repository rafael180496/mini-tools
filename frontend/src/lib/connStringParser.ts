// Parses a pasted connection string (copy-pasted from a .env, a psql/JDBC
// URL, an Oracle Easy Connect string, a tnsnames.ora descriptor, or a Redis
// URL) into the same {dbType, oracleMode/redisMode, params} shape
// ConnectionDialog.tsx already uses to build a ConnectionInput — see
// backend/db/{sqlite,postgres,oracle,redis}.go's BuildDSN for the params
// each engine actually needs.
//
// Best-effort, not a full DSN grammar: unrecognized formats return null and
// the dialog stays exactly as manually-fillable as before — nothing is lost
// by trying. Redis Cluster/Sentinel DSNs (multiple nodes) are deliberately
// NOT covered here — they're rarely pasted as a single URL, and
// backend/db/redis.go's cluster/sentinel DSN shape (nodes/sentinels in a
// query param) isn't something a user would hand-paste anyway; only
// standalone redis://[user:pass@]host[:port][/db] is detected.

export type DBType = 'sqlite' | 'postgres' | 'oracle' | 'sqlserver' | 'mongodb' | 'redis'
export type OracleMode = 'service_name' | 'easy_connect' | 'sid' | 'tns'
export type RedisMode = 'standalone' | 'cluster' | 'sentinel'
export type MongoMode = 'standard' | 'srv'

export interface ParsedConnection {
    dbType: DBType
    oracleMode?: OracleMode
    redisMode?: RedisMode
    mongoMode?: MongoMode
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

// Standalone Redis URL: "redis://[user:pass@]host[:port][/db]" (or
// "rediss://" for TLS) — same shape backend/db/redis.go's BuildDSN produces
// for standalone mode.
function parseRedisURL(s: string): ParsedConnection | null {
    try {
        const url = new URL(s)
        const params: Record<string, string> = {}
        if (url.hostname) params.host = url.hostname
        if (url.port) params.port = url.port
        if (url.username) params.user = decodeURIComponent(url.username)
        if (url.password) params.password = decodeURIComponent(url.password)
        const dbIndex = url.pathname.replace(/^\//, '')
        if (dbIndex) params.db = dbIndex
        if (url.protocol === 'rediss:') params.tls = 'true'
        return {dbType: 'redis', redisMode: 'standalone', params}
    } catch {
        return null
    }
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

// go-mssqldb URL form, e.g.
// "sqlserver://user:pass@host:1433/INSTANCE?database=db&encrypt=disable".
function parseSQLServerURL(s: string): ParsedConnection | null {
    try {
        const url = new URL(s)
        const params: Record<string, string> = {}
        if (url.hostname) params.host = url.hostname
        if (url.port) params.port = url.port
        if (url.username) params.user = decodeURIComponent(url.username)
        if (url.password) params.password = decodeURIComponent(url.password)
        const instance = url.pathname.replace(/^\//, '')
        if (instance) params.instance = instance
        const database = url.searchParams.get('database')
        if (database) params.dbname = database
        const encrypt = url.searchParams.get('encrypt')
        if (encrypt) params.encrypt = encrypt.toLowerCase()
        const tsc = url.searchParams.get('trustservercertificate') ?? url.searchParams.get('TrustServerCertificate')
        if (tsc) params.trustServerCertificate = tsc.toLowerCase()
        return {dbType: 'sqlserver', params}
    } catch {
        return null
    }
}

// applySQLServerHost splits a SQL Server "server" token — which can carry a
// port (host,1433 .NET-style or host:1433 JDBC-style) and/or a named instance
// (host\INSTANCE) — into the separate host/port/instance params BuildDSN wants.
function applySQLServerHost(params: Record<string, string>, raw: string): void {
    let hp = raw.replace(/^tcp:/i, '').replace(/^np:/i, '').trim()
    const portMatch = hp.match(/[,:](\d+)$/)
    if (portMatch) {
        params.port = portMatch[1]
        hp = hp.slice(0, portMatch.index).trim()
    }
    const bs = hp.indexOf('\\')
    if (bs >= 0) {
        const instance = hp.slice(bs + 1).trim()
        if (instance) params.instance = instance
        hp = hp.slice(0, bs).trim()
    }
    if (hp) params.host = hp
}

// .NET (ADO) and JDBC key=value forms, e.g.
// "Server=tcp:host,1433;Database=db;User Id=me;Password=x;Encrypt=True" or
// "jdbc:sqlserver://host:1433;databaseName=db;user=me;password=x".
function parseSQLServerKeywordValue(s: string): ParsedConnection {
    const params: Record<string, string> = {}
    let rest = s

    const jdbc = rest.match(/^jdbc:sqlserver:\/\/([^;]*)/i)
    if (jdbc) {
        const hostPort = jdbc[1].trim()
        if (hostPort) applySQLServerHost(params, hostPort)
        rest = rest.slice(jdbc[0].length)
    }

    for (const pair of rest.split(';')) {
        const idx = pair.indexOf('=')
        if (idx < 0) continue
        const key = pair.slice(0, idx).trim().toLowerCase()
        const val = pair.slice(idx + 1).trim()
        if (!val) continue
        switch (key) {
            case 'server':
            case 'data source':
            case 'address':
            case 'addr':
            case 'network address':
                applySQLServerHost(params, val)
                break
            case 'database':
            case 'initial catalog':
            case 'databasename':
                params.dbname = val
                break
            case 'user id':
            case 'uid':
            case 'user':
                params.user = val
                break
            case 'password':
            case 'pwd':
                params.password = val
                break
            case 'encrypt':
                params.encrypt = val.toLowerCase()
                break
            case 'trustservercertificate':
                params.trustServerCertificate = val.toLowerCase()
                break
            case 'instance name':
            case 'instancename':
                params.instance = val
                break
        }
    }
    return {dbType: 'sqlserver', params}
}

// MongoDB URI: mongodb://[user:pass@]host[:port][,host2...]/[db]?opts or the
// SRV/Atlas form mongodb+srv://[user:pass@]host/[db]?opts. A multi-host
// authority (comma list) becomes params.hosts; a single host splits into
// host/port. The scheme decides the mode (mongodb vs mongodb+srv).
function parseMongoURL(s: string): ParsedConnection | null {
    try {
        const url = new URL(s)
        const srv = /^mongodb\+srv:/i.test(s)
        const params: Record<string, string> = {}
        // url.host keeps the raw authority (multi-host "h1,h2" survives here,
        // where url.hostname/url.port would mis-split it).
        const authority = url.host
        if (srv) {
            params.host = url.hostname
        } else if (authority.includes(',')) {
            params.hosts = authority
        } else {
            params.host = url.hostname
            if (url.port) params.port = url.port
        }
        if (url.username) params.user = decodeURIComponent(url.username)
        if (url.password) params.password = decodeURIComponent(url.password)
        const database = url.pathname.replace(/^\//, '')
        if (database) params.database = database
        const authSource = url.searchParams.get('authSource')
        if (authSource) params.authSource = authSource
        const replicaSet = url.searchParams.get('replicaSet')
        if (replicaSet) params.replicaSet = replicaSet
        if (url.searchParams.get('tls') === 'true' || url.searchParams.get('ssl') === 'true') params.tls = 'true'
        return {dbType: 'mongodb', mongoMode: srv ? 'srv' : 'standard', params}
    } catch {
        return null
    }
}

export function parseConnectionString(raw: string): ParsedConnection | null {
    const s = stripEnvWrapper(raw)
    if (!s) return null

    if (/^rediss?:\/\//i.test(s)) return parseRedisURL(s)
    if (/^mongodb(\+srv)?:\/\//i.test(s)) return parseMongoURL(s)
    if (/^(sqlserver|mssql):\/\//i.test(s)) return parseSQLServerURL(s)
    if (/^jdbc:sqlserver:/i.test(s)) return parseSQLServerKeywordValue(s)
    if (/^postgres(ql)?:\/\//i.test(s)) return parsePostgresURL(s)
    if (/^sqlite3?:\/\//i.test(s)) return {dbType: 'sqlite', params: {path: stripSqliteScheme(s)}}
    if (/^file:\/\//i.test(s)) return {dbType: 'sqlite', params: {path: stripSqliteScheme(s)}}
    if (/^oracle:\/\//i.test(s)) return parseOracleURL(s)
    if (/^jdbc:oracle:thin:/i.test(s)) return parseOracleJDBC(s)
    if (/^\(DESCRIPTION\s*=/i.test(s)) return {dbType: 'oracle', oracleMode: 'tns', params: {connectDescriptor: s}}
    if (/^[^/\s@]+\/[^@\s]*@/.test(s)) return parseOracleEasyConnect(s)
    if (/\b(server|data source|initial catalog|databasename)\s*=/i.test(s)) return parseSQLServerKeywordValue(s)
    if (/\b(host|dbname|user)\s*=/i.test(s)) return parsePostgresKeywordValue(s)
    if (/^([./]|[A-Za-z]:\\|~\/)/.test(s) || /\.(db|sqlite3?|db3)$/i.test(s)) {
        return {dbType: 'sqlite', params: {path: s}}
    }

    return null
}
