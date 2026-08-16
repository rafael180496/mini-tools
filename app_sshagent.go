package main

import (
	"fmt"
	"strings"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/sshconn"
)

// IA agéntica sobre la terminal SSH: explicar un error con el contexto del
// sistema operativo del servidor donde pasó.
//
// **Por qué el contexto del SO cambia todo acá.** Un mismo error se arregla
// distinto en SunOS, RHEL, Ubuntu y Alpine: cambian los gestores de paquetes,
// las rutas, el init, y hasta las banderas de comandos que existen en las
// cuatro. Un agente al que se le pasa solo el stacktrace contesta con el
// comando de la distribución más común de su entrenamiento, que sobre un
// Solaris de producción no existe. Pasarle `uname -a` cuesta una línea y es la
// diferencia entre una respuesta aplicable y una que hace perder diez minutos.
//
// **Lo que este archivo no hace: escribir en la terminal.** El comando que el
// agente proponga se copia o se inserta sin ejecutar. Un asistente que escribe
// y manda Enter en una sesión de producción es exactamente lo que nadie pidió.

// SSHErrorAnalysis es lo que se le devuelve a la interfaz.
type SSHErrorAnalysis struct {
	// Answer es la explicación en Markdown.
	Answer string `json:"answer"`
	// Lines son las líneas de terminal que efectivamente se le mandaron. Se
	// devuelven para que la interfaz pueda mostrarlas: lo que sale de la
	// máquina tiene que poder verse, igual que en las fichas del chat.
	Lines []string `json:"lines"`
	// OSInfo es el contexto de sistema que se adjuntó, o "" si no se pudo
	// averiguar (una sesión recién abierta que todavía no imprimió nada).
	OSInfo string `json:"osInfo"`
	// Redacted es cuántos valores se ocultaron por parecer secretos (una
	// contraseña en la línea de comandos, un token en una cabecera). Se informa
	// para que la redacción no sea invisible: si el agente contesta algo raro,
	// hay que poder saber que le faltaba un dato.
	Redacted int `json:"redacted"`
}

// AnalyzeSSHError le pide al agente que explique un error de la terminal.
//
// `selection` es lo que el usuario marcó en pantalla; si viene vacío se usan
// las últimas líneas del buffer, que es el caso de "acaba de fallar algo".
func (a *App) AnalyzeSSHError(connID, selection string, lines int) (SSHErrorAnalysis, error) {
	if err := a.requireUnlocked(); err != nil {
		return SSHErrorAnalysis{}, err
	}
	if !a.sshSessions.HasSession(connID) {
		return SSHErrorAnalysis{}, fmt.Errorf("app: no hay ninguna terminal abierta para esa conexión")
	}

	conn, err := a.connByNameOrID(connID)
	if err != nil {
		return SSHErrorAnalysis{}, err
	}

	out := SSHErrorAnalysis{}
	if strings.TrimSpace(selection) != "" {
		// Lo seleccionado a mano se redacta igual: que el usuario haya marcado
		// el texto no lo convierte en algo que quiera mandar entero.
		out.Lines, out.Redacted = redactSelection(selection)
	} else {
		out.Lines, out.Redacted = a.sshSessions.TailRedacted(connID, lines)
	}
	if len(out.Lines) == 0 {
		return out, fmt.Errorf("app: la terminal todavía no imprimió nada que analizar")
	}

	out.OSInfo = a.sshOSInfo(connID)

	answer, err := a.AgentAsk(
		agentctx.SSHErrorPrompt(conn.Name, out.OSInfo, strings.Join(out.Lines, "\n")),
		"ssh", connID,
	)
	if err != nil {
		return out, err
	}
	out.Answer = answer
	return out, nil
}

// sshOSInfo devuelve el contexto de sistema de una sesión abierta.
//
// **Se deduce de lo que la terminal ya imprimió, no ejecutando nada.** Correr
// `uname -a` por nuestra cuenta significaría escribir en la sesión interactiva
// del usuario: aparecería en su pantalla, ensuciaría su historial y, si lo
// hiciera en el medio de un `vi` abierto, sería un desastre. Si el banner de
// login o un `uname` que el usuario ya corrió lo dicen, se usa; si no, se
// informa vacío y el prompt lo dice.
func (a *App) sshOSInfo(connID string) string {
	lines := a.sshSessions.Tail(connID, maxScrollbackScan)
	var hits []string
	for _, l := range lines {
		low := strings.ToLower(l)
		switch {
		case strings.Contains(low, "sunos"), strings.Contains(low, "solaris"),
			strings.Contains(low, "linux "), strings.Contains(low, "darwin "),
			strings.Contains(low, "red hat"), strings.Contains(low, "centos"),
			strings.Contains(low, "ubuntu"), strings.Contains(low, "debian"),
			strings.Contains(low, "alpine"), strings.Contains(low, "aix"):
			t := strings.TrimSpace(l)
			if t != "" && len(t) < 200 {
				hits = append(hits, t)
			}
		}
	}
	if len(hits) == 0 {
		return ""
	}
	// La primera coincidencia suele ser el banner de login, que es la más
	// confiable: las de más abajo pueden venir del contenido de un log.
	if len(hits) > 3 {
		hits = hits[:3]
	}
	return strings.Join(hits, "\n")
}

// maxScrollbackScan es cuántas líneas se miran para deducir el sistema
// operativo. El banner de login está al principio de la sesión, así que hay que
// mirar bastante hacia atrás.
const maxScrollbackScan = 500

// SSHTail devuelve las últimas líneas de una terminal abierta.
//
// Lo usa el resolvedor `@ssh:` y el botón de análisis. **No hay ninguna forma
// de pedir el buffer de una sesión que no esté abierta**: el buffer vive con la
// sesión y se va con ella.
func (a *App) SSHTail(connID string, lines int) ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	if !a.sshSessions.HasSession(connID) {
		return nil, fmt.Errorf("app: no hay ninguna terminal abierta para esa conexión")
	}
	out := a.sshSessions.Tail(connID, lines)
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// SSHCwd devuelve el directorio de trabajo de una terminal SSH, o "" si no se
// pudo saber.
//
// **Se sabe solo si la shell del servidor lo informa** (secuencia OSC 7, la
// que emiten las shells modernas en cada prompt y la que usan iTerm2, WezTerm
// y VS Code para esto mismo). No se ejecuta nada para averiguarlo: correr
// `pwd` escribiría en la sesión interactiva del usuario, y adivinarlo del
// prompt es adivinar — el prompt lo define él, no es un contrato.
//
// Vacío significa "no se sabe", y la interfaz lo dice así en vez de mostrar un
// directorio inventado. Ver backend/sshconn/scrollback.go.
func (a *App) SSHCwd(connID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return a.sshSessions.Cwd(connID), nil
}

// redactSelection aplica la misma redacción a un texto seleccionado a mano.
//
// Pasa por el mismo camino que el buffer —`TailRedacted` sobre una sesión
// falsa no existe, así que se reusa el paquete— para que no haya dos criterios
// de qué es un secreto.
func redactSelection(text string) ([]string, int) {
	return sshconn.RedactLines(strings.Split(strings.TrimRight(text, "\n"), "\n"))
}
