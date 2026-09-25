package sshconn

import (
	"errors"
	"fmt"
	"strings"
)

// Una clave vencida no se rechaza: se conversa.
//
// Hasta acá el cliente ofrecía exactamente dos métodos de auth —`password` y
// `publickey` (ver clientConfig)— y ninguno de los dos sabe contestar un
// diálogo. Cuando la cuenta tiene la clave vencida, sshd con PAM rechaza el
// método `password` y deja abierto `keyboard-interactive` para correr el
// cambio ("Current password:" / "New password:" / "Retype new password:").
// Como ese método no estaba en la lista, x/crypto/ssh se quedaba sin nada que
// intentar y moría con
//
//	ssh: unable to authenticate, attempted methods [none password],
//	no supported methods remain
//
// que no nombra la clave vencida por ningún lado: el mismo texto sale con una
// clave simplemente equivocada. Quien lo leía se quedaba mirando un error de
// autenticación sin forma de saber que el servidor estaba *pidiendo* algo.

// ErrPasswordExpired marca el único caso que el usuario puede resolver sin
// salir de la app: el servidor pidió una contraseña nueva y no teníamos
// ninguna que darle. El frontend lo reconoce por el texto (mismo criterio que
// GitFileEditor.tsx con "cambió en el disco") para abrir el diálogo de cambio
// en vez de escupir el error crudo en la terminal.
var ErrPasswordExpired = errors.New("sshconn: el servidor pide cambiar la contraseña vencida")

// ErrNewPasswordRejected es el servidor diciendo que la contraseña nueva no
// le sirve (corta, en el diccionario, igual a una anterior). Se separa de un
// fallo de auth porque la acción que sigue es distinta: no hay que revisar
// credenciales, hay que elegir otra contraseña.
var ErrNewPasswordRejected = errors.New("sshconn: el servidor rechazó la contraseña nueva")

// ErrInteractiveRefused es el servidor ofreciendo el diálogo
// keyboard-interactive y cortándolo con un rechazo seco, sin llegar a
// preguntar nada. x/crypto/ssh no lo trata como un fallo de autenticación
// común sino como un error de protocolo —"unexpected message type 51
// (expected 60)": 51 es USERAUTH_FAILURE y 60 el INFO_REQUEST que esperaba—,
// y ese texto no le dice nada a nadie.
//
// Casi siempre es la cuenta y no la contraseña: expirada del todo (no solo su
// contraseña), bloqueada, o sin shell asignado. También sale cuando el sshd
// anuncia el método pero no tiene con qué atenderlo (UsePAM en no sin ningún
// otro dispositivo configurado).
var ErrInteractiveRefused = errors.New("sshconn: el servidor rechazó el diálogo interactivo sin preguntar nada (suele ser la cuenta bloqueada o vencida, no la contraseña)")

// ErrAuthRejected es el caso más común de todos y el que peor se leía: la
// contraseña guardada ya no es la del servidor.
//
// x/crypto/ssh lo reporta como "unable to authenticate, attempted methods
// [none keyboard-interactive password], no supported methods remain", que
// enumera protocolo y no menciona la contraseña por ningún lado. Leído así
// parece que falta soportar un método —y eso fue exactamente lo que se
// persiguió durante un buen rato— cuando lo que pasó es que alguien cambió la
// clave.
var ErrAuthRejected = errors.New("sshconn: el servidor rechazó la contraseña guardada")

// errChangeRequired aborta la conversación desde adentro del callback cuando
// el servidor pide una contraseña nueva y no hay ninguna configurada. Nunca
// sale de este paquete: dial lo traduce a ErrPasswordExpired mirando el
// estado del answerer, no el texto del error, porque x/crypto/ssh envuelve lo
// que devuelve el callback dentro de su propio "handshake failed".
var errChangeRequired = errors.New("sshconn: hace falta una contraseña nueva")

