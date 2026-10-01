//go:build windows

package portkill

import (
	"context"
	"mini-tools/backend/hidewin"
	"os/exec"
)

// listPlatform en Windows cruza dos herramientas que trae el sistema: netstat
// dice qué pid tiene cada puerto y tasklist, cómo se llama ese pid.
func listPlatform(ctx context.Context) ([]Listener, error) {
	out, err := run(ctx, "netstat", "-ano")
	if err != nil {
		if isNotInstalled(err) {
			return nil, ErrNoTool
		}
		return nil, err
	}
	found := parseNetstat(out)

	// Sin los nombres la lista sigue sirviendo (pid y puerto): no es motivo
	// para fallar.
	if tl, err := run(ctx, "tasklist", "/FO", "CSV", "/NH"); err == nil {
		names := parseTasklist(tl)
		for i := range found {
			found[i].Process = names[found[i].PID]
		}
	}
	return found, nil
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	hidewin.Hide(cmd)
	out, err := cmd.Output()
	return string(out), err
}
