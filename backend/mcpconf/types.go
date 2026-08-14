// Package mcpconf lee la configuración de servidores MCP de los CLIs
// agénticos que esta app sabe abrir (Claude Code, Codex, Antigravity — antes
// llamado Gemini CLI, de ahí que sus rutas cuelguen de ~/.gemini).
//
// Qué problema resuelve: MCP es cómo un agente gana herramientas —una base de
// datos, un issue tracker, un navegador— y hoy cada CLI lo configura en su
// propio archivo, con su propio formato y en su propio lugar. Saber "qué
// herramientas tiene realmente el agente que estoy por abrir en este
// repositorio" implicaba abrir tres archivos distintos en tres formatos
// distintos, y la respuesta cambia según el repositorio.
//
// Tres decisiones de fondo:
//
//   - **Lectura de todo, escritura solo donde es seguro.** Escribir en estos
//     archivos es la parte delicada: son del usuario, otros programas los
//     tocan, y perder una clave ajena rompe el setup de alguien fuera de esta
//     app. Por eso se escriben únicamente los que son *configuración* y no los
//     que son estado — ver los límites y el porqué en write.go.
//   - **Los VALORES de `env` no cruzan nunca al frontend, solo sus claves.**
//     Ahí es donde viajan los tokens de las integraciones. Enmascararlos en la
//     UI no alcanza: si el valor llega al frontend, ya está fuera del backend.
//     Es la misma regla que hace que un DSN no cruce el binding
//     (.claude/rules/technical.md punto 9).
//   - **Tolerante, y explícito sobre dónde miró.** Los formatos cambian entre
//     versiones de cada CLI: lo que no se entiende se ignora, y además se
//     devuelve la lista de archivos consultados con su estado. Un config que
//     no se pudo parsear se INFORMA; sin eso, "no hay servidores MCP" y "tu
//     archivo tiene un error de sintaxis" se ven exactamente igual.
package mcpconf

// Scope distingue lo que viaja con el repositorio de lo que es de esta
// máquina. Un servidor que anda para vos y no para un compañero casi siempre
// es uno de scope "user".
type Scope string

const (
	ScopeProject Scope = "project"
	ScopeUser    Scope = "user"
)

// Transport es cómo se habla con el servidor. `stdio` lanza un proceso local;
// `http`/`sse` apuntan a uno remoto — la diferencia importa al leer la lista,
// porque un servidor remoto manda datos del repositorio fuera de la máquina.
type Transport string

const (
	TransportStdio Transport = "stdio"
	TransportHTTP  Transport = "http"
	TransportSSE   Transport = "sse"
)

// Server es un servidor MCP configurado, normalizado desde el formato de
// cualquiera de los tres CLIs.
type Server struct {
	Name string `json:"name"`
	// Agent es el id del catálogo de backend/agents que lee esta config.
	Agent     string    `json:"agent"`
	Scope     Scope     `json:"scope"`
	Transport Transport `json:"transport"`
	// Command y Args solo para stdio.
	Command string   `json:"command"`
	Args    []string `json:"args"`
	// URL solo para http/sse.
	URL string `json:"url"`
	// EnvKeys son los NOMBRES de las variables de entorno configuradas, sin
	// sus valores — ver la nota del paquete. Alcanza para lo que la UI tiene
	// que poder decir ("este servidor necesita GITHUB_TOKEN") sin que el
	// secreto salga del backend.
	EnvKeys []string `json:"envKeys"`
	// Source es el archivo del que salió, para que la UI pueda decir dónde
	// tocarlo.
	Source string `json:"source"`
}

// File es un archivo de configuración consultado. Se devuelven TODOS los que
// se miraron, existan o no: es lo que convierte "no aparece mi servidor" en
// una pregunta contestable.
type File struct {
	Path    string `json:"path"`
	Agent   string `json:"agent"`
	Scope   Scope  `json:"scope"`
	Present bool   `json:"present"`
	// Error es el fallo de parseo, si lo hubo. Un archivo presente con error
	// es muy distinto de uno ausente, y la UI tiene que poder distinguirlos.
	Error string `json:"error"`
	// Servers es cuántos salieron de este archivo.
	Servers int `json:"servers"`
	// Writable dice si la app puede escribirlo (ver write.go). La UI ofrece
	// las acciones de edición solo donde funcionan, en vez de mostrarlas y
	// fallar al tocarlas.
	Writable bool `json:"writable"`
}

// Config es lo que ve un repositorio.
type Config struct {
	Servers []Server `json:"servers"`
	Files   []File   `json:"files"`
}
