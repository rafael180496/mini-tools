// Package procmon es el monitor de procesos del sistema: qué está usando CPU y
// memoria ahora mismo, y cuánta red entra y sale. Lo que muestra la utilidad
// «Activity Monitor».
//
// **Sin estado residente y sin goroutines.** Un % de CPU no existe en una sola
// lectura: es la diferencia de tiempo de CPU entre dos lecturas dividida por el
// tiempo que pasó entre ellas. Por eso el Sampler guarda UNA lectura anterior —
// unos pocos cientos de enteros— y nada más: no hay temporizador, ni hilo, ni
// historial. Quien decide cada cuánto leer es la pestaña que lo muestra, y al
// cerrarse (o quedar oculta) llama a Reset, que suelta hasta esa lectura.
//
// **Sin cgo y sin dependencias nuevas**: cada plataforma lee lo que ya tiene
// (`ps`/`vm_stat`/`netstat` en macOS, `/proc` en Linux, la API de Windows vía
// `golang.org/x/sys/windows`, que ya estaba enlazada). Lo específico vive en
// raw_*.go; lo que sigue —los cálculos y el parseo de texto— es puro y compila
// en todos lados.
package procmon

import (
	"context"
	"os/user"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"mini-tools/backend/portkill"
)

// Process es un proceso con sus números ya calculados.
type Process struct {
	PID  int    `json:"pid"`
	PPID int    `json:"ppid"`
	Name string `json:"name"`
	// User es el dueño. Vacío donde el sistema no lo informa sin más trámite
	// (Windows): la interfaz entonces no ofrece el filtro «Míos».
	User string `json:"user"`
	// CPU es el % de UN núcleo: un proceso que ocupa dos núcleos completos
	// marca 200. Es la convención de `top` y del Monitor de actividad.
	CPU float64 `json:"cpu"`
	// Memory son los bytes residentes (en RAM ahora).
	Memory uint64 `json:"memory"`
	// Protected marca lo que no se ofrece terminar (el sistema, esta app).
	Protected bool `json:"protected"`
}

// Snapshot es una lectura completa.
type Snapshot struct {
	Processes []Process `json:"processes"`
	Cores     int       `json:"cores"`
	// CPUTotal es el uso de TODA la máquina, de 0 a 100: la suma de los
	// procesos dividida por los núcleos.
	CPUTotal float64 `json:"cpuTotal"`
	MemUsed  uint64  `json:"memUsed"`
	MemTotal uint64  `json:"memTotal"`
	// NetRx / NetTx son bytes por segundo, sumando todas las interfaces menos
	// el loopback.
	NetRx float64 `json:"netRx"`
	NetTx float64 `json:"netTx"`
	// HasUser dice si los procesos traen dueño.
	HasUser bool `json:"hasUser"`
	// Me es el usuario de esta sesión, para el filtro «Míos». Vacío donde los
	// procesos no traen dueño.
	Me string `json:"me"`
	// TakenAt es el instante de la lectura, en milisegundos Unix.
	TakenAt int64 `json:"takenAt"`
}

// rawProc y rawSample son lo que cada plataforma devuelve: contadores
// ACUMULADOS, todavía sin convertir en tasas.
type rawProc struct {
	pid, ppid int
	name      string
	user      string
	cpu       time.Duration // tiempo de CPU acumulado desde que arrancó
	mem       uint64
}

type rawSample struct {
	at       time.Time
	procs    []rawProc
	memUsed  uint64
	memTotal uint64
	netRx    uint64 // bytes acumulados
	netTx    uint64
}

const (
	// primeGap es lo que se espera entre las dos lecturas de la primera
	// llamada: sin ella la primera pantalla mostraría todo en 0 % hasta el
	// siguiente ciclo. Lo bastante largo para que el contador de 10 ms de
	// macOS marque algo, lo bastante corto para no notarse.
	primeGap = 400 * time.Millisecond
	// staleAfter: una lectura anterior más vieja que esto ya no sirve para
	// calcular tasas (la pestaña estuvo oculta, o la máquina dormida): se
	// descarta y se vuelve a empezar.
	staleAfter = 30 * time.Second
)

// Sampler calcula tasas a partir de dos lecturas. Es seguro para uso
// concurrente.
type Sampler struct {
	mu   sync.Mutex
	prev *rawSample
}

// Reset suelta la lectura anterior. La pestaña lo llama al cerrarse o quedar
// oculta: así, mientras no se la mira, el paquete no retiene nada.
func (s *Sampler) Reset() {
	s.mu.Lock()
	s.prev = nil
	s.mu.Unlock()
}

// Sample lee el sistema y devuelve la instantánea. La primera llamada (o la
// primera tras un Reset) toma dos lecturas separadas por primeGap.
func (s *Sampler) Sample(ctx context.Context) (*Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cur, err := readRaw(ctx)
	if err != nil {
		return nil, err
	}

	if s.prev == nil || cur.at.Sub(s.prev.at) > staleAfter {
		s.prev = cur
		select {
		case <-time.After(primeGap):
		case <-ctx.Done():
			s.prev = nil
			return nil, ctx.Err()
		}
		if cur, err = readRaw(ctx); err != nil {
			s.prev = nil
			return nil, err
		}
	}

	snap := compute(s.prev, cur)
	s.prev = cur
	return snap, nil
}

