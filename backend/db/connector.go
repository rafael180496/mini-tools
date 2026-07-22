package db

import "fmt"

// DBType identifies which of the 4 supported engines a connection uses.
type DBType string

const (
	DBTypeSQLite    DBType = "sqlite"
	DBTypePostgres  DBType = "postgres"
	DBTypeOracle    DBType = "oracle"
	DBTypeSQLServer DBType = "sqlserver"
	// DBTypeRedis is the one deliberate exception to "all engines go
	// through database/sql" (.claude/rules/technical.md point 2, exception
	// documented there) — Redis isn't relational and go-redis's client
	// doesn't implement database/sql interfaces, so it's driven by
	// RedisPoolManager (redis_pool.go) instead of PoolManager. See
	// .claude/skills/mini-tools-patterns/SKILL.md's Redis section.
	DBTypeRedis DBType = "redis"
	// DBTypeMongo is a further deliberate exception to the same rule, same
	// reasoning as DBTypeRedis (approved explicitly, not assumed — see
	// .claude/rules/technical.md point 2): MongoDB is document-oriented, not
	// relational, and the official go.mongodb.org/mongo-driver/v2 doesn't
	// implement database/sql interfaces, so it's driven by MongoPoolManager
	// (mongo_pool.go) + backend/mongoquery instead of PoolManager/query. See
	// .claude/skills/mini-tools-patterns/SKILL.md's MongoDB section.
	DBTypeMongo DBType = "mongodb"
	// DBTypeSSH is a further deliberate exception to the same rule, same
	// reasoning as DBTypeRedis: an SSH session is not a relational
	// database/sql connection at all, so it's driven by
	// sshconn.SessionManager instead of PoolManager. Unlike Redis it has no
	// pooled/reusable connection concept in the first place — an SSH
	// terminal session is a stateful remote process, opened and closed
	// explicitly per connection, never reused across queries.
	DBTypeSSH DBType = "ssh"
)

// DriverName returns the database/sql driver name registered for this
// engine — Oracle/Postgres/SQLite are unified under database/sql, never
// sqlx or a driver's native SDK directly. See .claude/rules/technical.md.
// Redis has no database/sql driver and never calls this — it's routed
// through RedisPoolManager instead of PoolManager.
func (t DBType) DriverName() string {
	switch t {
	case DBTypeSQLite:
		return "sqlite"
	case DBTypePostgres:
		return "pgx"
	case DBTypeOracle:
		return "oracle"
	case DBTypeSQLServer:
		return "sqlserver"
	default:
		return ""
	}
}

// Connector builds a database/sql DSN for one engine from user-supplied
// params. The frontend never sends or sees a raw DSN — only these params —
// and the built DSN is encrypted immediately after (see vault.Store).
type Connector interface {
	Type() DBType
	BuildDSN(params map[string]string) (string, error)
	// ParseDSN reverses BuildDSN, for pre-filling an "edit connection" form
	// from an already-saved (decrypted) DSN. Returns every param BuildDSN
	// would need, INCLUDING password — callers at the App/binding boundary
	// are responsible for stripping it before anything reaches the
	// frontend (see app.go's GetConnectionForEdit); this function itself
	// has no way to know which caller needs which, so it stays complete.
	ParseDSN(dsn string) (map[string]string, error)
}

// ConnectorFor returns the Connector implementation for t. See
// .claude/skills/mini-tools-patterns/SKILL.md before adding a new engine.
func ConnectorFor(t DBType) (Connector, error) {
	switch t {
	case DBTypeSQLite:
		return sqliteConnector{}, nil
	case DBTypePostgres:
		return postgresConnector{}, nil
	case DBTypeOracle:
		return oracleConnector{}, nil
	case DBTypeSQLServer:
		return sqlserverConnector{}, nil
	case DBTypeRedis:
		return redisConnector{}, nil
	case DBTypeMongo:
		return mongoConnector{}, nil
	case DBTypeSSH:
		return sshConnector{}, nil
	default:
		return nil, fmt.Errorf("db: db_type desconocido %q", t)
	}
}
