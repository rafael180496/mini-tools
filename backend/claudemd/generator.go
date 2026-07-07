package claudemd

import (
	"fmt"
	"os"
	"path/filepath"

	"mini-tools/backend/db"
)

// ProjectInfo is what the templates need: which connection the project's
// SQL files are being worked against, and its current schema. Never
// includes a DSN or password — only the connection's display name and
// engine, both already safe to show the frontend elsewhere in the app.
type ProjectInfo struct {
	ConnectionName string
	DBType         db.DBType
	// Schema is the specific schema Metadata was scoped to when non-empty
	// (matches the toolbar's schema dropdown) — templates surface it so a
	// regenerated CLAUDE.md is honest about what it does and doesn't cover,
	// instead of silently documenting only part of the connection.
	Schema   string
	Metadata *db.SchemaMetadata
}

// Generate writes CLAUDE.md + .claude/{specs,rules,skills} into dir,
// UNLESS CLAUDE.md already exists there — spec: "un CLAUDE.md existente no
// se sobreescribe sin regenerar explícito". Returns wrote=true if it
// actually wrote anything, so callers can tell "created" from "already
// there, skipped".
func Generate(dir string, info ProjectInfo) (wrote bool, err error) {
	claudeMDPath := filepath.Join(dir, "CLAUDE.md")
	if _, statErr := os.Stat(claudeMDPath); statErr == nil {
		return false, nil
	} else if !os.IsNotExist(statErr) {
		return false, fmt.Errorf("claudemd: comprobando CLAUDE.md existente: %w", statErr)
	}

	if err := Regenerate(dir, info); err != nil {
		return false, err
	}
	return true, nil
}

// Regenerate always (over)writes all 4 artifacts — the explicit "Regenerar"
// action.
func Regenerate(dir string, info ProjectInfo) error {
	files := map[string]string{
		filepath.Join(dir, "CLAUDE.md"):                                            renderClaudeMD(info),
		filepath.Join(dir, ".claude", "specs", "database-schema.md"):               renderSchemaSpec(info),
		filepath.Join(dir, ".claude", "rules", "sql-conventions.md"):               renderSQLConventions(info),
		filepath.Join(dir, ".claude", "skills", "mini-tools-database", "SKILL.md"): renderSkill(info),
	}

	for path, content := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("claudemd: creando %s: %w", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("claudemd: escribiendo %s: %w", path, err)
		}
	}
	return nil
}
