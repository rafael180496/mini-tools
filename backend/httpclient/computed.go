package httpclient

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"hash"
	"strconv"
	"strings"
	"time"
)

// Variables calculadas: derivar un valor antes de enviar, sin JavaScript.
//
// # Por qué declarativo y no un motor JS
//
// Decisión del usuario (2026-08-21), tomada sobre una medición: goja suma
// +19,8 MB al binario y otto +15,1, contra un techo de 80 MB que el
// artefacto de Windows ya roza con 55,66. El caso que hacía falta cubrir —
// derivar un token con HMAC para firmar la petición— no necesita un
// lenguaje: necesita un algoritmo, una entrada y una clave.
//
// El costo honesto de esta decisión: un script existente no corre, hay que
// traducirlo. Lo que no se pueda expresar así queda guardado y se exporta
// intacto, con el aviso de que no se ejecuta.

// Operaciones disponibles.
const (
	OpHMACSHA1   = "hmac-sha1"
	OpHMACSHA256 = "hmac-sha256"
	OpHMACSHA512 = "hmac-sha512"
	OpSHA1       = "sha1"
	OpSHA256     = "sha256"
	OpSHA512     = "sha512"
	OpMD5        = "md5"
	OpBase64     = "base64"
	OpBase64URL  = "base64url"
	OpText       = "text"
)

// Encodings de salida para lo que produce un hash.
const (
	EncHex       = "hex"
	EncBase64    = "base64"
	EncBase64URL = "base64url"
)

// Computed es una variable derivada. Se evalúan EN ORDEN, y cada una queda
// disponible para las siguientes: así se puede armar una firma en dos pasos
// (primero el texto a firmar, después el HMAC) sin un lenguaje de por medio.
type Computed struct {
	// Name es la variable que produce; se usa como {{name}} en el resto.
	Name string `json:"name"`
	Op   string `json:"op"`
	// Input es una plantilla: admite {{variables}} y las dinámicas
	// ({{$timestamp}}, {{$isoTimestamp}}, {{$randomUUID}}).
	Input string `json:"input"`
	// Key solo aplica a las operaciones HMAC.
	Key string `json:"key,omitempty"`
	// Encoding de la salida de un hash. Vacío = hex.
	Encoding string `json:"encoding,omitempty"`
	Enabled  bool   `json:"enabled"`
}

// DynamicScope arma el nivel de variables dinámicas de esta ejecución.
//
// Se calculan UNA VEZ por envío y no por aparición: si {{$timestamp}} diera
// un valor distinto en la URL y en la firma, la firma no validaría nunca — y
// ese es exactamente el bug que este flujo existe para evitar.
func DynamicScope() VarScope {
	now := time.Now()
	uuid, err := randomUUID()
	if err != nil {
		uuid = ""
	}
	return VarScope{
		Label: "dinámicas",
		Vars: []Variable{
			{Key: "$timestamp", Value: strconv.FormatInt(now.Unix(), 10), Enabled: true},
			{Key: "$timestampMs", Value: strconv.FormatInt(now.UnixMilli(), 10), Enabled: true},
			{Key: "$isoTimestamp", Value: now.UTC().Format(time.RFC3339), Enabled: true},
			{Key: "$randomUUID", Value: uuid, Enabled: true},
			{Key: "$guid", Value: uuid, Enabled: true},
		},
	}
}

// EvaluateComputed calcula las variables derivadas y devuelve un scope con
// los resultados, listo para anteponerse a la cadena de precedencia.
//
// Los errores se devuelven junto con lo que SÍ se pudo calcular: una fila
// mal configurada no puede impedir que las otras tres funcionen, y la UI
// necesita poder decir cuál falló.
func EvaluateComputed(rows []Computed, scopes []VarScope) (VarScope, []string) {
	out := VarScope{Label: "calculadas"}
	var problems []string

	for _, row := range rows {
		if !row.Enabled || strings.TrimSpace(row.Name) == "" {
			continue
		}
		// Cada una ve las anteriores: el scope propio va primero.
		chain := append([]VarScope{out}, scopes...)
		input := ResolveText(row.Input, chain).Text
		key := ResolveText(row.Key, chain).Text

		value, err := computeOne(row, input, key)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", row.Name, err))
			continue
		}
		// Secreta siempre: lo que sale de acá es una firma o un token, y
		// marcarlo hace que quede enmascarado en el historial y fuera de un
		// export sin que el usuario tenga que acordarse.
		out.Vars = append(out.Vars, Variable{Key: row.Name, Value: value, Enabled: true, Secret: true})
	}
	return out, problems
}

func computeOne(row Computed, input, key string) (string, error) {
	switch row.Op {
	case OpText, "":
		return input, nil

	case OpBase64:
		return base64.StdEncoding.EncodeToString([]byte(input)), nil
	case OpBase64URL:
		return base64.RawURLEncoding.EncodeToString([]byte(input)), nil

	case OpMD5:
		sum := md5.Sum([]byte(input))
		return encodeSum(sum[:], row.Encoding), nil
	case OpSHA1:
		sum := sha1.Sum([]byte(input))
		return encodeSum(sum[:], row.Encoding), nil
	case OpSHA256:
		sum := sha256.Sum256([]byte(input))
		return encodeSum(sum[:], row.Encoding), nil
	case OpSHA512:
		sum := sha512.Sum512([]byte(input))
		return encodeSum(sum[:], row.Encoding), nil

	case OpHMACSHA1, OpHMACSHA256, OpHMACSHA512:
		if key == "" {
			return "", fmt.Errorf("%s necesita una clave", row.Op)
		}
		var newHash func() hash.Hash
		switch row.Op {
		case OpHMACSHA1:
			newHash = sha1.New
		case OpHMACSHA256:
			newHash = sha256.New
		default:
			newHash = sha512.New
		}
		mac := hmac.New(newHash, []byte(key))
		mac.Write([]byte(input))
		return encodeSum(mac.Sum(nil), row.Encoding), nil

	default:
		return "", fmt.Errorf("operación desconocida: %q", row.Op)
	}
}

func encodeSum(sum []byte, encoding string) string {
	switch encoding {
	case EncBase64:
		return base64.StdEncoding.EncodeToString(sum)
	case EncBase64URL:
		return base64.RawURLEncoding.EncodeToString(sum)
	default:
		return hex.EncodeToString(sum)
	}
}

// randomUUID genera un UUID v4 sin dependencias: son 16 bytes aleatorios con
// dos nibbles fijos, y traer una librería para eso sería exactamente el tipo
// de dependencia que este módulo viene evitando.
func randomUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // versión 4
	b[8] = (b[8] & 0x3f) | 0x80 // variante RFC 4122
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
