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

// NoConsole solo evita la consola, sin pedir que la ventana arranque oculta.
// Es para lanzar programas de ventana (el editor, el explorador de archivos):
// HideWindow les pasa SW_HIDE y algunos abrirían su ventana escondida.
func NoConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
}
