package agentchat

import "testing"

func TestTrimTitleSacaMarcadores(t *testing.T) {
	cases := map[string]string{
		"[Image #1] [Image #2] en el git hay un bton de comando": "en el git hay un bton de comando",
		"[Image #1] mejora la ux de esta barra":                  "mejora la ux de esta barra",
		"[Request interrupted by user]":                          "",
		"revisa el splitter de PL/SQL":                           "revisa el splitter de PL/SQL",
		"[Pasted text #1 +40 lines] arreglá esto":                "arreglá esto",
	}
	for in, want := range cases {
		if got := trimTitle(in); got != want {
			t.Errorf("trimTitle(%q) = %q, esperado %q", in, got, want)
		}
	}
}
