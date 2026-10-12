//go:build !windows

package workspace

import (
	"os/exec"
	"syscall"
)

// setupProc pone al comando en su propio grupo de procesos y, al cancelarse,
// mata el grupo entero: matar solo al shell dejaría vivo lo que el shell
// lanzó (un servidor de desarrollo, un `sleep`), que seguiría corriendo
// después de que el modelo ya recibió «se agotó el tiempo».
func setupProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
