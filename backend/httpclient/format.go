package httpclient

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

// Formatear el cuerpo (el botón "Beautify" de Postman) se hace en Go y no en
// el frontend por una razón concreta: el mismo formateador tiene que servir
// para el CUERPO QUE SE ESCRIBE y para la RESPUESTA QUE SE MUESTRA, y la
// respuesta puede pesar megabytes. Pasarla al webview, formatearla en JS y
// devolverla sería mover el doble de datos por el puente para un resultado
// idéntico.

// FormatBody devuelve el texto indentado según lang ("json" o "xml").
//
// Un texto que no parsea se devuelve **tal cual, sin error**: el caso normal
// de apretar el botón es un JSON a medio escribir, y vaciar el editor o
// tirar un cartel rojo por eso sería castigar el flujo de trabajo real. Se
// reporta con `ok=false` para que la UI pueda decir "no se pudo formatear"
// sin perder nada.
func FormatBody(lang, text string) (out string, ok bool) {
	switch strings.ToLower(lang) {
	case "json":
		return formatJSON(text)
	case "xml":
		return formatXML(text)
	default:
		return text, false
	}
}

func formatJSON(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return text, false
	}
	var buf bytes.Buffer
	// json.Indent en vez de Unmarshal+Marshal: preserva el ORDEN de las
	// claves. Un round-trip por map[string]any las reordena alfabéticamente
	// y convierte "formatear" en "reescribirme el cuerpo", que no es lo que
	// nadie pide al apretar el botón.
	if err := json.Indent(&buf, []byte(trimmed), "", "    "); err != nil {
		return text, false
	}
	return buf.String(), true
}

func formatXML(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return text, false
	}

	decoder := xml.NewDecoder(strings.NewReader(trimmed))
	// Entidades HTML sueltas (&nbsp;) hacen fallar al decoder estricto, y
	// aparecen seguido en respuestas reales. Se toleran: el objetivo es
	// indentar para poder leer, no validar el documento.
	decoder.Strict = false
	decoder.AutoClose = xml.HTMLAutoClose
	decoder.Entity = xml.HTMLEntity

	var buf bytes.Buffer
	encoder := xml.NewEncoder(&buf)
	encoder.Indent("", "    ")

	// Con Strict=false, un texto que no es XML ("no es xml") se decodifica
	// como un único nodo de texto y sale igual que entró — o sea que sin
	// esta bandera la función devolvía ok=true sin haber formateado nada, y
	// la UI diría "listo" sobre algo que no tocó. Se exige al menos un
	// elemento para llamarlo XML.
	sawElement := false

	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return text, false
		}
		if _, ok := tok.(xml.StartElement); ok {
			sawElement = true
		}
		if err := encoder.EncodeToken(tok); err != nil {
			return text, false
		}
	}
	if err := encoder.Flush(); err != nil {
		return text, false
	}

	formatted := buf.String()
	if !sawElement || strings.TrimSpace(formatted) == "" {
		return text, false
	}
	return formatted, true
}

// PrettyResponse formatea el cuerpo de una respuesta usando el lenguaje que
// el motor ya dedujo. Devuelve el original cuando no se puede.
func PrettyResponse(r *Response) string {
	if r == nil || r.Body == "" {
		return ""
	}
	out, ok := FormatBody(r.Lang, r.Body)
	if !ok {
		return r.Body
	}
	return out
}

// Describe arma la línea de resumen del panel de respuesta
// ("200 OK · 142 ms · 1.2 KB"). Vive en Go y no en la UI porque el formato
// de tamaño tiene que coincidir con el del historial y el de la exportación,
// y tres implementaciones del mismo redondeo terminan discrepando.
func Describe(r *Response) string {
	if r == nil {
		return ""
	}
	status := fmt.Sprintf("%d", r.Status)
	if r.StatusText != "" {
		status += " " + r.StatusText
	}
	return fmt.Sprintf("%s · %d ms · %s", status, r.DurationMs, HumanSize(r.SizeBytes))
}

// HumanSize formatea bytes en unidades binarias con un decimal.
func HumanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 3; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGT"[exp])
}
