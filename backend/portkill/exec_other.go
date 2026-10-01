//go:build !windows

package portkill

import "os/exec"

// hideWindow no hace nada fuera de Windows: allá es lo que evita que cada
// consulta haga parpadear una consola.
func hideWindow(*exec.Cmd) {}
