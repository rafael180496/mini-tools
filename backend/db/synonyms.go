package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"mini-tools/backend/i18n"
)

// Oracle synonyms for the editor's completion.
//
// On an SGC-style database most application code never writes
// "SGCPRO.CARGVAR": it writes "CARGVAR" and a PUBLIC synonym resolves it. A
// catalog scan that only knows tables therefore cannot complete the name a
// person actually types, nor offer the columns of "FROM <synonym> x" — it is
// the same table, reached through a name the index has never heard of.
//
// Like routineargs.go this is enrichment, never a precondition:
// FetchSchemaMetadata swallows the error, so a user who cannot read
// ALL_SYNONYMS keeps every table and column completion it had.

// maxSynonymRows bounds the scan. A public-synonym catalog can hold tens of
// thousands of rows (every SYS object has one) and the query is already
// restricted to the scanned schemas, so this is a backstop for a schema that
// is itself enormous, not something normal use runs into.
const maxSynonymRows = 50000

// attachSynonyms fills meta.Synonyms with the synonyms that resolve to a
// table or view already in meta.Tables. Oracle only; every other engine has
// no equivalent and this is not an error there.
func attachSynonyms(ctx context.Context, pool *sql.DB, dbType DBType, schemas []string, meta *SchemaMetadata) error {
	if meta == nil || dbType != DBTypeOracle {
		return nil
	}

	var (
		query string
		args  []interface{}
	)
	if len(schemas) == 0 {
		// Owner-less scan: the tables are the connected user's own, so the
		// synonyms worth knowing are the ones aimed at them (a PUBLIC one, or
		// the user's own).
		query = fmt.Sprintf(`
			SELECT owner, synonym_name, table_owner, table_name
			FROM all_synonyms
			WHERE db_link IS NULL
			  AND table_owner = USER
			  AND owner IN ('PUBLIC', USER)
			  AND ROWNUM <= %d
			ORDER BY owner, synonym_name
		`, maxSynonymRows)
	} else {
		// Positional binds are numbered in the order they appear in the text:
		// the target-owner list first, then the synonym-owner list.
		targetFilter, targetArgs := oracleSchemaFilterClause("table_owner", schemas, 1)
		owners := append(append([]string{}, schemas...), "PUBLIC")
		ownerFilter, ownerArgs := oracleSchemaFilterClause("owner", owners, len(schemas)+1)
		query = fmt.Sprintf(`
			SELECT owner, synonym_name, table_owner, table_name
			FROM all_synonyms
			WHERE db_link IS NULL
			%s
			%s
			AND ROWNUM <= %d
			ORDER BY owner, synonym_name
		`, targetFilter, ownerFilter, maxSynonymRows)
		args = append(targetArgs, ownerArgs...)
	}

	rows, err := pool.QueryContext(ctx, query, args...)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: listando sinónimos oracle: %w", EN: "db: listing oracle synonyms: %w"}, err)
	}
	defer rows.Close()

	// Targets that exist in this scan. Owner-less scans leave Table.Schema
	// empty, so those tables are keyed by name alone.
	type target struct{ schema, name string }
	known := make(map[target]bool, len(meta.Tables))
	for i := range meta.Tables {
		t := &meta.Tables[i]
		known[target{strings.ToUpper(t.Schema), strings.ToUpper(t.Name)}] = true
	}

	var out []Synonym
	for rows.Next() {
		var owner, name, tableOwner, tableName string
		if err := rows.Scan(&owner, &name, &tableOwner, &tableName); err != nil {
			return i18n.Errorf(i18n.Msg{ES: "db: escaneando sinónimo oracle: %w", EN: "db: scanning oracle synonym: %w"}, err)
		}
		key := target{strings.ToUpper(tableOwner), strings.ToUpper(tableName)}
		if len(schemas) == 0 {
			key.schema = ""
		}
		if !known[key] {
			continue
		}
		out = append(out, Synonym{Schema: owner, Name: name, TargetSchema: tableOwner, TargetName: tableName})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	meta.Synonyms = out
	return nil
}
