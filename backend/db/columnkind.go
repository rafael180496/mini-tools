package db

import "strings"

// ColumnKind traduce el tipo de una columna a la clase con la que la app la
// trata: qué editor dibuja la grilla y cómo se escribe su valor en el SQL que
// la app genera (una fecha sale con TO_DATE, no como texto).
//
// Recibe el nombre del tipo tal como lo escribe quien lo declara —el catálogo
// (`Column.DataType`) o el driver del result set
// (`sql.ColumnType.DatabaseTypeName`)— y son nombres distintos para lo mismo
// en cada motor: `int4`/`NUMBER`/`INTEGER`/`bigint` son todos un número, y
// `timestamptz`/`DATE`/`datetime2`/`TimeStampTZ` son todos un instante. La
// traducción vive acá, en un solo lugar, para que agregar un tipo nuevo no
// haya que acordarse de hacerlo en dos.
func ColumnKind(dataType string) string {
	t := strings.ToLower(strings.TrimSpace(dataType))
	switch {
	case strings.Contains(t, "bool"), t == "bit":
		return "bool"
	case strings.Contains(t, "json"):
		return "json"
	case strings.Contains(t, "timestamp"):
		// Cubre las cinco formas en que go-ora nombra un TIMESTAMP
		// (`TimeStampDTY`, `TimeStampTZ`, `TimeStampeLTZ`, …) además del
		// `timestamptz` de Postgres.
		return "datetime"
	case strings.Contains(t, "datetime"):
		return "datetime"
	case strings.HasSuffix(t, "date"):
		// Sufijo y no igualdad: el catálogo dice `DATE`, pero el driver de
		// Oracle puede nombrar la misma columna `OCIDate`.
		return "date"
	case strings.Contains(t, "time"):
		// TIME sin fecha se edita como texto: un selector de fecha para una
		// hora sola confunde más de lo que ayuda.
		return "text"
	case strings.Contains(t, "int"), strings.Contains(t, "numeric"), strings.Contains(t, "decimal"),
		strings.Contains(t, "number"), strings.Contains(t, "float"), strings.Contains(t, "double"),
		strings.Contains(t, "real"), strings.Contains(t, "money"):
		return "number"
	default:
		return "text"
	}
}