// promptAnswerer contesta UNA conversación keyboard-interactive.
//
// Tiene estado porque el diálogo llega repartido en varios mensajes del
// servidor —el pedido de la clave actual, el de la nueva y el de la
// confirmación son tres llamadas distintas al callback— y hay que acordarse
// de en cuál de los tres tramos se está.
type promptAnswerer struct {
	// password es la contraseña guardada en el vault: la respuesta a
	// cualquier prompt que no sea el de la contraseña nueva.
	password string
	// newPassword está vacío en un dial normal. Con valor, este dial ES el
	// cambio de clave (ver ChangePassword).
	newPassword string

	// expired queda en true apenas el servidor pide una contraseña nueva,
	// haya podido contestarse o no. Es lo que distingue "la clave está
	// vencida" de "la clave está mal", que desde el error de x/crypto/ssh se
	// ven idénticos.
	expired bool
	// newAnswers cuenta los prompts de contraseña nueva ya contestados. El
	// diálogo normal son dos (la nueva y su confirmación); un tercero
	// significa que el servidor la rechazó y está volviendo a preguntar.
	newAnswers int

	// instruction es el último texto explicativo que mandó el servidor
	// ("You are required to change your password immediately",
	// "BAD PASSWORD: it is too short"). Es lo único que explica POR QUÉ, así
	// que viaja dentro del error en vez de descartarse.
	instruction string
	// rejectedChange recuerda que el servidor devolvió el diálogo en vez de
	// aceptar la contraseña nueva. Es un bool y no el motivo en texto porque
	// el servidor puede rechazarla sin explicar nada, y ahí el motivo vacío
	// se leería como "no hubo rechazo".
	rejectedChange bool

	// asked son los prompts que el servidor llegó a hacer, en orden.
	//
	// Se guardan porque son la única evidencia de qué pasó cuando la auth
	// falla sin que aparezca ningún pedido de contraseña nueva, y los dos
	// desenlaces posibles se ven idénticos desde afuera: "el servidor pidió la
	// contraseña y no le gustó la que mandamos" (la guardada está mal o la
	// cuenta está bloqueada) y "el servidor no preguntó nada" (no llegó a
	// abrir el diálogo). x/crypto/ssh reporta las dos como
	// "no supported methods remain".
	//
	// Son los TEXTOS de las preguntas, nunca las respuestas: lo que el
	// servidor imprime en pantalla no es un secreto, lo que se teclea sí.
	asked []string

	// passwordAuth distingue la conexión por contraseña de la que va por
	// llave. Hace falta porque el answerer se arma siempre, aunque
	// clientConfig solo lo enganche en la primera: sin esto, un fallo de
	// autenticación por llave se explicaría hablando de una contraseña que esa
	// conexión ni siquiera tiene.
	passwordAuth bool
}

// challenge tiene la firma de ssh.KeyboardInteractiveChallenge.
func (p *promptAnswerer) challenge(_, instruction string, questions []string, echos []bool) ([]string, error) {
	if text := strings.TrimSpace(instruction); text != "" {
		p.instruction = text
	}

	answers := make([]string, len(questions))
	for i, question := range questions {
		if text := strings.TrimSpace(question); text != "" {
			p.asked = append(p.asked, text)
		}
		// Un prompt con eco no es un secreto (un usuario, el rótulo de un
		// token): no hay nada guardado con qué contestarlo, y mandarle la
		// contraseña sería escribirla en claro en la pantalla del servidor.
		if i < len(echos) && echos[i] {
			answers[i] = ""
			continue
		}

		if !isNewPasswordPrompt(question) {
			answers[i] = p.password
			continue
		}

		p.expired = true
		if p.newPassword == "" {
			return nil, errChangeRequired
		}
		if p.newAnswers >= 2 {
			// Tercera vuelta: el servidor no aceptó la contraseña nueva y
			// está reabriendo el diálogo. Repetir la misma respuesta gastaría
			// los intentos que quedan para terminar con el mismo error sin el
			// motivo, que es lo único aprovechable acá.
			p.rejectedChange = true
			return nil, errChangeRequired
		}
		p.newAnswers++
		answers[i] = p.newPassword
	}
	return answers, nil
}

