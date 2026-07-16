package sshconn

import (
	"fmt"

	"golang.org/x/crypto/ssh"
)

// PingSSHDSN opens a short-lived SSH connection to verify dsn is reachable
// and its credentials are accepted, then closes it immediately — no shell
// or PTY opened. Mirrors db.PingRedisDSN's role for "Test Connection".
func PingSSHDSN(dsn string) error {
	cp, err := parseDSN(dsn)
	if err != nil {
		return err
	}
	config, err := clientConfig(cp)
	if err != nil {
		return err
	}

	client, err := ssh.Dial("tcp", cp.addr, config)
	if err != nil {
		return fmt.Errorf("sshconn: ping falló: %w", err)
	}
	return client.Close()
}
