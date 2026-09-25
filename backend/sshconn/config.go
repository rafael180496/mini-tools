// Package sshconn is SSH's native parallel path — same deliberate exception
// to .claude/rules/technical.md point 2 as backend/redisquery is for Redis:
// an interactive SSH terminal session isn't a database/sql connection, so
// it's driven by SessionManager here instead of db.PoolManager. Unlike
// Redis it has no pooled/reusable connection concept at all — a session is
// a stateful remote shell process, opened and torn down explicitly per
// terminal tab.
package sshconn

import (
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"

	"mini-tools/backend/db"
)

const dialTimeout = 10 * time.Second

// connParams is a parsed SSH DSN, resolved once per Open/Ping call by
// reusing db.ConnectorFor(db.DBTypeSSH).ParseDSN — the same URL shape
// sshConnector.BuildDSN (backend/db/ssh.go) produces, so this package never
// duplicates that parsing logic.
type connParams struct {
	addr            string
	user            string
	auth            string
	password        string
	privateKey      string
	passphrase      string
	agentForwarding bool
}

func parseDSN(dsn string) (*connParams, error) {
	connector, err := db.ConnectorFor(db.DBTypeSSH)
	if err != nil {
		return nil, err
	}
	params, err := connector.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	return &connParams{
		addr:            net.JoinHostPort(params["host"], params["port"]),
		user:            params["user"],
		auth:            params["auth"],
		password:        params["password"],
		privateKey:      params["privateKey"],
		passphrase:      params["passphrase"],
		agentForwarding: params["agentForwarding"] == "1",
	}, nil
}

// clientConfig builds cp's ssh.ClientConfig. HostKeyCallback deliberately
// never verifies the remote host key (ssh.InsecureIgnoreHostKey()) — same
// documented tradeoff support-lab makes for its own SSH connections
// (acceptable only on internal/trusted networks; there is no host-key
// pinning UI yet to configure otherwise).
//
// answerer contesta el diálogo keyboard-interactive y solo se usa en la auth
// por contraseña — ver password.go. Con auth por llave no se ofrece ese
// método a propósito: no hay ninguna contraseña guardada con que contestarlo,
// y ofrecerlo haría que el servidor preguntara algo que este cliente no
// puede responder.
func clientConfig(cp *connParams, answerer *promptAnswerer) (*ssh.ClientConfig, error) {
	var authMethods []ssh.AuthMethod
	switch cp.auth {
	case db.SSHAuthPassword:
		// El diálogo va PRIMERO y la contraseña suelta después, que es el
		// mismo orden que trae el ssh de OpenSSH por defecto
		// (PreferredAuthentications: …,keyboard-interactive,password). No es
		// por imitarlo: es la única forma de que el cambio de contraseña
		// llegue a pasar.
		//
		// Con `password` adelante, sshd corre la conversación PAM para ese
		// intento, la cierra al rechazarla, y el keyboard-interactive que
		// viene después lo contesta con un USERAUTH_FAILURE seco, sin
		// preguntar nada — x/crypto/ssh lo reporta como
		// "unexpected message type 51 (expected 60)" y el diálogo de la clave
		// vencida no aparece nunca. Al revés, la conversación arranca limpia y
		// es la que pide la contraseña actual y después la nueva.
		if answerer != nil {
			authMethods = append(authMethods, ssh.KeyboardInteractive(answerer.challenge))
		}
		authMethods = append(authMethods, ssh.Password(cp.password))
	case db.SSHAuthKey:
		signer, err := parsePrivateKey(cp.privateKey, cp.passphrase)
		if err != nil {
			return nil, err
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	default:
		return nil, fmt.Errorf("sshconn: método de autenticación desconocido %q", cp.auth)
	}

	return &ssh.ClientConfig{
		User:            cp.user,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         dialTimeout,
	}, nil
}

func parsePrivateKey(pemKey, passphrase string) (ssh.Signer, error) {
	if passphrase != "" {
		signer, err := ssh.ParsePrivateKeyWithPassphrase([]byte(pemKey), []byte(passphrase))
		if err != nil {
			return nil, fmt.Errorf("sshconn: parseando private key (con passphrase): %w", err)
		}
		return signer, nil
	}
	signer, err := ssh.ParsePrivateKey([]byte(pemKey))
	if err != nil {
		return nil, fmt.Errorf("sshconn: parseando private key: %w", err)
	}
	return signer, nil
}
