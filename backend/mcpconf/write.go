package mcpconf

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Escritura de configs MCP.
//
// # Qué se puede escribir y qué NO, y por qué
//
// Escribir en el archivo de otro programa es la parte peligrosa de este
// paquete: si se pierde o se reordena una clave ajena, se rompe el setup de
// alguien fuera de esta app. Por eso el alcance es chico y explícito:
//
//   - **Sí: `.mcp.json` del proyecto y los configs de Antigravity
//     (`~/.gemini/config/mcp_config.json` y el `settings.json` del nombre
//     anterior).** Son archivos chicos y de propósito específico, cuyo
//     contenido entero es configuración.
//   - **No: `~/.claude.json`.** No es un archivo de configuración de MCP: es
//     el archivo de ESTADO de Claude Code —historial por proyecto, y mucho
//     más—, típicamente enorme. Reescribirlo completo para tocar una clave es
//     un riesgo desproporcionado frente a lo que se gana.
//   - **No: `~/.codex/config.toml`.** El lector de TOML de este paquete está
//     acotado a lo que necesita leer e ignora lo que no entiende; eso alcanza
//     para leer y NO para escribir, porque escribir exige preservar
//     exactamente lo desconocido. Traer un parser TOML completo es una
//     dependencia nueva y esa decisión no se toma de costado (regla 12).
//
// Lo que no se puede escribir se informa como tal, así que la UI ofrece el
// botón solo donde funciona en vez de fallar al tocarlo.
//
// # Cómo se escribe
//
// Se decodifica a `map[string]json.RawMessage` en los dos niveles que
// importan: así **todo lo que no se toca vuelve al archivo byte a byte**,
// incluidas las claves que este código no conoce. Antes de escribir se deja
// una copia `.mini-tools.bak` al lado, y la escritura es atómica.
//
// Efecto conocido y aceptado: Go serializa los mapas con las claves
// **ordenadas alfabéticamente**, así que un archivo cuyas claves estaban en
// otro orden queda reordenado. Es un cambio cosmético —el JSON significa lo
// mismo— y es el precio de no traer un parser que preserve el orden. Los
// valores no se tocan.

// Writable informa si este archivo se puede escribir desde la app.
func Writable(f File) bool {
	if f.Agent == "codex" {
		return false
	}
	// El archivo de estado de Claude Code se reconoce por su nombre: es el
	// único config JSON de ese agente que no es solo configuración.
	if strings.EqualFold(filepath.Base(f.Path), ".claude.json") {
		return false
	}
	return strings.EqualFold(filepath.Ext(f.Path), ".json")
}

