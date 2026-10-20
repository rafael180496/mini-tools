package mcpconf

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"mini-tools/backend/i18n"
)

// Reglas de permiso de Antigravity (`agy`) para las herramientas MCP de
// mini-tools. Diseño y decisión: .claude/specs/chat-cli-permisos.md
// («Antigravity»).
//
// # Por qué existe
//
// En `agy -p` (headless) toda herramienta MCP que no esté preaprobada se
// auto-deniega y el turno termina sin respuesta. Lo único que lo evita es una
// regla `mcp(<servidor>/<herramienta>)` en `permissions.allow` del
// `settings.json` GLOBAL de Antigravity (`~/.gemini/antigravity-cli/`): ni los
// hooks, ni `.agents/settings.json`, ni los proyectos configurados sirven.
//
// # Qué se toca y qué no
//
// Este archivo es del usuario y lo comparten otras herramientas, así que el
// contrato es el mismo que el de write.go, más estricto en un punto:
//
//   - Solo se agregan, mantienen y quitan reglas **propias**: las que tienen la
//     forma `mcp(<servidor>/<herramienta>)` con el nombre de servidor que se
//     pasa. Cualquier otra regla de `allow`, `deny`, y toda otra clave del
//     archivo, vuelve tal cual.
//   - **Nunca** se genera una regla con comodín (`mcp(*)`, `command(*)`): los
//     nombres con `*`, `/`, paréntesis o espacios se rechazan antes de
//     escribir.
//   - Un archivo que no es JSON válido no se pisa.
//   - Sin cambios no se escribe (ni siquiera la copia de respaldo).
//
// Todas las funciones reciben la ruta como parámetro para poder probarse
// contra un directorio temporal; `AgySettingsPath` da la real.

// AgySettingsPath es el settings.json global de Antigravity, o "" si no hay
// directorio home.
func AgySettingsPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
}

// AgyPerm es el estado de las reglas de mini-tools en el archivo.
type AgyPerm struct {
	Path string `json:"path"`
	// Exists: el archivo está en disco.
	Exists bool `json:"exists"`
	// Valid: se pudo leer como JSON con la forma esperada. Un archivo que no
	// existe es válido (se crearía); uno ilegible no.
	Valid bool `json:"valid"`
	// Problem explica por qué no es válido, en el idioma activo.
	Problem string `json:"problem,omitempty"`
	// Expected son las reglas que deberían estar, una por herramienta.
	Expected []string `json:"expected"`
	// Missing son las esperadas que no están.
	Missing []string `json:"missing"`
	// Extra son reglas propias (`mcp(<servidor>/…)`) que ya no corresponden a
	// ninguna herramienta.
	Extra []string `json:"extra"`
	// Synced: no falta ni sobra nada y el archivo es legible.
	Synced bool `json:"synced"`
}

// AgyPermStatus informa qué reglas faltan y cuáles sobran sin escribir nada.
// Un archivo ilegible no es un error de la función sino un estado
// (`Valid=false`): es lo que la UI necesita mostrar. El error queda para
// nombres inválidos y fallos de lectura del disco.
func AgyPermStatus(path, server string, tools []string) (AgyPerm, error) {
	st := AgyPerm{Path: path, Expected: []string{}, Missing: []string{}, Extra: []string{}}
	want, err := agyRules(server, tools)
	if err != nil {
		return st, err
	}
	st.Expected = want

	f, err := loadAgySettings(path)
	if err != nil {
		if f.unreadable {
			st.Exists, st.Problem = true, err.Error()
			st.Missing = append(st.Missing, want...)
			return st, nil
		}
		return st, err
	}
	st.Exists, st.Valid = f.exists, true

	have := map[string]bool{}
	for _, r := range f.rules() {
		if isAgyOwn(r, server) {
			have[r] = true
			if !contains(want, r) {
				st.Extra = append(st.Extra, r)
			}
		}
	}
	for _, r := range want {
		if !have[r] {
			st.Missing = append(st.Missing, r)
		}
	}
	st.Synced = len(st.Missing) == 0 && len(st.Extra) == 0
	return st, nil
}

