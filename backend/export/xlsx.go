package export

import (
	"github.com/xuri/excelize/v2"

	"mini-tools/backend/i18n"
)

const xlsxSheetName = "Sheet1"

// WriteXLSX writes columns/rows to destPath as a single-sheet .xlsx
// workbook, header row bold.
func WriteXLSX(destPath string, columns []string, rows [][]interface{}) error {
	f := excelize.NewFile()
	defer f.Close()

	if err := f.SetSheetName("Sheet1", xlsxSheetName); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "export: nombrando hoja xlsx: %w", EN: "export: naming xlsx sheet: %w"}, err)
	}

	headerStyle, err := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "export: creando estilo de encabezado xlsx: %w", EN: "export: creating xlsx header style: %w"}, err)
	}

	for i, col := range columns {
		cell, err := excelize.CoordinatesToCellName(i+1, 1)
		if err != nil {
			return i18n.Errorf(i18n.Msg{ES: "export: calculando celda de encabezado: %w", EN: "export: computing header cell: %w"}, err)
		}
		if err := f.SetCellValue(xlsxSheetName, cell, col); err != nil {
			return i18n.Errorf(i18n.Msg{ES: "export: escribiendo encabezado xlsx: %w", EN: "export: writing xlsx header: %w"}, err)
		}
		if err := f.SetCellStyle(xlsxSheetName, cell, cell, headerStyle); err != nil {
			return i18n.Errorf(i18n.Msg{ES: "export: aplicando estilo de encabezado: %w", EN: "export: applying header style: %w"}, err)
		}
	}

	for r, row := range rows {
		for c, v := range row {
			cell, err := excelize.CoordinatesToCellName(c+1, r+2)
			if err != nil {
				return i18n.Errorf(i18n.Msg{ES: "export: calculando celda: %w", EN: "export: computing cell: %w"}, err)
			}
			if err := f.SetCellValue(xlsxSheetName, cell, v); err != nil {
				return i18n.Errorf(i18n.Msg{ES: "export: escribiendo celda xlsx: %w", EN: "export: writing xlsx cell: %w"}, err)
			}
		}
	}

	if err := f.SaveAs(destPath); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "export: guardando xlsx: %w", EN: "export: saving xlsx: %w"}, err)
	}
	return nil
}
