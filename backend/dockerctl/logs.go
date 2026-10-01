package dockerctl

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"mini-tools/backend/hidewin"
)

// LogEvent es lo que llega a la interfaz por el evento de la sesión: un lote de
// líneas, o el cierre del flujo (con su error, si lo hubo).
type LogEvent struct {
	Lines []string `json:"lines"`
	End   bool     `json:"end"`
	Error string   `json:"error"`
}

// EmitFunc es el contrato de «un evento de Wails por sesión» que usa el resto
// de la app (terminales, consultas).
type EmitFunc func(event string, data interface{})

const (
	// maxTail acota cuántas líneas viejas se piden al abrir.
	maxTail = 10000
	// flushEvery agrupa líneas: un contenedor hablador emite miles por segundo y
	// un evento por línea ahogaría a la interfaz.
	flushEvery = 100 * time.Millisecond
	flushLines = 500
)

// LogStreams administra los `docker logs -f` abiertos. Su valor cero sirve.
// Cada flujo es un proceso hijo que existe mientras alguien mira ese panel:
// Stop (o CloseAll al cerrar la app) lo termina.
type LogStreams struct {
	mu      sync.Mutex
	streams map[string]context.CancelFunc
}

// Start abre el flujo de logs de containerID bajo el evento sessionID. Una
// sesión con el mismo id reemplaza a la anterior.
func (s *LogStreams) Start(sessionID, containerID string, tail int, emit EmitFunc) error {
	if sessionID == "" || !validID(containerID) {
		return ErrBadID
	}
	bin := find()
	if bin == "" {
		return ErrNotInstalled
	}
	if tail < 1 {
		tail = 500
	}
	if tail > maxTail {
		tail = maxTail
	}

	ctx, cancel := context.WithCancel(context.Background())
	// --timestamps: la interfaz decide si los muestra; pedirlos siempre evita
	// reabrir el flujo para encenderlos.
	cmd := exec.CommandContext(ctx, bin, "logs", "--follow", "--timestamps", "--tail", strconv.Itoa(tail), containerID)
	hidewin.Hide(cmd)
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+string(os.PathListSeparator)+filepath.Dir(bin))
	// stdout y stderr del contenedor llegan por canales distintos de la CLI;
	// juntos en una tubería salen en el orden en que se escribieron.
	pr, pw, err := os.Pipe()
	if err != nil {
		cancel()
		return err
	}
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		cancel()
		pr.Close()
		pw.Close()
		return err
	}
	pw.Close() // el hijo conserva su copia; acá no se escribe

	s.mu.Lock()
	if s.streams == nil {
		s.streams = map[string]context.CancelFunc{}
	}
	if old, ok := s.streams[sessionID]; ok {
		old()
	}
	s.streams[sessionID] = cancel
	s.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			pr.Close()
			s.mu.Lock()
			// Solo se desregistra si sigue siendo ESTA sesión: una que la
			// reemplazó ya puso su propio cancel.
			delete(s.streams, sessionID)
			s.mu.Unlock()
		}()
		pump(ctx, pr, emit, sessionID)
		waitErr := cmd.Wait()
		ev := LogEvent{End: true}
		// Cancelar (cerrar el panel) no es un error del flujo.
		if ctx.Err() == nil && waitErr != nil {
			ev.Error = waitErr.Error()
		}
		emit(sessionID, ev)
	}()
	return nil
}

// pump lee líneas y las manda en lotes. Un hilo lee y el principal agrupa por
// tiempo o por cantidad, para que ni un contenedor mudo retenga la última línea
// ni uno hablador dispare un evento por cada una.
func pump(ctx context.Context, r io.Reader, emit EmitFunc, sessionID string) {
	lines := make(chan string, 1024)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for sc.Scan() {
			select {
			case lines <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
	}()

	var batch []string
	flush := func() {
		if len(batch) > 0 {
			emit(sessionID, LogEvent{Lines: batch})
			batch = nil
		}
	}
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				flush()
				return
			}
			batch = append(batch, l)
			if len(batch) >= flushLines {
				flush()
			}
		case <-tick.C:
			flush()
		case <-ctx.Done():
			return
		}
	}
}

// Stop termina el flujo de sessionID, si existe.
func (s *LogStreams) Stop(sessionID string) {
	s.mu.Lock()
	cancel := s.streams[sessionID]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// CloseAll termina todos los flujos. Se llama al cerrar la app: sin esto los
// `docker logs -f` quedarían huérfanos.
func (s *LogStreams) CloseAll() {
	s.mu.Lock()
	all := s.streams
	s.streams = nil
	s.mu.Unlock()
	for _, cancel := range all {
		cancel()
	}
}
