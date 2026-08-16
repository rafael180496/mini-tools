//go:build windows

package mcpserver

import (
	"net"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
)

// Transporte del puente en Windows: un named pipe.
//
// Windows no tiene sockets de dominio Unix con permisos de archivo, así que el
// equivalente es un named pipe con su descriptor de seguridad. **La ACL es la
// parte que importa**: un pipe con permisos abiertos sería un canal al vault
// del usuario disponible para cualquier proceso de la máquina — exactamente lo
// que el `chmod 0600` evita del otro lado.
//
// `D:P(A;;GA;;;OW)` es un DACL protegido (`P`, no hereda nada) con una única
// entrada: acceso total (`GA`) para el propietario del objeto (`OW`), que es
// quien creó el pipe. Nadie más entra, ni siquiera otro usuario de la misma
// máquina.
const pipeSecurity = "D:P(A;;GA;;;OW)"

// pipeName convierte la ruta del socket en un nombre de pipe.
//
// Se deriva de la ruta y no es un nombre fijo a propósito: dos instalaciones
// con directorios de datos distintos (un usuario y otro) no pueden pisarse el
// canal.
func pipeName(path string) string {
	clean := strings.NewReplacer(`\`, "-", "/", "-", ":", "").Replace(path)
	return `\\.\pipe\mini-tools` + clean
}

func listen(path string) (net.Listener, error) {
	return winio.ListenPipe(pipeName(path), &winio.PipeConfig{SecurityDescriptor: pipeSecurity})
}

func dial(path string, timeout time.Duration) (net.Conn, error) {
	return winio.DialPipe(pipeName(path), &timeout)
}
