package git

import (
	"context"
	"strconv"
	"strings"
)

// El reflog: el registro local de por dónde estuvo HEAD.
//
// **Por qué este módulo existe.** El resto de la pestaña Git ya sabe hacer las
// operaciones que borran trabajo — `reset --hard`, rebase, cambiar de rama con
// cambios encima, `push --force`. El reflog es la red debajo de todas ellas: el
// commit que "desapareció" sigue estando, y esto es lo único que lo encuentra.
// Sin esta vista, la única salida de un reset equivocado es la línea de
// comandos, que es exactamente de lo que el módulo pretende sacar al usuario.
//
// **Es local y caduca.** No se clona, no se empuja, y git lo poda solo (90 días
// los alcanzables, 30 los que no). Eso se dice en la interfaz: creer que el
// reflog es un historial permanente es la forma de perder algo de verdad.

// ReflogEntry es un movimiento de HEAD.
type ReflogEntry struct {
	// Selector es cómo se nombra esa posición en un comando: `HEAD@{3}`. Es lo
	// que se le pasa a checkout/branch/reset, y lo que hay que poder copiar.
	Selector string `json:"selector"`
	Hash     string `json:"hash"`
	Short    string `json:"short"`
	// Action es lo que hizo git ("commit", "reset", "rebase (finish)",
	// "checkout"), ya separado del detalle: es por lo que uno busca cuando
	// quiere encontrar "el reset de recién".
	Action string `json:"action"`
	// Detail es el resto del mensaje del reflog ("moving to HEAD~2",
	// "from main to feature/x").
	Detail string `json:"detail"`
	// Subject es el título del commit al que apunta la entrada, que es lo que
	// de verdad permite reconocerlo.
	Subject string `json:"subject"`
	Author  string `json:"author"`
	// Date es la del MOVIMIENTO, no la del commit: dos entradas pueden apuntar
	// al mismo commit en momentos distintos, y lo que se busca es "hace diez
	// minutos", no "cuándo se escribió".
	Date string `json:"date"`
}

// reflogFormat: un movimiento por registro, con los mismos separadores de
// control que el log — un mensaje de commit puede contener cualquier cosa
// imprimible, incluido el delimitador que parecía seguro.
// `%gD` va con `--date=iso-strict`, así que rinde `HEAD@{2026-08-20T16:10:20-06:00}`:
// de ahí sale la FECHA del movimiento. El selector `HEAD@{n}` no se pide a git
// —esa misma bandera lo reescribe— sino que se arma con la posición, que es lo
// que significa: git devuelve el reflog en orden, 0 es el movimiento más
// reciente.
//
// No hay marcador propio para la fecha del reflog (`%gI` no existe; se probó y
// git lo imprime literal). Sacarla de las llaves del selector es el camino que
// queda, y es determinista.
const reflogFormat = recordSep +
	"%gD" + fieldSep +
	"%H" + fieldSep +
	"%h" + fieldSep +
	"%gs" + fieldSep +
	"%s" + fieldSep +
	"%an" + fieldSep

// Reflog devuelve los últimos movimientos de HEAD.
//
// limit acota de verdad: un repositorio con meses de trabajo tiene miles de
// entradas y ninguna interfaz las muestra. Cero toma un valor por defecto en
// vez de traerlas todas.
func (r *Runner) Reflog(repoPath string, limit int) ([]ReflogEntry, error) {
	if limit <= 0 {
		limit = 200
	}
	// SIN `--date`: esa bandera también reescribe `%gD`, y el selector sale
	// como `HEAD@{2026-08-20T16:10:20-06:00}` en vez de `HEAD@{0}`. Las dos
	// formas son válidas para git, pero la de fecha significa otra cosa
	// —"donde estaba HEAD en ese instante"— y es la que no sirve para copiar y
	// pegar. La fecha del movimiento viene igual por `%gI`, que ya es ISO.
	out, err := r.run(context.Background(), repoPath,
		"reflog", "--date=iso-strict", "--max-count="+strconv.Itoa(limit), "--format="+reflogFormat)
	if err != nil {
		// Un repositorio recién iniciado no tiene reflog todavía. No es un
		// error que valga la pena mostrar: es una lista vacía.
		if strings.Contains(err.Error(), "does not have any commits yet") {
			return []ReflogEntry{}, nil
		}
		return nil, err
	}

	entries := []ReflogEntry{}
	for _, chunk := range strings.Split(out, recordSep) {
		if strings.TrimSpace(chunk) == "" {
			continue
		}
		f := strings.Split(chunk, fieldSep)
		if len(f) < 6 {
			continue
		}
		action, detail := splitReflogSubject(f[3])
		subject := strings.TrimSpace(f[4])
		// `commit: <asunto>` y `commit (initial): <asunto>` repiten el asunto
		// dentro del detalle, y la interfaz ya lo muestra en su columna. Se
		// quita del final para que quede lo que de verdad distingue —nada en
		// el primer caso, `(initial)` en el segundo— en vez de dos veces la
		// misma frase por fila.
		detail = trimSubjectTail(detail, subject)
		entries = append(entries, ReflogEntry{
			Selector: "HEAD@{" + strconv.Itoa(len(entries)) + "}",
			Hash:     strings.TrimSpace(f[1]),
			Short:    strings.TrimSpace(f[2]),
			Action:   action,
			Detail:   detail,
			Subject:  subject,
			Author:   strings.TrimSpace(f[5]),
			Date:     dateFromSelector(f[0]),
		})
	}
	return entries, nil
}

// splitReflogSubject parte "reset: moving to HEAD~2" en acción y detalle.
//
// git separa las dos partes con ": " en casi todas sus entradas, pero no en
// todas: un commit normal dice solo "commit", y un merge dice
// "merge feature/x: Fast-forward" —donde lo de antes de los dos puntos ya trae
// el detalle adentro—. Por eso se parte por el PRIMER espacio o dos puntos, lo
// que venga antes, y no se intenta normalizar más: el texto crudo de git es más
// informativo que cualquier taxonomía que inventemos acá.
func splitReflogSubject(subject string) (action, detail string) {
	subject = strings.TrimSpace(subject)
	if subject == "" {
		return "", ""
	}
	colon := strings.Index(subject, ":")
	space := strings.Index(subject, " ")
	cut := colon
	if colon < 0 || (space >= 0 && space < colon) {
		cut = space
	}
	if cut < 0 {
		return subject, ""
	}
	return strings.TrimSpace(subject[:cut]), strings.TrimSpace(strings.TrimPrefix(subject[cut:], ":"))
}

// dateFromSelector saca la fecha de `HEAD@{2026-08-20T16:10:20-06:00}`.
// Devuelve "" si el selector no trae fecha (un git que ignore `--date`), que la
// interfaz muestra como una fila sin fecha en vez de con una inventada.
func dateFromSelector(selector string) string {
	open := strings.Index(selector, "{")
	close := strings.LastIndex(selector, "}")
	if open < 0 || close < open {
		return ""
	}
	inner := strings.TrimSpace(selector[open+1 : close])
	// Un `HEAD@{0}` (sin fecha) no es una fecha.
	if inner == "" || !strings.Contains(inner, "-") {
		return ""
	}
	return inner
}

// trimSubjectTail saca del detalle el asunto del commit cuando el detalle
// termina con él, y limpia lo que quede colgando.
func trimSubjectTail(detail, subject string) string {
	if subject == "" || detail == "" || !strings.HasSuffix(detail, subject) {
		return detail
	}
	return strings.TrimRight(strings.TrimSpace(strings.TrimSuffix(detail, subject)), ": ")
}
