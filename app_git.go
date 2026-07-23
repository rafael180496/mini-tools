package main

import (
	"fmt"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/git"
	"mini-tools/backend/vault"
)

// Git module bindings.
//
// These live in their own file rather than inside app.go's ~2500 lines purely
// for readability — Wails binds every exported method on *App regardless of
// which file declares it, so this is the same binding surface documented in
// .claude/specs/go-react-contract.md.
//
// Two invariants hold for every method here:
//
//   - requireUnlocked first, without exception (.claude/rules/technical.md
//     point 5). The repository list is user data even though it holds no
//     credential.
//   - The frontend addresses repositories by opaque ID, never by path. gitRepo
//     below is the single place an ID becomes a filesystem path, mirroring the
//     connection-ID indirection the rest of the app already uses.

// gitRepo resolves an opaque repository ID to its on-disk path, after the gate
// check. Every operation below funnels through it.
func (a *App) gitRepo(repoID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	repo, err := a.vault.GetGitRepo(repoID)
	if err != nil {
		return "", err
	}
	return repo.Path, nil
}

// resolveGitAuth turns an empty AuthConfig into a stored-token one when the
// vault has a credential for the remote's host.
//
// This is where the auth machinery in backend/git actually gets used. The
// frontend never sends a token — it does not have one, by design — so it
// always passes the zero value, and this fills it in from the vault. When
// nothing is stored the zero value is passed through unchanged, which means
// "let git resolve credentials itself" (OS keychain, credential helper,
// ssh-agent) — the correct default and the reason a missing credential is not
// an error here.
//
// An explicitly-provided Mode is never overridden, so a future dialog that
// supplies a one-off key or token still wins.
func (a *App) resolveGitAuth(repoID, remote string, explicit git.AuthConfig) git.AuthConfig {
	if explicit.Mode != "" {
		return explicit
	}
	path, err := a.gitRepo(repoID)
	if err != nil {
		return explicit
	}
	if remote == "" {
		remote = "origin"
	}
	rawURL, err := a.gitRunner.RemoteHost(path, remote)
	if err != nil {
		return explicit
	}
	username, token, err := a.vault.GitToken(vault.NormalizeGitHost(rawURL))
	if err != nil {
		// Includes vault.ErrNoGitCredential — nothing stored is normal.
		return explicit
	}
	return git.AuthConfig{Mode: "token", Username: username, Token: token}
}

// --- Identity (user.name / user.email) --------------------------------------

// GitIdentity reports the author identity for a repository at both scopes,
// plus which one is actually in effect. See git.Identity.
func (a *App) GitIdentity(repoID string) (*git.Identity, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetIdentity(path)
}

// GitSetIdentity writes user.name/user.email. global=true targets ~/.gitconfig
// (every repository without a local override); false targets this repository
// only. An empty value unsets the key rather than storing an empty string —
// see git.Runner.SetIdentity.
func (a *App) GitSetIdentity(repoID, name, email string, global bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.SetIdentity(path, name, email, global)
}

// --- Stored tokens ----------------------------------------------------------

// GitListCredentials returns the stored hosts and usernames. It never returns
// a token — see vault.GitCredential.
func (a *App) GitListCredentials() ([]vault.GitCredential, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListGitCredentials()
}

// GitSaveCredential stores (or replaces) a Personal Access Token for a host.
// host accepts a bare hostname or a full clone URL — it is normalised before
// storage, so pasting a URL from the browser works.
//
// The token is encrypted at rest with the vault key (AES-256-GCM, same
// column-level scheme as connections.encrypted_dsn) and is never read back to
// the frontend.
func (a *App) GitSaveCredential(host, username, token string) (*vault.GitCredential, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SaveGitCredential(host, username, token)
}

func (a *App) GitDeleteCredential(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteGitCredential(id)
}

