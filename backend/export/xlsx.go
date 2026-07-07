package export

import (
	"fmt"

	"github.com/xuri/excelize/v2"
)

const xlsxSheetName = "Sheet1"

// WriteXLSX writes columns/rows to destPath as a single-sheet .xlsx
// workbook, header row bold.
func WriteXLSX(destPath string, columns []string, rows [][]interface{}) error {
	f := excelize.NewFile()
	defer f.Close()

	if err := f.SetSheetName("Sheet1", xlsxSheetName); err != nil {
		return fmt.Errorf("export: nombrando hoja xlsx: %w", err)
	}

	headerStyle, err := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	if err != nil {
		return fmt.Errorf("export: creando estilo de encabezado xlsx: %w", err)
	}

	for i, col := range columns {
		cell, err := excelize.CoordinatesToCellName(i+1, 1)
		if err != nil {
			return fmt.Errorf("export: calculando celda de encabezado: %w", err)
		}
		if err := f.SetCellValue(xlsxSheetName, cell, col); err != nil {
			return fmt.Errorf("export: escribiendo encabezado xlsx: %w", err)
		}
		if err := f.SetCellStyle(xlsxSheetName, cell, cell, headerStyle); err != nil {
			return fmt.Errorf("export: aplicando estilo de encabezado: %w", err)
		}
	}

	for r, row := range rows {
		for c, v := range row {
			cell, err := excelize.CoordinatesToCellName(c+1, r+2)
			if err != nil {
				return fmt.Errorf("export: calculando celda: %w", err)
			}
			if err := f.SetCellValue(xlsxSheetName, cell, v); err != nil {
				return fmt.Errorf("export: escribiendo celda xlsx: %w", err)
			}
		}
	}

	if err := f.SaveAs(destPath); err != nil {
		return fmt.Errorf("export: guardando xlsx: %w", err)
	}
	return nil
}
