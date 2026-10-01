// Package portkill lista los puertos TCP que están escuchando en ESTA máquina
// y termina el proceso que tiene uno ocupado: el "¿quién se quedó con el 3000?"
// que de otro modo es `lsof -i :3000` + `kill`, o `netstat -ano` +
// `taskkill`, según el sistema operativo.
//
// **No hay nada residente.** Ningún paquete de este archivo arranca una
// goroutine, un temporizador ni un caché: cada llamada ejecuta una herramienta
// del sistema, parsea su salida y termina. Quien decide cada cuánto mirar es la
// pestaña que lo muestra (y solo mientras está abierta y a la vista), así que
// una app con la utilidad cerrada no gasta nada en ella.
//
// **Sin cgo y sin dependencias nuevas**: se apoya en lo que cada sistema ya
// trae (`lsof`/`ss` en macOS y Linux, `netstat`/`tasklist` en Windows). Lo
// específico de cada plataforma vive en list_*.go y kill_*.go; lo que sigue es
// el parseo de sus salidas, que es puro y compila en todos lados.
package portkill

import (
	"context"
	"encoding/csv"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"mini-tools/backend/i18n"
)

// Listener es un puerto TCP en escucha y el proceso que lo tiene.
type Listener struct {
	Port int `json:"port"`
	// Address es el origen del socket tal como lo informa el sistema:
	// `*` / `0.0.0.0` / `[::]` (todas las interfaces) o una dirección
	// concreta (`127.0.0.1`, solo esta máquina). Es lo que distingue un
	// servidor de desarrollo de uno expuesto a la red.
	Address string `json:"address"`
	PID     int    `json:"pid"`
	// Process es el nombre del ejecutable. Vacío si el sistema no lo
	// reveló (un proceso de otro usuario, sin privilegios para verlo).
	Process string `json:"process"`
	// Protected marca lo que la interfaz no debe ofrecer terminar: la propia
	// app, los procesos del sistema y los que no se pudo identificar.
	Protected bool `json:"protected"`
}

// Errores con código: la interfaz reacciona distinto a cada uno (pedir
// permisos, avisar que ya no existe) y no puede comparar contra un texto que
// cambia con el idioma. Ver backend/i18n.NewCoded.
var (
	ErrProtected = i18n.NewCoded("protected", i18n.Msg{
		ES: "ese proceso es del sistema (o es esta misma app) y no se puede terminar desde acá",
		EN: "that process belongs to the system (or is this very app) and can't be ended from here",
	})
	ErrPermission = i18n.NewCoded("permission", i18n.Msg{
		ES: "no tenés permiso para terminar ese proceso: es de otro usuario o del sistema",
		EN: "you don't have permission to end that process: it belongs to another user or to the system",
	})
	ErrNotFound = i18n.NewCoded("not-found", i18n.Msg{
		ES: "el proceso ya no existe",
		EN: "the process no longer exists",
	})
	ErrElevationDenied = i18n.NewCoded("elevation-denied", i18n.Msg{
		ES: "no se concedieron los permisos de administrador",
		EN: "administrator permission was not granted",
	})
	ErrNoTool = i18n.NewCoded("no-tool", i18n.Msg{
		ES: "este sistema no tiene ninguna herramienta para listar puertos (se busca lsof o ss)",
		EN: "this system has no tool to list ports (lsof or ss is required)",
	})
)

// listTimeout acota una consulta: lsof en una máquina con miles de sockets
// puede tardar, pero nunca debería quedarse colgado.
const listTimeout = 15 * time.Second

// List devuelve los puertos TCP en escucha, ordenados por puerto.
func List(ctx context.Context) ([]Listener, error) {
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()

	found, err := listPlatform(ctx)
	if err != nil {
		return nil, err
	}
	return finish(found), nil
}

// Kill termina el proceso pid con los permisos de la app. force=false pide un
// cierre ordenado (SIGTERM); force=true lo corta ya (SIGKILL). Windows no
// tiene la primera: allá los dos son TerminateProcess.
//
// Devuelve si el proceso ya había salido al cabo de un par de segundos — un
// servidor que atrapa SIGTERM puede tardar o ignorarlo, y la interfaz usa eso
// para ofrecer «Forzar» en vez de dar por hecho que se cerró.
func Kill(pid int, force bool) (bool, error) {
	if err := checkKillable(pid); err != nil {
		return false, err
	}
	if err := terminate(pid, force); err != nil {
		return false, err
	}
	return waitExit(pid, 2*time.Second), nil
}

// KillElevated es Kill pidiéndole al sistema los permisos de administrador:
// el diálogo de contraseña de macOS, pkexec en Linux o el UAC de Windows. Es
// lo que hace falta para un proceso de otro usuario. Solo se llama después de
// que Kill respondió ErrPermission y el usuario lo confirmó.
func KillElevated(ctx context.Context, pid int, force bool) (bool, error) {
	if err := checkKillable(pid); err != nil {
		return false, err
	}
	if err := terminateElevated(ctx, pid, force); err != nil {
		return false, err
	}
	return waitExit(pid, 2*time.Second), nil
}

