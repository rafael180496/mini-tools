package httpclient

import (
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Tarros de cookies, uno POR ENTORNO.
//
// **Por qué por entorno y no por colección** (decisión del usuario): probar
// producción y desarrollo a la vez es el caso normal en soporte, y las dos
// pruebas usan la MISMA colección. Un tarro por colección mezclaría la sesión
// de prod con la de dev en el mismo frasco: la segunda petición saldría con la
// cookie de la primera y el error resultante —una sesión que "se pisa sola"—
// es de los más difíciles de ver. Por entorno, cada destino tiene la suya.
//
// Sin entorno activo hay un tarro propio (`""`), no "ninguno": una petición
// suelta contra un login también recibe su cookie y la manda en la siguiente,
// que es lo que uno espera de un cliente HTTP.
//
// **En memoria, no en el vault.** Una cookie de sesión es una credencial viva;
// escribirla al disco obliga a cifrarla, a decidir cuándo caduca de verdad y a
// explicar por qué una sesión sobrevive a cerrar la aplicación. Que se pierdan
// al salir es el comportamiento defendible: se vuelve a hacer login, que es una
// petición más de la misma colección.

// JarStore guarda un tarro por entorno.
type JarStore struct {
	mu   sync.Mutex
	jars map[string]http.CookieJar
	// domains recuerda con qué hosts se habló en cada entorno. Hace falta
	// porque el tarro de la biblioteca estándar no se puede enumerar: solo
	// contesta "qué le mandarías a esta URL".
	domains map[string][]string
}

func NewJarStore() *JarStore {
	return &JarStore{jars: map[string]http.CookieJar{}, domains: map[string][]string{}}
}

// For devuelve el tarro de un entorno, creándolo la primera vez.
func (s *JarStore) For(envID string) http.CookieJar {
	s.mu.Lock()
	defer s.mu.Unlock()
	if jar, ok := s.jars[envID]; ok {
		return jar
	}
	// cookiejar.New con opciones nil no aplica la lista de sufijos públicos:
	// acepta una cookie de `.com` si un servidor la manda. Para un cliente de
	// pruebas contra APIs internas —donde los dominios suelen ser de una sola
	// etiqueta, `api`, `gateway`— esa es la política correcta, y la alternativa
	// (traerse la lista de sufijos públicos) suma un paquete al binario para
	// protegerse de un servidor al que el usuario le está apuntando a propósito.
	jar, err := cookiejar.New(nil)
	if err != nil {
		// cookiejar.New solo falla con opciones inválidas; con nil no puede.
		return nil
	}
	s.jars[envID] = jar
	return jar
}

// Cookie es una cookie guardada, para mostrarla y poder borrarla.
type Cookie struct {
	Domain string `json:"domain"`
	Name   string `json:"name"`
	Value  string `json:"value"`
	Path   string `json:"path"`
	Secure bool   `json:"secure"`
}

// List devuelve las cookies del entorno, agrupadas por dominio.
//
// `net/http/cookiejar` no expone su contenido: solo contesta "qué mandarías a
// esta URL". Así que se le pregunta por cada dominio del que se sabe algo — los
// que se registraron en `Note`. Es una limitación real de la biblioteca
// estándar, y la alternativa (escribir un tarro propio) es reimplementar las
// reglas de dominio y de caducidad de las cookies, que es exactamente donde uno
// se equivoca.
func (s *JarStore) List(envID string) []Cookie {
	s.mu.Lock()
	jar := s.jars[envID]
	domains := append([]string(nil), s.domains[envID]...)
	s.mu.Unlock()
	if jar == nil {
		return []Cookie{}
	}

	out := []Cookie{}
	seen := map[string]bool{}
	for _, d := range domains {
		for _, scheme := range []string{"https", "http"} {
			u := &url.URL{Scheme: scheme, Host: d, Path: "/"}
			for _, c := range jar.Cookies(u) {
				key := d + "\x00" + c.Name
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, Cookie{Domain: d, Name: c.Name, Value: c.Value, Path: "/", Secure: scheme == "https"})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Domain != out[j].Domain {
			return out[i].Domain < out[j].Domain
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// Note registra que se habló con un host, para poder listar después sus
// cookies. Lo llama el motor en cada envío.
func (s *JarStore) Note(envID, host string) {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.domains == nil {
		s.domains = map[string][]string{}
	}
	for _, d := range s.domains[envID] {
		if d == host {
			return
		}
	}
	s.domains[envID] = append(s.domains[envID], host)
}

// ClearDomain borra las cookies de un dominio en un entorno.
//
// Se hace caducando cada cookie conocida en vez de con un método del tarro:
// `net/http/cookiejar` no tiene forma de borrar, y una cookie con fecha pasada
// es exactamente cómo un servidor le pide al cliente que la olvide. El
// resultado es el mismo y no hay que sustituir la implementación entera.
func (s *JarStore) ClearDomain(envID, domain string) {
	cookies := s.List(envID)
	s.mu.Lock()
	jar := s.jars[envID]
	s.mu.Unlock()
	if jar == nil {
		return
	}
	expired := []*http.Cookie{}
	for _, c := range cookies {
		if domain != "" && c.Domain != domain {
			continue
		}
		expired = append(expired, &http.Cookie{
			Name: c.Name, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(1, 0),
		})
	}
	if len(expired) == 0 {
		return
	}
	target := domain
	if target == "" {
		// Sin dominio se limpian todos los conocidos, uno por uno.
		for _, d := range s.knownDomains(envID) {
			s.expireOn(jar, d, expired)
		}
		return
	}
	s.expireOn(jar, target, expired)
}

func (s *JarStore) expireOn(jar http.CookieJar, host string, expired []*http.Cookie) {
	for _, scheme := range []string{"https", "http"} {
		jar.SetCookies(&url.URL{Scheme: scheme, Host: host, Path: "/"}, expired)
	}
}

func (s *JarStore) knownDomains(envID string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.domains[envID]...)
}

// Reset tira el tarro entero de un entorno. Es lo que hace "cerrar sesión en
// todos lados": más simple y más confiable que caducar cookie por cookie.
func (s *JarStore) Reset(envID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.jars, envID)
	delete(s.domains, envID)
}
