package export

import (
	"encoding/json"
	"fmt"
	"os"
)

// WriteJSON writes columns/rows to destPath as a JSON array of objects
// (one per row, keyed by column name) — easier for downstream tools to
// consume than a parallel array-of-arrays.
func WriteJSON(destPath string, columns []string, rows [][]interface{}) error {
	objects := make([]map[string]interface{}, len(rows))
	for i, row := range rows {
		obj := make(map[string]interface{}, len(columns))
		for j, col := range columns {
			if j < len(row) {
				obj[col] = row[j]
			}
		}
		objects[i] = obj
	}

	data, err := json.MarshalIndent(objects, "", "  ")
	if err != nil {
		return fmt.Errorf("export: serializando json: %w", err)
	}

	if err := os.WriteFile(destPath, data, 0o644); err != nil {
		return fmt.Errorf("export: escribiendo archivo json: %w", err)
	}
	return nil
}
