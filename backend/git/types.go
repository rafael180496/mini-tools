// Package git is the Git client backend — a native parallel path in the same
// spirit as backend/sshconn (interactive terminal) and backend/sftpx (file
// transfer): a repository is not a database/sql connection, so it does not go
// through db.PoolManager.
//
// # Why exec instead of go-git
//
// Every operation shells out to the system `git` binary through Runner rather
// than using github.com/go-git/go-git. This was a deliberate call, not the
// path of least resistance:
//
//   - Binary size (.claude/rules/technical.md point 8): go-git pulls a large
//     dependency tree. exec adds zero bytes to a binary already at 51.2MB on
//     Windows, against an 80MB ceiling.
//   - Minimal dependencies (point 12): no new module enters go.mod for this.
//   - Auth — the deciding factor. The product needs OS credential helpers,
//     SSH agent, and PATs. The git binary implements all three correctly and
//     per-platform. go-git does not support OS credential helpers at all and
//     its ssh-agent support is partial, so go-git would mean reimplementing
//     the hardest part of this package with a worse result.
//   - Speed: for commit graphs and large diffs, git-in-C beats go-git.
//
// The cost of this tradeoff is a hard runtime dependency on git being
// installed. That is surfaced honestly rather than hidden: Probe() reports
// availability and version, and the frontend is expected to render a degraded
// state when git is missing instead of failing per-operation.
//
// # Secrets
//
// A PAT never reaches a command line or a remote URL (both leak into
// ~/.bash_history-equivalents, the process table, and .git/config). Tokens are
// fed to git through an askpass re-exec of this same binary — see auth.go.
package git

// Repository is one repository tracked in the sidebar. Path is the working
// tree root (the directory containing .git), not the .git directory itself.
// Group is the user-defined folder used to build the sidebar tree; empty means
// ungrouped.
type Repository struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	Group string `json:"group"`
}

// DiffStat is the line-level churn of a commit or a single file.
type DiffStat struct {
	FilesChanged int `json:"filesChanged"`
	Insertions   int `json:"insertions"`
	Deletions    int `json:"deletions"`
}

// CommitInfo is one node of the commit graph. Parents carries every parent
// hash in order, so the frontend can lay out merge lanes without a second
// call; Parents[0] is the first parent. Refs holds the decoration git itself
// resolved for this commit, already split by kind — Branches includes remote
// branches ("origin/main"), Tags are bare tag names.
//
// Stats is only populated when the log was requested with stats; otherwise it
// is the zero value. It is opt-in because --numstat roughly doubles the cost
// of walking a large history, and the graph view does not need it until a
// commit is selected.
type CommitInfo struct {
	Hash      string   `json:"hash"`
	ShortHash string   `json:"shortHash"`
	Author    string   `json:"author"`
	Email     string   `json:"email"`
	Date      string   `json:"date"` // RFC 3339, author date
	Subject   string   `json:"subject"`
	Body      string   `json:"body"`
	Parents   []string `json:"parents"`
	Branches  []string `json:"branches"`
	Tags      []string `json:"tags"`
	IsHead    bool     `json:"isHead"`
	Stats     DiffStat `json:"stats"`
}

