package agentctx

import (
	"bufio"
	"io"
	"os"
	"strings"
)

// Lector de frontmatter, acotado a propósito a lo que hace falta.
//
// Los SKILL.md, los subagentes y los comandos slash llevan un bloque YAML
// arriba del todo, entre dos líneas de "---", y de ahí solo se leen `name` y
// `description`: son los dos campos que un catálogo necesita para mostrar
// "qué es esto" sin abrir el archivo.
//
// Por qué a mano y no con un parser YAML: sumar gopkg.in/yaml.v3 al binario
// por dos claves escalares va contra la regla de dependencias mínimas
// (.claude/rules/technical.md punto 12), y el mismo criterio que ya se aplicó
// al no meter un parser de SQL (punto 7). Lo que este lector NO entiende
// —anidamiento, listas, valores en bloque con | o >, anclas— tampoco aparece
// en estos dos campos; si aparece, el valor se ignora y el archivo se lista
// igual por su ruta, que es el modo de fallo correcto para un catálogo.

// maxFrontmatterBytes es cuánto del comienzo se lee. El frontmatter vive en
// las primeras líneas; leer un SKILL.md de 200 KB entero para sacarle dos
// campos sería pagar el archivo completo por cada entrada del catálogo.
const maxFrontmatterBytes = 8 << 10

// frontmatter devuelve name y description de un archivo con frontmatter YAML.
// Un archivo sin frontmatter, o con uno que no trae esos campos, no es un
// error: devuelve vacíos y el llamador cae a su fallback (el nombre del
// directorio o del archivo).
func frontmatter(path string) (name, description string) {
	f, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer f.Close()

	r := bufio.NewReader(io.LimitReader(f, maxFrontmatterBytes))

	first, err := r.ReadString('\n')
	if err != nil && first == "" {
		return "", ""
	}
	// El BOM se saca antes de comparar: un editor de Windows puede haber
	// guardado el archivo con uno, y entonces la primera línea no es "---"
	// sino "\ufeff---" y el skill quedaría sin nombre por un byte invisible.
	if strings.TrimSpace(strings.TrimPrefix(first, "\ufeff")) != "---" {
		return "", ""
	}

	// cur es la clave (name o description) cuyo valor sigue en las líneas
	// indentadas de abajo: YAML permite partir un valor en varias líneas, sea
	// con un indicador de bloque (`description: >` / `|`) o sin él, y los
	// skills largos lo usan. Se unen con un espacio: para un catálogo da igual
	// si el original era plegado o literal.
	cur := ""
	set := func(key, value string) {
		switch key {
		case "name":
			name = value
		case "description":
			description = value
		}
	}
	get := func(key string) string {
		if key == "name" {
			return name
		}
		return description
	}

	for {
		line, err := r.ReadString('\n')
		if line == "" && err != nil {
			break
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.TrimSpace(trimmed) == "---" {
			break
		}
		if trimmed == "" {
			if err != nil {
				break
			}
			continue
		}
		// Una línea indentada continúa el valor de la clave anterior si era
		// name/description; si no, pertenece a una estructura anidada que este
		// lector no interpreta.
		if strings.HasPrefix(trimmed, " ") || strings.HasPrefix(trimmed, "\t") {
			if cur != "" {
				if cont := strings.TrimSpace(trimmed); cont != "" {
					if prev := get(cur); prev != "" {
						set(cur, prev+" "+cont)
					} else {
						set(cur, cont)
					}
				}
			}
			if err != nil {
				break
			}
			continue
		}

		cur = ""
		key, value, found := strings.Cut(trimmed, ":")
		if found {
			k := strings.ToLower(strings.TrimSpace(key))
			if k == "name" || k == "description" {
				cur = k
				v := strings.TrimSpace(value)
				// Indicador de bloque (>, |, >-, |+…): el texto está abajo.
				if v != "" && strings.Trim(v, ">|+-") == "" {
					v = ""
				}
				set(k, v)
			}
		}
		if err != nil {
			break
		}
	}
	return unquote(name), unquote(description)
}

// unquote limpia el valor: espacios, comillas simples o dobles envolventes, y
// el comentario final de una línea sin comillas.
func unquote(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}
