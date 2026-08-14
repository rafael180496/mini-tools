package agentapprove

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// El archivo de settings que se le pasa al CLI para instalar el hook.
//
// Se escribe una sola vez, en el directorio de datos de la app, y apunta al
// propio ejecutable — el mismo truco que usa git/auth.go para el askpass: no
// hay un helper aparte que empaquetar ni que mantener sincronizado con la
// versión de la app.
//
// **Este archivo reemplaza los settings del usuario durante esa sesión**, no
// se fusiona con ellos. Es lo correcto acá: la sesión existe para que cada
// acción pase por la aprobación de la ventana, y unos permisos preconcedidos
// del usuario harían que algunas acciones se saltearan el hook sin que nadie
// lo note. Vale solo para las sesiones de chat que se abren en este modo; la
// terminal y el resto del chat no lo usan.

// SettingsPath es dónde se escribe.
func SettingsPath(dataDir string) string {
	return filepath.Join(dataDir, "approve-settings.json")
}

// WriteSettings deja el archivo listo y devuelve su ruta.
func WriteSettings(dataDir, selfPath string) (string, error) {
	doc := map[string]any{
		"hooks": map[string]any{
			// matcher "*" para que pase TODA acción por la aprobación. Filtrar
			// por herramienta acá sería decidir por el usuario qué es riesgoso,
			// y esa es justamente la decisión que este mecanismo le devuelve.
			"PreToolUse": []any{
				map[string]any{
					"matcher": "*",
					"hooks": []any{
						map[string]any{"type": "command", "command": selfPath},
					},
				},
			},
		},
	}

	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	path := SettingsPath(dataDir)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("agentapprove: preparando el directorio: %w", err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return "", fmt.Errorf("agentapprove: escribiendo los settings del hook: %w", err)
	}
	return path, nil
}
