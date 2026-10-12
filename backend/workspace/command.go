package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"mini-tools/backend/agents"
	"mini-tools/backend/i18n"
	"mini-tools/backend/localterm"
)

// envAllow son las variables del proceso que se le dejan ver a un comando.
//
// **Lista blanca, no `agents.Env()`.** Ese entorno es el del proceso entero
// (lo que necesita un CLI para encontrar su sesión) y acá el que manda el
// comando es un texto generado por un modelo —quizá en otra máquina—: heredar
// todo le daría de gratis lo que haya en el entorno de la app, que es donde
// vive cualquier token que el usuario haya exportado (GITHUB_TOKEN,
// AWS_SECRET_ACCESS_KEY, la API key de un agente…). Con la lista, un comando
// ve lo mínimo para funcionar: dónde está el home, el idioma, la zona horaria
// y el PATH.
//
// Lo que NO es un secreto pero tampoco se hereda: SSH_AUTH_SOCK. Un `git push`
// por ssh dentro de run_command falla por eso; es el costo de no prestarle al
// modelo el agente de claves del usuario, y `git push` pregunta igual.
var envAllow = map[string]bool{
	"HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "LANG": true, "LANGUAGE": true,
	"TZ": true, "TMPDIR": true,
	// Windows: sin estas, casi ningún programa arranca.
	"SYSTEMROOT": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true, "USERPROFILE": true,
	"APPDATA": true, "LOCALAPPDATA": true, "TEMP": true, "TMP": true, "PROGRAMFILES": true,
	"PROGRAMFILES(X86)": true, "PROGRAMDATA": true, "HOMEDRIVE": true, "HOMEPATH": true,
	"USERNAME": true, "OS": true, "NUMBER_OF_PROCESSORS": true, "PROCESSOR_ARCHITECTURE": true,
}

// env arma el entorno de un comando. Ver envAllow.
func env() []string {
	out := []string{"PATH=" + agents.PathEnv()}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		uk := strings.ToUpper(k)
		if envAllow[uk] || strings.HasPrefix(uk, "LC_") {
			out = append(out, kv)
		}
	}
	return append(out,
		// Un comando no tiene terminal ni nadie que conteste.
		"TERM=dumb", "NO_COLOR=1", "PAGER=cat", "GIT_PAGER=cat", "GIT_TERMINAL_PROMPT=0",
	)
}

// shellArgv arma cómo se invoca el shell para UN comando. Los shells Unix
// conservan el `-l` con el que los lanza la terminal: una app abierta desde el
// Dock hereda un PATH mínimo y sin leer el perfil no encontraría git ni node.
func shellArgv(sh localterm.Shell, command string) []string {
	switch sh.ID {
	case "pwsh", "powershell":
		return []string{sh.Path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command}
	case "cmd":
		return []string{sh.Path, "/d", "/s", "/c", command}
	case "gitbash":
		return []string{sh.Path, "-c", command}
	case "wsl":
		return []string{sh.Path, "sh", "-c", command}
	}
	argv := []string{sh.Path}
	argv = append(argv, sh.Args...)
	return append(argv, "-c", command)
}

func (w *Workspace) runCommand(ctx context.Context, args map[string]any) (string, error) {
	command := strings.TrimSpace(strArg(args, "command"))
	if command == "" {
		return "", missing("command")
	}
	timeout := w.opts.CommandTimeout
	if secs := intArg(args, "timeout_seconds", 0); secs > 0 {
		timeout = time.Duration(secs) * time.Second
	}
	if timeout > maxCommandTimeout {
		timeout = maxCommandTimeout
	}

	sh, ok := localterm.ResolveShell(w.opts.ShellID)
	if !ok {
		return "", i18n.Errorf(i18n.Msg{ES: "no hay ningún shell disponible para ejecutar comandos", EN: "there is no shell available to run commands"})
	}
	argv := shellArgv(sh, command)

	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(tctx, argv[0], argv[1:]...)
	cmd.Dir = w.root
	cmd.Env = env()
	// Sin stdin: un comando que pregunta algo recibe EOF en vez de colgarse.
	cmd.Stdin = nil
	out := newCapWriter(MaxCommandOutput)
	cmd.Stdout, cmd.Stderr = out, out
	setupProc(cmd)
	// Los nietos pueden quedarse con el pipe abierto después de matar al hijo;
	// sin esto Wait esperaría para siempre.
	cmd.WaitDelay = 3 * time.Second

	runErr := cmd.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	text := out.String()
	if strings.TrimSpace(text) == "" {
		text = i18n.T(i18n.Msg{ES: "(sin salida)", EN: "(no output)"})
	}
	switch {
	case errors.Is(tctx.Err(), context.DeadlineExceeded):
		return text + "\n" + i18n.T(i18n.Msg{
			ES: "[se agotó el tiempo (%s) y el comando se cortó]",
			EN: "[timed out (%s) and the command was killed]",
		}, timeout), nil
	case runErr == nil:
		return text + "\n[exit code: 0]", nil
	}
	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		return text + fmt.Sprintf("\n[exit code: %d]", ee.ExitCode()), nil
	}
	return "", i18n.Errorf(i18n.Msg{ES: "no se pudo ejecutar el comando: %w", EN: "could not run the command: %w"}, runErr)
}

// capWriter se queda con el principio y el final de la salida. Lo importante
// de un comando que falla suele estar al final (el error del compilador, el
// resumen del test) y el contexto del principio dice qué corrió: lo del medio
// es lo que se sacrifica.
type capWriter struct {
	mu       sync.Mutex
	headMax  int
	tailMax  int
	head     []byte
	tail     []byte
	total    int64
	overflow bool
}

func newCapWriter(max int) *capWriter {
	return &capWriter{headMax: max / 3, tailMax: max - max/3}
}

func (c *capWriter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))
	rest := p
	if room := c.headMax - len(c.head); room > 0 {
		n := min(room, len(rest))
		c.head = append(c.head, rest[:n]...)
		rest = rest[n:]
	}
	if len(rest) > 0 {
		c.tail = append(c.tail, rest...)
		if len(c.tail) > c.tailMax*2 {
			c.tail = append([]byte(nil), c.tail[len(c.tail)-c.tailMax:]...)
			c.overflow = true
		}
	}
	return len(p), nil
}

func (c *capWriter) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	head, tail := c.head, c.tail
	if len(tail) > c.tailMax {
		tail = tail[len(tail)-c.tailMax:]
		c.overflow = true
	}
	if !c.overflow {
		return strings.ToValidUTF8(string(head)+string(tail), "�")
	}
	// Cortar en un carácter entero: un byte suelto no es texto.
	for len(tail) > 0 && !utf8.RuneStart(tail[0]) {
		tail = tail[1:]
	}
	omitted := c.total - int64(len(head)) - int64(len(tail))
	return strings.ToValidUTF8(string(head), "�") +
		"\n" + i18n.T(i18n.Msg{ES: "[… %d bytes omitidos …]", EN: "[… %d bytes omitted …]"}, omitted) + "\n" +
		strings.ToValidUTF8(string(tail), "�")
}
