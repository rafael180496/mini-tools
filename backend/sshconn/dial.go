package sshconn

import (
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"

	"mini-tools/backend/db"
)

// Dial opens (and returns) a live SSH client for dsn, reusing the exact same
// parseDSN + clientConfig path as the interactive terminal (SessionManager)
// and PingSSHDSN — same InsecureIgnoreHostKey tradeoff, same password/key
// auth. The caller owns the returned *ssh.Client and MUST Close() it.
//
// This is the shared entry point the SFTP layer (backend/sftpx) dials
// through so it never re-implements DSN parsing or auth: an SFTP transfer is
// just another subsystem opened over this same SSH connection. Agent
// forwarding (a terminal-only concern) is deliberately not applied here.
//
// Si el servidor pide cambiar la contraseña, el error devuelto envuelve
// ErrPasswordExpired: quien llame puede distinguir "hay que cambiar la clave"
// de "la clave está mal", que en el error crudo de x/crypto/ssh se leen igual.
func Dial(dsn string) (*ssh.Client, error) {
	client, _, err := dial(dsn, "")
	return client, err
}

// ChangePassword corre el diálogo de cambio de contraseña del servidor y no
// deja nada abierto: es una autenticación completa cuyo único propósito es
// contestar los prompts de "New password" / "Retype new password" con
// newPassword. El cliente resultante se cierra acá mismo.
//
// No hay forma de cambiar una contraseña SSH sin autenticarse, y no hay forma
// de autenticarse con la contraseña vencida sin cambiarla — por eso el cambio
// y la conexión son la misma operación y no dos.
func ChangePassword(dsn, newPassword string) error {
	if strings.TrimSpace(newPassword) == "" {
		return fmt.Errorf("sshconn: la contraseña nueva no puede estar vacía")
	}

	client, answerer, err := dial(dsn, newPassword)
	if err != nil {
		return err
	}
	defer client.Close()

	// Autenticó sin que el servidor pidiera nada: la contraseña guardada
	// seguía sirviendo y no se cambió nada. Decirlo importa porque el llamador
	// va a guardar la contraseña nueva en el vault al recibir un nil, y ahí
	// quedaría guardada una que el servidor no conoce.
	if answerer.newAnswers == 0 {
		return fmt.Errorf("sshconn: el servidor no pidió cambiar la contraseña, así que no se cambió (la contraseña guardada sigue siendo válida)")
	}
	return nil
}

// dial es el camino único: parsea el DSN, arma la config con el answerer y
// conecta. Devuelve el answerer además del cliente porque lo que distingue
// una clave vencida de una equivocada no está en el error —x/crypto/ssh
// reporta las dos como "no supported methods remain"— sino en lo que el
// servidor llegó a preguntar durante el intento.
func dial(dsn, newPassword string) (*ssh.Client, *promptAnswerer, error) {
	cp, err := parseDSN(dsn)
	if err != nil {
		return nil, nil, err
	}

	answerer := &promptAnswerer{
		password:     cp.password,
		newPassword:  newPassword,
		passwordAuth: cp.auth == db.SSHAuthPassword,
	}
	config, err := clientConfig(cp, answerer)
	if err != nil {
		return nil, answerer, err
	}

	client, err := ssh.Dial("tcp", cp.addr, config)
	if err != nil {
		if described := answerer.describe(err); described != nil {
			return nil, answerer, described
		}
		return nil, answerer, fmt.Errorf("sshconn: conectando: %w", err)
	}
	return client, answerer, nil
}
