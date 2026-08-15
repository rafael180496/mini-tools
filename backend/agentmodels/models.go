// Package agentmodels arma el catálogo de modelos y niveles de esfuerzo que
// ofrece cada CLI agéntico.
//
// # Por qué no está hardcodeado
//
// La primera versión de esta pantalla usaba un campo de texto libre para el
// modelo, justamente para no mantener una lista de ids que envejece con cada
// versión de cada proveedor. El problema es que un campo libre no ayuda a
// elegir: hay que saberse los ids de memoria.
//
// La salida es sacar la lista de cada CLI en vez de escribirla acá:
//
//   - **Claude Code**: sus propios ALIAS (`opus`, `sonnet`, `haiku`, `fable`),
//     documentados en su `--model` como "un alias del último modelo". Un alias
//     no envejece — esa es su razón de existir — así que es lo único de este
//     paquete que se escribe a mano, y a propósito.
//   - **Codex**: `~/.codex/models_cache.json`, que el propio CLI mantiene, con
//     nombre, descripción y **los niveles de esfuerzo soportados por cada
//     modelo**.
//   - **Antigravity**: `agy models`, que los lista.
//
// Si algo falla, se devuelve solo "por defecto": el turno corre igual con el
// modelo que el CLI tenga configurado, que es exactamente lo que pasaba antes
// de que esta pantalla existiera.
package agentmodels

import (
	"context"
	"encoding/json"
	"mini-tools/backend/agents"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Model es una opción del selector.
type Model struct {
	// ID es lo que se le pasa al CLI en `--model`. Vacío = el default del CLI.
	ID    string `json:"id"`
	Label string `json:"label"`
	// Description es la línea de ayuda: para qué sirve ese modelo.
	Description string `json:"description"`
	// Efforts son los niveles de razonamiento que acepta ESE modelo. Vacío
	// significa que el agente no distingue niveles por modelo y valen los
	// generales del agente.
	Efforts []string `json:"efforts"`
}

// Catalog es lo que necesita la UI para armar los dos selectores.
type Catalog struct {
	Models []Model `json:"models"`
	// Efforts son los niveles del AGENTE, para cuando no dependen del modelo.
	Efforts []string `json:"efforts"`
}

// claudeAliases son los alias documentados por Claude Code en su propio
// `--model`. Es la única lista escrita a mano del paquete: un alias apunta
// siempre al último modelo de esa familia, así que no envejece.
var claudeAliases = []Model{
	{ID: "opus", Label: "Opus", Description: "El más capaz para tareas complejas y largas"},
	{ID: "sonnet", Label: "Sonnet", Description: "Equilibrio entre capacidad y velocidad para el día a día"},
	{ID: "haiku", Label: "Haiku", Description: "El más rápido, para respuestas cortas"},
	{ID: "fable", Label: "Fable", Description: "Para lo más difícil y de más aliento"},
}

// claudeEfforts salen de su `--effort`, que los enumera.
var claudeEfforts = []string{"low", "medium", "high", "xhigh", "max"}

var (
	cacheMu sync.Mutex
	cache   = map[string]cached{}
)

type cached struct {
	catalog Catalog
	at      time.Time
}

// cacheTTL evita preguntarle al CLI en cada apertura del panel. Los modelos de
// un proveedor no cambian en una sesión de trabajo, y `agy models` sale a la
// red: repetirlo por cada click sería pagar latencia por un dato estable.
const cacheTTL = 10 * time.Minute

// For devuelve el catálogo de un agente.
func For(agentID string) Catalog {
	cacheMu.Lock()
	if c, ok := cache[agentID]; ok && time.Since(c.at) < cacheTTL {
		cacheMu.Unlock()
		return c.catalog
	}
	cacheMu.Unlock()

	cat := build(agentID)

	cacheMu.Lock()
	cache[agentID] = cached{catalog: cat, at: time.Now()}
	cacheMu.Unlock()
	return cat
}

func build(agentID string) Catalog {
	// La opción vacía va SIEMPRE primera y en todos los agentes: "el que ya
	// tenés configurado" es la respuesta correcta para quien no quiere elegir,
	// y es la única que no puede fallar.
	def := Model{ID: "", Label: "Por defecto", Description: "El que tenga configurado el CLI"}

	switch agentID {
	case "claude":
		return Catalog{Models: append([]Model{def}, claudeAliases...), Efforts: claudeEfforts}
	case "codex":
		return Catalog{Models: append([]Model{def}, codexModels()...)}
	case "antigravity":
		// Sin niveles de esfuerzo aparte: sus modelos YA lo llevan en el
		// nombre (`gemini-3.7-flash-high`, `-medium`, `-low`), así que un
		// selector adicional pediría dos veces la misma decisión y permitiría
		// combinaciones contradictorias. Se comprobó listando sus modelos
		// reales.
		return Catalog{Models: append([]Model{def}, antigravityModels()...)}
	}
	return Catalog{Models: []Model{def}}
}

// codexModels lee el cache que el propio CLI mantiene. Trae además los niveles
// de esfuerzo por modelo, que es un dato que ningún otro agente da.
func codexModels() []Model {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "models_cache.json"))
	if err != nil {
		return nil
	}

	var doc struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Description string `json:"description"`
			Levels      []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}

	out := make([]Model, 0, len(doc.Models))
	for _, m := range doc.Models {
		if m.Slug == "" {
			continue
		}
		efforts := make([]string, 0, len(m.Levels))
		for _, l := range m.Levels {
			if l.Effort != "" {
				efforts = append(efforts, l.Effort)
			}
		}
		label := m.DisplayName
		if label == "" {
			label = m.Slug
		}
		out = append(out, Model{ID: m.Slug, Label: label, Description: m.Description, Efforts: efforts})
	}
	return out
}

// antigravityModels le pregunta al CLI. Es una llamada de red suya, por eso el
// cache de arriba y el tope de tiempo: que el panel tarde en abrir por listar
// modelos sería peor que no listarlos.
func antigravityModels() []Model {
	// Mismo resolvedor que el catálogo: `exec.LookPath` sola falla en una app
	// abierta desde Finder, que hereda un PATH mínimo.
	bin := agents.Resolve("agy")
	if bin == "" {
		return nil
	}
	argv := agents.Launcher(bin)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, argv[0], append(argv[1:], "models")...).Output()
	if err != nil {
		return nil
	}

	var models []Model
	for _, line := range strings.Split(string(out), "\n") {
		// Formato: "<slug>\t<nombre legible>". Una línea sin tabulador es
		// ruido del CLI ("Fetching available models…") y se descarta.
		slug, label, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if !ok || slug == "" {
			continue
		}
		models = append(models, Model{ID: slug, Label: strings.TrimSpace(label)})
	}
	return models
}
