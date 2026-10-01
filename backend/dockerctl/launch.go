package dockerctl

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"mini-tools/backend/hidewin"
	"mini-tools/backend/i18n"
)

var ErrNoLauncher = i18n.NewCoded("no-launcher", i18n.Msg{
	ES: "no hay una aplicación de Docker conocida para abrir: arrancá el servicio a mano",
	EN: "there's no known Docker application to open: start the service by hand",
})

type launcherApp struct {
	label string
	path  string // ruta de la app (macOS) o del ejecutable (Windows)
}

func launchers() []launcherApp {
	switch runtime.GOOS {
	case "darwin":
		return []launcherApp{
			{"Docker Desktop", "/Applications/Docker.app"},
			{"OrbStack", "/Applications/OrbStack.app"},
			{"Rancher Desktop", "/Applications/Rancher Desktop.app"},
		}
	case "windows":
		return []launcherApp{
			{"Docker Desktop", filepath.Join(os.Getenv("ProgramFiles"), `Docker\Docker\Docker Desktop.exe`)},
		}
	}
	return nil
}

// launcher es la primera aplicación conocida que está instalada.
func launcher() string {
	for _, l := range launchers() {
		if _, err := os.Stat(l.path); err == nil {
			return l.label
		}
	}
	return ""
}

// StartApp abre la aplicación que levanta el motor (Docker Desktop, OrbStack…).
// Solo en macOS y Windows: en Linux el motor es un servicio del sistema y
// arrancarlo pide privilegios que esta app no tiene por qué pedir.
func StartApp(ctx context.Context) error {
	for _, l := range launchers() {
		if _, err := os.Stat(l.path); err != nil {
			continue
		}
		var cmd *exec.Cmd
		if runtime.GOOS == "darwin" {
			cmd = exec.CommandContext(ctx, "open", l.path)
		} else {
			cmd = exec.Command(l.path)
		}
		hidewin.Hide(cmd)
		if runtime.GOOS == "darwin" {
			return cmd.Run()
		}
		// En Windows se lanza y se suelta: Docker Desktop no termina.
		return cmd.Start()
	}
	return ErrNoLauncher
}
