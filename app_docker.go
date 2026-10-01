package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/dockerctl"
	"mini-tools/backend/i18n"
)

// Bindings de la utilidad Docker. Mismo criterio que app_utilities.go: todos
// pasan por requireUnlocked —operar contenedores es una acción sobre la máquina
// entera— y ninguno deja nada corriendo salvo los logs en vivo, que existen
// mientras el panel está a la vista (DockerLogsStop o el cierre de la app los
// termina). El contrato está en .claude/specs/go-react-contract.md.

// dockerLogs son los `docker logs -f` abiertos. Valor, no servicio: no arranca
// nada hasta que alguien abre un panel de logs.
var dockerLogs dockerctl.LogStreams

// DockerStatus dice si Docker está instalado y si su motor responde.
func (a *App) DockerStatus() (*dockerctl.Status, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Probe(context.Background()), nil
}

// DockerStartApp abre la aplicación que levanta el motor (Docker Desktop,
// OrbStack…) en macOS y Windows.
func (a *App) DockerStartApp() error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return dockerctl.StartApp(ctx)
}

func (a *App) DockerContainers() ([]dockerctl.Container, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Containers(context.Background())
}

func (a *App) DockerImages() ([]dockerctl.Image, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Images(context.Background())
}

func (a *App) DockerVolumes() ([]dockerctl.Volume, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Volumes(context.Background())
}

func (a *App) DockerNetworks() ([]dockerctl.Network, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Networks(context.Background())
}

// DockerStats lee el consumo de los contenedores en marcha. Tarda un par de
// segundos (Docker muestrea), por eso es una llamada aparte de la lista.
func (a *App) DockerStats() ([]dockerctl.Stat, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Stats(context.Background())
}

// DockerAction ejecuta una operación de la lista cerrada de dockerctl
// (`container.stop`, `image.remove`…) sobre uno o varios ids. La interfaz manda
// el nombre de la operación, nunca una línea de comandos.
func (a *App) DockerAction(op string, ids []string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return dockerctl.Do(context.Background(), op, ids)
}

// DockerCompose ejecuta una operación de Compose (`up`, `down`, `stop`, `start`,
// `restart`) sobre un proyecto ya existente. Los archivos los lee el backend de
// las etiquetas de sus contenedores. `up` puede tardar minutos (descarga y
// construye).
func (a *App) DockerCompose(op, project string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return dockerctl.Compose(context.Background(), op, project)
}

// DockerPickComposeFile abre el diálogo del sistema para elegir un archivo de
// Compose. Devuelve "" si se cancela.
func (a *App) DockerPickComposeFile() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: i18n.T(i18n.Msg{ES: "Elegir un archivo de Compose", EN: "Choose a Compose file"}),
		Filters: []runtime.FileFilter{{
			DisplayName: "Docker Compose (*.yml, *.yaml)",
			Pattern:     "*.yml;*.yaml",
		}},
	})
}

// DockerComposeUpFile levanta un proyecto nuevo (`docker compose up -d`) desde
// el archivo elegido con DockerPickComposeFile.
func (a *App) DockerComposeUpFile(path string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return dockerctl.ComposeUpFile(context.Background(), path)
}

// DockerCounts devuelve cuántos contenedores, imágenes, volúmenes, redes y builds
// hay, para los contadores del submenú de la barra lateral. Una sola llamada
// liviana en vez de listar cada sección entera.
func (a *App) DockerCounts() (*dockerctl.Counts, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	c := dockerctl.CountAll(context.Background())
	return &c, nil
}

// DockerBuilds lista el historial de builds (`docker buildx history`).
func (a *App) DockerBuilds() ([]dockerctl.Build, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return dockerctl.Builds(context.Background())
}

// DockerBuildLogs devuelve el log de un build para mostrarlo en pantalla, con un
// aviso si hubo que acortarlo (se conserva el final, donde suele estar el error).
func (a *App) DockerBuildLogs(ref string) (*DockerBuildLogResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	text, truncated, err := dockerctl.BuildLogs(context.Background(), ref)
	if err != nil {
		return nil, err
	}
	return &DockerBuildLogResult{Text: text, Truncated: truncated}, nil
}

// DockerBuildLogResult es el log de un build y si se lo acortó.
type DockerBuildLogResult struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

