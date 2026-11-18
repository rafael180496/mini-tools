//go:build windows

package workspace

import (
	"os/exec"

	"mini-tools/backend/hidewin"
)

// En Windows no hay grupos de procesos equivalentes sin ConPTY/Job Objects:
// se mata el proceso del shell (comportamiento por defecto de CommandContext).
// Sin verificar en una Windows real, como el resto de los comandos de la app.
// Sí oculta la consola: la app no tiene una que heredar y sin esto cada
// comando abría una ventana a la vista.
func setupProc(cmd *exec.Cmd) { hidewin.Hide(cmd) }
