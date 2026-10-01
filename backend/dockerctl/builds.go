package dockerctl

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"mini-tools/backend/hidewin"
	"mini-tools/backend/i18n"
)

// ErrNoBuildx: el historial de builds es de `docker buildx history`, que existe
// desde buildx 0.20. Un Docker más viejo (o sin buildx) no lo tiene, y eso no es
// un fallo: la pantalla lo explica.
var ErrNoBuildx = i18n.NewCoded("no-buildx", i18n.Msg{
	ES: "este Docker no tiene el historial de builds (hace falta buildx 0.20 o más nuevo)",
	EN: "this Docker has no build history (buildx 0.20 or newer is required)",
})

// Build es un registro del historial de builds.
type Build struct {
	// Ref es lo que se le pasa a `buildx history logs`.
	Ref         string `json:"ref"`
	Name        string `json:"name"`
	Status      string `json:"status"`
	CreatedAt   string `json:"createdAt"`
	CompletedAt string `json:"completedAt"`
	// DurationMs es 0 mientras el build no terminó.
	DurationMs int64 `json:"durationMs"`
	Total      int   `json:"totalSteps"`
	Completed  int   `json:"completedSteps"`
	Cached     int   `json:"cachedSteps"`
}

// Builds lista el historial de builds, del más nuevo al más viejo.
func Builds(ctx context.Context) ([]Build, error) {
	ctx, cancel := listCtx(ctx)
	defer cancel()
	out, err := run(ctx, "buildx", "history", "ls", "--format", "json")
	if err != nil {
		// buildx viejo: «unknown command "history"» / «unknown flag». Se
		// distingue de un motor caído por el texto de Docker, que es lo único
		// que hay, y se acota a esa frase.
		msg := err.Error()
		if strings.Contains(msg, "unknown command") || strings.Contains(msg, "is not a docker command") || strings.Contains(msg, "unknown flag") {
			return nil, ErrNoBuildx
		}
		return nil, err
	}
	res := []Build{}
	err = eachJSON(out, func(raw []byte) error {
		var b struct {
			Ref         string `json:"ref"`
			Name        string `json:"name"`
			Status      string `json:"status"`
			CreatedAt   string `json:"created_at"`
			CompletedAt string `json:"completed_at"`
			Total       int    `json:"total_steps"`
			Completed   int    `json:"completed_steps"`
			Cached      int    `json:"cached_steps"`
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		// `ls` informa «builder/contexto/id», pero `logs` solo entiende el id
		// (con la ruta completa responde «no record found»).
		ref := b.Ref
		if i := strings.LastIndex(ref, "/"); i >= 0 {
			ref = ref[i+1:]
		}
		bd := Build{Ref: ref, Name: b.Name, Status: b.Status, CreatedAt: b.CreatedAt, CompletedAt: b.CompletedAt, Total: b.Total, Completed: b.Completed, Cached: b.Cached}
		if c, e1 := time.Parse(time.RFC3339Nano, b.CreatedAt); e1 == nil {
			if d, e2 := time.Parse(time.RFC3339Nano, b.CompletedAt); e2 == nil && d.After(c) {
				bd.DurationMs = d.Sub(c).Milliseconds()
			}
		}
		res = append(res, bd)
		return nil
	})
	return res, err
}

// maxViewBytes acota lo que se trae a pantalla de un build: el log de uno grande
// pesa megas, y la ventana no es lugar para leerlos enteros. La exportación a
// archivo, en cambio, no tiene tope.
const maxViewBytes = 2 << 20

// BuildLogs devuelve el log de un build para mostrarlo. Si es más largo que
// maxViewBytes devuelve el FINAL (lo último es donde está el error) y truncated.
func BuildLogs(ctx context.Context, ref string) (text string, truncated bool, err error) {
	if !validID(ref) {
		return "", false, ErrBadID
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, err := runAllRaw(ctx, "buildx", "history", "logs", ref)
	if err != nil {
		return "", false, err
	}
	if len(out) > maxViewBytes {
		out = out[len(out)-maxViewBytes:]
		// No empezar a mitad de una línea ni de un carácter.
		if i := strings.IndexByte(out, '\n'); i >= 0 {
			out = out[i+1:]
		}
		truncated = true
	}
	return out, truncated, nil
}

// runAllRaw es runAll sin recortar a las últimas líneas.
func runAllRaw(ctx context.Context, args ...string) (string, error) {
	bin := find()
	if bin == "" {
		return "", ErrNotInstalled
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	hidewin.Hide(cmd)
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+string(os.PathListSeparator)+filepath.Dir(bin))
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(buf.String()); msg != "" {
			return "", &cliError{msg: tailLines(msg, 20), err: err}
		}
		return "", err
	}
	return buf.String(), nil
}

// streamTo ejecuta `docker args…` escribiendo su stdout y stderr directamente en
// w, sin pasar por memoria: exportar el historial de un contenedor hablador son
// cientos de megas.
func streamTo(ctx context.Context, w io.Writer, args ...string) error {
	bin := find()
	if bin == "" {
		return ErrNotInstalled
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	hidewin.Hide(cmd)
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+string(os.PathListSeparator)+filepath.Dir(bin))
	var errb bytes.Buffer
	// Docker manda a stderr lo que el contenedor escribió en su stderr: es parte
	// de los logs. Pero también sus propios errores; si el comando falla, lo que
	// importa es el mensaje, que se arma al final de lo escrito.
	cmd.Stdout = w
	cmd.Stderr = io.MultiWriter(w, &limited{buf: &errb, max: 4096})
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(errb.String()); msg != "" {
			return &cliError{msg: tailLines(msg, 6), err: err}
		}
		return err
	}
	return nil
}

