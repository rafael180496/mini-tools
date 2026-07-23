package git

import "fmt"

// Tag operations.
//
// The distinction that matters throughout: a tag exists independently in the
// local repository and on each remote. Deleting it locally leaves it on the
// server and vice versa, which is the single most common surprise with tags —
// so local and remote deletion are separate methods with separate names,
// never one method with a boolean that quietly does both.

// CreateTag creates a tag at ref ("" = HEAD). A non-empty message makes it an
// annotated tag (a real object with a tagger and date); an empty one makes it
// lightweight (just a pointer). Annotated is what release tags should be, so
// the UI defaults to offering a message.
func (r *Runner) CreateTag(repoPath, name, ref, message string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("tag", name); err != nil {
		return err
	}

	args := []string{"tag"}
	if message != "" {
		args = append(args, "--annotate", "--message", message)
	}
	args = append(args, name)
	if ref != "" {
		if err := checkRefArg("referencia", ref); err != nil {
			return err
		}
		args = append(args, ref)
	}
	_, err = r.runLocal(root, args...)
	return err
}

// DeleteTag removes a tag from the local repository only. The remote copy, if
// any, is untouched — DeleteRemoteTag handles that.
func (r *Runner) DeleteTag(repoPath, name string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("tag", name); err != nil {
		return err
	}
	_, err = r.runLocal(root, "tag", "--delete", name)
	return err
}

// PushTag publishes a single tag to a remote.
func (r *Runner) PushTag(repoPath, remote, name string, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if remote == "" {
		remote = "origin"
	}
	if err := checkRefArg("remoto", remote); err != nil {
		return "", err
	}
	if err := checkRefArg("tag", name); err != nil {
		return "", err
	}
	// refs/tags/<name> rather than bare <name>: if a branch and a tag share a
	// name, the bare form is ambiguous and git may push the wrong one.
	return r.runNetwork(root, auth, "push", "--progress", remote, "refs/tags/"+name)
}

// DeleteRemoteTag removes a tag from a remote, leaving the local one alone.
//
// This is a genuinely destructive, hard-to-undo operation for anyone else who
// already fetched it: recreating the tag later at a different commit gives
// different people different ideas of what the tag means. The UI confirms it
// separately from local deletion for that reason.
func (r *Runner) DeleteRemoteTag(repoPath, remote, name string, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if remote == "" {
		remote = "origin"
	}
	if err := checkRefArg("remoto", remote); err != nil {
		return "", err
	}
	if err := checkRefArg("tag", name); err != nil {
		return "", err
	}
	return r.runNetwork(root, auth, "push", "--progress", remote, "--delete", "refs/tags/"+name)
}

// --- Branch upstream and remote deletion ------------------------------------

// SetUpstream binds a local branch to a remote-tracking branch, so plain
// `pull`/`push` know where to go and ahead/behind counts become meaningful.
//
// upstream is the full short form ("origin/main"), matching what the branch
// list already displays.
func (r *Runner) SetUpstream(repoPath, branch, upstream string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", branch); err != nil {
		return err
	}
	if err := checkRefArg("upstream", upstream); err != nil {
		return err
	}
	_, err = r.runLocal(root, "branch", "--set-upstream-to="+upstream, branch)
	return err
}

// UnsetUpstream removes the tracking relationship. Nothing is deleted — the
// remote branch stays, the local branch stays, they just stop being linked.
func (r *Runner) UnsetUpstream(repoPath, branch string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", branch); err != nil {
		return err
	}
	_, err = r.runLocal(root, "branch", "--unset-upstream", branch)
	return err
}

// DeleteRemoteBranch deletes a branch on the server (`git push --delete`).
//
// remoteBranch is the short form the UI shows ("origin/feature-x"); it is split
// here so callers never have to know the remote/branch separation. Deleting
// "origin/HEAD" is refused outright — it is a symbolic pointer to the default
// branch, not a branch, and removing it breaks bare `git clone` defaults for
// everyone.
func (r *Runner) DeleteRemoteBranch(repoPath, remoteBranch string, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if err := checkRefArg("rama remota", remoteBranch); err != nil {
		return "", err
	}

	remote, branch, ok := splitRemoteRef(remoteBranch)
	if !ok {
		return "", fmt.Errorf("%q no parece una rama remota (se esperaba algo como origin/main)", remoteBranch)
	}
	if branch == "HEAD" {
		return "", fmt.Errorf("%q no es una rama: es el puntero simbólico a la rama por defecto del remoto", remoteBranch)
	}
	return r.runNetwork(root, auth, "push", "--progress", remote, "--delete", branch)
}

// splitRemoteRef splits "origin/feature/x" into ("origin", "feature/x"). Only
// the FIRST separator is a boundary — branch names legitimately contain
// slashes, so splitting on the last one would mangle every nested branch name.
func splitRemoteRef(ref string) (remote, branch string, ok bool) {
	for i := 0; i < len(ref); i++ {
		if ref[i] == '/' {
			if i == 0 || i == len(ref)-1 {
				return "", "", false
			}
			return ref[:i], ref[i+1:], true
		}
	}
	return "", "", false
}

// RenameBranch renames a local branch in place.
//
// `git branch -m` rather than create-new-then-delete-old, which looks
// equivalent and is not: the move form preserves the branch's reflog and its
// upstream configuration, while create+delete silently drops both — the user
// would lose their `git reflog show <branch>` history and have to set the
// upstream again after every rename.
func (r *Runner) RenameBranch(repoPath, oldName, newName string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", oldName); err != nil {
		return err
	}
	if err := checkRefArg("nuevo nombre", newName); err != nil {
		return err
	}
	_, err = r.runLocal(root, "branch", "-m", oldName, newName)
	return err
}
