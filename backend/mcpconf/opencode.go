package mcpconf

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"mini-tools/backend/i18n"
)

// Lectura del config de OpenCode (`opencode.json` u `opencode.jsonc`, en el
// proyecto y en ~/.config/opencode).
//
// Es el cuarto formato y no se parece a los otros: los servidores van bajo
// `mcp` (no `mcpServers`), el comando es UN arreglo con el ejecutable y sus
// argumentos juntos, las variables están en `environment` y el transporte se
// declara como `local`/`remote`. Además el archivo admite comentarios y comas
// finales (JSONC), así que no se puede pasar directo a encoding/json.
//
// Solo lectura: escribirlo exigiría preservar los comentarios del usuario,
// cosa que un decodificador a mapas no hace (ver Writable).

type opencodeServer struct {
	Type        string            `json:"type"`
	Command     []string          `json:"command"`
	Environment map[string]string `json:"environment"`
	URL         string            `json:"url"`
	Enabled     *bool             `json:"enabled"`
}

// opencodeConfigNames son los nombres que OpenCode reconoce, en el orden en
// que se miran.
var opencodeConfigNames = []string{"opencode.json", "opencode.jsonc"}

// IsOpencodeConfig dice si una ruta es un config de OpenCode. Lo necesita la
// comprobación de escritura, que recibe solo la ruta.
func IsOpencodeConfig(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	for _, n := range opencodeConfigNames {
		if base == n {
			return true
		}
	}
	return false
}

// readOpencodeDir lee los configs de OpenCode de un directorio. Se devuelven
// los dos nombres consultados, existan o no, como en el resto del paquete.
func readOpencodeDir(dir string, scope Scope, add func([]Server, File)) {
	for _, n := range opencodeConfigNames {
		add(readOpencodeFile(filepath.Join(dir, n), scope))
	}
}

func readOpencodeFile(path string, scope Scope) ([]Server, File) {
	f := File{Path: path, Agent: "opencode", Scope: scope}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, f
	}
	f.Present = true

	var doc struct {
		MCP map[string]opencodeServer `json:"mcp"`
	}
	if err := json.Unmarshal(stripJSONC(data), &doc); err != nil {
		f.Error = i18n.T(i18n.Msg{ES: "no se pudo leer como JSON: %v", EN: "couldn't be read as JSON: %v"}, err)
		return nil, f
	}

	names := make([]string, 0, len(doc.MCP))
	for name := range doc.MCP {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]Server, 0, len(names))
	for _, name := range names {
		r := doc.MCP[name]
		// Un servidor apagado en el config no es una herramienta que el agente
		// tenga: listarlo diría lo contrario.
		if r.Enabled != nil && !*r.Enabled {
			continue
		}
		s := Server{Name: name, Agent: "opencode", Scope: scope, Source: path, Args: []string{}, EnvKeys: envKeys(r.Environment)}
		if r.Type == "remote" || (r.URL != "" && len(r.Command) == 0) {
			s.Transport, s.URL = TransportHTTP, r.URL
		} else {
			s.Transport = TransportStdio
			if len(r.Command) > 0 {
				s.Command = r.Command[0]
				s.Args = append(s.Args, r.Command[1:]...)
			}
		}
		out = append(out, s)
	}
	f.Servers = len(out)
	return out, f
}

// stripJSONC quita comentarios (`//` y `/* */`) y comas finales, respetando
// las cadenas. Lo que no es comentario queda en su lugar, así que un error de
// sintaxis real se sigue informando.
func stripJSONC(in []byte) []byte {
	out := make([]byte, 0, len(in))
	inStr := false
	for i := 0; i < len(in); i++ {
		c := in[i]
		if inStr {
			out = append(out, c)
			if c == '\\' && i+1 < len(in) {
				i++
				out = append(out, in[i])
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out = append(out, c)
		case c == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
			if i < len(in) {
				out = append(out, '\n')
			}
		case c == '/' && i+1 < len(in) && in[i+1] == '*':
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i++
		case c == ']' || c == '}':
			// Coma final: la última coma antes de este cierre, separada solo
			// por espacios, sobra.
			j := len(out) - 1
			for j >= 0 && (out[j] == ' ' || out[j] == '\t' || out[j] == '\n' || out[j] == '\r') {
				j--
			}
			if j >= 0 && out[j] == ',' {
				out = append(out[:j], out[j+1:]...)
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}
