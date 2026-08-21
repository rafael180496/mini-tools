package httpclient

import (
	"errors"
	"strings"
)

// Importar un comando cURL pegado.
//
// Es la vía más corta desde "el navegador me dio esto" hasta "puedo
// modificarlo y reenviarlo": las herramientas de desarrollo de Chrome y
// Firefox ofrecen "Copy as cURL", y las APIs documentan sus ejemplos así.
//
// El parseo es propio y cubre las opciones que aparecen de verdad. Una
// opción desconocida se ignora en vez de fallar: un comando con `--compressed`
// o `--http2` sigue siendo perfectamente importable, y rechazarlo entero por
// una bandera que no cambia la petición sería hostil.

// ParseCurl traduce un comando cURL a una petición.
func ParseCurl(command string) (Request, error) {
	tokens, err := tokenizeShell(command)
	if err != nil {
		return Request{}, err
	}
	if len(tokens) == 0 {
		return Request{}, errors.New("no hay nada que importar")
	}
	if strings.ToLower(tokens[0]) == "curl" {
		tokens = tokens[1:]
	}

	req := Request{Settings: DefaultSettings(), Body: Body{Mode: BodyNone}, Auth: Auth{Type: AuthInherit}}
	var dataParts []string
	var formFields []FormField
	methodSet := false

	next := func(i *int) string {
		if *i+1 < len(tokens) {
			*i++
			return tokens[*i]
		}
		return ""
	}

	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		switch {
		case tok == "-X" || tok == "--request":
			req.Method = strings.ToUpper(next(&i))
			methodSet = true

		case tok == "-H" || tok == "--header":
			key, value, ok := strings.Cut(next(&i), ":")
			if ok {
				req.Headers = append(req.Headers, KeyValue{
					Key: strings.TrimSpace(key), Value: strings.TrimSpace(value), Enabled: true,
				})
			}

		case tok == "-d" || tok == "--data" || tok == "--data-raw" || tok == "--data-binary" || tok == "--data-ascii":
			dataParts = append(dataParts, next(&i))

		case tok == "--data-urlencode":
			dataParts = append(dataParts, next(&i))

		case tok == "-F" || tok == "--form":
			key, value, ok := strings.Cut(next(&i), "=")
			if !ok {
				continue
			}
			field := FormField{Key: key, Enabled: true, Type: "text", Value: value}
			// En cURL, un valor que empieza con @ es un archivo.
			if strings.HasPrefix(value, "@") {
				field.Type, field.Value = "file", strings.TrimPrefix(value, "@")
			}
			formFields = append(formFields, field)

		case tok == "-u" || tok == "--user":
			user, pass, _ := strings.Cut(next(&i), ":")
			req.Auth = Auth{Type: AuthBasic, Username: user, Password: pass}

		case tok == "-k" || tok == "--insecure":
			req.Settings.VerifyTLS = false

		case tok == "-L" || tok == "--location":
			req.Settings.FollowRedirects = true

		case tok == "--url":
			req.URL = next(&i)

		case tok == "-A" || tok == "--user-agent":
			req.Headers = append(req.Headers, KeyValue{Key: "User-Agent", Value: next(&i), Enabled: true})

		case tok == "-b" || tok == "--cookie":
			req.Headers = append(req.Headers, KeyValue{Key: "Cookie", Value: next(&i), Enabled: true})

		case tok == "-I" || tok == "--head":
			req.Method, methodSet = "HEAD", true

		case strings.HasPrefix(tok, "-"):
			// Opción desconocida. Si toma un valor no hay forma de saberlo
			// sin una tabla completa de cURL, así que se salta solo la
			// bandera: un valor suelto que quede se descarta más abajo por
			// no parecer una URL.
			continue

		default:
			if req.URL == "" && looksLikeURL(tok) {
				req.URL = tok
			}
		}
	}

	if req.URL == "" {
		return Request{}, errors.New("el comando no trae una URL reconocible")
	}

	switch {
	case len(formFields) > 0:
		req.Body = Body{Mode: BodyFormData, FormData: formFields}
	case len(dataParts) > 0:
		joined := strings.Join(dataParts, "&")
		req.Body = Body{Mode: BodyRaw, Raw: joined, RawLang: guessBodyLang(joined, req.Headers)}
	}

	// cURL usa POST implícito cuando hay cuerpo y no se pidió otro método —
	// replicar eso evita que una petición importada salga como GET con
	// cuerpo, que casi ningún servidor acepta.
	if !methodSet {
		if req.Body.Mode != BodyNone && req.Body.Mode != "" {
			req.Method = "POST"
		} else {
			req.Method = "GET"
		}
	}
	return req, nil
}

