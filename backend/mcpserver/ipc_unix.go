//go:build !windows

package mcpserver

import (
	"net"
	"os"
	"time"
)

// Transporte del puente en Unix: un socket de dominio local.
//
// El permiso del archivo es la única barrera entre "el agente que vos lanzaste
// pregunta" y "cualquier proceso de la máquina pregunta por él", así que se
// restringe al usuario — mismo criterio que backend/agentapprove.
func listen(path string) (net.Listener, error) {
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return ln, nil
}

func dial(path string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", path, timeout)
}
