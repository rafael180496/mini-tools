//go:build unix

package sftpx

import (
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// localOwner resolves a local file's owner/group to names on unix (darwin,
// linux) via the underlying stat's UID/GID. Falls back to the numeric id if
// the name can't be looked up, and to "" if the platform stat isn't available.
func localOwner(info os.FileInfo) (owner, group string) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", ""
	}
	uid := strconv.FormatUint(uint64(st.Uid), 10)
	gid := strconv.FormatUint(uint64(st.Gid), 10)
	owner, group = uid, gid
	if u, err := user.LookupId(uid); err == nil {
		owner = u.Username
	}
	if g, err := user.LookupGroupId(gid); err == nil {
		group = g.Name
	}
	return owner, group
}
