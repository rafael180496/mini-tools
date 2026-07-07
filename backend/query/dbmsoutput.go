package query

import (
	"context"
	"database/sql"
	"fmt"

	go_ora "github.com/sijms/go-ora/v2"
)

// maxDBMSOutputLines bounds how many DBMS_OUTPUT lines we'll fetch after a
// PL/SQL block — a runaway PUT_LINE loop in the executed block shouldn't
// hang the fetch.
const maxDBMSOutputLines = 1000

// runOraclePLSQLBlock executes an Oracle anonymous PL/SQL block (or a
// CREATE PROCEDURE/FUNCTION/TRIGGER/TYPE body) on conn, since DBMS_OUTPUT's
// ENABLE/PUT_LINE/GET_LINE state is per-session — running enable, the
// block, and the fetch on different pooled connections would silently
// return nothing. Only meaningful for Oracle; callers must not call this
// against other engines. The caller owns conn's lifecycle (reserving it
// fresh per call, or reusing an already-open transaction's connection —
// see executor.go's runPLSQLBlock) — this function never closes it.
func runOraclePLSQLBlock(ctx context.Context, conn *sql.Conn, stmtText string) (sql.Result, []string, error) {
	if _, err := conn.ExecContext(ctx, `BEGIN DBMS_OUTPUT.ENABLE(NULL); END;`); err != nil {
		return nil, nil, fmt.Errorf("query: habilitando DBMS_OUTPUT: %w", err)
	}

	result, err := conn.ExecContext(ctx, stmtText)
	if err != nil {
		return nil, nil, err
	}

	// A failure to fetch buffered output shouldn't hide that the block
	// itself already succeeded — just come back with no captured lines.
	lines, _ := fetchDBMSOutput(ctx, conn)

	return result, lines, nil
}

func fetchDBMSOutput(ctx context.Context, conn *sql.Conn) ([]string, error) {
	var lines []string
	for i := 0; i < maxDBMSOutputLines; i++ {
		var line string
		var status int64
		if _, err := conn.ExecContext(ctx,
			`BEGIN DBMS_OUTPUT.GET_LINE(:1, :2); END;`,
			go_ora.Out{Dest: &line},
			go_ora.Out{Dest: &status},
		); err != nil {
			return lines, fmt.Errorf("query: leyendo DBMS_OUTPUT: %w", err)
		}
		if status != 0 {
			break
		}
		lines = append(lines, line)
	}
	return lines, nil
}
