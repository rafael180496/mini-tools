package agentchat

import (
	"encoding/json"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// Texto que llega partido: por qué hace falta pegarlo a mano.
//
// **El síntoma.** En una respuesta aparecía `borrado l<?><?>gico` en vez de
// `lógico`: dos caracteres de reemplazo justo donde iba una vocal con tilde, y
// una sola vez en toda la respuesta.
//
// **La causa.** Los CLIs que transmiten en vivo mandan la respuesta en trozos
// (`text_delta`), y el corte cae donde cae — a veces **en el medio de un
// carácter**. Un carácter con tilde ocupa dos bytes en UTF-8: si el primer byte
// se va en un trozo y el segundo en el siguiente, cada trozo, por separado, es
// texto inválido. Y ahí está lo importante: `encoding/json` **reemplaza los
// bytes inválidos por U+FFFD al decodificar**, sin avisar. Para cuando el texto
// llega a una variable de Go, los bytes originales ya no existen y el daño no
// tiene arreglo.
//
// **La solución, en dos partes.** Primero se lee el texto del JSON
// preservando los bytes tal cual (`jsonRawString`), en vez de dejar que el
// decodificador los "arregle". Después se juntan los trozos y se retiene el
// pedazo de carácter que quedó colgando hasta que llegue su continuación
// (`utf8Stitcher`). Lo que sale ya es texto válido, siempre.
//
// Nada de esto cambia lo que se ve en pantalla cuando el corte no parte un
// carácter, que es el caso habitual: el texto pasa igual, trozo por trozo, y el
// chat se sigue viendo escribir en vivo.

// jsonRawString desarma una cadena JSON conservando sus bytes.
//
// Es deliberadamente lo mismo que hace el decodificador estándar **menos** la
// validación de UTF-8: acá un byte suelto no es un dato corrupto que haya que
// tapar, es la primera mitad de un carácter que todavía no llegó.
func jsonRawString(raw json.RawMessage) string {
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return ""
	}
	b := raw[1 : len(raw)-1]
	out := make([]byte, 0, len(b))

	for i := 0; i < len(b); i++ {
		if b[i] != '\\' {
			out = append(out, b[i])
			continue
		}
		i++
		if i >= len(b) {
			break
		}
		switch b[i] {
		case '"', '\\', '/':
			out = append(out, b[i])
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'u':
			if i+4 >= len(b) {
				return string(out)
			}
			v, err := strconv.ParseUint(string(b[i+1:i+5]), 16, 32)
			if err != nil {
				// Un escape roto se deja como estaba: perder el resto de la
				// respuesta por un carácter mal formado sería peor.
				out = append(out, '\\', 'u')
				continue
			}
			i += 4
			r := rune(v)
			// Un emoji viaja como PAR de escapes; leerlos por separado daría
			// dos caracteres inválidos en vez de uno correcto.
			if utf16.IsSurrogate(r) && i+6 < len(b) && b[i+1] == '\\' && b[i+2] == 'u' {
				if v2, err2 := strconv.ParseUint(string(b[i+3:i+7]), 16, 32); err2 == nil {
					if dec := utf16.DecodeRune(r, rune(v2)); dec != utf8.RuneError {
						r = dec
						i += 6
					}
				}
			}
			out = utf8.AppendRune(out, r)
		default:
			out = append(out, b[i])
		}
	}
	return string(out)
}

// utf8Stitcher junta los trozos y retiene el carácter que quedó a medias.
//
// Hay uno por flujo (respuesta y razonamiento van por separado): mezclarlos
// pegaría la mitad de un carácter del texto a la mitad de otro del
// razonamiento, que es peor que el problema original.
type utf8Stitcher struct {
	tail []byte
}

// Feed devuelve la parte que ya es texto válido y se guarda el resto.
func (s *utf8Stitcher) Feed(chunk string) string {
	b := make([]byte, 0, len(s.tail)+len(chunk))
	b = append(b, s.tail...)
	b = append(b, chunk...)
	s.tail = nil

	// Se mira hacia atrás como mucho lo que ocupa un carácter: más atrás no
	// puede haber uno cortado.
	for i := len(b) - 1; i >= 0 && i > len(b)-utf8.UTFMax; i-- {
		c := b[i]
		if c < utf8.RuneSelf {
			break // ASCII: nada quedó colgando.
		}
		if c&0xC0 == 0x80 {
			continue // Byte de continuación: el arranque está más atrás.
		}
		// Byte de arranque: se cuenta cuántos bytes pide el carácter.
		need := 2
		switch {
		case c&0xF8 == 0xF0:
			need = 4
		case c&0xF0 == 0xE0:
			need = 3
		}
		if len(b)-i < need {
			s.tail = append([]byte(nil), b[i:]...)
			b = b[:i]
		}
		break
	}
	return string(b)
}

// Flush devuelve lo que haya quedado sin completar, al terminar el turno.
//
// Se devuelve en vez de descartarse: si el flujo se cortó en el medio de un
// carácter, lo que hay es una respuesta truncada, y comerse el último byte en
// silencio escondería que se truncó.
func (s *utf8Stitcher) Flush() string {
	out := string(s.tail)
	s.tail = nil
	return out
}