// isNewPasswordPrompt decide si un prompt pide la contraseña NUEVA o la
// actual. Es una heurística sobre el texto y no puede ser otra cosa: el
// protocolo manda los prompts como cadenas para mostrarle a una persona, sin
// ningún campo que diga de cuál de las dos se trata.
//
// Por eso la lista incluye las dos formas en que llegan de verdad —el inglés
// de pam_unix y el español de un servidor localizado— y la confirmación
// ("retype", "vuelva a escribir") se trata igual que la nueva, porque la
// respuesta es la misma.
func isNewPasswordPrompt(question string) bool {
	q := strings.ToLower(question)
	for _, hint := range []string{
		"new password", "new unix password", "new bsd password",
		"nueva contraseña", "contraseña nueva", "nueva clave", "clave nueva",
		"retype", "re-enter", "reenter", "again", "confirm",
		"repita", "vuelva a", "de nuevo",
	} {
		if strings.Contains(q, hint) {
			return true
		}
	}
	return false
}

// reason devuelve el texto con el que el servidor explicó lo que pasa, listo
// para pegarse a un error. Vacío si no dijo nada.
func (p *promptAnswerer) reason() string {
	if p.instruction == "" {
		return ""
	}
	return ": " + p.instruction
}

// describe traduce un fallo de dial a algo accionable cuando el answerer sabe
// más que el error de x/crypto/ssh. Devuelve nil si no es uno de esos casos.
func (p *promptAnswerer) describe(err error) error {
	switch {
	case p.rejectedChange:
		return fmt.Errorf("%w%s", ErrNewPasswordRejected, p.reason())
	case p.expired && p.newPassword == "":
		return fmt.Errorf("%w%s", ErrPasswordExpired, p.reason())
	case p.passwordAuth && isAuthExhausted(err):
		return fmt.Errorf("%w%s [%v]", ErrAuthRejected, p.dialogHint(), err)
	case isInteractiveRefused(err):
		// El error crudo se conserva detrás de la traducción: es lo que sirve
		// para buscarlo, y tirarlo dejaría sin nada a quien venga a revisar
		// esto con la documentación del protocolo al lado.
		return fmt.Errorf("%w [%v]", ErrInteractiveRefused, err)
	default:
		return nil
	}
}

// dialogHint cuenta qué alcanzó a preguntar el servidor, para pegarlo a un
// fallo de autenticación que por sí solo no distingue una contraseña
// equivocada de una cuenta que no llegó a que le preguntaran nada.
//
// Vacío cuando el diálogo nunca se abrió: ahí el error genérico ya dice todo
// lo que se sabe, y agregarle "no preguntó nada" sobre un servidor que ni
// siquiera ofrece el método sería inventar un detalle.
func (p *promptAnswerer) dialogHint() string {
	if len(p.asked) == 0 {
		return ""
	}
	hint := fmt.Sprintf(" (preguntó %q", strings.Join(p.asked, " / "))
	if p.instruction != "" {
		hint += "; " + p.instruction
	}
	return hint + ")"
}

// isAuthExhausted reconoce el final del recorrido de métodos de x/crypto/ssh.
// Se mira el texto por lo mismo que en isInteractiveRefused: la librería lo
// arma con fmt.Errorf al terminar clientAuthenticate y no expone ningún tipo.
//
// Llegar ahí con auth por contraseña significa que el servidor probó lo que
// teníamos y dijo que no. Cualquier otro desenlace —la clave vencida, el
// diálogo rechazado, la contraseña nueva no aceptada— ya quedó atrapado en los
// casos anteriores de describe, que van primero justamente por eso.
func isAuthExhausted(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no supported methods remain")
}

// isInteractiveRefused reconoce el error de protocolo por su texto porque
// x/crypto/ssh no expone ningún tipo ni centinela para él: lo arma con
// fmt.Errorf en unexpectedMessageError (ssh/common.go). Los dos números son
// fijos —USERAUTH_FAILURE donde se esperaba INFO_REQUEST— y solo los produce
// el camino keyboard-interactive.
func isInteractiveRefused(err error) bool {
	return err != nil && strings.Contains(err.Error(), "unexpected message type 51 (expected 60)")
}