func checkKillable(pid int) error {
	if IsProtected(pid) {
		return ErrProtected
	}
	return nil
}

// IsProtected es lo que nunca se ofrece terminar: pid 0 (no identificado), el
// init/launchd (1), los procesos del sistema de Windows (4) y esta app —
// matarse a sí misma desde su propio botón no es un caso que alguien busque.
func IsProtected(pid int) bool {
	if pid <= 1 || pid == os.Getpid() {
		return true
	}
	return runtime.GOOS == "windows" && pid <= 4
}

// finish deduplica, marca los protegidos y ordena. lsof y netstat informan el
// mismo servidor dos veces cuando escucha en IPv4 e IPv6 a la vez.
func finish(in []Listener) []Listener {
	seen := make(map[Listener]bool, len(in))
	out := make([]Listener, 0, len(in))
	for _, l := range in {
		l.Protected = IsProtected(l.PID)
		if seen[l] {
			continue
		}
		seen[l] = true
		out = append(out, l)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Port != out[j].Port {
			return out[i].Port < out[j].Port
		}
		if out[i].PID != out[j].PID {
			return out[i].PID < out[j].PID
		}
		return out[i].Address < out[j].Address
	})
	return out
}

// splitHostPort separa "127.0.0.1:7000", "*:5000" o "[::1]:8080" en dirección
// y puerto. No usa net.SplitHostPort porque `*:5000` y `[::]:80` mezclados con
// lo que escupe cada herramienta no siempre son direcciones válidas para él.
func splitHostPort(s string) (string, int, bool) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return "", 0, false
	}
	port, err := strconv.Atoi(s[i+1:])
	if err != nil || port <= 0 || port > 65535 {
		return "", 0, false
	}
	return strings.Trim(s[:i], "[]"), port, true
}

// parseLsof lee `lsof -F pcn`: un campo por línea, prefijado con su letra. Una
// línea `p` abre un proceso, `c` le pone nombre y cada `n` es uno de sus
// sockets.
func parseLsof(out string) []Listener {
	var res []Listener
	pid, name := 0, ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
			name = ""
		case 'c':
			// lsof escapa los espacios del nombre como \x20.
			name = strings.ReplaceAll(line[1:], `\x20`, " ")
		case 'n':
			if addr, port, ok := splitHostPort(line[1:]); ok {
				res = append(res, Listener{Port: port, Address: addr, PID: pid, Process: name})
			}
		}
	}
	return res
}

var ssUsers = regexp.MustCompile(`\("([^"]*)",pid=(\d+)`)

// parseSS lee `ss -H -ltnp`. Sin privilegios, `ss` solo revela el proceso de
// los sockets del propio usuario; el resto sale sin la columna `users:`, y se
// lista con pid 0 (protegido: no hay a quién apuntar).
func parseSS(out string) []Listener {
	var res []Listener
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		addr, port, ok := splitHostPort(f[3])
		if !ok {
			continue
		}
		procs := ssUsers.FindAllStringSubmatch(line, -1)
		if len(procs) == 0 {
			res = append(res, Listener{Port: port, Address: addr})
			continue
		}
		for _, m := range procs {
			pid, _ := strconv.Atoi(m[2])
			res = append(res, Listener{Port: port, Address: addr, PID: pid, Process: m[1]})
		}
	}
	return res
}

// parseNetstat lee `netstat -ano`. La columna de estado sale traducida
// ("LISTENING" / "ESCUCHANDO"), así que no se mira: un socket en escucha es el
// que tiene dirección remota `0.0.0.0:0` o `[::]:0`, en cualquier idioma.
func parseNetstat(out string) []Listener {
	var res []Listener
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 5 || !strings.EqualFold(f[0], "TCP") {
			continue
		}
		if f[2] != "0.0.0.0:0" && f[2] != "[::]:0" {
			continue
		}
		addr, port, ok := splitHostPort(f[1])
		if !ok {
			continue
		}
		pid, _ := strconv.Atoi(f[4])
		res = append(res, Listener{Port: port, Address: addr, PID: pid})
	}
	return res
}

// parseTasklist lee `tasklist /FO CSV /NH` y devuelve pid → nombre.
func parseTasklist(out string) map[int]string {
	names := map[int]string{}
	r := csv.NewReader(strings.NewReader(out))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return names
	}
	for _, row := range rows {
		if len(row) < 2 {
			continue
		}
		if pid, err := strconv.Atoi(row[1]); err == nil {
			names[pid] = row[0]
		}
	}
	return names
}

// isNotInstalled distingue "la herramienta no existe" de "corrió y falló".
func isNotInstalled(err error) bool {
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist)
}
