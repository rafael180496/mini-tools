//go:build !windows

package portkill

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mini-tools/backend/i18n"
)

func terminate(pid int, force bool) error {
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	err := syscall.Kill(pid, sig)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, syscall.EPERM):
		return ErrPermission
	case errors.Is(err, syscall.ESRCH):
		return ErrNotFound
	}
	return i18n.Errorf(i18n.Msg{ES: "no se pudo terminar el proceso %d: %w", EN: "could not end process %d: %w"}, pid, err)
}

// waitExit espera a que pid deje de existir. kill(pid, 0) no manda ninguna
// señal: solo pregunta. EPERM significa que existe pero es de otro usuario, o
// sea que sigue vivo.
func waitExit(pid int, max time.Duration) bool {
	deadline := time.Now().Add(max)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// terminateElevated pide permisos de administrador con el mecanismo nativo:
// el diálogo de contraseña del sistema en macOS, pkexec (polkit) en Linux. El
// pid es un entero ya validado, así que no hay nada que escapar en el comando.
func terminateElevated(ctx context.Context, pid int, force bool) error {
	sig := "TERM"
	if force {
		sig = "KILL"
	}
	target := strconv.Itoa(pid)

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		script := `do shell script "kill -` + sig + ` ` + target + `" with administrator privileges`
		cmd = exec.CommandContext(ctx, "osascript", "-e", script)
	case "linux":
		cmd = exec.CommandContext(ctx, "pkexec", "kill", "-"+sig, target)
	default:
		return ErrPermission
	}

	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if isNotInstalled(err) {
		return ErrPermission
	}
	text := string(out)
	var ee *exec.ExitError
	switch {
	// osascript: "User canceled. (-128)". pkexec: 126 = diálogo descartado,
	// 127 = sin autorización.
	case strings.Contains(text, "-128"):
		return ErrElevationDenied
	case errors.As(err, &ee) && (ee.ExitCode() == 126 || ee.ExitCode() == 127):
		return ErrElevationDenied
	case strings.Contains(text, "No such process"):
		return ErrNotFound
	}
	return i18n.Errorf(i18n.Msg{ES: "no se pudo terminar el proceso %d con permisos de administrador: %s", EN: "could not end process %d with administrator permission: %s"}, pid, strings.TrimSpace(text))
}
