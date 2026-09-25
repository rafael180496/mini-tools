package sshconn

import (
	"errors"
	"fmt"
)

// PingSSHDSN opens a short-lived SSH connection to verify dsn is reachable
// and its credentials are accepted, then closes it immediately — no shell
// or PTY opened. Mirrors db.PingRedisDSN's role for "Test Connection".
func PingSSHDSN(dsn string) error {
	client, _, err := dial(dsn, "")
	if err != nil {
		// Los errores que dial ya tradujo explican qué pasa y dicen qué hacer;
		// envolverlos en "ping falló" los empujaría al final de una frase que
		// empieza hablando de otra cosa.
		if errors.Is(err, ErrPasswordExpired) || errors.Is(err, ErrInteractiveRefused) || errors.Is(err, ErrAuthRejected) {
			return err
		}
		return fmt.Errorf("sshconn: ping falló: %w", err)
	}
	return client.Close()
}
