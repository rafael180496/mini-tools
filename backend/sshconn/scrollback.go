package sshconn

import (
	"strings"
	"sync"
)

// Buffer de salida de la terminal: las últimas líneas que imprimió el shell
// remoto, para poder mostrárselas a un agente cuando algo falla.
//
// **Por qué hace falta y por qué no estaba.** Hasta ahora la salida se
// streameaba al frontend y se olvidaba: los bytes iban a xterm.js, que los
// dibuja, y el backend no guardaba nada. Eso alcanzaba mientras la terminal
// fuera solo para mirar; deja de alcanzar en cuanto se quiere decir "explicá
// este error", porque el error ya pasó y el backend no lo tiene.
//
// **Qué guarda y qué no.** Un anillo de líneas, acotado. No es un registro:
// vive en memoria, se pierde al cerrar la sesión y no se escribe en ningún
// lado — la regla 10 de .claude/rules/technical.md prohíbe loguear resultados,
// y la salida de una terminal es exactamente eso, con contraseñas escritas a
// mano incluidas cuando alguien se equivoca de campo.
//
// **Los escapes ANSI se sacan al guardar.** Lo que se va a mandar a un agente
// tiene que ser texto: los códigos de color multiplican el tamaño, no aportan
// nada y en un buffer de 500 líneas son la mayor parte de los bytes.

// maxScrollbackLines es cuántas líneas retiene cada sesión.
//
// 500 es suficiente para un stacktrace de Java, un `tail` largo o la salida de
// un `systemctl status`, y a la vez es un techo firme: una terminal que corre
// un `find /` durante una hora no puede hacer crecer la memoria de la app sin
// límite.
const maxScrollbackLines = 500

// maxLineRunes corta una línea absurdamente larga (una que imprime un archivo
// binario, por ejemplo) en vez de retenerla entera.
const maxLineRunes = 4000

// scrollback es un anillo de líneas por sesión.
type scrollback struct {
	mu sync.Mutex
	// lines es el anillo ya cerrado (líneas completas).
	lines []string
	// partial es lo que llegó después del último salto de línea y todavía no
	// terminó: la salida llega por bloques arbitrarios, no por líneas.
	partial string
	// cwd es el directorio de trabajo que la shell remota informó por su
	// cuenta, vía la secuencia OSC 7 — ver parseOSC7.
	cwd string
}

func newScrollback() *scrollback {
	return &scrollback{lines: make([]string, 0, maxScrollbackLines)}
}

// write agrega un bloque de salida tal cual llegó del shell.
func (s *scrollback) write(chunk string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	clean, cwd := stripANSI(chunk)
	if cwd != "" {
		s.cwd = cwd
	}
	s.partial += clean
	for {
		i := strings.IndexAny(s.partial, "\r\n")
		if i < 0 {
			break
		}
		line := s.partial[:i]
		// \r\n cuenta como un solo corte.
		if s.partial[i] == '\r' && i+1 < len(s.partial) && s.partial[i+1] == '\n' {
			i++
		}
		s.partial = s.partial[i+1:]
		s.push(line)
	}
	// Una línea que nunca termina (una barra de progreso que solo usa \r ya
	// quedó cortada arriba; esto es para un prompt sin salto) igual se acota.
	if len([]rune(s.partial)) > maxLineRunes {
		s.push(s.partial)
		s.partial = ""
	}
}

func (s *scrollback) push(line string) {
	if r := []rune(line); len(r) > maxLineRunes {
		line = string(r[:maxLineRunes]) + "…"
	}
	if len(s.lines) >= maxScrollbackLines {
		// Se descarta la más vieja moviendo el resto: con 500 elementos el
		// copy es irrelevante y evita el índice de escritura de un anillo real,
		// que es lo que se lee mal después.
		copy(s.lines, s.lines[1:])
		s.lines = s.lines[:len(s.lines)-1]
	}
	s.lines = append(s.lines, line)
}

// tail devuelve las últimas n líneas, más lo que haya sin terminar.
func (s *scrollback) tail(n int) []string {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if n <= 0 || n > maxScrollbackLines {
		n = 50
	}
	out := make([]string, 0, n+1)
	from := len(s.lines) - n
	if from < 0 {
		from = 0
	}
	out = append(out, s.lines[from:]...)
	if strings.TrimSpace(s.partial) != "" {
		out = append(out, s.partial)
	}
	return out
}

