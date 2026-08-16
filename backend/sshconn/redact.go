package sshconn

import (
	"regexp"
	"strings"
)

// Redacción de secretos en la salida de terminal que se le muestra a un agente.
//
// **Por qué hace falta.** La matriz de permisos del proyecto decía que los logs
// de terminal eran "inyección segura". No lo son del todo, y la diferencia es
// concreta: nadie escribe una contraseña en un prompt que la esconde, pero
// escribir `mysql -pSecreto123`, `export TOKEN=…` o un `curl -H "Authorization:
// Bearer …"` es rutina, y todo eso **queda impreso en la pantalla**. Como el
// buffer se arma de lo que la terminal imprimió, esos valores estaban entrando
// al prompt del agente junto con el error que sí se quería analizar.
//
// **Qué se redacta y qué no.** Solo patrones de alta confianza, donde la forma
// misma dice que lo que sigue es un secreto. Redactar de más es peor que no
// redactar: esconde justamente lo que el usuario quiere que el agente mire, y
// entrena a desconfiar del resultado. Un token suelto sin nada alrededor que lo
// identifique no se toca — no hay forma honesta de distinguirlo de un hash de
// commit o de un identificador.
//
// **Y se avisa.** Cada valor oculto deja su marca en el texto, así que el
// agente ve que ahí había algo (y no razona sobre una línea truncada), y el
// usuario ve cuántos se ocultaron en el panel de "qué se mandó".

// redactMarker es lo que reemplaza al valor. redactOpen es su primer
// caracter, que alcanza para reconocer un valor ya redactado aunque se lo
// haya capturado a medias.
const (
	redactOpen   = "«"
	redactMarker = redactOpen + "oculto por mini-tools»"
)

// secretPatterns son las formas donde el propio texto dice que lo que sigue es
// un secreto. Cada una captura el prefijo en el grupo 1 para poder conservarlo:
// que el agente vea `PGPASSWORD=«oculto»` le dice mucho más que una línea sin
// nada.
var secretPatterns = []*regexp.Regexp{
	// Variables de entorno y asignaciones: PASSWORD=, TOKEN=, SECRET=, KEY=,
	// PASSWD=, PWD= (esta última solo con prefijo, para no comerse `$PWD`).
	regexp.MustCompile(`(?i)\b([A-Z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY)[A-Z_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)`),
	// Banderas de línea de comandos: -p<valor> de mysql, --password=…,
	// --token=…, -P de algunos clientes.
	regexp.MustCompile(`(?i)(--(?:password|token|secret|api-?key)[= ])("[^"]*"|'[^']*'|\S+)`),
	regexp.MustCompile(`(\s-p)([^\s-]\S*)`),
	// Cabeceras HTTP de autorización. El valor corta en la comilla: sin eso
	// se lleva puesta la que cierra el `-H "…"` y la línea queda mal formada.
	regexp.MustCompile(`(?i)((?:Authorization|X-Api-Key)\s*:\s*(?:Bearer\s+|Basic\s+)?)([^"'\s]+)`),
	// DSN con credenciales embebidas: postgres://usuario:clave@host.
	regexp.MustCompile(`(?i)((?:postgres|postgresql|mysql|mongodb|redis|oracle)(?:\+\w+)?://[^:@\s]+:)([^@\s]+)(@)`),
}

// privateKeyStart marca el comienzo de una clave privada pegada en la terminal.
// Todo el bloque se reemplaza por una sola línea: no hay ninguna parte de una
// clave privada que sea útil para diagnosticar nada.
var privateKeyStart = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)

// redactSecrets limpia un conjunto de líneas y devuelve cuántos valores ocultó.
func redactSecrets(lines []string) ([]string, int) {
	out := make([]string, 0, len(lines))
	count := 0
	inKey := false

	for _, line := range lines {
		if inKey {
			if strings.Contains(line, "-----END") {
				inKey = false
			}
			continue
		}
		if privateKeyStart.MatchString(line) {
			inKey = true
			count++
			out = append(out, redactMarker+" (clave privada)")
			continue
		}

		redacted := line
		for _, re := range secretPatterns {
			redacted = re.ReplaceAllStringFunc(redacted, func(m string) string {
				groups := re.FindStringSubmatch(m)
				if len(groups) < 3 {
					return m
				}
				// Un valor que YA fue redactado no se vuelve a redactar. Sin
				// esto, `--token=x` cae en dos patrones —el de `TOKEN=` y el
				// de `--token=`— y el segundo redacta un PEDAZO de la marca
				// del primero, dejando `«oculto por mini-tools» por mini-tools»`.
				//
				// Se compara contra el guillemet de apertura y no contra la
				// marca entera justamente por eso: el segundo patrón captura
				// solo hasta el primer espacio, así que nunca ve la marca
				// completa.
				if strings.Contains(groups[2], redactOpen) {
					return m
				}
				count++
				// El último grupo (la `@` del DSN) se conserva si existe, para
				// que la línea siga leyéndose como una URL.
				tail := ""
				if len(groups) > 3 {
					tail = groups[3]
				}
				return groups[1] + redactMarker + tail
			})
		}
		out = append(out, redacted)
	}
	return out, count
}

// RedactLines es redactSecrets expuesto, para el texto que el usuario
// seleccionó a mano en la terminal: tiene que pasar por el mismo criterio que
// el buffer, o habría dos definiciones de qué es un secreto.
func RedactLines(lines []string) ([]string, int) {
	return redactSecrets(lines)
}