// GitSetPaneWidths persists the Git tab's left/right pane widths after a drag.
// Values are clamped server-side (see vault.SetGitPaneWidths) so a bad width
// cannot leave the layout unusable across restarts.
func (a *App) GitSetPaneWidths(sideWidth, diffWidth int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetGitPaneWidths(sideWidth, diffWidth)
}

// GitSetDiffPrefs persists the diff viewer's display preferences (context
// lines, ignore-whitespace, wrap). Clamped server-side, see
// vault.SetGitDiffPrefs.
func (a *App) GitSetDiffPrefs(context int, ignoreWs, wrap bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetGitDiffPrefs(context, ignoreWs, wrap)
}

// --- Availability ----------------------------------------------------------

// GitProbe reports whether the system git binary was found and its version.
//
// Not gated: it reveals nothing about the user's data, and the frontend needs
// it to decide whether to render the Git module at all — including on the
// unlock screen. Same reasoning as GetSettings/SetTheme's documented exception.
func (a *App) GitProbe() git.Availability {
	return a.gitRunner.Probe()
}

// GitRefreshProbe re-runs the lookup, so a user who installs git while the app
// is open can recover without restarting.
func (a *App) GitRefreshProbe() git.Availability {
	return a.gitRunner.Refresh()
}

// --- Repository registry ---------------------------------------------------

// GitListRepos returns the repositories in the sidebar, flat — the tree is
// built client-side from folderId, same as connections and snippets.
func (a *App) GitListRepos() ([]vault.GitRepo, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListGitRepos()
}

// GitPickRepoFolder opens the native folder picker and returns the chosen
// path, or "" if the user cancelled. It does not validate or persist anything
// — GitAddRepo does both.
func (a *App) GitPickRepoFolder() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Elegir carpeta del repositorio Git",
	})
}

// GitAddRepo validates that path is a git working tree and registers it.
//
// The path stored is the working-tree root git itself reports, not what the
// user picked: selecting a subdirectory of a repository adds the repository,
// which is what someone browsing to "myproject/src" actually means.
func (a *App) GitAddRepo(path string) (*vault.GitRepo, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	info, err := a.gitRunner.OpenRepository(path)
	if err != nil {
		return nil, err
	}
	return a.vault.AddGitRepo(info.Name, info.Path)
}

// GitCloneRepo clones url into targetPath and registers the result, so a
// successful clone lands in the sidebar without a second step.
func (a *App) GitCloneRepo(url, targetPath string, auth git.AuthConfig) (*vault.GitRepo, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	root, err := a.gitRunner.Clone(url, targetPath, auth)
	if err != nil {
		return nil, err
	}
	info, err := a.gitRunner.OpenRepository(root)
	if err != nil {
		return nil, err
	}
	return a.vault.AddGitRepo(info.Name, info.Path)
}

// GitRenameRepo changes the sidebar label only; nothing on disk moves.
func (a *App) GitRenameRepo(repoID, name string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.RenameGitRepo(repoID, name)
}

// GitMoveRepoToFolder reparents a repository in the sidebar tree ("" = root).
func (a *App) GitMoveRepoToFolder(repoID, folderID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.MoveGitRepoToFolder(repoID, folderID)
}

// GitRemoveRepo drops a repository from the sidebar. The working tree on disk
// is never touched — see vault.Store.RemoveGitRepo.
func (a *App) GitRemoveRepo(repoID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.RemoveGitRepo(repoID)
}

// --- History and refs ------------------------------------------------------

// GitLog walks the commit graph. Options carry the paging window and whether
// per-commit stats are wanted — see git.LogOptions.
func (a *App) GitLog(repoID string, opts git.LogOptions) ([]git.CommitInfo, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetCommitLog(path, opts)
}

func (a *App) GitBranches(repoID string, includeRemote bool) ([]git.Branch, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetBranches(path, includeRemote)
}

func (a *App) GitTags(repoID string) ([]git.Tag, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetTags(path)
}

// GitRemotes returns configured remotes. URLs come back with any embedded
// credential redacted — see git.redactURL.
func (a *App) GitRemotes(repoID string) ([]git.Remote, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetRemotes(path)
}

