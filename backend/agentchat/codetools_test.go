package agentchat

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/workspace"
)

// fakeApprover registra las preguntas y contesta según su política.
type fakeApprover struct {
	mu    sync.Mutex
	asked []agentapprove.Request
	allow bool
	why   string
}

func (f *fakeApprover) ask(_ context.Context, req agentapprove.Request) agentapprove.Decision {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, req)
	return agentapprove.Decision{Allow: f.allow, Reason: f.why}
}

func newCodeTools(t *testing.T, mode Mode, ap *fakeApprover) (*CodeTools, string) {
	t.Helper()
	ws, err := workspace.New(t.TempDir(), workspace.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var approve Approver
	if ap != nil {
		approve = ap.ask
	}
	if err := os.WriteFile(filepath.Join(ws.Root(), "a.txt"), []byte("uno\ndos\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewCodeTools(ws, mode, approve), ws.Root()
}

func declared(c *CodeTools) string {
	var out []string
	for _, d := range c.Defs() {
		out = append(out, d.Name)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

const (
	readsOnly = "glob,list_dir,read_file,search"
	allTools  = "edit_file,glob,list_dir,read_file,run_command,search,write_file"
)

func TestDeclaredToolsPerMode(t *testing.T) {
	want := map[Mode]string{
		ModeAsk:     readsOnly,
		ModePlan:    readsOnly,
		ModeApprove: allTools,
		ModeEdit:    allTools,
		ModeAuto:    allTools,
		Mode("zzz"): readsOnly, // un modo desconocido no da permisos
	}
	for mode, w := range want {
		c, _ := newCodeTools(t, mode, &fakeApprover{})
		if got := declared(c); got != w {
			t.Errorf("modo %q declara %s, quería %s", mode, got, w)
		}
	}
}

func TestPermissionMatrix(t *testing.T) {
	type row struct {
		mode             Mode
		read, write, cmd ToolPermission
	}
	rows := []row{
		{ModeAsk, PermAuto, PermNone, PermNone},
		{ModePlan, PermAuto, PermNone, PermNone},
		{ModeApprove, PermAuto, PermAsk, PermAsk},
		{ModeEdit, PermAuto, PermAuto, PermAsk},
		{ModeAuto, PermAuto, PermAuto, PermAuto},
	}
	for _, r := range rows {
		if got := PermissionFor(r.mode, workspace.KindRead); got != r.read {
			t.Errorf("%q lectura = %v", r.mode, got)
		}
		if got := PermissionFor(r.mode, workspace.KindWrite); got != r.write {
			t.Errorf("%q escritura = %v", r.mode, got)
		}
		if got := PermissionFor(r.mode, workspace.KindCommand); got != r.cmd {
			t.Errorf("%q comando = %v", r.mode, got)
		}
	}
}

func TestRunEnforcesModeAndAsks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("comandos POSIX")
	}
	ctx := context.Background()
	write := map[string]any{"path": "n.txt", "content": "x"}
	edit := map[string]any{"path": "a.txt", "old_string": "uno", "new_string": "UNO"}
	cmd := map[string]any{"command": "echo hola"}
	read := map[string]any{"path": "a.txt"}

	type exp struct {
		tool   string
		args   map[string]any
		runs   bool // la herramienta llega a correr
		asked  int  // preguntas al usuario
		reject bool // el modo la rechaza sin preguntar
	}
	cases := []struct {
		mode Mode
		exps []exp
	}{
		{ModeAsk, []exp{
			{"read_file", read, true, 0, false},
			{"write_file", write, false, 0, true},
			{"edit_file", edit, false, 0, true},
			{"run_command", cmd, false, 0, true},
		}},
		{ModePlan, []exp{
			{"read_file", read, true, 0, false},
			{"write_file", write, false, 0, true},
			{"run_command", cmd, false, 0, true},
		}},
		{ModeApprove, []exp{
			{"read_file", read, true, 0, false},
			{"write_file", write, true, 1, false},
			{"edit_file", edit, true, 1, false},
			{"run_command", cmd, true, 1, false},
		}},
		{ModeEdit, []exp{
			{"read_file", read, true, 0, false},
			{"write_file", write, true, 0, false},
			{"edit_file", edit, true, 0, false},
			{"run_command", cmd, true, 1, false},
		}},
		{ModeAuto, []exp{
			{"read_file", read, true, 0, false},
			{"write_file", write, true, 0, false},
			{"edit_file", edit, true, 0, false},
			{"run_command", cmd, true, 0, false},
			{"run_command", map[string]any{"command": "git push --force origin main"}, false, 1, false},
			{"run_command", map[string]any{"command": "git push origin main"}, false, 1, false},
			{"run_command", map[string]any{"command": "rm -rf build"}, true, 1, false},
		}},
	}
	for _, c := range cases {
		for _, e := range c.exps {
			ap := &fakeApprover{allow: true}
			tools, root := newCodeTools(t, c.mode, ap)
			// Con sandbox propio por caso: la escritura no pisa a la edición.
			_, err := tools.Run(ctx, e.tool, e.args)
			if e.reject {
				if err == nil || len(ap.asked) != 0 {
					t.Errorf("%q %s: debía rechazarse sin preguntar (err=%v, preguntas=%d)", c.mode, e.tool, err, len(ap.asked))
				}
				continue
			}
			if len(ap.asked) != e.asked {
				t.Errorf("%q %s %v: %d preguntas, quería %d", c.mode, e.tool, e.args, len(ap.asked), e.asked)
			}
			if e.tool == "run_command" && strings.Contains(e.args["command"].(string), "git push") {
				// Aprobado, `git push` en un directorio sin repositorio falla: no
				// importa, lo que se prueba es que preguntó.
				continue
			}
			if e.runs && err != nil {
				t.Errorf("%q %s: %v", c.mode, e.tool, err)
			}
			if e.tool == "write_file" && e.runs {
				if _, err := os.Stat(filepath.Join(root, "n.txt")); err != nil {
					t.Errorf("%q: no escribió el archivo aprobado", c.mode)
				}
			}
		}
	}
}

func TestDeniedActionDoesNotRunAndTellsTheModel(t *testing.T) {
	ap := &fakeApprover{allow: false, why: "no toques eso"}
	c, root := newCodeTools(t, ModeApprove, ap)
	_, err := c.Run(context.Background(), "write_file", map[string]any{"path": "n.txt", "content": "x"})
	if err == nil || !strings.Contains(err.Error(), "no toques eso") {
		t.Fatalf("err = %v (el modelo tiene que saber que se denegó y por qué)", err)
	}
	if _, serr := os.Stat(filepath.Join(root, "n.txt")); serr == nil {
		t.Error("se escribió pese a la denegación")
	}
	_, err = c.Run(context.Background(), "run_command", map[string]any{"command": "touch hecho"})
	if err == nil {
		t.Error("un comando denegado no corre")
	}
	if _, serr := os.Stat(filepath.Join(root, "hecho")); serr == nil {
		t.Error("el comando corrió pese a la denegación")
	}
	if len(ap.asked) != 2 || ap.asked[0].Tool != "write_file" || ap.asked[0].Summary != "n.txt" || ap.asked[1].Summary != "touch hecho" {
		t.Fatalf("preguntas = %+v", ap.asked)
	}
}

func TestRiskyCommandAsksWithWarningInEveryMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("comandos POSIX")
	}
	for _, mode := range []Mode{ModeApprove, ModeEdit, ModeAuto} {
		ap := &fakeApprover{allow: false}
		c, _ := newCodeTools(t, mode, ap)
		_, err := c.Run(context.Background(), "run_command", map[string]any{"command": "sudo rm -rf /"})
		if err == nil || len(ap.asked) != 1 {
			t.Fatalf("%q: err=%v preguntas=%d", mode, err, len(ap.asked))
		}
		if !strings.Contains(ap.asked[0].Detail, "⚠") {
			t.Errorf("%q: la pregunta debe marcar el riesgo: %+v", mode, ap.asked[0])
		}
	}
}

func TestNoApproverMeansDenied(t *testing.T) {
	c, root := newCodeTools(t, ModeApprove, nil)
	if _, err := c.Run(context.Background(), "write_file", map[string]any{"path": "n.txt", "content": "x"}); err == nil {
		t.Fatal("sin forma de preguntar, se deniega")
	}
	if _, err := os.Stat(filepath.Join(root, "n.txt")); err == nil {
		t.Fatal("se escribió sin permiso")
	}
	// Leer no necesita permiso.
	if _, err := c.Run(context.Background(), "read_file", map[string]any{"path": "a.txt"}); err != nil {
		t.Fatal(err)
	}
}

func TestCancelledContextDenies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c, root := newCodeTools(t, ModeApprove, nil)
	c.approve = func(ctx context.Context, _ agentapprove.Request) agentapprove.Decision {
		cancel() // el turno se cancela mientras se esperaba la respuesta
		return agentapprove.Decision{Allow: true}
	}
	_, err := c.Run(ctx, "write_file", map[string]any{"path": "n.txt", "content": "x"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if _, serr := os.Stat(filepath.Join(root, "n.txt")); serr == nil {
		t.Error("aprobar con el turno cancelado no puede ejecutar")
	}
}

func TestOwnsAndModeRule(t *testing.T) {
	c, _ := newCodeTools(t, ModeAsk, nil)
	if !c.Owns("run_command") || !c.Owns("read_file") || c.Owns("vault_read_note") {
		t.Error("Owns despacha mal")
	}
	notes := map[string]bool{}
	for _, m := range []Mode{ModeAsk, ModePlan, ModeApprove, ModeEdit, ModeAuto} {
		cc, _ := newCodeTools(t, m, nil)
		notes[cc.ModeRule()] = true
	}
	if len(notes) != 5 {
		t.Errorf("cada modo tiene que decir su regla: %d reglas distintas", len(notes))
	}
	// Una herramienta fuera del catálogo se rechaza.
	if _, err := c.Run(context.Background(), "hack", nil); err == nil {
		t.Error("herramienta desconocida")
	}
}

// Las herramientas de skills solo se declaran si hay skills, y son de lectura:
// valen en todos los modos, también en ask y plan.
func TestSkillToolsDeclaredOnlyWithSkillsAndInEveryMode(t *testing.T) {
	skillDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("# guía\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws, err := workspace.New(t.TempDir(), workspace.Options{Skills: []workspace.SkillRef{{Name: "guia", Dir: skillDir}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []Mode{ModeAsk, ModePlan, ModeApprove, ModeEdit, ModeAuto} {
		c := NewCodeTools(ws, mode, nil)
		got := declared(c)
		if !strings.Contains(got, "skill") || !strings.Contains(got, "read_skill_file") {
			t.Errorf("modo %q con skills declara %s", mode, got)
		}
		// Sin approver y sin preguntar: son de lectura.
		out, err := c.Run(context.Background(), "skill", map[string]any{"name": "guia"})
		if err != nil || !strings.Contains(out, "# guía") {
			t.Errorf("modo %q: skill = %q, %v", mode, out, err)
		}
	}
	// Sin skills no figuran, y llamarlas igual falla con un mensaje claro.
	c, _ := newCodeTools(t, ModeAuto, &fakeApprover{})
	if got := declared(c); strings.Contains(got, "skill") {
		t.Errorf("sin skills no se declaran: %s", got)
	}
	if _, err := c.Run(context.Background(), "skill", map[string]any{"name": "x"}); err == nil {
		t.Error("skill sin skills debe fallar")
	}
}

func TestModeRuleAndCapabilities(t *testing.T) {
	for mode, w := range map[Mode][2]bool{
		ModeAsk: {false, false}, ModePlan: {false, false},
		ModeApprove: {true, true}, ModeEdit: {true, true}, ModeAuto: {true, true},
	} {
		c, _ := newCodeTools(t, mode, nil)
		if c.CanWrite() != w[0] || c.CanRun() != w[1] || c.ModeRule() == "" {
			t.Errorf("modo %q: CanWrite=%v CanRun=%v", mode, c.CanWrite(), c.CanRun())
		}
	}
	c, _ := newCodeTools(t, ModeAuto, nil)
	if !strings.Contains(c.ModeRule(), "git push") {
		t.Errorf("auto debe mencionar que lo riesgoso (git push) pregunta: %q", c.ModeRule())
	}
}
