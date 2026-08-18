package agentctx

import (
	"fmt"
	"strings"
)

// Prompt del redactor de mensajes de commit (el botón mágico del panel de
// cambios en el módulo Git).
//
// Vive acá y no en el frontend por el mismo motivo que los prompts de
// consultas: lo que decide si la respuesta sirve es el CONTEXTO —el parche
// preparado, los archivos y el estilo de los commits que ya tiene el
// repositorio—, y ese contexto lo arma el backend. El frontend no ve un parche
// entero nunca, y armar el prompt allá obligaría a mandárselo.
//
// **Por qué se le pasa el diff en vez de pedirle que lo lea.** La versión
// anterior le decía "corré `git diff --staged`". Funcionaba a veces: dependía
// de que el CLI decidiera ejecutar el comando, de que lo hiciera en el
// directorio correcto y de cuánta salida se tragara. Pasarle el parche ya
// recortado hace la respuesta determinista y —lo que importa más— hace que se
// pueda DECIR qué se le mandó, que es la misma regla de privacidad que sigue el
// asistente de consultas.

// CommitDraftInput es el contexto determinista del commit preparado.
type CommitDraftInput struct {
	// Branch es la rama con el checkout puesto, tal cual la reportó git. Sirve
	// para dos cosas: el ticket suele estar en el nombre, y el nombre de la
	// rama muchas veces dice la intención que el diff solo insinúa.
	Branch string
	// Files son las líneas "XY  ruta" de los archivos EN EL STAGE, en el mismo
	// formato corto de git. Van completas aunque el diff se haya recortado: la
	// lista de archivos es barata y es lo que evita un mensaje que solo habla
	// de la mitad del commit.
	Files []string
	// Diff es el parche preparado (`git diff --staged`), posiblemente recortado.
	Diff string
	// DiffTruncated indica que Diff no es el parche completo. Se le dice al
	// agente en vez de callarlo: un mensaje escrito sobre medio commit se
	// escribe distinto si quien lo escribe sabe que le falta la otra mitad.
	DiffTruncated bool
	// Recent son los asuntos (primera línea) de los últimos commits del
	// repositorio, del más nuevo al más viejo. Es de dónde sale la convención:
	// ningún prompt puede saber mejor que el propio historial si este proyecto
	// escribe "feat(auth): ..." o "Arregla el login".
	Recent []string
	// Insertions/Deletions son el churn del commit preparado, para que la
	// respuesta sepa si está describiendo un cambio de una línea o una
	// refactorización de mil.
	Insertions int
	Deletions  int
}

// CommitPrompt arma el pedido de "escribí el mensaje de este commit".
//
// **No le pide que commitee, ni que stagee, ni que toque el repositorio.**
// Devuelve texto que se escribe en el campo del panel; apretar Commit sigue
// siendo del usuario, igual que ejecutar la consulta que escribe el asistente
// de SQL.
func CommitPrompt(in CommitDraftInput) string {
	var b strings.Builder
	b.WriteString("Escribí el mensaje del commit para los cambios YA PREPARADOS (staged) de este repositorio.\n\n")

	if in.Branch != "" {
		fmt.Fprintf(&b, "## Rama\n\n%s\n\n", in.Branch)
	}

	fmt.Fprintf(&b, "## Archivos preparados (%d, +%d/-%d)\n\n```\n%s\n```\n\n",
		len(in.Files), in.Insertions, in.Deletions, strings.Join(in.Files, "\n"))

	if len(in.Recent) > 0 {
		b.WriteString("## Últimos commits de este repositorio\n\n```\n" + strings.Join(in.Recent, "\n") + "\n```\n\n" +
			"Escribí en ESE estilo e idioma. Si esos mensajes siguen una convención (Conventional Commits, " +
			"prefijo de ticket, mayúscula inicial), seguila; si no siguen ninguna, usá Conventional Commits.\n\n")
	} else {
		b.WriteString("El repositorio no tiene historial todavía: usá Conventional Commits en español.\n\n")
	}

	b.WriteString("## Diff preparado\n\n```diff\n" + in.Diff + "\n```\n\n")
	if in.DiffTruncated {
		b.WriteString("**Este parche está recortado**: es el principio de un commit más grande. " +
			"Escribí el mensaje sobre TODOS los archivos de la lista de arriba, no solo sobre los que se ven acá. " +
			"Si necesitás ver el resto, leelo con `git diff --staged -- <archivo>` (solo lectura, no cambies nada).\n\n")
	}

	b.WriteString(`## Qué contestar

Respondé **solo con el mensaje del commit**, tal cual va a quedar guardado:

- Primera línea: resumen en imperativo, menos de 72 caracteres, sin punto final.
- Si el cambio lo amerita: una línea en blanco y un cuerpo breve que explique EL PORQUÉ, no el qué —
  el qué ya está en el diff. Un cambio de una línea no necesita cuerpo.
- Nada de markdown, ni comillas alrededor, ni bloques de código, ni "Mensaje:" adelante, ni ninguna
  explicación tuya después: lo que devolvés se escribe tal cual en el campo del mensaje.
- No lo commitees ni ejecutes nada que modifique el repositorio: el commit lo hace el usuario.
`)
	return b.String()
}

// CleanCommitMessage saca del texto del agente lo que no puede ir en un mensaje
// de commit.
//
// Existe porque el prompt pide el mensaje pelado y aun así los CLIs devuelven a
// veces el mismo mensaje envuelto en un bloque de código o entre comillas. Eso
// no es motivo para descartar la respuesta —lo que devolvió está bien, el
// envoltorio no—, y desenvolverlo acá es la diferencia entre un campo listo
// para commitear y uno que hay que editar a mano cada vez.
//
// Es deliberadamente conservador: solo pela envoltorios que reconoce y nunca
// reescribe el texto de adentro.
func CleanCommitMessage(answer string) string {
	msg := strings.TrimSpace(answer)

	// Bloque de código que ocupa toda la respuesta: se pela la primera y la
	// última cerca. Un bloque en el medio se deja como está — ahí el agente
	// contestó otra cosa, y recortarla escondería el problema.
	if strings.HasPrefix(msg, "```") {
		lines := strings.Split(msg, "\n")
		if len(lines) >= 2 && strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
			msg = strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
		}
	}

	// Comillas alrededor de todo el mensaje, solo si abren y cierran.
	for _, q := range []string{`"`, "'", "`"} {
		if len(msg) > 1 && strings.HasPrefix(msg, q) && strings.HasSuffix(msg, q) && !strings.Contains(msg[1:len(msg)-1], "\n"+q) {
			msg = strings.TrimSpace(msg[1 : len(msg)-1])
		}
	}

	// Etiqueta antes del mensaje ("Mensaje del commit:", "Commit message:").
	if i := strings.IndexByte(msg, '\n'); i > 0 {
		first := strings.ToLower(strings.TrimSpace(msg[:i]))
		if strings.HasSuffix(first, ":") && (strings.Contains(first, "mensaje") || strings.Contains(first, "commit message")) {
			msg = strings.TrimSpace(msg[i+1:])
		}
	}

	// Más de una línea en blanco seguida: git las conserva tal cual y el
	// mensaje queda con huecos que nadie escribió a propósito.
	for strings.Contains(msg, "\n\n\n") {
		msg = strings.ReplaceAll(msg, "\n\n\n", "\n\n")
	}
	return msg
}
