package agentusage

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

// Los fixtures son salidas reales de `opencode stats --standalone --days 30
// --models --json` (OpenCode 2.0.22): la de toda la máquina y la de
// `--project .` sobre este repositorio.

func loadFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseOpencodeStatsTotals(t *testing.T) {
	s, err := parseOpencodeStats(loadFixture(t, "opencode-stats-all.json"))
	if err != nil {
		t.Fatal(err)
	}
	got := s.Tokens.totals(s.Steps)

	// output 41653 + reasoning 45287: el razonamiento se SUMA a la salida.
	if got.Output != 86940 {
		t.Errorf("Output = %d, quiero 86940 (salida + razonamiento)", got.Output)
	}
	if got.Input != 169865 || got.CacheRead != 13768678 || got.CacheWrite != 699489 {
		t.Errorf("clases de token incorrectas: %+v", got)
	}
	if want := int64(169865 + 86940 + 699489 + 13768678); got.Total != want {
		t.Errorf("Total = %d, quiero %d (la suma de las cuatro clases)", got.Total, want)
	}
	if got.Messages != 270 {
		t.Errorf("Messages = %d, quiero los 270 pasos", got.Messages)
	}
}

func TestApplyOpencodeModelsAndPeriod(t *testing.T) {
	all, err := parseOpencodeStats(loadFixture(t, "opencode-stats-all.json"))
	if err != nil {
		t.Fatal(err)
	}
	repo, err := parseOpencodeStats(loadFixture(t, "opencode-stats-repo.json"))
	if err != nil {
		t.Fatal(err)
	}

	u := AgentUsage{Agent: "opencode"}
	applyOpencode(&u, all, &repo)

	// Los repartos por modelo tienen que sumar el total: si no, hay un modelo
	// perdido o contado dos veces.
	var sum int64
	for _, m := range u.ByModel {
		sum += m.Total
	}
	if sum != u.All.Total {
		t.Errorf("la suma por modelo %d no coincide con el total %d", sum, u.All.Total)
	}

	// gpt-6-luna viene en dos variantes (medium y default): una sola fila.
	luna := 0
	for _, m := range u.ByModel {
		if m.Key == "opencode-go/gpt-6-luna" {
			luna++
			if m.Messages != 228 {
				t.Errorf("pasos de gpt-6-luna = %d, quiero 227+1", m.Messages)
			}
		}
		if strings.Contains(m.Key, "claude-sonnet-5-5") {
			t.Error("un modelo sin tokens no debería aparecer en el reparto")
		}
	}
	if luna != 1 {
		t.Errorf("gpt-6-luna aparece %d veces, quiero 1", luna)
	}
	if u.ByModel[0].Key != "opencode-go/gpt-6-luna" {
		t.Errorf("el modelo más usado debería ir primero, fue %q", u.ByModel[0].Key)
	}

	if u.FirstDay != "2026-09-23" || u.LastDay != "2026-10-15" {
		t.Errorf("período = %s → %s", u.FirstDay, u.LastDay)
	}
	if len(u.ByDay) != 0 {
		t.Error("ByDay debe quedar vacío: la actividad por día son pasos, no tokens")
	}
	// 13768678 / (169865 + 13768678 + 699489) = 94.1%
	if u.CacheHitPercent != 94.1 {
		t.Errorf("CacheHitPercent = %v", u.CacheHitPercent)
	}
	if u.Repo.Messages != 7 || u.Repo.Total != 17811+742+1612+52032 {
		t.Errorf("Repo = %+v", u.Repo)
	}
}

func fakeStats(t *testing.T, calls *[]string) opencodeStatsRunner {
	return func(_ context.Context, bin, dir string, days int, project bool) ([]byte, error) {
		*calls = append(*calls, dir)
		if project {
			return loadFixture(t, "opencode-stats-repo.json"), nil
		}
		return loadFixture(t, "opencode-stats-all.json"), nil
	}
}

func TestReadOpencodeWithRepo(t *testing.T) {
	var calls []string
	u := readOpencodeWith("/repo", 30, "/bin/opencode", fakeStats(t, &calls))
	if !u.Available || u.Note != "" {
		t.Fatalf("debería estar disponible: %+v", u)
	}
	if u.All.Messages != 270 || u.Repo.Messages != 7 {
		t.Errorf("All=%+v Repo=%+v", u.All, u.Repo)
	}
	if len(calls) != 2 {
		t.Errorf("con repositorio son dos consultas, fueron %d", len(calls))
	}
}

func TestReadOpencodeWithoutRepoLeavesRepoEmpty(t *testing.T) {
	var calls []string
	u := readOpencodeWith("", 30, "/bin/opencode", fakeStats(t, &calls))
	if !u.Available {
		t.Fatal("debería estar disponible")
	}
	if u.Repo.Total != 0 || u.Repo.Messages != 0 {
		t.Errorf("sin repositorio Repo debe quedar vacío: %+v", u.Repo)
	}
	if len(calls) != 1 {
		t.Errorf("sin repositorio es una sola consulta, fueron %d", len(calls))
	}
}

func TestReadOpencodeFailuresAreNotErrors(t *testing.T) {
	ok := func(raw string) opencodeStatsRunner {
		return func(context.Context, string, string, int, bool) ([]byte, error) { return []byte(raw), nil }
	}

	t.Run("sin binario", func(t *testing.T) {
		u := readOpencodeWith("/repo", 30, "", ok("{}"))
		if u.Available || u.Note == "" {
			t.Errorf("sin CLI: Available=false con nota, fue %+v", u)
		}
	})
	t.Run("el CLI falla", func(t *testing.T) {
		u := readOpencodeWith("/repo", 30, "/bin/opencode", func(context.Context, string, string, int, bool) ([]byte, error) {
			return nil, errors.New("exit 1")
		})
		if u.Available || u.Note == "" {
			t.Errorf("CLI roto: Available=false con nota, fue %+v", u)
		}
	})
	t.Run("formato ilegible", func(t *testing.T) {
		u := readOpencodeWith("/repo", 30, "/bin/opencode", ok("no es json"))
		if u.Available || !strings.Contains(u.Note, "formato") && !strings.Contains(u.Note, "format") {
			t.Errorf("formato desconocido debe decirse, fue %+v", u)
		}
	})
	t.Run("sin uso en el período", func(t *testing.T) {
		u := readOpencodeWith("/repo", 30, "/bin/opencode", ok(`{"sessions":0,"steps":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"activity":[],"models":[]}`))
		if u.Available || u.Note == "" {
			t.Errorf("período vacío: Available=false con nota, fue %+v", u)
		}
	})
}

func TestScanIncludesOpencode(t *testing.T) {
	u := Scan("", 30)
	found := false
	for _, a := range u.Agents {
		if a.Agent == "opencode" {
			found = true
		}
	}
	if !found {
		t.Error("Scan debe devolver un bloque para opencode, esté o no instalado")
	}
}
