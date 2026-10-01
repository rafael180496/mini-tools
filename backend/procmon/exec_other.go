//go:build !windows

package procmon

import "os/exec"

func hideWindow(*exec.Cmd) {}
