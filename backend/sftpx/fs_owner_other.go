//go:build !unix

package sftpx

import "os"

// localOwner is a no-op on non-unix platforms (Windows) — os.FileInfo there
// has no portable owner/group, and the SFTP transfer target is a POSIX host
// anyway. Ownership just shows blank for local files on Windows.
func localOwner(info os.FileInfo) (owner, group string) {
	return "", ""
}