// ServerInput es lo que la UI manda para agregar o reemplazar un servidor.
//
// Env viaja CON sus valores, al revés que en la lectura. No es una
// contradicción: al leer, los valores son secretos ajenos que no tienen por
// qué salir del backend; al escribir, son lo que el usuario acaba de tipear
// para su propio archivo. Van a parar al config en texto plano, que es como
// esos archivos funcionan — y NO al vault de esta app, que no administra
// credenciales de otros programas.
type ServerInput struct {
	Name      string            `json:"name"`
	Transport Transport         `json:"transport"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	URL       string            `json:"url"`
	Env       map[string]string `json:"env"`
}

// UpsertServer agrega o reemplaza un servidor en un archivo JSON.
func UpsertServer(path string, in ServerInput) error {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return fmt.Errorf("mcpconf: el nombre del servidor no puede estar vacío")
	}
	if in.Transport == TransportStdio && strings.TrimSpace(in.Command) == "" {
		return fmt.Errorf("mcpconf: un servidor local necesita un comando")
	}
	if in.Transport != TransportStdio && strings.TrimSpace(in.URL) == "" {
		return fmt.Errorf("mcpconf: un servidor remoto necesita una URL")
	}

	entry := map[string]any{}
	if in.Transport == TransportStdio {
		entry["command"] = in.Command
		if len(in.Args) > 0 {
			entry["args"] = in.Args
		}
	} else {
		entry["type"] = string(in.Transport)
		entry["url"] = in.URL
	}
	if len(in.Env) > 0 {
		entry["env"] = in.Env
	}

	encoded, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return editServers(path, func(servers map[string]json.RawMessage) error {
		servers[name] = encoded
		return nil
	})
}

// RemoveServer borra un servidor. Un nombre que no está no es un error: el
// resultado pedido —que no esté— ya se cumple.
func RemoveServer(path, name string) error {
	return editServers(path, func(servers map[string]json.RawMessage) error {
		delete(servers, name)
		return nil
	})
}

// editServers abre el archivo, deja que edit toque SOLO el bloque de
// servidores, y lo vuelve a escribir preservando el resto tal cual.
func editServers(path string, edit func(map[string]json.RawMessage) error) error {
	root := map[string]json.RawMessage{}
	mode := fs.FileMode(0o600)

	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(strings.TrimSpace(string(data))) > 0 {
			if err := json.Unmarshal(data, &root); err != nil {
				// Se corta acá a propósito: reescribir un archivo que no se
				// pudo entender es la forma más rápida de destruirlo.
				return fmt.Errorf("mcpconf: %q no se pudo leer como JSON, no se toca: %w", path, err)
			}
		}
		if info, err := os.Stat(path); err == nil {
			mode = info.Mode().Perm()
		}
		if err := backup(path, data, mode); err != nil {
			return err
		}
	case os.IsNotExist(err):
		// Un archivo que todavía no existe se crea. 0600 por defecto: puede
		// terminar conteniendo tokens.
	default:
		return fmt.Errorf("mcpconf: leyendo %q: %w", path, err)
	}

	servers := map[string]json.RawMessage{}
	if raw, ok := root["mcpServers"]; ok {
		if err := json.Unmarshal(raw, &servers); err != nil {
			return fmt.Errorf("mcpconf: el bloque mcpServers de %q no se pudo leer, no se toca: %w", path, err)
		}
	}

	if err := edit(servers); err != nil {
		return err
	}

	// Un bloque vacío se quita en vez de dejar `"mcpServers": {}`: es basura
	// que quedaría en el archivo del usuario por haber probado la función.
	if len(servers) == 0 {
		delete(root, "mcpServers")
	} else {
		encoded, err := json.Marshal(servers)
		if err != nil {
			return err
		}
		root["mcpServers"] = encoded
	}

	out, err := marshalIndented(root)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mcpconf: creando el directorio de %q: %w", path, err)
	}
	return writeAtomic(path, out, mode)
}

// marshalIndented serializa con indentación de dos espacios, que es como
// vienen escritos estos archivos: dejar una sola línea haría ilegible un
// archivo que el usuario también edita a mano.
func marshalIndented(root map[string]json.RawMessage) ([]byte, error) {
	// Las claves se ordenan explícitamente en vez de confiar en el orden del
	// mapa, para que dos escrituras seguidas den el mismo archivo.
	keys := make([]string, 0, len(root))
	for k := range root {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	b.WriteString("{\n")
	for i, k := range keys {
		key, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, root[k], "  ", "  "); err != nil {
			// Un valor que no se puede reindentar se escribe tal cual: se
			// prefiere un archivo feo a uno perdido.
			pretty.Reset()
			pretty.Write(root[k])
		}
		fmt.Fprintf(&b, "  %s: %s", key, pretty.String())
		if i < len(keys)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return []byte(b.String()), nil
}

// backup deja una copia al lado antes de la primera escritura.
//
// Una sola copia y no una por versión: lo que hay que poder deshacer es "la
// app me tocó el archivo", y para eso alcanza con el estado inmediatamente
// anterior. Un directorio de backups creciendo en el home de alguien es
// basura que nadie pidió.
func backup(path string, data []byte, mode fs.FileMode) error {
	if len(data) == 0 {
		return nil
	}
	if err := os.WriteFile(path+".mini-tools.bak", data, mode); err != nil {
		return fmt.Errorf("mcpconf: no se pudo respaldar %q, no se escribe: %w", path, err)
	}
	return nil
}

// writeAtomic escribe por temporal + rename en el MISMO directorio: rename
// solo es atómico dentro de un sistema de archivos, y un corte a mitad tiene
// que dejar el archivo anterior intacto y no uno truncado.
func writeAtomic(path string, data []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".mini-tools-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, mode); err != nil {
		return err
	}
	return os.Rename(name, path)
}
