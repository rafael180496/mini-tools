package export

import (
	"encoding/json"
	"os"

	"mini-tools/backend/i18n"
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
		return i18n.Errorf(i18n.Msg{ES: "export: serializando json: %w", EN: "export: serializing json: %w"}, err)
	}

	if err := os.WriteFile(destPath, data, 0o644); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "export: escribiendo archivo json: %w", EN: "export: writing json file: %w"}, err)
	}
	return nil
}
