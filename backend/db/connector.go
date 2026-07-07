package db

import "fmt"

// DBType identifies which of the 3 supported engines a connection uses.
type DBType string

const (
	DBTypeSQLite   DBType = "sqlite"
	DBTypePostgres DBType = "postgres"
	DBTypeOracle   DBType = "oracle"
)

// DriverName returns the database/sql driver name registered for this
// engine — all three engines are unified under database/sql, never sqlx or
// a driver's native SDK directly. See .claude/rules/technical.md.
func (t DBType) DriverName() string {
	switch t {
	case DBTypeSQLite:
		return "sqlite"
	case DBTypePostgres:
		return "pgx"
	case DBTypeOracle:
		return "oracle"
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
	default:
		return nil, fmt.Errorf("db: db_type desconocido %q", t)
	}
}
