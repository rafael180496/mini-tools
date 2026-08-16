package agentctx

import "strings"

// Sistema `@` de referenciación unificado: cómo se nombra un recurso de la app
// dentro de un mensaje al agente.
//
// Este archivo tiene SOLO el parser y la tabla de políticas. La resolución vive
// en app_refs.go, que es donde están el vault, las conexiones y el cliente de
// git — meterlos acá invertiría las capas y ataría este paquete, que hoy es
// solo lectura de archivos, a media aplicación.
//
// **El resolvedor corre entero en Go.** El frontend manda la cadena `@...` tal
// cual la escribió el usuario y nunca resuelve nada por su cuenta: si
// resolviera, el contenido sensible ya habría cruzado el binding, que es
// justamente lo que la regla 9 de .claude/rules/technical.md evita.
//
// **Qué NO toca este parser.** El chat del módulo Git ya tenía un `@ruta`
// suelto, sin tipo, que inserta la RUTA de un archivo del repositorio y deja
// que el agente lo abra él mismo (gastar contexto pegando un archivo que el
// agente puede leer con una herramienta es peor que nombrárselo). Eso sigue
// igual: acá solo se reconocen las referencias CON tipo (`@tipo:valor`), así
// que `@backend/git/files.go` pasa de largo y `@file:backend/git/files.go` sí
// se expande.

// Tipos de referencia. Son los que entiende el resolvedor; cualquier otro
// `@algo:` se deja tal cual en el texto — un mensaje puede mencionar
// `http://…` o un `TODO:` sin que la app decida que es una referencia rota.
const (
	KindFile    = "file"
	KindDB      = "db"
	KindExplain = "explain"
	KindSSH     = "ssh"
	KindGit     = "git"
	KindNote    = "note"
)

