package httpclient

import (
	"reflect"
	"regexp"
	"sort"
	"strings"
)

// Resolución de variables `{{var}}`.
//
// # Dónde ocurre y por qué acá
//
// En Go, en el momento de enviar, y nunca al guardar: lo que se persiste es
// siempre el texto con `{{HOST}}` adentro. Resolver al guardar convertiría
// la petición en una copia congelada del entorno que estaba activo cuando se
// escribió, que es justo lo contrario de para qué existen los entornos.
//
// # Precedencia
//
// El orden es el de Postman —Local > Environment > Collection > Global— y no
// otro, porque estas colecciones vienen de ahí: una colección define el
// `HOST` por defecto y el entorno `dev` o `prod` lo pisa. Con la colección
// ganando, cambiar de entorno no haría nada.

// Variable es una fila de la tabla de variables de un entorno o de una
// colección.
type Variable struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
	// Secret marca lo que no se muestra en pantalla ni sale en un export.
	// Es una propiedad del DATO, no de la vista: si fuera solo de la vista,
	// exportar la colección filtraría el token igual.
	Secret bool `json:"secret"`
}

// VarScope es un nivel de la cadena de precedencia, con su nombre para poder
// decirle al usuario DE DÓNDE salió un valor.
type VarScope struct {
	// Label es lo que se muestra ("entorno «prod»", "colección «reservev3»").
	Label string     `json:"label"`
	Vars  []Variable `json:"vars"`
}

// varPattern acepta espacios adentro de las llaves (`{{ HOST }}`) porque
// Postman los tolera y aparecen en colecciones reales. El nombre no puede
// contener llaves, que es lo que evita que `{{a}}{{b}}` se lea como una sola
// variable llamada "a}}{{b".
var varPattern = regexp.MustCompile(`\{\{\s*([^{}\s]+)\s*\}\}`)

// Resolved es el resultado de resolver un texto.
type Resolved struct {
	Text string
	// Missing son los nombres que no se pudieron resolver, sin repetir y en
	// orden alfabético para que el mensaje de la UI sea estable.
	Missing []string
	// UsedSecret indica que se sustituyó al menos una variable secreta. Lo
	// usa la capa de arriba para saber que ese texto NO se puede archivar en
	// el historial ni mandarle a un agente.
	UsedSecret bool
}

// ResolveText sustituye las `{{var}}` de un texto usando los scopes en
// orden: el primero que defina el nombre gana.
//
// Una variable sin resolver se deja TAL CUAL (`{{HOST}}` sigue en el texto)
// en vez de reemplazarse por vacío. Vaciarla produciría una URL como
// `http:///dev/blocks` que falla con un error del transporte sin nombrar la
// causa; dejándola, el error dice literalmente qué faltó, y la UI puede
// marcarla en rojo antes de mandar.
func ResolveText(text string, scopes []VarScope) Resolved {
	out := Resolved{Text: text}
	if text == "" || !strings.Contains(text, "{{") {
		return out
	}

	missing := map[string]bool{}
	resolve := func(text string) string {
		return varPattern.ReplaceAllStringFunc(text, func(match string) string {
			name := strings.TrimSpace(varPattern.FindStringSubmatch(match)[1])
			for _, scope := range scopes {
				for _, v := range scope.Vars {
					if !v.Enabled || v.Key != name {
						continue
					}
					if v.Secret {
						out.UsedSecret = true
					}
					return v.Value
				}
			}
			missing[name] = true
			return match
		})
	}

	// Varias pasadas: el valor de una variable puede usar otra.
	// `baseUrl = {{protocol}}://{{host}}` es un patrón normal en las
	// colecciones de Postman, y con una sola pasada quedaba literal en la URL
	// **y sin aviso**: los nombres de adentro nunca estuvieron en el texto
	// original, así que tampoco aparecían como faltantes. El resultado era una
	// petición rota sin nada en pantalla que explicara por qué.
	//
	// El tope corta las circulares (`a = {{a}}`), que si no darían vueltas para
	// siempre. Cinco es holgado: encadenar más de cinco variables no es un caso
	// real, y lo que quede sin resolver se informa abajo.
	const maxPasses = 5
	out.Text = text
	for i := 0; i < maxPasses; i++ {
		next := resolve(out.Text)
		if next == out.Text {
			break
		}
		out.Text = next
	}

	// Lo que sigue teniendo llaves después de todas las pasadas se informa como
	// faltante, exista la variable o no: para quien mira la pantalla, una
	// circular y una sin definir son el mismo problema —un marcador que va a
	// viajar literal— y las dos se arreglan mirando el mismo lugar.
	for _, name := range VariableNames(out.Text) {
		missing[name] = true
	}

	for name := range missing {
		out.Missing = append(out.Missing, name)
	}
	sort.Strings(out.Missing)
	return out
}

