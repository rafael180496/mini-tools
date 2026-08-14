package agentapprove

import (
	"bytes"
	"encoding/json"
	"os"
	"runtime"
	"testing"
)

func startTestChannel(t *testing.T, ask AskFunc) *Channel {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("AF_UNIX no está disponible en todas las configuraciones de Windows; ahí la función se degrada")
	}
	c, err := Start(t.TempDir(), ask)
	if err != nil {
		t.Fatalf("no se pudo abrir el canal: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// El camino completo: el proceso re-ejecutado pregunta, la ventana contesta.
func TestAskRoundTrip(t *testing.T) {
	var got Request
	c := startTestChannel(t, func(r Request) Decision {
		got = r
		return Decision{Allow: true}
	})

	d := Ask(c.Path(), Request{Tool: "Edit", Input: `{"file_path":"a.go"}`, Summary: "a.go"})

	if !d.Allow {
		t.Fatalf("se esperaba autorización: %+v", d)
	}
	if got.Tool != "Edit" || got.Summary != "a.go" {
		t.Errorf("la petición llegó incompleta: %+v", got)
	}
	// El id lo pone el canal, no quien pregunta: es lo que permite referirse a
	// una petición concreta desde la UI.
	if got.ID == "" {
		t.Error("la petición debería llegar con id")
	}
}

// Denegar tiene que llegar con su motivo, para que el agente sepa por qué y no
// insista con lo mismo.
func TestAskDenyCarriesReason(t *testing.T) {
	c := startTestChannel(t, func(Request) Decision {
		return Decision{Allow: false, Reason: "no toques ese archivo"}
	})

	d := Ask(c.Path(), Request{Tool: "Write"})
	if d.Allow || d.Reason != "no toques ese archivo" {
		t.Errorf("denegación mal propagada: %+v", d)
	}
}

// **La propiedad que sostiene todo el mecanismo: si no se puede preguntar, no
// se puede haber aprobado.** Un fallo que se leyera como permiso sería
// exactamente el error que esto existe para evitar.
func TestFailsClosed(t *testing.T) {
	if d := Ask("/ruta/que/no/existe.sock", Request{Tool: "Bash"}); d.Allow {
		t.Error("sin canal, la respuesta tiene que ser denegar")
	}

	c := startTestChannel(t, func(Request) Decision { return Decision{Allow: true} })
	_ = c.Close()
	if d := Ask(c.Path(), Request{Tool: "Bash"}); d.Allow {
		t.Error("con el canal cerrado, la respuesta tiene que ser denegar")
	}
}

// La salida del hook es lo que decide si la acción ocurre. Se emiten las DOS
// formas del contrato a la vez porque los CLIs lo cambian entre versiones: un
// campo que sobra se ignora, uno que falta convierte la denegación en un "no
// dijo nada".
func TestHookOutputShape(t *testing.T) {
	for _, allow := range []bool{true, false} {
		out := captureDecision(t, allow, "porque sí")

		hs, ok := out["hookSpecificOutput"].(map[string]any)
		if !ok {
			t.Fatalf("falta hookSpecificOutput: %+v", out)
		}
		want := "deny"
		if allow {
			want = "allow"
		}
		if hs["permissionDecision"] != want {
			t.Errorf("permissionDecision = %v, se esperaba %q", hs["permissionDecision"], want)
		}
		if hs["hookEventName"] != "PreToolUse" {
			t.Errorf("falta el nombre del evento: %+v", hs)
		}

		// La forma anterior solo se emite al DENEGAR: es la que bloquea en los
		// CLIs que todavía la leen. Mandarla al permitir no significaría nada.
		if allow {
			if _, has := out["decision"]; has {
				t.Errorf("permitir no debe emitir un `decision`: %+v", out)
			}
		} else if out["decision"] != "block" {
			t.Errorf("denegar debe emitir decision=block: %+v", out)
		}
	}
}

// captureDecision corre emitDecision y devuelve lo que escribió en stdout.
func captureDecision(t *testing.T, allow bool, reason string) map[string]any {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	emitDecision(allow, reason)
	w.Close()
	os.Stdout = old

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(buf.Bytes(), &out); err != nil {
		t.Fatalf("la salida del hook no es JSON: %q", buf.String())
	}
	return out
}

// La descripción es el texto que la persona lee para decidir, así que importa
// el doble que en el chat.
func TestDescribeForApproval(t *testing.T) {
	cases := []struct{ raw, summary, detail string }{
		{`{"file_path":"src/a.go","new_string":"x\ny"}`, "src/a.go", "2 líneas"},
		{`{"command":"rm -rf build"}`, "rm -rf build", ""},
		{`{"url":"https://ejemplo.com"}`, "https://ejemplo.com", ""},
		{`{}`, "", ""},
	}
	for _, c := range cases {
		s, d := Describe(c.raw)
		if s != c.summary || d != c.detail {
			t.Errorf("Describe(%s) = (%q, %q), se esperaba (%q, %q)", c.raw, s, d, c.summary, c.detail)
		}
	}
}
