//go:build windows

package portkill

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mini-tools/backend/i18n"
)

const (
	errAccessDenied     = syscall.Errno(5)
	errInvalidParameter = syscall.Errno(87)
)

// terminate en Windows no distingue cierre ordenado de forzado: no existe un
// SIGTERM para un proceso cualquiera, solo TerminateProcess. Por eso `force` se
// ignora acá.
func terminate(pid int, _ bool) error {
	p, err := os.FindProcess(pid)
	if err == nil {
		err = p.Kill()
		_ = p.Release()
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errAccessDenied):
		return ErrPermission
	case errors.Is(err, errInvalidParameter):
		return ErrNotFound
	}
	return i18n.Errorf(i18n.Msg{ES: "no se pudo terminar el proceso %d: %w", EN: "could not end process %d: %w"}, pid, err)
}

// waitExit espera a que el proceso salga. Wait sobre un proceso ajeno usa el
// handle del sistema, así que funciona aunque no sea hijo nuestro.
func waitExit(pid int, max time.Duration) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		// No se puede abrir: o ya no existe, o no es nuestro. Para quien
		// pregunta es lo mismo que "ya salió".
		return true
	}
	defer p.Release()

	done := make(chan struct{})
	go func() {
		_, _ = p.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(max):
		return false
	}
}

// terminateElevated relanza taskkill con el UAC de Windows (`-Verb RunAs`). El
// pid es un entero ya validado: no hay nada que escapar.
func terminateElevated(ctx context.Context, pid int, _ bool) error {
	script := "Start-Process -FilePath taskkill -ArgumentList '/PID','" + strconv.Itoa(pid) +
		"','/F' -Verb RunAs -WindowStyle Hidden -Wait"
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)

	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if isNotInstalled(err) {
		return ErrPermission
	}
	// Rechazar el UAC hace fallar a Start-Process: es el caso normal de
	// "dije que no", no un error de la herramienta.
	return errors.Join(ErrElevationDenied, i18n.Errorf(i18n.Msg{ES: "detalle: %s", EN: "detail: %s"}, strings.TrimSpace(string(out))))
}