// Ref es una referencia encontrada en el texto, sin resolver.
type Ref struct {
	// Raw es el texto exacto que la produjo (`@db:Prod/usuarios`), para poder
	// reemplazarlo en el mensaje sin volver a adivinar dónde estaba.
	Raw   string `json:"raw"`
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// Resolved es una referencia ya resuelta, lista para mostrarse como ficha en
// la UI y para inyectarse en el prompt.
type Resolved struct {
	Ref
	// Title es la etiqueta de la ficha ("Tabla SGCPRO.ACTIONS").
	Title string `json:"title"`
	// Body es EXACTAMENTE lo que se le va a mandar al agente. Se devuelve al
	// frontend para que la ficha lo pueda desplegar: una referencia que se
	// expande en silencio es indistinguible de una fuga, así que lo que sale
	// de la máquina tiene que poder verse antes de mandarlo.
	Body string `json:"body"`
	// Err explica por qué no se pudo resolver. La referencia se deja tal cual
	// en el mensaje: un error acá no cancela el turno, lo informa.
	Err string `json:"err,omitempty"`
	// Blocked marca que fue una POLÍTICA la que lo impidió y no una falla —
	// una nota privada, por ejemplo. Se muestra distinto porque la acción del
	// usuario es distinta: no hay nada que reintentar, hay algo que permitir.
	Blocked bool `json:"blocked,omitempty"`
}

// Policy describe qué inyecta cada tipo y qué NO. Es la tabla que el panel de
// ayuda del selector muestra tal cual: la promesa de seguridad de este sistema
// solo sirve si se puede leer antes de usarlo.
type Policy struct {
	Kind string `json:"kind"`
	// Syntax es la forma de escribirlo.
	Syntax string `json:"syntax"`
	// Injects es qué le llega al agente.
	Injects string `json:"injects"`
	// Never es lo que NUNCA cruza, aunque exista y la app lo tenga a mano.
	Never string `json:"never,omitempty"`
	// Available es si el tipo funciona en esta versión. Un tipo declarado y
	// todavía sin implementar se informa como tal en vez de fallar como si
	// fuera un error del usuario.
	Available bool `json:"available"`
}

// Policies es la tabla completa, en el orden en que se muestra.
func Policies() []Policy {
	return []Policy{
		{
			Kind:      KindFile,
			Syntax:    "@file:ruta/archivo.go",
			Injects:   "El contenido del archivo del repositorio abierto.",
			Never:     "Nada fuera del repositorio: una ruta que se escape se rechaza.",
			Available: true,
		},
		{
			Kind:      KindDB,
			Syntax:    "@db:Conexión/tabla",
			Injects:   "Columnas, tipos, clave primaria y claves foráneas de la tabla.",
			Never:     "Ninguna fila, ningún DSN, ningún usuario ni contraseña.",
			Available: true,
		},
		{
			Kind:      KindExplain,
			Syntax:    "@explain:last",
			Injects:   "El JSON del último plan de ejecución guardado para esa conexión.",
			Never:     "Los datos que devolvió la consulta.",
			Available: true,
		},
		{
			Kind:      KindGit,
			Syntax:    "@git:staged",
			Injects:   "El diff preparado del repositorio abierto (`git diff --staged`).",
			Available: true,
		},
		{
			Kind:      KindSSH,
			Syntax:    "@ssh:alias/last_error",
			Injects:   "Las últimas líneas de la terminal SSH activa.",
			Never:     "La contraseña ni la clave privada de la conexión.",
			// La terminal SSH streamea su salida al frontend y no la retiene:
			// no hay buffer del que leer todavía. Se declara acá igual para
			// que el tipo exista desde el primer día y no haya que rehacer el
			// registro después — ver la fase 5 del plan.
			Available: false,
		},
		{
			Kind:      KindNote,
			Syntax:    "@note:Título",
			Injects:   "El Markdown de la nota, solo si está marcada como visible para la IA.",
			Never:     "El contenido de una nota privada, bajo ninguna circunstancia.",
			// El módulo de notas llega en la fase 3.
			Available: false,
		},
	}
}

// knownKinds es el conjunto de tipos que el parser reconoce.
var knownKinds = map[string]bool{
	KindFile: true, KindDB: true, KindExplain: true, KindSSH: true, KindGit: true, KindNote: true,
}

// ParseRefs encuentra las referencias con tipo en un texto.
//
// Tolerante a fallos por diseño: un `@` suelto es texto, `@algo:` con un tipo
// que no conocemos es texto, y una referencia sin valor (`@db:`) es texto. Un
// mensaje a un agente es prosa, no una expresión — el parser que se pone
// exigente con la prosa termina rechazando mensajes válidos.
//
// El valor termina en el primer espacio, salto de línea o coma. Eso deja fuera
// los títulos con espacios (`@note:Mi nota`), que se escriben entre comillas:
// `@note:"Mi nota"`.
func ParseRefs(text string) []Ref {
	var out []Ref
	for i := 0; i < len(text); i++ {
		if text[i] != '@' {
			continue
		}
		// Una arroba pegada a otra cosa (un mail, `foo@bar`) no abre una
		// referencia: tiene que estar al principio o después de un separador.
		if i > 0 && !isBoundary(text[i-1]) {
			continue
		}
		rest := text[i+1:]
		colon := strings.IndexByte(rest, ':')
		if colon <= 0 {
			continue
		}
		kind := rest[:colon]
		if !knownKinds[kind] {
			continue
		}
		value, length := scanValue(rest[colon+1:])
		if value == "" {
			continue
		}
		raw := text[i : i+1+colon+1+length]
		out = append(out, Ref{Raw: raw, Kind: kind, Value: value})
		i += len(raw) - 1
	}
	return out
}

func isBoundary(b byte) bool {
	return b == ' ' || b == '\n' || b == '\t' || b == '(' || b == '[' || b == ','
}

// scanValue lee el valor de la referencia y devuelve además cuántos bytes
// ocupó en el texto original (que no es lo mismo cuando viene entre comillas).
func scanValue(s string) (value string, length int) {
	if strings.HasPrefix(s, `"`) {
		end := strings.IndexByte(s[1:], '"')
		if end < 0 {
			// Comilla sin cerrar: es texto, no una referencia a medio escribir
			// que haya que adivinar.
			return "", 0
		}
		return s[1 : 1+end], end + 2
	}
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case ' ', '\n', '\t', '\r', ',', ')', ']':
			return s[:i], i
		}
	}
	return s, len(s)
}