func looksLikeURL(s string) bool {
	// `{{baseUrl}}/pedidos` es una URL válida en este cliente y no tiene ni
	// esquema ni punto. Aparece en dos caminos reales: un comando que escribe
	// el agente (el prompt le pide justamente que use los marcadores en vez de
	// inventar valores) y uno copiado de la documentación de una colección.
	return strings.Contains(s, "://") || strings.Contains(s, "{{") ||
		strings.Contains(s, ".") || strings.HasPrefix(s, "localhost")
}

// guessBodyLang mira primero el Content-Type declarado y después la forma
// del cuerpo, en ese orden: lo que el comando dice explícitamente gana.
func guessBodyLang(body string, headers []KeyValue) string {
	for _, h := range headers {
		if !strings.EqualFold(h.Key, "content-type") {
			continue
		}
		ct := strings.ToLower(h.Value)
		switch {
		case strings.Contains(ct, "json"):
			return "json"
		case strings.Contains(ct, "xml"):
			return "xml"
		case strings.Contains(ct, "html"):
			return "html"
		}
	}
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return "json"
	}
	if strings.HasPrefix(trimmed, "<") {
		return "xml"
	}
	return "text"
}

// tokenizeShell parte el comando respetando comillas y continuaciones de
// línea.
//
// Es un tokenizador de shell mínimo, no una implementación de POSIX: cubre
// comillas simples, dobles, escapes y el `\` de fin de línea, que es todo lo
// que aparece en un comando copiado del navegador o pegado de una
// documentación. Lo que no cubre —expansión de variables, sustitución de
// comandos— no puede aparecer en algo que se pega para inspeccionar.
func tokenizeShell(input string) ([]string, error) {
	var tokens []string
	var cur strings.Builder
	var quote rune
	started := false

	runes := []rune(input)
	for i := 0; i < len(runes); i++ {
		c := runes[i]

		switch {
		case c == '\\' && i+1 < len(runes):
			nextRune := runes[i+1]
			// Barra al final de línea: continuación, no un carácter.
			if nextRune == '\n' || (nextRune == '\r' && i+2 < len(runes) && runes[i+2] == '\n') {
				i++
				if nextRune == '\r' {
					i++
				}
				continue
			}
			// Adentro de comillas simples la barra es literal, como en un
			// shell de verdad.
			if quote == '\'' {
				cur.WriteRune(c)
				started = true
				continue
			}
			cur.WriteRune(nextRune)
			started = true
			i++

		case quote != 0:
			if c == quote {
				quote = 0
				continue
			}
			cur.WriteRune(c)
			started = true

		case c == '\'' || c == '"':
			quote = c
			// Una cadena vacía entre comillas es un token válido.
			started = true

		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if started {
				tokens = append(tokens, cur.String())
				cur.Reset()
				started = false
			}

		default:
			cur.WriteRune(c)
			started = true
		}
	}
	if quote != 0 {
		return nil, errors.New("el comando tiene una comilla sin cerrar")
	}
	if started {
		tokens = append(tokens, cur.String())
	}
	return tokens, nil
}
