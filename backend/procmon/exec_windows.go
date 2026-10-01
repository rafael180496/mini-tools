//go:build windows

package procmon

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW: sin esto cada `netstat` hace parpadear una consola.
const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
