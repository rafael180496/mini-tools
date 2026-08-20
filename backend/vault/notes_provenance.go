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
	return strings.Contains(frontmatter, AgentOriginMark) && !strings.Contains(frontmatter, UserTouchedMark)
}

// NewAgentFrontmatter es el frontmatter de una nota recién creada por un agente.
func NewAgentFrontmatter(at time.Time) string {
	return fmt.Sprintf("%s\ncreada: %s\n", AgentOriginMark, at.Format(time.RFC3339))
}

// WithAgentUpdate deja constancia de la última reescritura del agente,
// conservando lo que ya hubiera.
func WithAgentUpdate(frontmatter string, at time.Time) string {
	return strings.TrimRight(frontmatter, "\n") + fmt.Sprintf("\nactualizada: %s\n", at.Format(time.RFC3339))
}

// WithUserTouch marca que el usuario editó una nota de origen agéntico. Sobre
// cualquier otra nota no hace nada: la marca solo significa algo donde hay una
// autoría de agente que dejar atrás.
func WithUserTouch(frontmatter string, at time.Time) string {
	if !strings.Contains(frontmatter, AgentOriginMark) || strings.Contains(frontmatter, UserTouchedMark) {
		return frontmatter
	}
	return strings.TrimRight(frontmatter, "\n") + fmt.Sprintf("\n%s %s\n", UserTouchedMark, at.Format(time.RFC3339))
}
