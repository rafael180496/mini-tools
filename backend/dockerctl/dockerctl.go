// Package dockerctl es la utilidad Docker: detecta si Docker está instalado y
// andando, lista contenedores, imágenes, volúmenes y redes, y los opera.
//
// **Habla con la CLI `docker`, no con el socket.** Es lo que respeta lo que el
// usuario ya tiene configurado —el contexto activo (Docker Desktop, OrbStack,
// Colima, un host remoto), las credenciales, el `DOCKER_HOST`— sin que esta app
// reimplemente nada de eso, y es lo que funciona igual en macOS, Windows y
// Linux, donde el socket cambia de ruta (o es una tubería con nombre). Sin cgo y
// sin dependencias nuevas.
//
// **Sin estado residente.** Cada función ejecuta un comando y vuelve. La única
// excepción son los logs en vivo (logs.go), que mantienen un `docker logs -f`
// abierto, y solo mientras alguien tiene ese panel a la vista.
package dockerctl

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"mini-tools/backend/hidewin"
	"mini-tools/backend/i18n"
)

var (
	ErrNotInstalled = i18n.NewCoded("not-installed", i18n.Msg{
		ES: "Docker no está instalado en esta máquina",
		EN: "Docker isn't installed on this machine",
	})
	ErrBadID = i18n.NewCoded("bad-id", i18n.Msg{
		ES: "identificador de Docker inválido",
		EN: "invalid Docker identifier",
	})
	ErrBadOp = i18n.NewCoded("bad-op", i18n.Msg{
		ES: "operación de Docker no permitida",
		EN: "Docker operation not allowed",
	})
)

// Status es lo que la pantalla necesita para decidir qué mostrar: «instalá
// Docker», «arrancá Docker» o las listas.
type Status struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path"`
	// Version es la del cliente; ServerVersion la del motor, vacía si no
	// responde.
	Version       string `json:"version"`
	ServerVersion string `json:"serverVersion"`
	Running       bool   `json:"running"`
	// Context es el contexto activo de la CLI (desktop-linux, orbstack…): dice
	// CONTRA QUÉ motor se está mirando, que con varios instalados importa.
	Context string `json:"context"`
	// Error es el motivo por el que el motor no responde, tal como lo dice
	// Docker ("Cannot connect to the Docker daemon at …").
	Error string `json:"error"`
	// Launcher es la app que se puede abrir para arrancar el motor
	// ("Docker Desktop", "OrbStack"), vacía si no hay una conocida.
	Launcher string `json:"launcher"`
}

type Container struct {
	// ID es el identificador completo; la interfaz muestra los 12 primeros.
	ID      string `json:"id"`
	Name    string `json:"name"`
	Image   string `json:"image"`
	State   string `json:"state"`
	Status  string `json:"status"`
	Ports   string `json:"ports"`
	Created string `json:"created"`
	// Project y Service salen de las etiquetas de Compose: lo que permite
	// agrupar los contenedores como lo hace Docker Desktop.
	Project string   `json:"project"`
	Service string   `json:"service"`
	Mounts  []string `json:"mounts"`
	// WorkingDir y ConfigFiles también salen de las etiquetas de Compose: son
	// lo que permite volver a operar el proyecto (`compose up/down`) desde
	// donde se lo levantó.
	WorkingDir  string `json:"workingDir"`
	ConfigFiles string `json:"configFiles"`
}

type Image struct {
	ID         string `json:"id"`
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	Size       string `json:"size"`
	Created    string `json:"created"`
	// InUse cuenta los contenedores (de cualquier estado) que la usan.
	InUse int `json:"inUse"`
}

type Volume struct {
	Name       string `json:"name"`
	Driver     string `json:"driver"`
	Mountpoint string `json:"mountpoint"`
	// UsedBy cuenta los contenedores que lo montan.
	UsedBy int `json:"usedBy"`
}

type Network struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Driver string `json:"driver"`
	Scope  string `json:"scope"`
}

// Stat es el consumo instantáneo de un contenedor en marcha.
type Stat struct {
	ID         string  `json:"id"`
	CPU        float64 `json:"cpu"`
	MemUsage   string  `json:"memUsage"`
	MemPercent float64 `json:"memPercent"`
}

