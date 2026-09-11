package httpclient

import "testing"

func TestDetectImport(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want ImportKind
	}{
		{"curl", `curl 'https://api.x/y' -H 'Accept: application/json'`, ImportCurl},
		{"url", "https://api.ejemplo.com/pedidos?page=2", ImportURL},
		{"raw", "POST /v1/pedidos HTTP/1.1\nHost: api.x\n\n{\"a\":1}", ImportRawHTTP},
		{"colección", `{"info":{"name":"Pedidos","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[{"name":"listar","request":{"method":"GET","url":"https://api.x/p"}}]}`, ImportPostmanCollection},
		{"entorno", `{"name":"dev","values":[{"key":"host","value":"https://dev.x","enabled":true}]}`, ImportPostmanEnvironment},
		{"volcado", `{"collections":[{"info":{"name":"A"},"item":[]}],"environments":[{"name":"dev","values":[]}]}`, ImportPostmanDump},
		{"nada", "hola qué tal", ImportUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := DetectImport([]byte(c.in))
			if got.Kind != c.want {
				t.Fatalf("kind = %q (motivo %q), se esperaba %q", got.Kind, got.Reason, c.want)
			}
			if got.Kind == ImportUnknown && got.Reason == "" {
				t.Fatal("un formato no reconocido tiene que decir por qué")
			}
		})
	}
}

// Una colección v1 se reconoce para poder decir qué hacer con ella: el
// mensaje es la única salida que tiene quien la pegó.
func TestDetectImportPostmanV1(t *testing.T) {
	got := DetectImport([]byte(`{"id":"x","name":"vieja","requests":[]}`))
	if got.Kind != ImportUnknown || got.Reason == "" {
		t.Fatalf("v1 debería quedar sin reconocer y con motivo, quedó %q / %q", got.Kind, got.Reason)
	}
}

func TestParseRawHTTP(t *testing.T) {
	req, err := ParseRawHTTP("POST /v1/pedidos HTTP/1.1\nHost: api.ejemplo.com\nContent-Type: application/json\n\n{\"total\":120}")
	if err != nil {
		t.Fatal(err)
	}
	if req.Method != "POST" {
		t.Fatalf("método = %q", req.Method)
	}
	if req.URL != "https://api.ejemplo.com/v1/pedidos" {
		t.Fatalf("url = %q", req.URL)
	}
	// El Host arma la URL y NO se repite como header: mandarlo dos veces es
	// la forma de que la petición llegue a un servidor distinto del que dice
	// la barra de direcciones.
	for _, h := range req.Headers {
		if h.Key == "Host" {
			t.Fatal("el Host no debería quedar como header")
		}
	}
	if req.Body.Mode != BodyRaw || req.Body.Raw != `{"total":120}` {
		t.Fatalf("cuerpo = %+v", req.Body)
	}
	if req.Body.RawLang != "json" {
		t.Fatalf("lenguaje del cuerpo = %q", req.Body.RawLang)
	}
}

func TestParseRawHTTPLocalhostSinTLS(t *testing.T) {
	req, err := ParseRawHTTP("GET /health\nHost: localhost:3000")
	if err != nil {
		t.Fatal(err)
	}
	if req.URL != "http://localhost:3000/health" {
		t.Fatalf("url = %q", req.URL)
	}
}

func TestParseRawHTTPRutaRelativaSinHost(t *testing.T) {
	if _, err := ParseRawHTTP("GET /health HTTP/1.1"); err == nil {
		t.Fatal("una ruta relativa sin Host no se puede resolver y tiene que fallar")
	}
}

func TestParsePostmanEnvironment(t *testing.T) {
	env, err := ParsePostmanEnvironment([]byte(`{"name":"dev","values":[
		{"key":"host","value":"https://dev.x","enabled":true},
		{"key":"token","value":"abc","type":"secret"},
		{"key":"viejo","value":"1"},
		{"key":"apagado","value":"2","enabled":false}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if env.Name != "dev" || len(env.Variables) != 4 {
		t.Fatalf("entorno = %+v", env)
	}
	if !env.Variables[1].Secret {
		t.Fatal("el type secret tiene que llegar cifrado a la bóveda")
	}
	// Sin el campo `enabled` (exports viejos) la variable vale: leerla como
	// deshabilitada importaría el entorno entero en gris.
	if !env.Variables[2].Enabled {
		t.Fatal("una variable sin el campo enabled tiene que quedar habilitada")
	}
	if env.Variables[3].Enabled {
		t.Fatal("enabled:false tiene que respetarse")
	}
}
