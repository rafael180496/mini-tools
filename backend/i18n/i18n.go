// Package i18n es la mitad Go del bilingüismo de la app (fase 7 de
// .claude/specs/i18n.md): los mensajes que el backend le devuelve a la
// interfaz —errores de los bindings, rótulos, avisos— y los prompts que se le
// mandan a un agente salen en el idioma que eligió el usuario.
//
// **Cada mensaje declara sus dos idiomas juntos** (`Msg{ES: …, EN: …}`), al
// lado del código que lo usa. No hay archivo de claves aparte: en Go no hay un
// compilador que valide que una clave existe, y un mensaje partido entre dos
// archivos es un mensaje que alguien actualiza en uno solo. Lo que el
// compilador no hace lo hace TestMessagesAreComplete: recorre el repo y falla
// si un Msg tiene un idioma vacío o los verbos de formato no coinciden.
//
// **Idioma global del proceso.** Es una app de escritorio de un solo usuario:
// el idioma es el de la ventana, no el de una petición. Se fija al arrancar
// (settings.language) y cambia con App.SetLanguage.
package i18n

import (
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
)

// Msg es un texto en los dos idiomas. Los verbos de formato (%s, %q, %w…)
// tienen que ser los mismos y en el mismo orden en ES y EN: los argumentos se
// pasan una sola vez.
type Msg struct {
	ES string
	EN string
}

var current atomic.Value // string: "en" | "es"

func init() { current.Store("en") }

// SetLang fija el idioma del proceso. Cualquier valor que no sea "es" —
// incluido "" (sin elegir)— es inglés, el default de la app.
func SetLang(lang string) {
	if lang != "es" {
		lang = "en"
	}
	current.Store(lang)
}

// Lang devuelve el idioma activo ("en" | "es").
func Lang() string { return current.Load().(string) }

// Text es el texto en el idioma activo, sin formatear.
func (m Msg) Text() string {
	if Lang() == "es" {
		return m.ES
	}
	return m.EN
}

// T formatea el mensaje en el idioma activo. Sin argumentos devuelve el texto
// tal cual, así un % literal no se interpreta.
func T(m Msg, args ...any) string {
	if len(args) == 0 {
		return m.Text()
	}
	return fmt.Sprintf(m.Text(), args...)
}

// Errorf es fmt.Errorf en el idioma activo: conserva %w, así que errors.Is y
// errors.As siguen funcionando sobre el error envuelto.
func Errorf(m Msg, args ...any) error {
	return fmt.Errorf(m.Text(), args...)
}

// lazyError resuelve su texto al leerse, no al crearse. Es lo que permite un
// `var ErrX = i18n.New(...)` de paquete: con errors.New el texto quedaría en
// el idioma del arranque para siempre.
type lazyError struct {
	m    Msg
	code string
}

func (e *lazyError) Error() string {
	if e.code != "" {
		return codePrefix(e.code) + e.m.Text()
	}
	return e.m.Text()
}

// New es errors.New con el texto en el idioma activo al momento de mostrarse.
// El valor es estable (sirve para errors.Is) aunque el idioma cambie.
func New(m Msg) error { return &lazyError{m: m} }

// NewCoded es New con un código estable que la interfaz puede reconocer sin
// mirar el texto (ver Code). Para los pocos errores ante los que la interfaz
// reacciona distinto: un conflicto al guardar, una contraseña vencida.
func NewCoded(code string, m Msg) error { return &lazyError{m: m, code: code} }

// El código viaja al principio del mensaje entre dos U+2063 (INVISIBLE
// SEPARATOR): un error de Go cruza el binding de Wails como string, sin tipo,
// así que el código tiene que ir en el texto — pero invisible, para que las
// decenas de pantallas que muestran `String(e)` sigan mostrando solo el
// mensaje. El frontend lo lee con errorCode() (frontend/src/i18n).
const codeMark = "⁣"

func codePrefix(code string) string { return codeMark + code + codeMark }

// Code devuelve el código de un error de NewCoded, o "" si no tiene. Busca en
// toda la cadena de Unwrap y también en el texto, por si el error se volvió a
// envolver con %v.
func Code(err error) string {
	var le *lazyError
	if errors.As(err, &le) && le.code != "" {
		return le.code
	}
	if err == nil {
		return ""
	}
	s := err.Error()
	i := strings.Index(s, codeMark)
	if i < 0 {
		return ""
	}
	j := strings.Index(s[i+len(codeMark):], codeMark)
	if j < 0 {
		return ""
	}
	return s[i+len(codeMark) : i+len(codeMark)+j]
}