// SyncAgyPermissions deja en `permissions.allow` exactamente una regla por
// herramienta de `tools` para ese servidor: agrega las que faltan y quita las
// propias que sobran. Devuelve si escribió. Crea el archivo y la carpeta si
// no existen.
func SyncAgyPermissions(path, server string, tools []string) (bool, error) {
	want, err := agyRules(server, tools)
	if err != nil {
		return false, err
	}
	return editAgyAllow(path, func(current []string) []string {
		out := make([]string, 0, len(current)+len(want))
		seen := map[string]bool{}
		for _, r := range current {
			if isAgyOwn(r, server) && (!contains(want, r) || seen[r]) {
				continue
			}
			seen[r] = true
			out = append(out, r)
		}
		for _, r := range want {
			if !seen[r] {
				seen[r] = true
				out = append(out, r)
			}
		}
		return out
	}, len(want) > 0)
}

// RemoveAgyPermissions quita solo las reglas `mcp(<servidor>/…)`. Un archivo
// que no existe o que no las tiene no es un error: lo pedido ya se cumple.
func RemoveAgyPermissions(path, server string) (bool, error) {
	if err := validAgyName(server); err != nil {
		return false, err
	}
	return editAgyAllow(path, func(current []string) []string {
		out := make([]string, 0, len(current))
		for _, r := range current {
			if !isAgyOwn(r, server) {
				out = append(out, r)
			}
		}
		return out
	}, false)
}

// agyRules valida los nombres y arma las reglas esperadas, sin repetidas y en
// el orden de tools.
func agyRules(server string, tools []string) ([]string, error) {
	if err := validAgyName(server); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(tools))
	seen := map[string]bool{}
	for _, t := range tools {
		if err := validAgyName(t); err != nil {
			return nil, err
		}
		r := agyRule(server, t)
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out, nil
}

func agyRule(server, tool string) string { return "mcp(" + server + "/" + tool + ")" }

// validAgyName rechaza lo que podría convertir una regla en un comodín o
// romper su sintaxis. Es la defensa de «nunca `mcp(*)`».
func validAgyName(name string) error {
	if name == "" || strings.ContainsAny(name, "*/()") || strings.IndexFunc(name, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) >= 0 {
		return i18n.Errorf(i18n.Msg{
			ES: "mcpconf: %q no sirve para una regla de permiso (no puede estar vacío ni llevar *, /, paréntesis o espacios)",
			EN: "mcpconf: %q can't be used in a permission rule (it can't be empty or contain *, /, parentheses or whitespace)",
		}, name)
	}
	return nil
}

// isAgyOwn reconoce `mcp(<server>/<algo>)`. El `/` final del prefijo evita
// confundir `mini-tools` con `mini-tools-otro`.
func isAgyOwn(rule, server string) bool {
	prefix := "mcp(" + server + "/"
	return strings.HasPrefix(rule, prefix) && strings.HasSuffix(rule, ")") && len(rule) > len(prefix)+1
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// agySettings es el archivo leído: la raíz y el bloque `permissions` se
// decodifican a RawMessage para que todo lo ajeno vuelva byte a byte.
type agySettings struct {
	exists     bool
	unreadable bool
	data       []byte
	mode       fs.FileMode
	root       map[string]json.RawMessage
	perms      map[string]json.RawMessage
	allow      []json.RawMessage
	hasAllow   bool
}

// rules son las reglas de `allow` que son texto; las entradas de otro tipo no
// se tocan pero tampoco pueden ser nuestras.
func (f *agySettings) rules() []string {
	out := make([]string, 0, len(f.allow))
	for _, raw := range f.allow {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			out = append(out, s)
		}
	}
	return out
}

