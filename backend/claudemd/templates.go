package claudemd

import (
	"fmt"
	"strings"
	"time"

	"mini-tools/backend/db"
)

func renderClaudeMD(info ProjectInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s — contexto de base de datos\n\n", info.ConnectionName)
	b.WriteString("> Generado automáticamente por [mini-tools](https://github.com/rafael180496/mini-tools) — no editar a mano, se puede regenerar desde la app sin perder cambios manuales porque no los tiene.\n\n")
	fmt.Fprintf(&b, "Este proyecto trabaja contra la conexión **%s** (%s). El detalle completo del schema está en [.claude/specs/database-schema.md](.claude/specs/database-schema.md).\n\n", info.ConnectionName, info.DBType)

	if info.Schema != "" {
		fmt.Fprintf(&b, "> **Alcance:** este documento solo cubre el esquema `%s` — el que estaba seleccionado en la app al generarlo. Otros esquemas de la misma conexión no están documentados acá; para incluirlos, seleccioná \"todos\" y regenerá.\n\n", info.Schema)
	}

	if info.Metadata != nil && len(info.Metadata.Tables) > 0 {
		b.WriteString("## Tablas\n\n")
		for _, t := range info.Metadata.Tables {
			fmt.Fprintf(&b, "- `%s` (%d columnas)\n", qualifiedName(t), len(t.Columns))
		}
		b.WriteString("\n")
	} else {
		b.WriteString("Sin tablas detectadas en esta conexión todavía.\n\n")
	}

	b.WriteString("Convenciones de SQL para este motor: ver [.claude/rules/sql-conventions.md](.claude/rules/sql-conventions.md).\n")
	fmt.Fprintf(&b, "\n_Última generación: %s_\n", time.Now().Format("2006-01-02 15:04"))
	return b.String()
}

func renderSchemaSpec(info ProjectInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Schema de %s (%s)\n\n", info.ConnectionName, info.DBType)
	b.WriteString("> Generado automáticamente por mini-tools desde la metadata de la conexión (tablas, columnas, nullable, primary keys, foreign keys).\n\n")

	if info.Schema != "" {
		fmt.Fprintf(&b, "**Esquema:** `%s` (solo estas tablas — ver nota de alcance en CLAUDE.md).\n\n", info.Schema)
	}

	if info.Metadata == nil || len(info.Metadata.Tables) == 0 {
		b.WriteString("Sin tablas detectadas.\n")
		return b.String()
	}

	for _, t := range info.Metadata.Tables {
		fmt.Fprintf(&b, "## %s\n\n", qualifiedName(t))
		b.WriteString("| Columna | Tipo | Nullable | PK |\n|---|---|---|---|\n")
		for _, c := range t.Columns {
			nullable := "sí"
			if !c.Nullable {
				nullable = "no"
			}
			pk := ""
			if c.IsPrimaryKey {
				pk = "✓"
			}
			fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", c.Name, c.DataType, nullable, pk)
		}
		if len(t.ForeignKeys) > 0 {
			b.WriteString("\nForeign keys:\n")
			for _, fk := range t.ForeignKeys {
				fmt.Fprintf(&b, "- `%s` → `%s.%s`\n", fk.Column, fk.ReferencedTable, fk.ReferencedColumn)
			}
		}
		b.WriteString("\n")
	}
	return b.String()
}

func renderSQLConventions(info ProjectInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Convenciones de SQL — %s\n\n", info.DBType)

	switch info.DBType {
	case db.DBTypePostgres:
		b.WriteString("- Placeholders: `$1`, `$2`, ... (no `?`).\n")
		b.WriteString("- Identificadores entre comillas dobles si tienen mayúsculas o caracteres especiales: `\"MiColumna\"`.\n")
		b.WriteString("- Paginación: `LIMIT n OFFSET m`.\n")
		b.WriteString("- `RETURNING` disponible en INSERT/UPDATE/DELETE.\n")
	case db.DBTypeOracle:
		b.WriteString("- Placeholders: `:1`, `:2`, ... o `:nombre`.\n")
		b.WriteString("- Paginación: `WHERE ROWNUM <= n` o `FETCH FIRST n ROWS ONLY` (12c+).\n")
		b.WriteString("- Bloques PL/SQL empiezan con `DECLARE` o `BEGIN`, terminan con `END;`.\n")
		b.WriteString("- `DUAL` para SELECTs sin tabla real.\n")
	case db.DBTypeSQLite:
		b.WriteString("- Placeholders: `?`.\n")
		b.WriteString("- Paginación: `LIMIT n`.\n")
		b.WriteString("- Tipado dinámico (type affinity) — las columnas no fuerzan estrictamente su tipo declarado.\n")
	case db.DBTypeSQLServer:
		b.WriteString("- Placeholders: `@p1`, `@p2`, ... o `@nombre`.\n")
		b.WriteString("- Identificadores entre corchetes si tienen espacios o palabras reservadas: `[Mi Columna]`.\n")
		b.WriteString("- Paginación: `SELECT TOP n ...` o `OFFSET m ROWS FETCH NEXT n ROWS ONLY` (requiere `ORDER BY`).\n")
		b.WriteString("- Lotes T-SQL separados por `GO` (separador de sqlcmd/SSMS, no se envía al servidor).\n")
		b.WriteString("- Bloques con `BEGIN ... END`; transacciones con `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`.\n")
	default:
		b.WriteString("Motor desconocido — sin convenciones documentadas.\n")
	}
	return b.String()
}

func renderSkill(info ProjectInfo) string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "name: mini-tools-database\ndescription: Contexto de la base de datos conectada (%s, motor %s), generado por mini-tools. Consultar antes de escribir queries contra este proyecto.\n", info.ConnectionName, info.DBType)
	b.WriteString("---\n\n")
	fmt.Fprintf(&b, "Este proyecto trabaja contra la conexión **%s** (%s).\n\n", info.ConnectionName, info.DBType)
	if info.Schema != "" {
		fmt.Fprintf(&b, "Documentación limitada al esquema `%s`.\n\n", info.Schema)
	}
	b.WriteString("- Schema completo: [.claude/specs/database-schema.md](../../specs/database-schema.md)\n")
	b.WriteString("- Convenciones de SQL del motor: [.claude/rules/sql-conventions.md](../../rules/sql-conventions.md)\n\n")
	b.WriteString("Antes de escribir una query nueva, revisar las foreign keys documentadas en el schema para armar los JOINs correctos.\n")
	return b.String()
}

func qualifiedName(t db.Table) string {
	if t.Schema != "" {
		return t.Schema + "." + t.Name
	}
	return t.Name
}
