package git

import (
	"strconv"
	"strings"
)

// GetBranches returns local branches, and remote-tracking branches when
// includeRemote is set. for-each-ref is used rather than `git branch` because
// it takes an explicit format: `git branch` output is porcelain meant for
// humans and its column layout has changed between versions.
func (r *Runner) GetBranches(repoPath string, includeRemote bool) ([]Branch, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	refs := []string{"refs/heads"}
	if includeRemote {
		refs = append(refs, "refs/remotes")
	}

	// %(upstream:track) renders as "[ahead 2, behind 1]" or "[gone]"; parsing
	// it here avoids a second rev-list per branch, which on a repo with many
	// branches is the difference between one process and fifty.
	format := strings.Join([]string{
		"%(refname:short)",
		"%(objectname)",
		"%(upstream:short)",
		"%(upstream:track)",
		"%(HEAD)",
		"%(refname)",
	}, fieldSep)

	args := append([]string{"for-each-ref", "--format=" + format}, refs...)
	out, err := r.runLocal(root, args...)
	if err != nil {
		return nil, err
	}

	branches := []Branch{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, fieldSep)
		if len(f) < 6 {
			continue
		}
		// refs/remotes/origin/HEAD is a symbolic pointer, not a branch a user
		// can check out meaningfully — showing it in the tree is noise.
		if strings.HasSuffix(f[5], "/HEAD") {
			continue
		}
		b := Branch{
			Name:      f[0],
			Hash:      f[1],
			Upstream:  f[2],
			IsCurrent: f[4] == "*",
			IsRemote:  strings.HasPrefix(f[5], "refs/remotes/"),
		}
		b.Ahead, b.Behind = parseTrack(f[3])
		branches = append(branches, b)
	}
	return branches, nil
}

// parseTrack reads git's "[ahead 2, behind 1]" tracking summary. "[gone]" — an
// upstream that was deleted on the remote — yields zeros; the branch still has
// a configured upstream, and reporting divergence numbers for a ref that no
// longer exists would be meaningless.
func parseTrack(track string) (ahead, behind int) {
	track = strings.Trim(strings.TrimSpace(track), "[]")
	if track == "" || track == "gone" {
		return 0, 0
	}
	for _, part := range strings.Split(track, ",") {
		fields := strings.Fields(strings.TrimSpace(part))
		if len(fields) != 2 {
			continue
		}
		n, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		switch fields[0] {
		case "ahead":
			ahead = n
		case "behind":
			behind = n
		}
	}
	return ahead, behind
}

// GetTags returns tags newest-first. Annotated tags are dereferenced with
// "*" fields so Hash is always the commit the tag points at, never the
// intermediate tag object — the UI wants to place the tag on the graph.
func (r *Runner) GetTags(repoPath string) ([]Tag, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	format := strings.Join([]string{
		"%(refname:short)",
		"%(objectname)",
		"%(*objectname)",
		"%(objecttype)",
		"%(contents:subject)",
		"%(taggerdate:iso-strict)",
		"%(creatordate:iso-strict)",
	}, fieldSep)

	out, err := r.runLocal(root, "for-each-ref", "--format="+format, "--sort=-creatordate", "refs/tags")
	if err != nil {
		return nil, err
	}

	tags := []Tag{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(strings.TrimRight(line, "\r"), fieldSep)
		if len(f) < 7 {
			continue
		}
		t := Tag{
			Name:      f[0],
			Hash:      f[1],
			Annotated: f[3] == "tag",
			Message:   f[4],
		}
		// %(*objectname) is empty for a lightweight tag, where the tag ref
		// already points straight at the commit.
		if f[2] != "" {
			t.Hash = f[2]
		}
		if t.TaggerDate = f[5]; t.TaggerDate == "" {
			t.TaggerDate = f[6]
		}
		tags = append(tags, t)
	}
	return tags, nil
}

// GetRemotes returns configured remotes with their fetch and push URLs
// resolved separately, so the UI never shows a URL that push would not use.
func (r *Runner) GetRemotes(repoPath string) ([]Remote, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}
	out, err := r.runLocal(root, "remote", "-v")
	if err != nil {
		return nil, err
	}

	byName := map[string]*Remote{}
	var order []string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 3 {
			continue
		}
		name, url, kind := fields[0], fields[1], fields[2]
		rem, ok := byName[name]
		if !ok {
			rem = &Remote{Name: name}
			byName[name] = rem
			order = append(order, name)
		}
		// Redacted before it can reach the frontend — a remote URL may carry
		// an embedded PAT, see redactURL.
		switch kind {
		case "(fetch)":
			rem.FetchURL = redactURL(url)
		case "(push)":
			rem.PushURL = redactURL(url)
		}
	}

	remotes := make([]Remote, 0, len(order))
	for _, name := range order {
		remotes = append(remotes, *byName[name])
	}
	return remotes, nil
}

// RemoteURLRaw returns a remote's fetch URL without redaction, for the
// sidebar's "Copy Remote URL" action.
//
// Separate from GetRemotes on purpose. GetRemotes feeds the UI and must never
// carry a credential (see redactURL); this one exists because copying a URL is
// an explicit request for the real value, and handing back a redacted string
// would silently give the user something that does not work. Keeping them
// apart means the raw value is only produced when someone asked for it, never
// as a side effect of rendering a list.
func (r *Runner) RemoteURLRaw(repoPath, name string) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if err := checkRefArg("remoto", name); err != nil {
		return "", err
	}
	out, err := r.runLocal(root, "remote", "get-url", name)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// GetStashes returns the stash reflog. A repository with no stashes has no
// refs/stash at all, which git reports as an error on some commands — hence
// reading it through `stash list`, which is silent when empty.
func (r *Runner) GetStashes(repoPath string) ([]Stash, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	format := strings.Join([]string{"%gd", "%gs", "%aI"}, fieldSep)
	out, err := r.runLocal(root, "stash", "list", "--format="+format)
	if err != nil {
		return nil, err
	}

	stashes := []Stash{}
	for i, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(strings.TrimRight(line, "\r"), fieldSep)
		if len(f) < 3 {
			continue
		}
		s := Stash{Ref: f[0], Index: i, Message: f[1], Date: f[2]}
		// %gs reads "WIP on main: 1a2b3c message" or "On main: message";
		// pulling the branch out gives the sidebar something to group by.
		if idx := strings.Index(s.Message, ": "); idx > 0 {
			head := s.Message[:idx]
			head = strings.TrimPrefix(head, "WIP on ")
			head = strings.TrimPrefix(head, "On ")
			s.Branch = head
		}
		stashes = append(stashes, s)
	}
	return stashes, nil
}

// GetCurrentBranch returns the checked-out branch, or an empty name with
// detached=true when HEAD points straight at a commit.
func (r *Runner) GetCurrentBranch(repoPath string) (name string, detached bool, err error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", false, err
	}
	out, err := r.runLocal(root, "symbolic-ref", "--short", "-q", "HEAD")
	if err != nil {
		// symbolic-ref fails by design on a detached HEAD; that is an answer,
		// not a failure.
		return "", true, nil
	}
	return strings.TrimSpace(out), false, nil
}
