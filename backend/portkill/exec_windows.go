//go:build windows

package portkill

import (
	"os/exec"
	"syscall"
)

// createNoWindow es CREATE_NO_WINDOW: sin esto, cada netstat/tasklist abre y
// cierra una consola a la vista del usuario, porque la app es de ventana y no
// tiene una consola que heredar.
const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
