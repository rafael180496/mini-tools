//go:build !windows

package hidewin

import "os/exec"

// Hide no hace nada fuera de Windows.
func Hide(*exec.Cmd) {}

// NoConsole no hace nada fuera de Windows.
func NoConsole(*exec.Cmd) {}