// limited guarda solo los últimos max bytes de lo que se le escribe.
type limited struct {
	buf *bytes.Buffer
	max int
}

func (l *limited) Write(p []byte) (int, error) {
	l.buf.Write(p)
	if l.buf.Len() > l.max {
		b := l.buf.Bytes()
		keep := append([]byte(nil), b[len(b)-l.max:]...)
		l.buf.Reset()
		l.buf.Write(keep)
	}
	return len(p), nil
}

// Límites de lo que se exporta, en líneas. El piso evita un archivo que no dice
// nada; el techo, uno de cientos de megas que el usuario no quería. La interfaz
// los aplica al escribir y el backend los vuelve a aplicar: es el backend el que
// decide cuánto se escribe a disco.
const (
	MinExportLines = 100
	MaxExportLines = 10000
)

// ClampExportLines lleva lines al rango permitido.
func ClampExportLines(lines int) int {
	if lines < MinExportLines {
		return MinExportLines
	}
	if lines > MaxExportLines {
		return MaxExportLines
	}
	return lines
}

// ExportContainerLogs escribe en w las ÚLTIMAS `lines` líneas de los logs de un
// contenedor (acotadas a 100-10000), con la hora de cada línea. A diferencia del
// panel, no está atado a lo que hay en pantalla.
func ExportContainerLogs(ctx context.Context, containerID string, lines int, w io.Writer) error {
	if !validID(containerID) {
		return ErrBadID
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	return streamTo(ctx, w, "logs", "--timestamps", "--tail", strconv.Itoa(ClampExportLines(lines)), containerID)
}

// ExportBuildLogs escribe en w las ÚLTIMAS `lines` líneas del log de un build
// (acotadas a 100-10000). `buildx history logs` no tiene --tail, así que se lee
// el log y se recorta: lo último es donde está el error.
func ExportBuildLogs(ctx context.Context, ref string, lines int, w io.Writer) error {
	if !validID(ref) {
		return ErrBadID
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	out, err := runAllRaw(ctx, "buildx", "history", "logs", ref)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, lastLines(out, ClampExportLines(lines)))
	return err
}

// lastLines deja las últimas n líneas de s (con su salto final).
func lastLines(s string, n int) string {
	s = strings.TrimRight(s, "\n")
	idx := len(s)
	for i := 0; i < n; i++ {
		j := strings.LastIndexByte(s[:idx], '\n')
		if j < 0 {
			return s + "\n"
		}
		idx = j
	}
	return s[idx+1:] + "\n"
}
