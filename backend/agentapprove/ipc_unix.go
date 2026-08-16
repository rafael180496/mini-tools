//go:build !windows

package agentapprove

import (
	"net"
	"os"
	"time"
)

// Transporte del canal de aprobación en Unix: un socket de dominio local.
//
// Extraído de channel.go sin cambiar comportamiento, para poder tener el
// equivalente de Windows al lado (ipc_windows.go). El permiso del archivo es la
// única barrera entre "el agente que vos lanzaste pregunta" y "cualquier
// proceso de la máquina contesta por él".
func listen(path string) (net.Listener, error) {
	// Un socket viejo de una corrida anterior que terminó mal impide escuchar;
	// borrarlo es seguro porque el nombre es de esta app y de este directorio.
	_ = os.Remove(path)

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

// Supported informa si esta plataforma puede ofrecer la aprobación por acción.
//
// En Unix siempre: `AF_UNIX` está en todos lados. Ver la versión de Windows
// para por qué esta función existe.
func Supported() bool { return true }
