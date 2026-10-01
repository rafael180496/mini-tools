//go:build !windows

package portkill

import (
	"context"
	"errors"
	"mini-tools/backend/hidewin"
	"os/exec"
	"runtime"
)

// listPlatform en macOS usa lsof (viene con el sistema) y en Linux ss, con lsof
// de respaldo. Una distro mínima puede no traer ninguno de los dos: se dice con
// ErrNoTool en vez de mostrar una lista vacía, que se leería como "no hay nada
// escuchando".
func listPlatform(ctx context.Context) ([]Listener, error) {
	if runtime.GOOS == "linux" {
		out, err := run(ctx, "ss", "-H", "-ltnp")
		if err == nil {
			return parseSS(out), nil
		}
		if !isNotInstalled(err) {
			return nil, err
		}
	}

	// +c 0: el nombre completo del comando, no los 9 primeros caracteres.
	out, err := run(ctx, "lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "+c", "0", "-F", "pcn")
	if err != nil {
		// lsof sale con 1 cuando no encontró nada: es una lista vacía, no un fallo.
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 && out == "" {
			return nil, nil
		}
		if isNotInstalled(err) {
			return nil, ErrNoTool
		}
		return nil, err
	}
	return parseLsof(out), nil
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	hidewin.Hide(cmd)
	out, err := cmd.Output()
	return string(out), err
}