// Branch is a local or remote-tracking branch. Ahead/Behind are counts against
// Upstream and are zero when there is no upstream configured.
type Branch struct {
	Name      string `json:"name"`
	Hash      string `json:"hash"`
	Upstream  string `json:"upstream"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	IsCurrent bool   `json:"isCurrent"`
	IsRemote  bool   `json:"isRemote"`
}

// Tag is an annotated or lightweight tag. Hash is the commit the tag resolves
// to (dereferenced for annotated tags, so it is always a commit and never a
// tag object).
type Tag struct {
	Name       string `json:"name"`
	Hash       string `json:"hash"`
	Annotated  bool   `json:"annotated"`
	Message    string `json:"message"`
	TaggerDate string `json:"taggerDate"`
}

// Remote is a configured remote. FetchURL and PushURL differ when the user has
// set a separate pushurl; both are reported so the UI never shows a URL the
// push would not actually use.
type Remote struct {
	Name     string `json:"name"`
	FetchURL string `json:"fetchUrl"`
	PushURL  string `json:"pushUrl"`
}

// Stash is one entry of the stash reflog. Ref is the addressable form
// ("stash@{0}") and is what every stash operation takes.
type Stash struct {
	Ref     string `json:"ref"`
	Index   int    `json:"index"`
	Branch  string `json:"branch"`
	Message string `json:"message"`
	Date    string `json:"date"`
}

// FileStatus is one entry of the working-tree status. IndexStatus and
// WorkStatus are the raw porcelain codes ('M', 'A', 'D', 'R', '?', ' ') for
// the staged and unstaged side respectively, so a file can legitimately appear
// as both staged and modified.
//
// OrigPath is set only for renames and copies, and holds the source path.
type FileStatus struct {
	Path        string `json:"path"`
	OrigPath    string `json:"origPath"`
	IndexStatus string `json:"indexStatus"`
	WorkStatus  string `json:"workStatus"`
	Staged      bool   `json:"staged"`
	Untracked   bool   `json:"untracked"`
}

// RepoStatus is the working-tree summary that drives the commit panel.
type RepoStatus struct {
	Branch     string       `json:"branch"`
	Upstream   string       `json:"upstream"`
	Ahead      int          `json:"ahead"`
	Behind     int          `json:"behind"`
	Detached   bool         `json:"detached"`
	Files      []FileStatus `json:"files"`
	HasChanges bool         `json:"hasChanges"`
}

// FileDiff is a unified diff for one file. Patch is the raw unified diff text
// — the frontend feeds it to CodeMirror's merge/diff view rather than the
// backend pre-parsing hunks, which keeps this layer thin and lets the editor
// own presentation.
//
// IsBinary is set when git refused to produce a textual diff; Patch is then
// empty and the UI must not try to render it as code.
type FileDiff struct {
	Path     string   `json:"path"`
	OrigPath string   `json:"origPath"`
	Patch    string   `json:"patch"`
	IsBinary bool     `json:"isBinary"`
	Stat     DiffStat `json:"stat"`
}

// AuthConfig describes how to authenticate a network operation. The zero value
// means "let git decide" — system credential helpers, ~/.gitconfig, and a
// running ssh-agent all still apply, which is the correct default for most
// users and the reason auth is opt-in rather than required.
//
// Token is write-only from the frontend's perspective: it is consumed to build
// the askpass environment and never stored, logged, or echoed back.
type AuthConfig struct {
	// Mode is "", "ssh", or "token". Empty defers entirely to git's own
	// credential resolution.
	Mode string `json:"mode"`

	// SSHKeyPath is an explicit private key (id_ed25519, id_rsa). Empty
	// falls back to ssh-agent and ~/.ssh/config, which is the common case.
	SSHKeyPath string `json:"sshKeyPath"`

	// SSHKeyPassphrase unlocks an encrypted key. Delivered through askpass,
	// never through the command line.
	SSHKeyPassphrase string `json:"sshKeyPassphrase"`

	// Username pairs with Token for HTTPS. Most forges ignore its value when
	// a PAT is used, but git still prompts for it, so it must be answerable.
	Username string `json:"username"`

	// Token is a Personal Access Token or password for HTTPS remotes.
	Token string `json:"token"`
}

// FetchOptions mirrors the fetch dropdown: fetch, --all, --tags, --prune.
type FetchOptions struct {
	Remote string `json:"remote"`
	All    bool   `json:"all"`
	Tags   bool   `json:"tags"`
	Prune  bool   `json:"prune"`
}

// PullOptions mirrors the pull dropdown: pull, --ff-only, --rebase,
// --rebase --autostash. FFOnly and Rebase are mutually exclusive; Rebase wins
// if both are set, matching git's own precedence.
type PullOptions struct {
	Remote    string `json:"remote"`
	Branch    string `json:"branch"`
	FFOnly    bool   `json:"ffOnly"`
	Rebase    bool   `json:"rebase"`
	Autostash bool   `json:"autostash"`
}

// PushOptions mirrors the push dropdown: push, --force, --force-with-lease,
// --no-verify. ForceWithLease is preferred over Force and takes precedence if
// both are set — losing someone else's commits should require asking for the
// strictly more dangerous flag alone, not getting it as a side effect.
type PushOptions struct {
	Remote         string `json:"remote"`
	Branch         string `json:"branch"`
	Force          bool   `json:"force"`
	ForceWithLease bool   `json:"forceWithLease"`
	NoVerify       bool   `json:"noVerify"`
	SetUpstream    bool   `json:"setUpstream"`
	Tags           bool   `json:"tags"`
}
