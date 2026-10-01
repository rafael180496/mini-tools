//go:build windows

package hidewin

import (
	"os/exec"
	"syscall"
)

// createNoWindow es CREATE_NO_WINDOW.
const createNoWindow = 0x08000000

// Hide configura cmd para que no abra una consola.
func Hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
