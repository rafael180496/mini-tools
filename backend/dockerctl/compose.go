package dockerctl

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"mini-tools/backend/hidewin"
	"mini-tools/backend/i18n"
)

var (
	ErrBadProject = i18n.NewCoded("bad-project", i18n.Msg{
		ES: "nombre de proyecto de Compose inválido",
		EN: "invalid Compose project name",
	})
	ErrNoProject = i18n.NewCoded("no-project", i18n.Msg{
		ES: "ese proyecto de Compose ya no tiene contenedores: no hay de dónde leer sus archivos",
		EN: "that Compose project has no containers left: there's nowhere to read its files from",
	})
	ErrBadComposeFile = i18n.NewCoded("bad-compose-file", i18n.Msg{
		ES: "no es un archivo de Compose válido (se espera un .yml o .yaml que exista)",
		EN: "not a valid Compose file (an existing .yml or .yaml is expected)",
	})
)

// projectRe es lo que Compose acepta como nombre de proyecto.
var projectRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// composeOps son las operaciones sobre un proyecto, de una lista cerrada. La
// interfaz manda el nombre, nunca los argumentos.
//
//	up      crea o recrea lo que haga falta y lo deja andando (`up -d`)
//	down    para y ELIMINA contenedores y redes del proyecto; los volúmenes se
//	        conservan (sin `-v`, a propósito)
var composeOps = map[string][]string{
	"up":      {"up", "-d"},
	"down":    {"down"},
	"stop":    {"stop"},
	"start":   {"start"},
	"restart": {"restart"},
}

// composeTimeout: `up` puede descargar imágenes y construir, que tarda minutos;
// el resto es cuestión de segundos.
func composeTimeout(op string) time.Duration {
	if op == "up" {
		return 15 * time.Minute
	}
	return 3 * time.Minute
}

// runAll es run pero devolviendo stdout y stderr juntos: Compose escribe su
// progreso («Container x Started») en stderr, y es lo que se quiere mostrar.
func runAll(ctx context.Context, args ...string) (string, error) {
	bin := find()
	if bin == "" {
		return "", ErrNotInstalled
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	hidewin.Hide(cmd)
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+string(os.PathListSeparator)+filepath.Dir(bin))
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	out := tailLines(buf.String(), 40)
	if err != nil {
		if out != "" {
			return out, &cliError{msg: out, err: err}
		}
		return out, err
	}
	return out, nil
}

// tailLines deja las últimas n líneas: un `up` que descarga imágenes escribe
// cientos de líneas de progreso y lo que importa es cómo terminó.
func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// Compose ejecuta op sobre el proyecto, usando los archivos con los que se lo
// levantó. Esos archivos se leen de las etiquetas de sus propios contenedores,
// no los manda la interfaz: así no se le puede pedir a Compose que corra un
// archivo cualquiera, solo volver a operar lo que ya existe.
func Compose(ctx context.Context, op, project string) (string, error) {
	args, ok := composeOps[op]
	if !ok {
		return "", ErrBadOp
	}
	if !projectRe.MatchString(project) {
		return "", ErrBadProject
	}

	list, err := Containers(ctx)
	if err != nil {
		return "", err
	}
	var wd, files string
	for _, c := range list {
		if c.Project == project && c.ConfigFiles != "" {
			wd, files = c.WorkingDir, c.ConfigFiles
			break
		}
	}
	if files == "" {
		return "", ErrNoProject
	}

	cmdArgs := []string{"compose", "-p", project}
	if wd != "" {
		cmdArgs = append(cmdArgs, "--project-directory", wd)
	}
	for _, f := range strings.Split(files, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		// Un archivo que se movió o borró: Compose lo diría con un error
		// largo; acá se dice cuál es.
		if _, err := os.Stat(f); err != nil {
			return "", i18n.Errorf(i18n.Msg{
				ES: "no se encuentra el archivo de Compose %s: ¿se movió o se borró?",
				EN: "the Compose file %s can't be found: was it moved or deleted?",
			}, f)
		}
		cmdArgs = append(cmdArgs, "-f", f)
	}
	cmdArgs = append(cmdArgs, args...)

	ctx, cancel := context.WithTimeout(ctx, composeTimeout(op))
	defer cancel()
	return runAll(ctx, cmdArgs...)
}

// ComposeUpFile levanta un proyecto NUEVO desde un archivo de Compose elegido
// por el usuario (`docker compose -f archivo up -d`). El nombre del proyecto
// sale del directorio del archivo, como hace Compose por su cuenta.
func ComposeUpFile(ctx context.Context, path string) (string, error) {
	ext := strings.ToLower(filepath.Ext(path))
	if (ext != ".yml" && ext != ".yaml") || !filepath.IsAbs(path) {
		return "", ErrBadComposeFile
	}
	if fi, err := os.Stat(path); err != nil || fi.IsDir() {
		return "", ErrBadComposeFile
	}
	ctx, cancel := context.WithTimeout(ctx, composeTimeout("up"))
	defer cancel()
	return runAll(ctx, "compose", "--project-directory", filepath.Dir(path), "-f", path, "up", "-d")
}