// compute convierte dos lecturas en una instantánea. Pura: no toca el sistema.
func compute(prev, cur *rawSample) *Snapshot {
	dt := cur.at.Sub(prev.at).Seconds()
	cores := runtime.NumCPU()

	before := make(map[int]rawProc, len(prev.procs))
	for _, p := range prev.procs {
		before[p.pid] = p
	}

	snap := &Snapshot{
		Processes: make([]Process, 0, len(cur.procs)),
		Cores:     cores,
		MemUsed:   cur.memUsed,
		MemTotal:  cur.memTotal,
		TakenAt:   cur.at.UnixMilli(),
	}

	var sum float64
	for _, p := range cur.procs {
		pct := 0.0
		// Mismo pid y mismo nombre: un pid se reutiliza, y restarle el tiempo
		// de CPU de OTRO proceso daría un número negativo o disparatado.
		if b, ok := before[p.pid]; ok && b.name == p.name && dt > 0 {
			if d := (p.cpu - b.cpu).Seconds(); d > 0 {
				pct = d / dt * 100
			}
		}
		sum += pct
		if p.user != "" {
			snap.HasUser = true
		}
		snap.Processes = append(snap.Processes, Process{
			PID: p.pid, PPID: p.ppid, Name: p.name, User: p.user,
			CPU: pct, Memory: p.mem, Protected: portkill.IsProtected(p.pid),
		})
	}

	if snap.HasUser {
		snap.Me = currentUser()
	}
	snap.CPUTotal = sum / float64(cores)
	if snap.CPUTotal > 100 {
		snap.CPUTotal = 100
	}
	if dt > 0 {
		snap.NetRx = rate(prev.netRx, cur.netRx, dt)
		snap.NetTx = rate(prev.netTx, cur.netTx, dt)
	}
	return snap
}

var (
	meOnce sync.Once
	me     string
)

// currentUser es el nombre de usuario de la sesión, leído una sola vez.
func currentUser() string {
	meOnce.Do(func() {
		if u, err := user.Current(); err == nil {
			me = u.Username
		}
	})
	return me
}

// rate es bytes/s entre dos contadores acumulados. Si el contador retrocedió
// (una interfaz que se reinició) no hay tasa que informar: 0, no un negativo.
func rate(before, after uint64, dt float64) float64 {
	if after < before {
		return 0
	}
	return float64(after-before) / dt
}

// parsePsTime lee la columna TIME de `ps`: `[[d-]hh:]mm:ss[.cc]`.
func parsePsTime(s string) time.Duration {
	s = strings.TrimSpace(s)
	var days float64
	if i := strings.Index(s, "-"); i >= 0 {
		days, _ = strconv.ParseFloat(s[:i], 64)
		s = s[i+1:]
	}
	secs := 0.0
	for _, part := range strings.Split(s, ":") {
		v, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return 0
		}
		secs = secs*60 + v
	}
	return time.Duration((days*86400 + secs) * float64(time.Second))
}

// parsePs lee `ps -axwwo pid=,ppid=,rss=,time=,user=,comm=`. El comando va al
// final porque puede tener espacios ("Google Chrome Helper"): todo lo que sigue
// a la quinta columna es el nombre. Se queda con el último tramo de la ruta.
func parsePs(out string) []rawProc {
	var res []rawProc
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		rss, err3 := strconv.ParseUint(f[2], 10, 64)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		name := strings.Join(f[5:], " ")
		if i := strings.LastIndex(name, "/"); i >= 0 && i < len(name)-1 {
			name = name[i+1:]
		}
		res = append(res, rawProc{
			pid: pid, ppid: ppid, mem: rss * 1024,
			cpu: parsePsTime(f[3]), user: f[4], name: name,
		})
	}
	return res
}

// parseVmStat devuelve la memoria en uso según vm_stat: páginas anónimas
// (memoria de apps) + cableadas + comprimidas, que es lo que el Monitor de
// actividad llama «Memoria usada».
func parseVmStat(out string) uint64 {
	pageSize := uint64(4096)
	var anon, wired, comp uint64
	for _, line := range strings.Split(out, "\n") {
		if i := strings.Index(line, "page size of "); i >= 0 {
			rest := strings.Fields(line[i+len("page size of "):])
			if len(rest) > 0 {
				if v, err := strconv.ParseUint(rest[0], 10, 64); err == nil {
					pageSize = v
				}
			}
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(val), "."), 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSpace(key) {
		case "Anonymous pages":
			anon = n
		case "Pages wired down":
			wired = n
		case "Pages occupied by compressor":
			comp = n
		}
	}
	return (anon + wired + comp) * pageSize
}

// parseNetstatIB suma los bytes de `netstat -ib` de macOS, una vez por
// interfaz (las filas `<Link#N>`) y sin el loopback. Las columnas se leen
// desde el FINAL: la dirección MAC puede faltar y correr todo un lugar.
func parseNetstatIB(out string) (rx, tx uint64) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 8 || !strings.HasPrefix(f[2], "<Link#") || strings.HasPrefix(f[0], "lo") {
			continue
		}
		in, err1 := strconv.ParseUint(f[len(f)-5], 10, 64)
		out, err2 := strconv.ParseUint(f[len(f)-2], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rx += in
		tx += out
	}
	return rx, tx
}

// parseNetstatE lee `netstat -e` de Windows: la primera fila con dos números
// grandes es la de bytes recibidos y enviados. El rótulo sale traducido
// ("Bytes" / "Bytes"), por eso no se mira.
func parseNetstatE(out string) (rx, tx uint64) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 3 {
			continue
		}
		a, err1 := strconv.ParseUint(f[1], 10, 64)
		b, err2 := strconv.ParseUint(f[2], 10, 64)
		if err1 == nil && err2 == nil {
			return a, b
		}
	}
	return 0, 0
}

// parseProcNetDev suma /proc/net/dev de Linux, sin el loopback.
func parseProcNetDev(out string) (rx, tx uint64) {
	for _, line := range strings.Split(out, "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) == "lo" {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		in, err1 := strconv.ParseUint(f[0], 10, 64)
		out, err2 := strconv.ParseUint(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rx += in
		tx += out
	}
	return rx, tx
}