func loadAgySettings(path string) (*agySettings, error) {
	if path == "" {
		return &agySettings{}, errNoAgyPath()
	}
	f := &agySettings{root: map[string]json.RawMessage{}, perms: map[string]json.RawMessage{}, mode: 0o600}

	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		f.exists, f.data = true, data
		if info, err := os.Stat(path); err == nil {
			f.mode = info.Mode().Perm()
		}
	case os.IsNotExist(err):
		return f, nil
	default:
		return f, i18n.Errorf(i18n.Msg{ES: "mcpconf: leyendo %q: %w", EN: "mcpconf: reading %q: %w"}, path, err)
	}

	// Algunos editores de Windows anteponen un BOM, que json.Unmarshal no
	// acepta.
	body := bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if len(bytes.TrimSpace(body)) == 0 {
		return f, nil
	}
	f.unreadable = true
	if err := json.Unmarshal(body, &f.root); err != nil {
		return f, i18n.Errorf(i18n.Msg{ES: "mcpconf: %q no se pudo leer como JSON, no se toca: %w", EN: "mcpconf: %q couldn't be read as JSON, leaving it untouched: %w"}, path, err)
	}
	if f.root == nil {
		f.root = map[string]json.RawMessage{}
	}
	if raw, ok := f.root["permissions"]; ok {
		if err := json.Unmarshal(raw, &f.perms); err != nil || f.perms == nil {
			return f, i18n.Errorf(i18n.Msg{ES: "mcpconf: el bloque permissions de %q no es un objeto, no se toca", EN: "mcpconf: the permissions block of %q isn't an object, leaving it untouched"}, path)
		}
	}
	if raw, ok := f.perms["allow"]; ok {
		if err := json.Unmarshal(raw, &f.allow); err != nil {
			return f, i18n.Errorf(i18n.Msg{ES: "mcpconf: permissions.allow de %q no es una lista, no se toca", EN: "mcpconf: permissions.allow of %q isn't a list, leaving it untouched"}, path)
		}
		f.hasAllow = true
	}
	f.unreadable = false
	return f, nil
}

// editAgyAllow aplica edit a las reglas de texto de `permissions.allow` y
// escribe solo si el resultado difiere. create indica si, con el archivo
// ausente, hay algo que crear.
func editAgyAllow(path string, edit func([]string) []string, create bool) (bool, error) {
	f, err := loadAgySettings(path)
	if err != nil {
		return false, err
	}
	current := f.rules()
	next := edit(current)
	if equalStrings(current, next) {
		// Nada que cambiar. Con el archivo ausente solo se crea si hay reglas.
		if f.exists || !create || len(next) == 0 {
			return false, nil
		}
	}

	// Se reconstruye `allow` conservando las entradas que no son texto y el
	// orden de las que sobreviven.
	rebuilt := make([]json.RawMessage, 0, len(next))
	left := map[string]int{}
	for _, s := range next {
		left[s]++
	}
	for _, raw := range f.allow {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			rebuilt = append(rebuilt, raw)
			continue
		}
		if left[s] > 0 {
			left[s]--
			rebuilt = append(rebuilt, raw)
		}
	}
	for _, s := range next {
		if left[s] > 0 {
			left[s]--
			enc, err := json.Marshal(s)
			if err != nil {
				return false, err
			}
			rebuilt = append(rebuilt, enc)
		}
	}

	if len(rebuilt) == 0 {
		// No dejar `"allow": []` ni un `permissions` vacío por haber quitado lo
		// último que había.
		delete(f.perms, "allow")
	} else {
		enc, err := json.Marshal(rebuilt)
		if err != nil {
			return false, err
		}
		f.perms["allow"] = enc
	}
	if len(f.perms) == 0 {
		delete(f.root, "permissions")
	} else {
		enc, err := json.Marshal(f.perms)
		if err != nil {
			return false, err
		}
		f.root["permissions"] = enc
	}

	out, err := marshalIndented(f.root)
	if err != nil {
		return false, err
	}
	if f.exists {
		if err := backup(path, f.data, f.mode); err != nil {
			return false, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, i18n.Errorf(i18n.Msg{ES: "mcpconf: creando el directorio de %q: %w", EN: "mcpconf: creating the directory of %q: %w"}, path, err)
	}
	if err := writeAtomic(path, out, f.mode); err != nil {
		return false, err
	}
	return true, nil
}

func errNoAgyPath() error {
	return i18n.Errorf(i18n.Msg{ES: "mcpconf: no se encontró el directorio home para ubicar la configuración de Antigravity", EN: "mcpconf: couldn't find the home directory to locate Antigravity's settings"})
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
