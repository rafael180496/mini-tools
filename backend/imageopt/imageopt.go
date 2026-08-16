// Package imageopt valida y comprime las imágenes que se pegan en una nota.
//
// **Solo PNG y JPEG.** No es una limitación arbitraria: son los dos formatos
// que produce una captura de pantalla y una cámara, que es el 99% de lo que
// termina en una nota técnica. Los otros quedan afuera por motivos concretos —
// SVG es un documento con scripts adentro (pegarlo en una app que lo va a
// renderizar es una superficie de ataque, no una imagen), y GIF/WebP animados
// harían que "una captura" pese decenas de megabytes sin que nadie lo note.
//
// **La compresión no pierde calidad, y por eso trata distinto a cada formato:**
//
//   - **PNG se recomprime.** El formato es sin pérdida por definición: se
//     vuelve a codificar con el nivel máximo de compresión y se compara. La
//     imagen resultante tiene exactamente los mismos píxeles — lo único que
//     cambia es cuánto ocupa. Las capturas de pantalla suelen bajar bastante
//     porque las herramientas que las generan priorizan velocidad sobre tamaño.
//   - **JPEG se deja intacto, byte a byte.** Un JPEG ya está comprimido, y
//     **volver a codificarlo pierde calidad siempre**, incluso "al 100": el
//     formato es con pérdida y cada pasada agrega artefactos. Comprimir acá
//     sería justamente lo que el usuario pidió que no pasara.
//
// Y en los dos casos se valida por los **bytes mágicos** y no por lo que diga
// el navegador: un archivo puede declarar un tipo y ser otro, y esto es lo que
// después se va a decodificar para mostrarlo.
package imageopt

import (
	"bytes"
	"fmt"
	"image"
	"image/png"

	// Registran los decodificadores para image.DecodeConfig/Decode. El de GIF
	// no se importa a propósito: si no se puede decodificar, no se acepta.
	_ "image/jpeg"
)

// Result es la imagen ya validada y, si correspondía, comprimida.
type Result struct {
	// Data son los bytes que hay que guardar.
	Data []byte
	// Mime es el tipo real, deducido de los bytes.
	Mime string
	// OriginalSize es cuánto pesaba antes, para poder informar el ahorro.
	OriginalSize int
	// Width/Height, para poder mostrarlas y para dejar constancia de que la
	// imagen se decodificó de verdad (un archivo corrupto no llega hasta acá).
	Width  int
	Height int
	// Recompressed indica si se recomprimió (PNG) o se dejó igual (JPEG).
	Recompressed bool
}

// Saved es cuántos bytes se ahorraron.
func (r Result) Saved() int { return r.OriginalSize - len(r.Data) }

// Prepare valida y comprime. Devuelve un error explicando el motivo cuando el
// formato no se acepta — el mensaje se muestra tal cual, así que dice qué
// formato llegó y cuáles sirven.
func Prepare(raw []byte) (Result, error) {
	mime := sniff(raw)
	switch mime {
	case "image/png", "image/jpeg":
	case "":
		return Result{}, fmt.Errorf("eso no es una imagen PNG ni JPG")
	default:
		return Result{}, fmt.Errorf("solo se aceptan imágenes PNG y JPG, y esto es %s", mime)
	}

	// Se decodifica la configuración para confirmar que la imagen es válida y
	// para tener sus medidas. Un archivo que dice ser PNG pero está cortado
	// falla acá y no al mostrarlo.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return Result{}, fmt.Errorf("la imagen está dañada o incompleta: %w", err)
	}

	out := Result{Data: raw, Mime: mime, OriginalSize: len(raw), Width: cfg.Width, Height: cfg.Height}
	if mime != "image/png" {
		// JPEG: se deja tal cual. Ver el doc del paquete.
		return out, nil
	}

	smaller, err := recompressPNG(raw)
	if err != nil {
		// Un fallo recomprimiendo NO tira la operación: se guarda el original,
		// que es válido. Perder una captura por no haber podido optimizarla
		// sería cambiar un problema chico por uno grande.
		return out, nil
	}
	// Solo si realmente quedó más chica: una recompresión que agranda el
	// archivo es peor que no hacer nada.
	if len(smaller) < len(raw) {
		out.Data = smaller
		out.Recompressed = true
	}
	return out, nil
}

// recompressPNG vuelve a codificar con el nivel máximo. Sin pérdida: los
// píxeles decodificados son los mismos, cambia el flujo comprimido.
func recompressPNG(raw []byte) ([]byte, error) {
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// sniff deduce el tipo por los bytes mágicos.
//
// Por los bytes y no por lo que declare quien la manda: un archivo puede decir
// que es PNG y ser un SVG, y lo que se guarda acá después se decodifica para
// mostrarlo.
func sniff(b []byte) string {
	switch {
	case len(b) >= 8 && bytes.Equal(b[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png"
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 6 && (bytes.Equal(b[:6], []byte("GIF87a")) || bytes.Equal(b[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	case bytes.Contains(peek(b, 256), []byte("<svg")):
		return "image/svg+xml"
	}
	return ""
}

func peek(b []byte, n int) []byte {
	if len(b) < n {
		return b
	}
	return b[:n]
}
