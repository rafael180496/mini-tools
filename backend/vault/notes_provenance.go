package vault

import (
	"fmt"
	"strings"
	"time"
)

// Procedencia de una nota: quién la escribió y quién la tocó después.
//
// Vive en el frontmatter —el bloque de metadatos de la propia nota— y no en una
// columna aparte por un motivo concreto: una nota exportada a Obsidian o
// copiada a otra máquina se lleva su procedencia adentro. Una columna de la
// base se quedaría acá.
//
// **Para qué sirve y para qué NO.** Sirve para contestar "¿esto lo escribí yo o
// el agente?" seis meses después, y para decidir qué puede reescribir un agente
// por MCP. **No es un control de seguridad**: el frontmatter es texto de la nota
// y el usuario lo puede editar a mano — es su vault. Lo que sí garantiza es la
// dirección que importa: sin la marca de origen, un agente no toca la nota.

const (
	// AgentOriginMark la escribe el servidor MCP al crear una nota.
	AgentOriginMark = "origen: agente-mcp"
	// HTTPDocsOriginMark la escribe el módulo de peticiones al publicar la
	// documentación de una colección. Es una marca distinta de la del agente
	// porque son dos generadores distintos: que el usuario haya editado la
	// documentación de una colección no tiene por qué habilitar al agente MCP
	// a reescribir esa nota, ni al revés.
	HTTPDocsOriginMark = "origen: http-colecciones"
	// UserTouchedMark la escribe la aplicación cuando el USUARIO guarda una
	// nota que había creado un agente. Desde ese momento la nota es suya: el
	// agente deja de poder reescribirla, porque lo que escribió una persona no
	// se pisa ni siquiera en una nota que empezó escribiendo un modelo.
	UserTouchedMark = "editada-por-el-usuario:"
)

// AgentCanEdit decide si un agente puede reescribir una nota, mirando su
// frontmatter. Es la regla completa, en un solo lugar: la escribió él y nadie
// la editó después.
func AgentCanEdit(frontmatter string) bool {
	return GeneratorCanEdit(frontmatter, AgentOriginMark)
}

// GeneratorCanEdit es la misma regla para cualquier generador de notas: la nota
// la escribió él y ninguna persona la tocó después.
//
// Una sola función para las dos marcas para que la regla no se bifurque: el día
// que aparezca un tercer generador, hereda el comportamiento en vez de traer su
// propia versión ligeramente distinta de "¿la puedo pisar?".
func GeneratorCanEdit(frontmatter, originMark string) bool {
	return strings.Contains(frontmatter, originMark) && !strings.Contains(frontmatter, UserTouchedMark)
}

// NewGeneratedFrontmatter es el frontmatter de una nota recién publicada por un
// generador, con la referencia a lo que documenta (`source`) para que se pueda
// volver a ella desde la nota.
func NewGeneratedFrontmatter(originMark, source string, at time.Time) string {
	fm := fmt.Sprintf("%s\ncreada: %s\n", originMark, at.Format(time.RFC3339))
	if source != "" {
		fm += "fuente: " + source + "\n"
	}
	return fm
}

// NewAgentFrontmatter es el frontmatter de una nota recién creada por un agente.
func NewAgentFrontmatter(at time.Time) string {
	return fmt.Sprintf("%s\ncreada: %s\n", AgentOriginMark, at.Format(time.RFC3339))
}

// WithAgentUpdate deja constancia de la última reescritura del generador,
// conservando lo que ya hubiera.
func WithAgentUpdate(frontmatter string, at time.Time) string {
	return strings.TrimRight(frontmatter, "\n") + fmt.Sprintf("\nactualizada: %s\n", at.Format(time.RFC3339))
}

// WithUserTouch marca que el usuario editó una nota generada, sea por el agente
// o por el módulo de peticiones. Sobre una nota escrita a mano desde el
// principio no hace nada: la marca solo significa algo donde hay una autoría
// automática que dejar atrás.
//
// Se aplica en el único lugar por donde el usuario guarda una nota
// (`app_notes.go`), así que alcanza con conocer acá la lista de orígenes: un
// generador nuevo que registre su marca queda protegido sin tocar el guardado.
func WithUserTouch(frontmatter string, at time.Time) string {
	if strings.Contains(frontmatter, UserTouchedMark) {
		return frontmatter
	}
	generated := false
	for _, mark := range []string{AgentOriginMark, HTTPDocsOriginMark} {
		if strings.Contains(frontmatter, mark) {
			generated = true
			break
		}
	}
	if !generated {
		return frontmatter
	}
	return strings.TrimRight(frontmatter, "\n") + fmt.Sprintf("\n%s %s\n", UserTouchedMark, at.Format(time.RFC3339))
}
