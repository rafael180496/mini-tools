//go:build windows

package agentapprove

import (
	"net"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
)

// Transporte del canal de aprobación en Windows: un named pipe.
//
// **Esto es lo que faltaba para que el modo "aprobar cada acción" exista en
// Windows.** Hasta acá el canal era un socket de dominio Unix y punto, así que
// en una máquina sin `AF_UNIX` el modo directamente no se ofrecía — decisión
// correcta (nunca comportarse como permisivo sin avisar), pero dejaba al
// usuario de Windows sin el modo de más control de los cinco.
//
// La ACL es la parte que importa: `D:P(A;;GA;;;OW)` es un DACL protegido con
// una sola entrada, acceso total para el propietario del objeto. Un pipe con
// permisos abiertos sería peor que no tener el modo — cualquier proceso de la
// máquina podría contestar "sí" por el usuario.
const pipeSecurity = "D:P(A;;GA;;;OW)"

func pipeName(path string) string {
	clean := strings.NewReplacer(`\`, "-", "/", "-", ":", "").Replace(path)
	return `\\.\pipe\mini-tools-approve` + clean
}

func listen(path string) (net.Listener, error) {
	return winio.ListenPipe(pipeName(path), &winio.PipeConfig{SecurityDescriptor: pipeSecurity})
}

func dial(path string, timeout time.Duration) (net.Conn, error) {
	return winio.DialPipe(pipeName(path), &timeout)
}

// Supported informa si esta plataforma puede ofrecer la aprobación por acción.
func Supported() bool { return true }
