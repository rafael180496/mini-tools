//go:build linux

package procmon

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// clockTicks es USER_HZ: los tiempos de /proc/<pid>/stat vienen en ticks de
// 1/100 s en todo Linux de uso común.
const clockTicks = 100

var userNames = map[uint32]string{}

func userName(uid uint32) string {
	if n, ok := userNames[uid]; ok {
		return n
	}
	name := strconv.FormatUint(uint64(uid), 10)
	if u, err := user.LookupId(name); err == nil {
		name = u.Username
	}
	userNames[uid] = name
	return name
}

// readRaw en Linux lee /proc directamente: más rápido y más exacto que
// invocar `ps`, que da el tiempo de CPU en segundos enteros.
func readRaw(_ context.Context) (*rawSample, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	s := &rawSample{at: time.Now()}
	page := uint64(os.Getpagesize())

	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue // el proceso terminó entre el listado y la lectura
		}
		p, ok := parseProcStat(string(raw))
		if !ok {
			continue
		}
		p.pid = pid
		p.mem *= page
		if fi, err := os.Stat(filepath.Join("/proc", e.Name())); err == nil {
			if st, ok := fi.Sys().(*syscall.Stat_t); ok {
				p.user = userName(st.Uid)
			}
		}
		s.procs = append(s.procs, p)
	}

	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		var total, avail uint64
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			v, _ := strconv.ParseUint(f[1], 10, 64)
			switch f[0] {
			case "MemTotal:":
				total = v * 1024
			case "MemAvailable:":
				avail = v * 1024
			}
		}
		s.memTotal = total
		if total > avail {
			s.memUsed = total - avail
		}
	}
	if b, err := os.ReadFile("/proc/net/dev"); err == nil {
		s.netRx, s.netTx = parseProcNetDev(string(b))
	}
	return s, nil
}

// parseProcStat lee /proc/<pid>/stat. El nombre va entre paréntesis y PUEDE
// tener paréntesis y espacios adentro, así que se corta en el último ')'.
// Con los campos que siguen numerados como en proc(5): 4 = ppid, 14 = utime,
// 15 = stime, 24 = rss (en páginas; el llamador la pasa a bytes).
func parseProcStat(s string) (rawProc, bool) {
	l := strings.IndexByte(s, '(')
	r := strings.LastIndexByte(s, ')')
	if l < 0 || r < l {
		return rawProc{}, false
	}
	f := strings.Fields(s[r+1:])
	if len(f) < 22 {
		return rawProc{}, false
	}
	ppid, _ := strconv.Atoi(f[1])
	ut, _ := strconv.ParseUint(f[11], 10, 64)
	st, _ := strconv.ParseUint(f[12], 10, 64)
	rss, _ := strconv.ParseUint(f[21], 10, 64)
	return rawProc{
		name: s[l+1 : r],
		ppid: ppid,
		cpu:  time.Duration(ut+st) * time.Second / clockTicks,
		mem:  rss,
	}, true
}