func (a *App) GitStashes(repoID string) ([]git.Stash, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetStashes(path)
}

func (a *App) GitStatus(repoID string) (*git.RepoStatus, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetStatus(path)
}

// --- Diffs -----------------------------------------------------------------

func (a *App) GitDiff(repoID string, target git.DiffTarget) (*git.FileDiff, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetDiff(path, target)
}

// GitChangedFiles lists what a commit touched, with per-file churn — the file
// list of the commit-detail panel. The diff for a specific file is fetched
// separately, only once the user selects it.
func (a *App) GitChangedFiles(repoID, commit string) ([]git.FileDiff, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return nil, err
	}
	return a.gitRunner.GetChangedFiles(path, commit)
}

// GitFileAtCommit returns a file's full contents at a commit, for the
// side-by-side view where both complete documents are needed.
func (a *App) GitFileAtCommit(repoID, commit, filePath string) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.GetFileAtCommit(path, commit, filePath)
}

// --- Remote operations -----------------------------------------------------

func (a *App) GitFetch(repoID string, opts git.FetchOptions, auth git.AuthConfig) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.Fetch(path, opts, a.resolveGitAuth(repoID, opts.Remote, auth))
}

func (a *App) GitPull(repoID string, opts git.PullOptions, auth git.AuthConfig) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.Pull(path, opts, a.resolveGitAuth(repoID, opts.Remote, auth))
}

func (a *App) GitPush(repoID string, opts git.PushOptions, auth git.AuthConfig) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.Push(path, opts, a.resolveGitAuth(repoID, opts.Remote, auth))
}

// --- Branching -------------------------------------------------------------

func (a *App) GitCheckout(repoID, name string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.CheckoutBranch(path, name)
}

func (a *App) GitCreateBranch(repoID, name, startPoint string, checkout bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.CreateBranch(path, name, startPoint, checkout)
}

// GitRenameBranch renames a local branch, preserving its reflog and upstream.
func (a *App) GitRenameBranch(repoID, oldName, newName string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.RenameBranch(path, oldName, newName)
}

// GitDeleteBranch removes a local branch. force maps to -D, which discards
// unmerged commits — the caller must have confirmed with the user first
// (ConfirmDialog, never window.confirm).
func (a *App) GitDeleteBranch(repoID, name string, force bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.DeleteBranch(path, name, force)
}

// GitSetUpstream binds a local branch to a remote-tracking branch.
func (a *App) GitSetUpstream(repoID, branch, upstream string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.SetUpstream(path, branch, upstream)
}

// GitUnsetUpstream unlinks a branch from its upstream. Nothing is deleted.
func (a *App) GitUnsetUpstream(repoID, branch string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.UnsetUpstream(path, branch)
}

// GitDeleteRemoteBranch deletes a branch on the server. remoteBranch is the
// short "origin/x" form the UI displays.
func (a *App) GitDeleteRemoteBranch(repoID, remoteBranch string, auth git.AuthConfig) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.DeleteRemoteBranch(path, remoteBranch, a.resolveGitAuth(repoID, "", auth))
}

// GitMerge joins a ref into the current branch.
func (a *App) GitMerge(repoID, ref string, noFF bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.Merge(path, ref, noFF)
}

// --- Tags ------------------------------------------------------------------

func (a *App) GitCreateTag(repoID, name, ref, message string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.CreateTag(path, name, ref, message)
}

// GitDeleteTag removes a tag locally only — the copy on the remote survives.
func (a *App) GitDeleteTag(repoID, name string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.DeleteTag(path, name)
}

func (a *App) GitPushTag(repoID, remote, name string, auth git.AuthConfig) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.PushTag(path, remote, name, a.resolveGitAuth(repoID, remote, auth))
}

// GitDeleteRemoteTag removes a tag from the remote only.
func (a *App) GitDeleteRemoteTag(repoID, remote, name string, auth git.AuthConfig) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.DeleteRemoteTag(path, remote, name, a.resolveGitAuth(repoID, remote, auth))
}

