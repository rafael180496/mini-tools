package git

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// Interactive rebase.
//
// `git rebase -i` is defined around opening an editor on a "todo" file and
// letting the user rewrite it. There is no flag that takes the todo list
// directly, so driving it programmatically means BEING that editor —
// GIT_SEQUENCE_EDITOR is re-executed by git with the todo path as its only
// argument, and whatever it leaves in that file is what runs.
//
// This re-executes our own binary as that editor, exactly the way
// backend/git/auth.go already re-executes it as the askpass helper. Same
// mechanism, same reason: no shell, no temp script, nothing on disk the user
// did not ask for.

const (
	envSequenceActive = "MINITOOLS_SEQUENCE_EDITOR"
	envSequenceTodo   = "MINITOOLS_SEQUENCE_TODO"
)

// RebaseAction is one line of the todo list.
type RebaseAction struct {
	// Command is pick / reword / edit / squash / fixup / drop.
	Command string `json:"command"`
	Hash    string `json:"hash"`
	// Subject is carried for display only; git ignores everything after the
	// hash on a todo line.
	Subject string `json:"subject"`
	// Message replaces the commit message for reword/squash. Applied through
	// a separate step, see RebaseTodo's doc.
	Message string `json:"message,omitempty"`
}

// IsSequenceEditorInvocation reports whether this process was re-executed by
// git as its sequence editor. main() must check it before anything else, the
// same way it checks IsAskpassInvocation.
func IsSequenceEditorInvocation() bool {
	return os.Getenv(envSequenceActive) == "1" && len(os.Args) > 1
}

// SequenceEditorMain writes the prepared todo list over the file git handed
// us and exits.
//
// Exits non-zero when the todo is missing, which git reads as "the editor
// failed" and aborts the rebase — the correct outcome. Silently leaving the
// original todo would instead replay every commit unchanged, which looks
// like the reorder simply did not happen.
func SequenceEditorMain() {
	todo := os.Getenv(envSequenceTodo)
	if todo == "" {
		fmt.Fprintln(os.Stderr, "mini-tools: no se preparó ninguna lista de rebase")
		os.Exit(1)
	}
	if err := os.WriteFile(os.Args[1], []byte(todo), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "mini-tools: no se pudo escribir la lista de rebase:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// RebaseTodo starts an interactive rebase onto base, applying actions in the
// order given.
//
// Two things are deliberately NOT done here:
//
//   - Rewording is left to the rebase stopping. A `reword` makes git open the
//     commit-message editor, which this process cannot provide; the
//     alternative — passing the new message through a second editor
//     re-exec — is doable but doubles the moving parts, so reword is
//     reported back to the caller as "the rebase stopped, edit the message
//     and continue" instead.
//   - No --autostash. Stashing on the user's behalf and popping it later is
//     the kind of helpfulness that loses work when the pop conflicts. A
//     dirty working tree is refused up front, with a message saying so.
func (r *Runner) RebaseTodo(repoPath, base string, actions []RebaseAction) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("base", base); err != nil {
		return err
	}
	if len(actions) == 0 {
		return fmt.Errorf("no hay ninguna acción de rebase que aplicar")
	}

	// A rebase rewrites history under the working tree; starting one with
	// uncommitted changes either refuses halfway or drags them along.
	// Refusing here means the message names the actual problem.
	status, err := r.GetStatus(root)
	if err != nil {
		return err
	}
	if status.HasChanges {
		return fmt.Errorf("hay cambios sin commitear: guardalos en un stash o commiteálos antes de reordenar la historia")
	}

	// The first line must be a pick or an edit: git rejects a todo that
	// starts with squash/fixup, because there is nothing before it to fold
	// into. Catching it here says why, instead of letting git fail with its
	// own wording after the rebase already started.
	if len(actions) > 0 && (actions[0].Command == "squash" || actions[0].Command == "fixup") {
		return fmt.Errorf("el primer commit de la lista no puede ser squash ni fixup: no hay ningún commit anterior con el que combinarlo")
	}

	var todo strings.Builder
	for _, a := range actions {
		switch a.Command {
		case "pick", "reword", "edit", "squash", "fixup", "drop":
		default:
			return fmt.Errorf("acción de rebase desconocida: %q", a.Command)
		}
		if err := checkRefArg("commit", a.Hash); err != nil {
			return err
		}
		todo.WriteString(a.Command)
		todo.WriteByte(' ')
		todo.WriteString(a.Hash)
		todo.WriteByte('\n')
	}

	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("no se pudo resolver el ejecutable para el editor de secuencia: %w", err)
	}

	env := []string{
		envSequenceActive + "=1",
		envSequenceTodo + "=" + todo.String(),
		"GIT_SEQUENCE_EDITOR=" + shellQuote(self),
		// core.editor still has to be neutralised: a reword or a squash
		// opens the MESSAGE editor, which is a different one from the
		// sequence editor and would hang with no terminal. `true` accepts
		// the message git already prepared.
		"GIT_EDITOR=true",
	}

	// runRaw needs a real context — it is the env-carrying variant, and the
	// convenience wrappers that build one (runLocal) do not take env.
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()

	_, err = r.runRaw(ctx, root, env, "rebase", "-i", base)
	return err
}

