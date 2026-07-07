package export

import (
	"encoding/csv"
	"fmt"
	"os"
)

// WriteCSV writes columns/rows to destPath as a standard CSV file (comma
// separated, RFC 4180 quoting via encoding/csv). NULLs become an empty
// field, matching common CSV conventions.
func WriteCSV(destPath string, columns []string, rows [][]interface{}) error {
	f, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("export: creando archivo csv: %w", err)
	}
	defer f.Close()

	w := csv.NewWriter(f)
	if err := w.Write(columns); err != nil {
		return fmt.Errorf("export: escribiendo encabezado csv: %w", err)
	}

	record := make([]string, len(columns))
	for _, row := range rows {
		for i, v := range row {
			record[i] = cellToString(v)
		}
		if err := w.Write(record); err != nil {
			return fmt.Errorf("export: escribiendo fila csv: %w", err)
		}
	}

	w.Flush()
	if err := w.Error(); err != nil {
		return fmt.Errorf("export: finalizando csv: %w", err)
	}
	return nil
}

// cellToString renders one cell value for text-based export formats
// (CSV/generated INSERTs use their own quoting; this is for plain text).
func cellToString(v interface{}) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%v", v)
}
