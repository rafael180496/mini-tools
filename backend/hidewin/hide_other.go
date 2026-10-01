//go:build !windows

package hidewin

import "os/exec"

// Hide no hace nada fuera de Windows.
func Hide(*exec.Cmd) {}
