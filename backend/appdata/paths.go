package appdata

import (
	"os"
	"path/filepath"
)

const dirName = "mini-tools"

// OverrideEnv redirige TODO el directorio de datos a otra ruta.
//
// # Por qué existe: un incidente real, no una hipótesis
//
// Los tests de este paquete y de backend/vault corrían contra el directorio
// de datos REAL del usuario, porque no había forma de inyectar otra ruta —
// el helper de vault lo decía en su propio comentario— y para poder empezar
// de cero BORRABAN vault.db y salt.bin antes y después de cada caso.
//
// Correr `go test ./backend/...` en una máquina con la aplicación instalada
// destruía entonces el vault del usuario. Pasó: el 21/08/2026 se perdió un
// vault con diez conexiones, once repositorios y el historial de consultas,
// y —peor— el salt.bin borrado dejó a los backups automáticos posteriores
// escribiéndose sin él, o sea inservibles, sin que nada avisara.
//
// Sandbox por variable de entorno y no por parámetro para que cubra a TODO
// el que resuelva rutas por acá, incluidos los tests que ya existen y
// cualquiera que se agregue después sin acordarse de este problema.
const OverrideEnv = "MINI_TOOLS_DATA_DIR"

// Dir returns the per-user application data directory, creating it if needed.
func Dir() (string, error) {
	base := os.Getenv(OverrideEnv)
	if base != "" {
		if err := os.MkdirAll(base, 0o700); err != nil {
			return "", err
		}
		return base, nil
	}

	configBase, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	dir := filepath.Join(configBase, dirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	return dir, nil
}

// VaultPath returns the path to the local vault SQLite database.
func VaultPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}

	return filepath.Join(dir, "vault.db"), nil
}

// SaltPath returns the path to the per-install Argon2id salt file.
func SaltPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}

	return filepath.Join(dir, "salt.bin"), nil
}