// idRe: lo que Docker acepta como id o nombre. Que el PRIMER carácter sea
// alfanumérico es lo que importa: un valor que empiece con `-` se leería como
// una opción de la CLI.
var idRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$`)

func validID(id string) bool { return len(id) <= 256 && idRe.MatchString(id) }

// candidatePaths son los lugares donde vive la CLI fuera del PATH. Una app
// abierta desde el Dock o el menú Inicio hereda un PATH mínimo que no incluye
// /usr/local/bin ni /opt/homebrew/bin: por eso `docker` «no existe» para la
// app aunque funcione en cualquier terminal.
func candidatePaths() []string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/usr/local/bin/docker",
			"/opt/homebrew/bin/docker",
			"/Applications/Docker.app/Contents/Resources/bin/docker",
			filepath.Join(home, ".docker/bin/docker"),
			filepath.Join(home, ".orbstack/bin/docker"),
			filepath.Join(home, ".rd/bin/docker"),
			"/usr/bin/docker",
		}
	case "windows":
		pf := os.Getenv("ProgramFiles")
		return []string{
			filepath.Join(pf, `Docker\Docker\resources\bin\docker.exe`),
			filepath.Join(os.Getenv("LOCALAPPDATA"), `Programs\Docker\Docker\resources\bin\docker.exe`),
		}
	default:
		return []string{"/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker", filepath.Join(home, ".docker/bin/docker")}
	}
}

// find devuelve la ruta de la CLI, o "" si no está.
func find() string {
	if p, err := exec.LookPath("docker"); err == nil {
		return p
	}
	for _, p := range candidatePaths() {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// run ejecuta `docker args…` y devuelve su stdout. El error lleva lo que Docker
// escribió en stderr, que es lo informativo («No such container», «Cannot
// connect to the Docker daemon…»), no el «exit status 1» pelado.
func run(ctx context.Context, args ...string) (string, error) {
	bin := find()
	if bin == "" {
		return "", ErrNotInstalled
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	hidewin.Hide(cmd)
	// El directorio de la CLI al PATH: algunos contextos invocan helpers
	// (docker-credential-*, plugins) que viven junto a ella.
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+string(os.PathListSeparator)+filepath.Dir(bin))
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(errb.String()); msg != "" {
			return out.String(), &cliError{msg: msg, err: err}
		}
		return out.String(), err
	}
	return out.String(), nil
}

// cliError muestra lo que dijo Docker pero conserva el error de origen para
// errors.Is/As (un timeout sigue siendo un timeout).
type cliError struct {
	msg string
	err error
}

func (e *cliError) Error() string { return e.msg }
func (e *cliError) Unwrap() error { return e.err }

// Probe responde las dos preguntas: ¿está instalado? ¿y el motor está andando?
func Probe(ctx context.Context) *Status {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	st := &Status{Launcher: launcher()}
	bin := find()
	if bin == "" {
		return st
	}
	st.Installed, st.Path = true, bin

	if out, err := run(ctx, "--version"); err == nil {
		// "Docker version 29.4.0, build 9d7ad9f"
		if _, rest, ok := strings.Cut(out, "version "); ok {
			st.Version, _, _ = strings.Cut(strings.TrimSpace(rest), ",")
		}
	}
	if out, err := run(ctx, "context", "show"); err == nil {
		st.Context = strings.TrimSpace(out)
	}
	out, err := run(ctx, "info", "--format", "{{.ServerVersion}}")
	if err != nil {
		st.Error = err.Error()
		return st
	}
	st.Running = true
	st.ServerVersion = strings.TrimSpace(out)
	return st
}

// lines devuelve cada línea de out ya decodificada como JSON en v.
func eachJSON(out string, f func(raw []byte) error) error {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if err := f([]byte(line)); err != nil {
			return err
		}
	}
	return nil
}

func listCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 20*time.Second)
}

const containerFormat = `{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"ports":{{json .Ports}},"created":{{json .CreatedAt}},"project":{{json (.Label "com.docker.compose.project")}},"service":{{json (.Label "com.docker.compose.service")}},"workingDir":{{json (.Label "com.docker.compose.project.working_dir")}},"configFiles":{{json (.Label "com.docker.compose.project.config_files")}},"mounts":{{json .Mounts}}}`

// Containers lista todos los contenedores, en marcha o no. Los ordena por
// proyecto y nombre: la interfaz los agrupa por proyecto y necesita que los de
// un mismo proyecto vengan juntos y siempre en el mismo orden.
func Containers(ctx context.Context) ([]Container, error) {
	ctx, cancel := listCtx(ctx)
	defer cancel()
	// --no-trunc: sin él Mounts llega cortado con «…», y de ahí salen los
	// volúmenes en uso.
	out, err := run(ctx, "ps", "-a", "--no-trunc", "--format", containerFormat)
	if err != nil {
		return nil, err
	}
	res := []Container{}
	err = eachJSON(out, func(raw []byte) error {
		var c struct {
			Container
			Mounts string `json:"mounts"`
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			return err
		}
		ct := c.Container
		for _, m := range strings.Split(c.Mounts, ",") {
			if m = strings.TrimSpace(m); m != "" {
				ct.Mounts = append(ct.Mounts, m)
			}
		}
		res = append(res, ct)
		return nil
	})
	sort.SliceStable(res, func(i, j int) bool {
		if res[i].Project != res[j].Project {
			// Los sueltos (sin proyecto) al final.
			if res[i].Project == "" || res[j].Project == "" {
				return res[i].Project != ""
			}
			return res[i].Project < res[j].Project
		}
		return res[i].Name < res[j].Name
	})
	return res, err
}

// Images lista las imágenes, con cuántos contenedores usan cada una.
func Images(ctx context.Context) ([]Image, error) {
	ctx, cancel := listCtx(ctx)
	defer cancel()
	out, err := run(ctx, "image", "ls", "--format",
		`{"id":{{json .ID}},"repository":{{json .Repository}},"tag":{{json .Tag}},"size":{{json .Size}},"created":{{json .CreatedSince}}}`)
	if err != nil {
		return nil, err
	}
	res := []Image{}
	err = eachJSON(out, func(raw []byte) error {
		var im Image
		if err := json.Unmarshal(raw, &im); err != nil {
			return err
		}
		res = append(res, im)
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Cuántos contenedores usan cada imagen. Una consulta aparte y tolerante:
	// si falla, la lista de imágenes sigue sirviendo, solo sin ese dato.
	if used, err := run(ctx, "ps", "-a", "--format", "{{.Image}}"); err == nil {
		counts := map[string]int{}
		for _, name := range strings.Split(used, "\n") {
			if name = strings.TrimSpace(name); name != "" {
				counts[name]++
			}
		}
		for i := range res {
			ref := res[i].Repository + ":" + res[i].Tag
			res[i].InUse = counts[ref] + counts[res[i].ID]
			if res[i].Tag == "latest" {
				res[i].InUse += counts[res[i].Repository]
			}
		}
	}
	return res, nil
}

// Volumes lista los volúmenes con cuántos contenedores los montan.
func Volumes(ctx context.Context) ([]Volume, error) {
	ctx, cancel := listCtx(ctx)
	defer cancel()
	out, err := run(ctx, "volume", "ls", "--format",
		`{"name":{{json .Name}},"driver":{{json .Driver}},"mountpoint":{{json .Mountpoint}}}`)
	if err != nil {
		return nil, err
	}
	res := []Volume{}
	err = eachJSON(out, func(raw []byte) error {
		var v Volume
		if err := json.Unmarshal(raw, &v); err != nil {
			return err
		}
		res = append(res, v)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if mounts, err := run(ctx, "ps", "-a", "--no-trunc", "--format", "{{.Mounts}}"); err == nil {
		counts := map[string]int{}
		for _, line := range strings.Split(mounts, "\n") {
			for _, m := range strings.Split(line, ",") {
				if m = strings.TrimSpace(m); m != "" {
					counts[m]++
				}
			}
		}
		for i := range res {
			res[i].UsedBy = counts[res[i].Name]
		}
	}
	sort.SliceStable(res, func(i, j int) bool { return res[i].Name < res[j].Name })
	return res, nil
}

// Networks lista las redes.
func Networks(ctx context.Context) ([]Network, error) {
	ctx, cancel := listCtx(ctx)
	defer cancel()
	out, err := run(ctx, "network", "ls", "--format",
		`{"id":{{json .ID}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}}}`)
	if err != nil {
		return nil, err
	}
	res := []Network{}
	err = eachJSON(out, func(raw []byte) error {
		var n Network
		if err := json.Unmarshal(raw, &n); err != nil {
			return err
		}
		res = append(res, n)
		return nil
	})
	sort.SliceStable(res, func(i, j int) bool { return res[i].Name < res[j].Name })
	return res, err
}

// Stats lee el consumo de los contenedores EN MARCHA. `docker stats` muestrea
// durante un par de segundos, por eso va aparte de la lista: la tabla no tiene
// que esperarlo.
func Stats(ctx context.Context) ([]Stat, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	out, err := run(ctx, "stats", "--no-stream", "--format",
		`{"id":{{json .ID}},"cpu":{{json .CPUPerc}},"mem":{{json .MemUsage}},"memPct":{{json .MemPerc}}}`)
	if err != nil {
		return nil, err
	}
	res := []Stat{}
	err = eachJSON(out, func(raw []byte) error {
		var s struct {
			ID     string `json:"id"`
			CPU    string `json:"cpu"`
			Mem    string `json:"mem"`
			MemPct string `json:"memPct"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		res = append(res, Stat{ID: s.ID, CPU: pct(s.CPU), MemUsage: s.Mem, MemPercent: pct(s.MemPct)})
		return nil
	})
	return res, err
}