// --- History rewriting -----------------------------------------------------

// GitRevert creates a commit undoing another one — additive, always
// recoverable.
func (a *App) GitRevert(repoID, commit string, noCommit bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.Revert(path, commit, noCommit)
}

func (a *App) GitCherryPick(repoID, commit string, noCommit bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.CherryPick(path, commit, noCommit)
}

// GitReset moves the current branch to commit. mode is "soft", "mixed" or
// "hard"; "hard" destroys uncommitted work irrecoverably — the frontend
// confirms it separately from the other two. See git.Runner.Reset.
func (a *App) GitReset(repoID, commit, mode string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.Reset(path, commit, mode)
}

// GitInProgress reports "merge", "cherry-pick", "revert", "rebase" or "" —
// what lets the UI offer an abort instead of leaving the user stuck mid-conflict
// with no way out except the terminal.
func (a *App) GitInProgress(repoID string) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.InProgress(path)
}

// GitAbort backs out of whatever operation is in progress. op mirrors
// GitInProgress's return value.
func (a *App) GitAbort(repoID, op string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	switch op {
	case "merge":
		return a.gitRunner.MergeAbort(path)
	case "cherry-pick":
		return a.gitRunner.CherryPickAbort(path)
	case "revert":
		return a.gitRunner.RevertAbort(path)
	default:
		return fmt.Errorf("no se puede abortar %q desde acá", op)
	}
}

// --- Remotes management ----------------------------------------------------

func (a *App) GitAddRemote(repoID, name, url string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.AddRemote(path, name, url)
}

func (a *App) GitRenameRemote(repoID, oldName, newName string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.RenameRemote(path, oldName, newName)
}

func (a *App) GitSetRemoteURL(repoID, name, url string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.SetRemoteURL(path, name, url)
}

func (a *App) GitRemoveRemote(repoID, name string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.RemoveRemote(path, name)
}

// GitRemoteURLForCopy returns a remote's fetch URL unredacted, for the
// sidebar's "Copy Remote URL" action.
//
// This is the one deliberate exception to redaction: copying a URL is an
// explicit user request for the real value, and returning the redacted form
// would silently hand them a broken string. It is never used to populate the
// UI — GitRemotes stays redacted — so the raw value only ever exists for the
// duration of the clipboard write.
func (a *App) GitRemoteURLForCopy(repoID, name string) (string, error) {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return "", err
	}
	return a.gitRunner.RemoteURLRaw(path, name)
}

// --- Staging and committing ------------------------------------------------

func (a *App) GitStage(repoID string, paths []string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.StageFiles(path, paths)
}

func (a *App) GitStageAll(repoID string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.StageAll(path)
}

func (a *App) GitUnstage(repoID string, paths []string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.UnstageFiles(path, paths)
}

// GitDiscard throws away uncommitted work — unrecoverable, no reflog covers
// it. The frontend must confirm before calling.
func (a *App) GitDiscard(repoID string, paths []string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.DiscardChanges(path, paths)
}

// GitApplyPatch is how per-hunk and per-line staging works: the frontend
// builds a partial patch from the diff it is already displaying and git
// applies it to the index (cached) or reverses it in the working tree.
func (a *App) GitApplyPatch(repoID, patch string, cached, reverse bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.ApplyPatch(path, patch, cached, reverse)
}

func (a *App) GitCommit(repoID, message string, amend bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.Commit(path, message, amend)
}

// --- Stash -----------------------------------------------------------------

func (a *App) GitStashPush(repoID, message string, includeUntracked bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.StashPush(path, message, includeUntracked)
}

func (a *App) GitStashApply(repoID, ref string, drop bool) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.StashApply(path, ref, drop)
}

func (a *App) GitStashDrop(repoID, ref string) error {
	path, err := a.gitRepo(repoID)
	if err != nil {
		return err
	}
	return a.gitRunner.StashDrop(path, ref)
}