// exportSlug deja un nombre apto para un archivo: letras, números, punto, guion
// y guion bajo. Lo demás (barras, dos puntos, espacios) se vuelve guion bajo.
func exportSlug(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	s := strings.Trim(b.String(), "._")
	if s == "" {
		return "docker"
	}
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

// pickLogFile abre el diálogo de guardado con un nombre sugerido. Devuelve ""
// si el usuario cancela. Empieza en Descargas cuando existe: es donde se espera
// encontrar algo que se acaba de exportar.
func (a *App) pickLogFile(kind, name string) (string, error) {
	opts := runtime.SaveDialogOptions{
		Title:           i18n.T(i18n.Msg{ES: "Exportar logs", EN: "Export logs"}),
		DefaultFilename: exportSlug(name) + "-" + kind + "-" + time.Now().Format("20060102-150405") + ".log",
		Filters:         []runtime.FileFilter{{DisplayName: "Logs (*.log, *.txt)", Pattern: "*.log;*.txt"}},
	}
	if home, err := os.UserHomeDir(); err == nil {
		if dl := filepath.Join(home, "Downloads"); dirExists(dl) {
			opts.DefaultDirectory = dl
		}
	}
	return runtime.SaveFileDialog(a.ctx, opts)
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// writeLogFile crea el archivo (0600: un log puede llevar datos que no son para
// cualquiera de la máquina) y le pasa a fill el destino. Si falla, no deja un
// archivo a medias.
func writeLogFile(path string, fill func(f *os.File) error) (int64, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	err = fill(f)
	size, _ := f.Seek(0, 1)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(path)
		return 0, err
	}
	return size, nil
}

// DockerExportResult dice dónde quedó lo exportado. Path vacío = el usuario
// canceló el diálogo.
type DockerExportResult struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
	// Lines es cuántas líneas se escribieron.
	Lines int `json:"lines"`
}

// lineCounter cuenta los saltos de línea que pasan hacia el archivo, para
// decirle al usuario cuántas líneas exportó realmente (puede haber menos que el
// límite pedido, si el contenedor no tiene tantas).
type lineCounter struct {
	w io.Writer
	n int
}

func (c *lineCounter) Write(p []byte) (int, error) {
	c.n += bytes.Count(p, []byte{'\n'})
	return c.w.Write(p)
}

// DockerExportContainerLogs guarda en un archivo las últimas `lines` líneas de
// los logs de un contenedor —de 100 a 10000, el backend lo vuelve a acotar—, no
// solo lo que muestra el panel.
func (a *App) DockerExportContainerLogs(containerID, name string, lines int) (*DockerExportResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	path, err := a.pickLogFile("logs", name)
	if err != nil || path == "" {
		return &DockerExportResult{}, err
	}
	var cnt *lineCounter
	n, err := writeLogFile(path, func(f *os.File) error {
		cnt = &lineCounter{w: f}
		return dockerctl.ExportContainerLogs(context.Background(), containerID, lines, cnt)
	})
	if err != nil {
		return nil, err
	}
	return &DockerExportResult{Path: path, Bytes: n, Lines: cnt.n}, nil
}

// DockerExportBuildLogs guarda en un archivo las últimas `lines` líneas del log
// de un build (de 100 a 10000).
func (a *App) DockerExportBuildLogs(ref, name string, lines int) (*DockerExportResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	path, err := a.pickLogFile("build", name)
	if err != nil || path == "" {
		return &DockerExportResult{}, err
	}
	var cnt *lineCounter
	n, err := writeLogFile(path, func(f *os.File) error {
		cnt = &lineCounter{w: f}
		return dockerctl.ExportBuildLogs(context.Background(), ref, lines, cnt)
	})
	if err != nil {
		return nil, err
	}
	return &DockerExportResult{Path: path, Bytes: n, Lines: cnt.n}, nil
}

// DockerSaveText guarda en un archivo un texto que ya está en pantalla (los
// logs filtrados por una búsqueda, por ejemplo), acotado a las últimas `lines`
// líneas (100 a 10000). Devuelve el destino, vacío si se canceló.
func (a *App) DockerSaveText(name, content string, lines int) (*DockerExportResult, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	path, err := a.pickLogFile("view", name)
	if err != nil || path == "" {
		return &DockerExportResult{}, err
	}
	limit := dockerctl.ClampExportLines(lines)
	all := strings.Split(strings.TrimRight(content, "\n"), "\n")
	if len(all) > limit {
		all = all[len(all)-limit:]
	}
	text := strings.Join(all, "\n") + "\n"
	n, err := writeLogFile(path, func(f *os.File) error {
		_, werr := f.WriteString(text)
		return werr
	})
	if err != nil {
		return nil, err
	}
	return &DockerExportResult{Path: path, Bytes: n, Lines: len(all)}, nil
}

// DockerInspect devuelve el JSON de inspección de un contenedor, imagen, volumen
// o red.
func (a *App) DockerInspect(kind, id string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return dockerctl.Inspect(context.Background(), kind, id)
}

// DockerLogsStart abre el flujo de logs de un contenedor bajo el evento
// sessionID (ver dockerctl.LogEvent). Igual que las terminales y las consultas:
// el frontend se suscribe ANTES de llamar, así no se pierde el primer lote.
func (a *App) DockerLogsStart(sessionID, containerID string, tail int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return dockerLogs.Start(sessionID, containerID, tail, func(event string, data interface{}) {
		runtime.EventsEmit(a.ctx, event, data)
	})
}

// DockerLogsStop cierra el flujo de logs de sessionID.
func (a *App) DockerLogsStop(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	dockerLogs.Stop(sessionID)
	return nil
}
