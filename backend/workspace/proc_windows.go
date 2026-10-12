//go:build windows

package workspace

import "os/exec"

// En Windows no hay grupos de procesos equivalentes sin ConPTY/Job Objects:
// se mata el proceso del shell (comportamiento por defecto de CommandContext).
// Sin verificar en una Windows real, como el resto de los comandos de la app.
func setupProc(cmd *exec.Cmd) {}
