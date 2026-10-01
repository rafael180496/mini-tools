//go:build darwin

package procmon

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	memTotalOnce sync.Once
	memTotal     uint64
)

func out(ctx context.Context, name string, args ...string) (string, error) {
	b, err := exec.CommandContext(ctx, name, args...).Output()
	return string(b), err
}

// readRaw en macOS: tres herramientas del sistema, sin privilegios.
// `ps` da el tiempo de CPU ACUMULADO de cada proceso (con centésimas), y de ahí
// sale el % de la diferencia entre dos lecturas — es lo que hace instantáneo el
// número, en vez del promedio de toda la vida del proceso que da `ps -o %cpu`.
func readRaw(ctx context.Context) (*rawSample, error) {
	ps, err := out(ctx, "ps", "-axwwo", "pid=,ppid=,rss=,time=,user=,comm=")
	if err != nil {
		return nil, err
	}
	s := &rawSample{at: time.Now(), procs: parsePs(ps)}

	memTotalOnce.Do(func() {
		if v, err := out(ctx, "sysctl", "-n", "hw.memsize"); err == nil {
			memTotal, _ = strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		}
	})
	s.memTotal = memTotal
	// Que falte la memoria o la red no es motivo para perder la lista.
	if v, err := out(ctx, "vm_stat"); err == nil {
		s.memUsed = parseVmStat(v)
	}
	if v, err := out(ctx, "netstat", "-ib"); err == nil {
		s.netRx, s.netTx = parseNetstatIB(v)
	}
	return s, nil
}
