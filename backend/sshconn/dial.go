package sshconn

import (
	"fmt"

	"golang.org/x/crypto/ssh"
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
func Dial(dsn string) (*ssh.Client, error) {
	cp, err := parseDSN(dsn)
	if err != nil {
		return nil, err
	}
	config, err := clientConfig(cp)
	if err != nil {
		return nil, err
	}
	client, err := ssh.Dial("tcp", cp.addr, config)
	if err != nil {
		return nil, fmt.Errorf("sshconn: conectando: %w", err)
	}
	return client, nil
}
