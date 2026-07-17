package query

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

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
//
// captureOutput is the frontend's "DBMS_OUTPUT" toolbar toggle — when
// false, the block runs directly with no ENABLE/GET_LINE round trips at
// all (not just a skipped fetch), which matters when running a large
// multi-statement script full of PL/SQL blocks and the output isn't
// needed.
func runOraclePLSQLBlock(ctx context.Context, conn *sql.Conn, stmtText string, captureOutput bool) (sql.Result, []string, error) {
	// SplitStatements deliberately strips the delimiting ";" from every
	// flushed statement (fine for plain SQL sent via a single Exec call —
	// Oracle's SQL engine rejects a trailing ";" there) — but Oracle's
	// PL/SQL grammar requires that ";" right after the block's final END to
	// terminate it; without it the parser hits EOF still expecting either
	// ";" or a label identifier ("PLS-00103: encountered end-of-file").
	// Real bug found live: every anonymous block/CREATE PROCEDURE-FUNCTION-
	// TRIGGER body executed via this path failed until this was added back.
	stmtText = ensureTrailingSemicolon(stmtText)

	if !captureOutput {
		result, err := conn.ExecContext(ctx, stmtText)
		return result, nil, err
	}

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

// ensureTrailingSemicolon appends ";" to stmtText if its last non-whitespace
// character isn't already one — SplitStatements strips it during flush, and
// a PL/SQL block/unit needs it back to compile.
func ensureTrailingSemicolon(stmtText string) string {
	trimmed := strings.TrimRight(stmtText, " \t\r\n")
	if strings.HasSuffix(trimmed, ";") {
		return stmtText
	}
	return trimmed + ";"
}

func fetchDBMSOutput(ctx context.Context, conn *sql.Conn) ([]string, error) {
	var lines []string
	for i := 0; i < maxDBMSOutputLines; i++ {
		var line string
		var status int64
		if _, err := conn.ExecContext(ctx,
			`BEGIN DBMS_OUTPUT.GET_LINE(:1, :2); END;`,
			// Size is REQUIRED for a VARCHAR2 OUT param in go-ora: without it
			// the driver allocates a zero-length buffer and Oracle can't return
			// the line (ORA-06502), which fetchDBMSOutput's caller swallows —
			// the symptom being "DBMS_OUTPUT enabled but nothing shows". 32767
			// is the max length a single DBMS_OUTPUT line can have.
			go_ora.Out{Dest: &line, Size: 32767},
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