// Rebase replays the current branch's commits on top of another branch —
// the plain, non-interactive rebase, and the one people mean by "rebase
// feature onto develop".
//
// Kept apart from RebaseTodo, which exists to REORDER the current branch's
// own history: that one re-executes `rebase -i` with a scripted todo file
// and needs the sequence-editor re-exec. This one hands the work to git
// unchanged, so it needs none of that machinery — and conflating the two
// would drag a fake editor into the common case for no reason.
//
// autostash is offered because the failure it prevents is the most common
// one here: git refuses to rebase with a dirty working tree, and the
// alternative is stash / rebase / stash pop by hand for something git can
// do atomically.
func (r *Runner) Rebase(repoPath, upstream string, autostash bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama base", upstream); err != nil {
		return err
	}

	// No core.editor override here, unlike RebaseTodo and
	// ContinueOperation: a plain rebase never opens an editor — only `-i`
	// and a --continue that has to amend a message do. Adding the override
	// anyway would also push "-c" into args[0], which is what the error
	// message and the command log are labelled with ("git -c: cannot
	// rebase…" instead of "git rebase: cannot rebase…").
	args := []string{"rebase"}
	if autostash {
		args = append(args, "--autostash")
	}
	args = append(args, upstream)

	_, err = r.runLocal(root, args...)
	return err
}

// RebaseAbort returns the repository to the state it had before the rebase
// started.
//
// It was the one operation with no way back: InProgress reports "rebase",
// ContinueOperation accepts "rebase", and the UI hid its own abort button
// for rebases precisely because nothing behind it could do the job — so a
// rebase that stopped on a conflict could only be finished, never undone.
// An escape hatch that exists for merge, cherry-pick and revert but not for
// the one operation that rewrites history is the wrong way round.
func (r *Runner) RebaseAbort(repoPath string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	_, err = r.runLocal(root, "rebase", "--abort")
	return err
}

// RebaseTodoFrom builds the default todo (every commit picked, newest last)
// for the range base..HEAD, which is what the UI starts from before the user
// reorders anything.
//
// Ordered OLDEST FIRST, matching git's own todo file. The graph shows
// newest first, so the caller has to reverse — getting that backwards
// reverses the whole history, which is the single most destructive way this
// feature can fail.
func (r *Runner) RebaseTodoFrom(repoPath, base string) ([]RebaseAction, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}
	if err := checkRefArg("base", base); err != nil {
		return nil, err
	}

	out, err := r.runLocal(root, "log", "--reverse", "--pretty=format:%H%x1f%s", base+"..HEAD")
	if err != nil {
		return nil, err
	}

	var actions []RebaseAction
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		hash, subject, _ := strings.Cut(line, "\x1f")
		actions = append(actions, RebaseAction{Command: "pick", Hash: hash, Subject: subject})
	}
	return actions, nil
}