// stripANSI saca las secuencias de escape que colorean y mueven el cursor, y
// de paso devuelve el directorio de trabajo si la shell lo informó.
//
// Escrito a mano y acotado a lo que aparece en una terminal real: CSI
// (`ESC [ … letra`), OSC (`ESC ] … BEL` o `ESC \`) y los escapes de dos
// caracteres. No pretende ser un emulador de terminal — para eso está xterm.js
// del otro lado; acá solo hay que dejar el texto legible.
//
// **OSC 7 es cómo se sabe en qué directorio está la shell sin preguntarle.**
// Es la secuencia que las shells modernas emiten en cada prompt
// (`ESC ] 7 ; file://host/ruta BEL`) y la que usan iTerm2, WezTerm y VS Code
// para lo mismo. Se lee al pasar, sin costo.
//
// Las tres alternativas se descartaron: parsear el prompt es adivinar (el
// prompt lo define el usuario, no es un contrato); leer `/proc/<pid>/cwd` no
// existe en SunOS ni en AIX, que son justamente los servidores donde esto
// haría más falta; y correr `pwd` en la sesión **escribiría en la terminal
// interactiva del usuario** — aparecería en su pantalla, ensuciaría su
// historial y, dentro de un editor abierto, sería un desastre. Es la misma
// regla que ya se respeta para deducir el sistema operativo.
//
// Cuando la shell no emite OSC 7 —lo habitual en un servidor sin configurar—
// el directorio queda vacío y la interfaz lo dice, en vez de mostrar uno
// inventado.
func stripANSI(s string) (string, string) {
	if !strings.ContainsRune(s, 0x1b) {
		return s, ""
	}
	cwd := ""
	var b strings.Builder
	b.Grow(len(s))
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r != 0x1b {
			// El backspace se aplica en vez de guardarse: una terminal lo usa
			// para reescribir, y dejarlo haría que el texto guardado no se
			// parezca a lo que se vio en pantalla.
			if r == '\b' {
				cur := b.String()
				if len(cur) > 0 {
					cr := []rune(cur)
					b.Reset()
					b.WriteString(string(cr[:len(cr)-1]))
				}
				continue
			}
			b.WriteRune(r)
			continue
		}
		if i+1 >= len(runes) {
			break
		}
		switch runes[i+1] {
		case '[':
			// CSI: termina en una letra ASCII.
			i += 2
			for i < len(runes) && !((runes[i] >= 'A' && runes[i] <= 'Z') || (runes[i] >= 'a' && runes[i] <= 'z')) {
				i++
			}
		case ']':
			// OSC: termina en BEL o en ESC \. Se retiene el contenido para
			// poder leer el OSC 7 antes de descartarlo.
			start := i + 2
			i += 2
			for i < len(runes) && runes[i] != 0x07 {
				if runes[i] == 0x1b && i+1 < len(runes) && runes[i+1] == '\\' {
					i++
					break
				}
				i++
			}
			if end := i; end > start && end <= len(runes) {
				if p := parseOSC7(string(runes[start:end])); p != "" {
					cwd = p
				}
			}
		default:
			i++
		}
	}
	return b.String(), cwd
}

// parseOSC7 saca la ruta de una secuencia `7;file://host/ruta`.
//
// El host se ignora a propósito: en una sesión SSH siempre es el servidor
// remoto, y compararlo contra el alias de la conexión fallaría cada vez que el
// hostname configurado no coincide con el nombre que le pusimos nosotros.
func parseOSC7(body string) string {
	if !strings.HasPrefix(body, "7;") {
		return ""
	}
	u := strings.TrimPrefix(body, "7;")
	i := strings.Index(u, "://")
	if i < 0 {
		return ""
	}
	rest := u[i+3:]
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return ""
	}
	path := rest[slash:]
	// Los caracteres escapados de una URL (%20 en un nombre con espacios) se
	// resuelven a mano: son los únicos que aparecen en una ruta y traer
	// net/url para eso sería sumar un import por tres líneas.
	return unescapePath(path)
}

func unescapePath(p string) string {
	if !strings.ContainsRune(p, '%') {
		return p
	}
	var b strings.Builder
	for i := 0; i < len(p); i++ {
		if p[i] == '%' && i+2 < len(p) {
			hi, ok1 := hexVal(p[i+1])
			lo, ok2 := hexVal(p[i+2])
			if ok1 && ok2 {
				b.WriteByte(hi<<4 | lo)
				i += 2
				continue
			}
		}
		b.WriteByte(p[i])
	}
	return b.String()
}

func hexVal(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// Cwd devuelve el directorio de trabajo que la shell de connID informó por
// OSC 7, o "" si nunca lo informó. Ver stripANSI para por qué no se pregunta.
func (m *SessionManager) Cwd(connID string) string {
	s := m.get(connID)
	if s == nil || s.scroll == nil {
		return ""
	}
	s.scroll.mu.Lock()
	defer s.scroll.mu.Unlock()
	return s.scroll.cwd
}

// Tail devuelve las últimas n líneas de la terminal de connID, **con los
// secretos evidentes redactados**.
//
// Este método es el que alimenta todo lo que ve un agente (el análisis de
// errores, `@ssh:` y la herramienta MCP), y por eso la redacción va acá y no en
// cada llamador: agregar un camino nuevo hacia un agente no puede ser la
// oportunidad de olvidarse de redactar. La terminal que ve el usuario no pasa
// por acá — esa recibe el stream en vivo, sin tocar.
//
// Vacío cuando no hay sesión abierta: no es un error, es que no hay nada que
// leer. Que una terminal cerrada no tenga historial es correcto — el buffer
// vive con la sesión.
func (m *SessionManager) Tail(connID string, lines int) []string {
	out, _ := m.TailRedacted(connID, lines)
	return out
}

// TailRedacted devuelve además cuántos valores se ocultaron, para poder
// decírselo al usuario en vez de que la redacción sea invisible.
func (m *SessionManager) TailRedacted(connID string, lines int) ([]string, int) {
	s := m.get(connID)
	if s == nil {
		return nil, 0
	}
	return redactSecrets(s.scroll.tail(lines))
}

// HasSession informa si hay una terminal abierta para connID, para poder
// distinguir "no hay nada" de "no está conectado".
func (m *SessionManager) HasSession(connID string) bool {
	return m.get(connID) != nil
}
