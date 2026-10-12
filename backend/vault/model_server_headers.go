package vault

import (
	"strings"

	"mini-tools/backend/i18n"
)

// Cabeceras propias de un servidor de modelos (migración 60).
//
// Los NOMBRES no son secretos y se muestran; los VALORES sí (suelen ser una
// clave de gateway) y viajan cifrados en una sola columna, igual que el token.

const (
	maxModelServerHeaders     = 20
	maxModelServerHeaderName  = 100
	maxModelServerHeaderValue = 2000
)

// reservedModelServerHeaders son cabeceras que el cliente HTTP o el propio
// protocolo manejan: pisarlas rompe el request (Host, Content-Length,
// Transfer-Encoding…) o el stream (Content-Type, Accept). Authorization NO
// está acá: se permite salvo que el servidor tenga token (ver
// ValidateModelServerHeaders).
var reservedModelServerHeaders = map[string]bool{
	"host": true, "content-length": true, "content-type": true, "accept": true,
	"transfer-encoding": true, "connection": true, "upgrade": true, "te": true,
	"trailer": true, "keep-alive": true, "accept-encoding": true,
}

// ValidateModelServerHeaders valida y normaliza (nombres sin espacios) las
// cabeceras de un servidor. Reglas:
//
//   - el nombre es un token HTTP válido (RFC 7230), sin repetidos sin importar
//     mayúsculas;
//   - no puede ser una cabecera reservada (Host, Content-Length, Content-Type,
//     Accept, Transfer-Encoding, Connection…);
//   - `Authorization` solo se admite si el servidor NO tiene token: con token,
//     el cliente manda `Authorization: Bearer …` y una cabecera propia con ese
//     nombre es un choque que pisaría uno u otro en silencio;
//   - el valor no es vacío, no tiene saltos de línea ni otros caracteres de
//     control (inyección de cabeceras) y entra en el tope.
//
// tokenSet es si el servidor va a quedar con token.
func ValidateModelServerHeaders(headers map[string]string, tokenSet bool) (map[string]string, error) {
	if len(headers) == 0 {
		return nil, nil
	}
	if len(headers) > maxModelServerHeaders {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: demasiadas cabeceras (máximo %d)", EN: "vault: too many headers (maximum %d)"}, maxModelServerHeaders)
	}
	out := make(map[string]string, len(headers))
	seen := map[string]bool{}
	for rawName, value := range headers {
		name := strings.TrimSpace(rawName)
		if name == "" || len(name) > maxModelServerHeaderName || !isHeaderToken(name) {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: %q no es un nombre de cabecera válido (letras, números y - _ . solamente)", EN: "vault: %q is not a valid header name (letters, digits and - _ . only)"}, rawName)
		}
		lower := strings.ToLower(name)
		if reservedModelServerHeaders[lower] {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: la cabecera %q está reservada y no se puede definir", EN: "vault: the header %q is reserved and cannot be set"}, name)
		}
		if lower == "authorization" && tokenSet {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: el servidor ya tiene un token (se envía como Authorization): quitá el token o la cabecera Authorization", EN: "vault: the server already has a token (sent as Authorization): remove the token or the Authorization header"})
		}
		if seen[lower] {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: la cabecera %q está repetida", EN: "vault: the header %q is repeated"}, name)
		}
		seen[lower] = true
		if strings.TrimSpace(value) == "" {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: la cabecera %q no tiene valor", EN: "vault: the header %q has no value"}, name)
		}
		if len(value) > maxModelServerHeaderValue || hasControlChars(value) {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: el valor de la cabecera %q no es válido (muy largo o con saltos de línea / caracteres de control)", EN: "vault: the value of header %q is not valid (too long or with line breaks / control characters)"}, name)
		}
		out[name] = value
	}
	return out, nil
}

// isHeaderToken dice si s es un token del RFC 7230 (tchar).
func isHeaderToken(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0:
		default:
			return false
		}
	}
	return s != ""
}

// hasControlChars detecta CR, LF, NUL y demás controles (el tabulador sí vale).
func hasControlChars(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < 0x20 && c != '\t') || c == 0x7f {
			return true
		}
	}
	return false
}