// ResolveRequest devuelve la petición con todo sustituido: URL, params,
// variables de ruta, headers y cuerpo.
//
// Los nombres de los params y headers también se resuelven, no solo sus
// valores: `{{header_auth}}: {{token}}` aparece en colecciones reales, y
// resolver solo un lado dejaría un header con nombre literal `{{...}}`, que
// el servidor rechaza sin explicar por qué.
func ResolveRequest(req Request, scopes []VarScope) (Request, Resolved) {
	summary := Resolved{}

	apply := func(text string) string {
		r := ResolveText(text, scopes)
		summary.Missing = append(summary.Missing, r.Missing...)
		summary.UsedSecret = summary.UsedSecret || r.UsedSecret
		return r.Text
	}
	applyRows := func(rows []KeyValue) []KeyValue {
		if len(rows) == 0 {
			return rows
		}
		out := make([]KeyValue, len(rows))
		for i, r := range rows {
			out[i] = KeyValue{Key: apply(r.Key), Value: apply(r.Value), Enabled: r.Enabled, Description: r.Description}
		}
		return out
	}

	req.URL = apply(req.URL)
	req.Params = applyRows(req.Params)
	req.PathVars = applyRows(req.PathVars)
	req.Headers = applyRows(req.Headers)
	req.Body.Raw = apply(req.Body.Raw)
	req.Body.GraphQLQuery = apply(req.Body.GraphQLQuery)
	req.Body.GraphQLVariables = apply(req.Body.GraphQLVariables)

	// Sin repetidos y ordenado: la UI muestra esta lista, y un nombre que
	// falta en la URL y en un header no son dos problemas distintos.
	summary.Missing = dedupeSorted(summary.Missing)
	return req, summary
}

func dedupeSorted(names []string) []string {
	seen := map[string]bool{}
	var unique []string
	for _, n := range names {
		if seen[n] {
			continue
		}
		seen[n] = true
		unique = append(unique, n)
	}
	sort.Strings(unique)
	return unique
}

// ResolveAuthVars sustituye las `{{variables}}` en TODOS los campos de texto
// de una autenticación.
//
// Usa reflexión en vez de una lista de campos escrita a mano, y es
// deliberado: la lista a mano ya se desincronizó una vez —resolvía el token
// y la contraseña pero no la URL del servidor de OAuth, así que un
// `{{authHost}}/oauth/token` salía literal— y volvería a pasar en cuanto
// alguien agregue un campo. Con reflexión, un campo nuevo queda cubierto sin
// que nadie se acuerde.
//
// Dos exclusiones: Type es un discriminador (no un valor del usuario) y Raw
// es el JSON preservado de un tipo que no ejecutamos, que tiene que salir
// del export byte a byte como entró.
func ResolveAuthVars(a Auth, scopes []VarScope) Auth {
	if len(scopes) == 0 {
		return a
	}
	v := reflect.ValueOf(&a).Elem()
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if field.Type.Kind() != reflect.String {
			continue
		}
		if field.Name == "Type" || field.Name == "Raw" {
			continue
		}
		current := v.Field(i).String()
		if !strings.Contains(current, "{{") {
			continue
		}
		v.Field(i).SetString(ResolveText(current, scopes).Text)
	}
	return a
}

// MaskSecrets reemplaza por `***` los valores de las variables secretas que
// aparezcan en un texto ya resuelto.
//
// Es la última barrera antes de archivar en el historial o de mandarle un
// contexto a un agente: para entonces la sustitución ya ocurrió y el token
// está adentro del texto, así que no alcanza con "no mostrar la variable".
// Se buscan los valores, no los nombres.
func MaskSecrets(text string, scopes []VarScope) string {
	if text == "" {
		return text
	}
	for _, scope := range scopes {
		for _, v := range scope.Vars {
			// Un secreto de uno o dos caracteres enmascararía media URL:
			// esos no se buscan. No es una pérdida real — un token de dos
			// letras no es un token.
			if !v.Secret || len(v.Value) < 4 {
				continue
			}
			text = strings.ReplaceAll(text, v.Value, "***")
		}
	}
	return text
}

// VariableNames lista los nombres de `{{var}}` que aparecen en un texto, sin
// repetir. Lo usa la UI para pintar en rojo lo que no se va a resolver.
func VariableNames(text string) []string {
	matches := varPattern.FindAllStringSubmatch(text, -1)
	seen := map[string]bool{}
	var names []string
	for _, m := range matches {
		name := strings.TrimSpace(m[1])
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}