// pct lee "0.17%" como 0.17; lo que no se pueda leer es 0.
func pct(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return v
}

// ops es la lista cerrada de lo que se puede ejecutar: la interfaz manda un
// nombre, no una línea de comandos. Cualquier otra cosa se rechaza.
var ops = map[string][]string{
	"container.start":   {"start"},
	"container.stop":    {"stop"},
	"container.restart": {"restart"},
	"container.pause":   {"pause"},
	"container.unpause": {"unpause"},
	"container.kill":    {"kill"},
	// -f: borrar un contenedor en marcha es lo que se pide al tocar el
	// tacho; sin -f, Docker se negaría y habría que parar primero.
	"container.remove": {"rm", "-f"},
	"image.remove":     {"rmi"},
	"volume.remove":    {"volume", "rm"},
	"network.remove":   {"network", "rm"},
}

// Do ejecuta op sobre los ids. Devuelve lo que Docker imprimió; si alguno
// falla, el error trae su mensaje (los demás ya se aplicaron).
func Do(ctx context.Context, op string, ids []string) (string, error) {
	base, ok := ops[op]
	if !ok {
		return "", ErrBadOp
	}
	if len(ids) == 0 {
		return "", ErrBadID
	}
	for _, id := range ids {
		if !validID(id) {
			return "", ErrBadID
		}
	}
	// Parar espera hasta 10 s por contenedor: con varios, el tope se escala.
	ctx, cancel := context.WithTimeout(ctx, time.Duration(30+15*len(ids))*time.Second)
	defer cancel()
	return run(ctx, append(append([]string{}, base...), ids...)...)
}

var inspectKinds = map[string][]string{
	"container": {"container", "inspect"},
	"image":     {"image", "inspect"},
	"volume":    {"volume", "inspect"},
	"network":   {"network", "inspect"},
}

// Inspect devuelve el JSON de `docker <kind> inspect id`, ya indentado.
func Inspect(ctx context.Context, kind, id string) (string, error) {
	base, ok := inspectKinds[kind]
	if !ok {
		return "", ErrBadOp
	}
	if !validID(id) {
		return "", ErrBadID
	}
	ctx, cancel := listCtx(ctx)
	defer cancel()
	return run(ctx, append(append([]string{}, base...), id)...)
}
