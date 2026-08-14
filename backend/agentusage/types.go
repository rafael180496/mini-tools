// Package agentusage lee cuántos tokens consumieron los CLIs agénticos,
// a partir de los transcripts que ellos mismos dejan en el disco.
//
// # Qué se puede saber desde el disco y qué no
//
// Esto es importante antes de leer un solo número: lo que se calcula acá es
// consumo REAL medido sobre lo que el CLI escribió, no "cuánto te queda de tu
// plan". El porcentaje del límite de una suscripción no vive en ningún archivo
// local — lo sabe el servidor y el CLI lo muestra preguntándoselo. Cualquier
// porcentaje que muestre este paquete es una PROPORCIÓN de lo consumido (qué
// parte se fue en un modelo, qué parte la absorbió el caché), nunca una
// fracción de un tope.
//
// # Verificado contra datos reales, por agente
//
//   - **Claude Code: verificado.** Sus transcripts están en
//     `~/.claude/projects/<slug>/<sesión>.jsonl`, una línea JSON por evento, y
//     las de tipo `assistant` traen `message.usage` con las cuatro clases de
//     token (entrada, salida, escritura de caché y lectura de caché) más el
//     modelo y la fecha. El slug del directorio es la ruta del proyecto con
//     `/`, `_` y `.` reemplazados por `-`, que es lo que permite atribuir el
//     consumo AL REPOSITORIO abierto.
//   - **Codex y Antigravity: no verificados.** En la máquina donde se
//     implementó esto no están instalados (`~/.codex` no existe, ninguno de
//     los dos binarios está en el PATH), así que no hubo forma de mirar un
//     archivo real. Escribir un parser a ciegas para el formato de otro
//     programa es cómo se producen números equivocados que nadie detecta —y en
//     consumo de tokens, un total inflado diez veces se parece bastante a uno
//     correcto—. Se detecta si están y se dice que no hay datos; el lector se
//     escribe cuando haya un archivo real contra el cual comprobarlo.
package agentusage

// Bucket es una porción del consumo: un modelo, un día o un proyecto.
type Bucket struct {
	Key   string `json:"key"`
	Total int64  `json:"total"`
	// Percent es la parte que representa del total del agente, 0..100.
	Percent  float64 `json:"percent"`
	Messages int     `json:"messages"`
}

// Totals son las cuatro clases de token que reporta la API, separadas porque
// no cuestan lo mismo ni significan lo mismo: una lectura de caché es barata y
// es justamente lo que uno QUIERE que sea alto.
type Totals struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheWrite int64 `json:"cacheWrite"`
	CacheRead  int64 `json:"cacheRead"`
	Total      int64 `json:"total"`
	Messages   int   `json:"messages"`
}

// Activity es lo que se puede saber de un agente que NO deja contadores de
// tokens en el disco: cuánto se lo usó. Es el caso de Antigravity, cuya cuota
// la contesta el servidor y solo se ve con /usage dentro de su sesión.
//
// Existe para no tener que elegir entre mentir y callarse: un panel que
// dijera "0 tokens" de un agente que se usó todo el día sería falso, y no
// mostrar nada desperdiciaría información real que sí está en la máquina.
type Activity struct {
	Conversations     int    `json:"conversations"`
	Steps             int    `json:"steps"`
	RepoConversations int    `json:"repoConversations"`
	RepoSteps         int    `json:"repoSteps"`
	LastUsed          string `json:"lastUsed"`
}

// AgentUsage es el consumo de un agente.
type AgentUsage struct {
	Agent string `json:"agent"`
	// Available es si se pudo leer consumo. False no es un error: puede ser
	// que el CLI no esté instalado, que no se haya usado, o —el caso de Codex
	// y Antigravity— que todavía no haya un lector verificado.
	Available bool `json:"available"`
	// Note explica por qué no hay datos, para que la UI diga algo mejor que
	// un cero sin contexto.
	Note   string `json:"note"`
	Source string `json:"source"`

	All  Totals `json:"all"`
	Repo Totals `json:"repo"`

	// FirstDay y LastDay acotan el período que cubren los datos (YYYY-MM-DD).
	// Sin esto, un total no significa nada: no se sabe si es de una semana o
	// de seis meses.
	FirstDay string `json:"firstDay"`
	LastDay  string `json:"lastDay"`

	ByModel []Bucket `json:"byModel"`
	ByDay   []Bucket `json:"byDay"`

	// CacheHitPercent es qué parte de los tokens de ENTRADA salieron del
	// caché. Es el único porcentaje de esta pantalla sobre el que se puede
	// actuar: subirlo es lo que abarata una sesión larga.
	CacheHitPercent float64 `json:"cacheHitPercent"`

	// Activity está presente cuando el agente no deja tokens en el disco pero
	// sí rastro de uso. Nil cuando no aplica.
	Activity *Activity `json:"activity"`
}

// Usage es lo que ve la UI: un bloque por agente del catálogo.
type Usage struct {
	Agents []AgentUsage `json:"agents"`
	// Days es la ventana de días que se leyó, para poder decirlo en pantalla.
	Days int `json:"days"`
}
