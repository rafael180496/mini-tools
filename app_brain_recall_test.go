package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRecallKeywords(t *testing.T) {
	cases := []struct {
		name, in string
		want     []string
	}{
		{"pliega tildes y mayúsculas", "¿Cómo resuelvo los BLOQUEOS de Oracle en producción?", []string{"resuelvo", "bloqueos", "oracle", "produccion"}},
		{"descarta cortas y vacías", "para que con los de una the and with that", nil},
		{"sin repetir", "oracle Oracle ORACLE bloqueo oracle", []string{"oracle", "bloqueo"}},
		{"máximo 8", "uno1 dos2 tres3 cuatro cinco seis7 siete8 ocho9 nueve10 diez11", []string{"uno1", "dos2", "tres3", "cuatro", "cinco", "seis7", "siete8", "ocho9"}},
		{"signos y números", "ORA-00060: deadlock (detectado)", []string{"00060", "deadlock", "detectado"}},
		{"vacío", "   ", nil},
	}
	for _, c := range cases {
		if got := recallKeywords(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: recallKeywords(%q) = %v, quería %v", c.name, c.in, got, c.want)
		}
	}
}

func TestRankRecallMoreMatchedWordsWins(t *testing.T) {
	// "b" aparece en las tres palabras (por abajo), "a" solo en la primera
	// (primera de la lista): coincidir en más palabras le gana a una posición alta.
	got := rankRecall([][]string{
		{"a", "x", "b"},
		{"y", "b"},
		{"b"},
	})
	if len(got) == 0 || got[0] != "b" {
		t.Fatalf("debía ganar la que acierta más palabras: %v", got)
	}
	if want := []string{"b", "a", "y", "x"}; !reflect.DeepEqual(got, want) {
		t.Errorf("orden = %v, quería %v", got, want)
	}
}

func TestRankRecallIsDeterministicOnTies(t *testing.T) {
	for i := 0; i < 20; i++ {
		got := rankRecall([][]string{{"a", "b"}, {"b", "a"}})
		// Mismo puntaje (20+19 cada una): queda primero la que se vio antes.
		if !reflect.DeepEqual(got, []string{"a", "b"}) {
			t.Fatalf("empate no determinista: %v", got)
		}
	}
	if got := rankRecall(nil); len(got) != 0 {
		t.Errorf("sin búsquedas = %v", got)
	}
}

func TestFitRecallBudgets(t *testing.T) {
	long := strings.Repeat("palabra ", 400) // 3200 caracteres
	var ranked []recallNote
	for i := 0; i < 8; i++ {
		ranked = append(ranked, recallNote{ID: fmt.Sprint(i), Title: fmt.Sprintf("Nota %d", i), Content: long})
	}

	t.Run("cada nota se recorta y el total se acota", func(t *testing.T) {
		kept := fitRecall(nil, ranked)
		total := 0
		for _, n := range kept {
			if utf8.RuneCountInString(n.Content) > recallMaxNoteChars {
				t.Errorf("%s: %d caracteres", n.Title, utf8.RuneCountInString(n.Content))
			}
			if !strings.HasSuffix(n.Content, "…") {
				t.Errorf("%s: el recorte debe marcarse", n.Title)
			}
			total += utf8.RuneCountInString(recallBlock(n.Title, n.Content))
		}
		if total > recallMaxTotalChars {
			t.Errorf("total %d > %d", total, recallMaxTotalChars)
		}
		if len(kept) == 0 || len(kept) > recallMaxNotes {
			t.Errorf("notas = %d", len(kept))
		}
	})

	t.Run("tope de notas sin contar el índice", func(t *testing.T) {
		short := make([]recallNote, 8)
		for i := range short {
			short[i] = recallNote{ID: fmt.Sprint(i), Title: fmt.Sprintf("N%d", i), Content: "contenido corto de la nota"}
		}
		idx := &recallNote{ID: "idx", Title: "_Índice p", Content: "- [[N0]]"}
		kept := fitRecall(idx, short)
		if len(kept) != recallMaxNotes+1 || kept[0].ID != "idx" {
			t.Fatalf("quería índice + %d notas, con el índice primero: %+v", recallMaxNotes, kept)
		}
		if kept[len(kept)-1].ID != "4" {
			t.Errorf("deben quedar las mejor rankeadas: %+v", kept)
		}
	})

	t.Run("el índice no desplaza el tope y una nota vacía no cuenta", func(t *testing.T) {
		in := []recallNote{{ID: "v", Title: "Vacía", Content: "  \n "}, {ID: "a", Title: "A", Content: "algo"}}
		kept := fitRecall(nil, in)
		if len(kept) != 1 || kept[0].ID != "a" {
			t.Errorf("kept = %+v", kept)
		}
	})

	t.Run("caracteres multibyte no se cortan a la mitad", func(t *testing.T) {
		kept := fitRecall(nil, []recallNote{{ID: "a", Title: "Ñ", Content: strings.Repeat("ñandú ", 600)}})
		if len(kept) != 1 || !utf8.ValidString(kept[0].Content) {
			t.Errorf("UTF-8 inválido: %q", kept[0].Content)
		}
	})
}

// recallApp deja un App con el cerebro encendido en el chat "c" (módulo git, con
// el repositorio «proyecto») y las notas de prueba creadas.
func recallApp(t *testing.T) (a *App, repoID string) {
	t.Helper()
	a, _ = notesApp(t)
	repoID, _ = addRepo(t, a)
	if err := a.vault.CreateAgentChat("c", "", "claude", "t", "git", repoID); err != nil {
		t.Fatal(err)
	}
	if err := a.vault.SetAgentChatBrain("c", true); err != nil {
		t.Fatal(err)
	}
	return a, repoID
}

func makeNote(t *testing.T, a *App, title, content, folder string) {
	t.Helper()
	call(t, a, "vault_create_note", map[string]any{"title": title, "content": content, "folder": folder})
}

func makePrivate(t *testing.T, a *App, title string) {
	t.Helper()
	notes, _ := a.vault.ListNotes()
	for _, n := range notes {
		if n.Title == title {
			if err := a.vault.SetNotePrivacy(n.ID, true); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatalf("no está la nota %q", title)
}

func TestBrainRecallProjectRankingIndexAndFirewall(t *testing.T) {
	a, repoID := recallApp(t)
	const proj = "Cerebro/Proyectos/proyecto"
	makeNote(t, a, "_Índice proyecto", "- [[Bloqueos Oracle]]\n- [[Deploy SGC]]", proj)
	makeNote(t, a, "Oracle general", "notas varias de oracle", proj)
	makeNote(t, a, "Bloqueos Oracle", "El bloqueo se resuelve matando la sesión que retiene el lock. Oracle bloqueos.", proj+"/oracle")
	makeNote(t, a, "Deploy SGC", "pasos de despliegue del batch", proj)
	makeNote(t, a, "Secreto producción", "bloqueos oracle clave: hunter2", proj)
	makePrivate(t, a, "Secreto producción")
	makeNote(t, a, "Otro proyecto", "bloqueos oracle del otro proyecto", "Cerebro/Proyectos/otro")
	makeNote(t, a, "Tema suelto", "bloqueos oracle en temas", "Cerebro/Temas/oracle")
	makeNote(t, a, "En la raíz", "bloqueos oracle sin carpeta", "")

	text, titles := a.brainRecall("c", "git", repoID, "¿Cómo resuelvo los bloqueos de Oracle?", true)
	if len(titles) == 0 || titles[0] != "_Índice proyecto" {
		t.Fatalf("el índice va primero: %v", titles)
	}
	if titles[1] != "Bloqueos Oracle" {
		t.Errorf("gana la que coincide en más palabras: %v", titles)
	}
	want := []string{"_Índice proyecto", "Bloqueos Oracle", "Oracle general"}
	if !reflect.DeepEqual(titles, want) {
		t.Errorf("títulos = %v, quería %v (Deploy SGC no coincide)", titles, want)
	}
	for _, bad := range []string{"Secreto producción", "hunter2", "Otro proyecto", "Tema suelto", "En la raíz"} {
		if strings.Contains(text, bad) {
			t.Errorf("el recuerdo no debe incluir %q:\n%s", bad, text)
		}
	}
	for _, good := range []string{"## [[_Índice proyecto]]", "## [[Bloqueos Oracle]]", "matando la sesión", "vault_read_note"} {
		if !strings.Contains(text, good) {
			t.Errorf("falta %q:\n%s", good, text)
		}
	}
	if strings.Index(text, "## [[_Índice proyecto]]") > strings.Index(text, "## [[Bloqueos Oracle]]") {
		t.Error("el índice debe ir antes en el texto")
	}

	// Segundo turno de la misma sesión: nada se repite.
	text, titles = a.brainRecall("c", "git", repoID, "¿Cómo resuelvo los bloqueos de Oracle?", true)
	if text != "" || titles != nil {
		t.Errorf("una nota ya enviada no se repite: %v\n%s", titles, text)
	}
	// Una pregunta que trae otra nota: solo la nueva.
	_, titles = a.brainRecall("c", "git", repoID, "pasos del despliegue del batch", true)
	if !reflect.DeepEqual(titles, []string{"Deploy SGC"}) {
		t.Errorf("solo la nueva: %v", titles)
	}

	// Otra sesión (con su propio cerebro encendido) vuelve a recibirlas.
	_ = a.vault.CreateAgentChat("c2", "", "claude", "t", "git", repoID)
	_ = a.vault.SetAgentChatBrain("c2", true)
	if _, titles = a.brainRecall("c2", "git", repoID, "bloqueos de Oracle", true); len(titles) == 0 {
		t.Error("otra sesión debe recibir el recuerdo")
	}

	// Reiniciar la conversación olvida lo enviado.
	if err := a.ResetAgentChat("c"); err != nil {
		t.Fatal(err)
	}
	if _, titles = a.brainRecall("c", "git", repoID, "bloqueos de Oracle", true); len(titles) == 0 {
		t.Error("tras ResetAgentChat debe recordar de nuevo")
	}

	// Por system prompt (Claude Code, servidores de modelos) el recuerdo no
	// queda en el historial: se manda en cada turno y no marca nada como
	// enviado, así que tampoco le quita notas a la vía con deduplicación.
	_ = a.vault.CreateAgentChat("c3", "", "claude", "t", "git", repoID)
	_ = a.vault.SetAgentChatBrain("c3", true)
	for i := 0; i < 2; i++ {
		if _, titles = a.brainRecall("c3", "git", repoID, "bloqueos de Oracle", false); len(titles) == 0 {
			t.Errorf("turno %d sin deduplicar: debe recordar", i+1)
		}
	}
	if _, titles = a.brainRecall("c3", "git", repoID, "bloqueos de Oracle", true); len(titles) == 0 {
		t.Error("lo recordado sin deduplicar no cuenta como enviado")
	}
}

func TestBrainRecallNeverReturnsPrivateNotes(t *testing.T) {
	a, repoID := recallApp(t)
	const proj = "Cerebro/Proyectos/proyecto"
	makeNote(t, a, "_Índice proyecto", "- [[Privada]]", proj)
	makeNote(t, a, "Privada", "clave del servidor produccion", proj)
	makePrivate(t, a, "_Índice proyecto")
	makePrivate(t, a, "Privada")

	if text, titles := a.brainRecall("c", "git", repoID, "clave servidor produccion", true); text != "" || titles != nil {
		t.Errorf("solo hay notas privadas, no se recuerda nada: %v\n%s", titles, text)
	}
}

func TestBrainRecallWithoutProjectSearchesTemas(t *testing.T) {
	a, _ := recallApp(t)
	makeNote(t, a, "Oracle - bloqueos", "diagnóstico de bloqueos en Oracle", "Cerebro/Temas/Oracle")
	makeNote(t, a, "Proyecto aparte", "bloqueos oracle del proyecto", "Cerebro/Proyectos/proyecto")

	_, titles := a.brainRecall("c", "utilities", "", "bloqueos Oracle", true)
	if !reflect.DeepEqual(titles, []string{"Oracle - bloqueos"}) {
		t.Errorf("sin proyecto se busca en todo Temas: %v", titles)
	}
}

func TestBrainRecallRespectsBrainFlagAndPermissions(t *testing.T) {
	a, repoID := recallApp(t)
	makeNote(t, a, "Bloqueos Oracle", "bloqueos de oracle", "Cerebro/Proyectos/proyecto")

	// Chat sin la bandera.
	_ = a.vault.CreateAgentChat("sin", "", "claude", "t", "git", repoID)
	if text, titles := a.brainRecall("sin", "git", repoID, "bloqueos oracle", true); text != "" || titles != nil {
		t.Error("sin cerebro en el chat no hay recuerdo")
	}
	// Con la bandera pero sin el permiso global de escritura.
	if err := a.vault.SetMCPNotesWrite(false); err != nil {
		t.Fatal(err)
	}
	if text, _ := a.brainRecall("c", "git", repoID, "bloqueos oracle", true); text != "" {
		t.Error("sin mcpNotesWrite el cerebro no aplica")
	}
	if err := a.vault.SetMCPNotesWrite(true); err != nil {
		t.Fatal(err)
	}
	// Carpeta inexistente (nada escrito para ese proyecto): vacío, sin error.
	if err := a.vault.SetBrainRoot("Otra"); err != nil {
		t.Fatal(err)
	}
	if text, titles := a.brainRecall("c", "git", repoID, "bloqueos oracle", true); text != "" || titles != nil {
		t.Error("la raíz sin notas no recuerda nada")
	}
}

func TestWithRecallAppendsToInstructionsOnly(t *testing.T) {
	a, repoID := recallApp(t)
	makeNote(t, a, "Bloqueos Oracle", "bloqueos de oracle", "Cerebro/Proyectos/proyecto")

	if got, titles := a.withRecall("", "codex", "c", "git", repoID, "bloqueos oracle"); got != "" || titles != nil {
		t.Errorf("sin instrucciones del cerebro no se recuerda: %q %v", got, titles)
	}
	got, titles := a.withRecall("INSTRUCCIONES", "codex", "c", "git", repoID, "bloqueos oracle")
	if !strings.HasPrefix(got, "INSTRUCCIONES\n\n") || !strings.Contains(got, "## [[Bloqueos Oracle]]") || len(titles) != 1 {
		t.Errorf("withRecall = %q %v", got, titles)
	}
	// Nada que recordar: las instrucciones quedan tal cual.
	if got, titles := a.withRecall("INSTRUCCIONES", "codex", "c", "git", repoID, "zzzzzzzz"); got != "INSTRUCCIONES" || titles != nil {
		t.Errorf("sin coincidencias = %q %v", got, titles)
	}
}

func TestBrainRecallRespectsCaps(t *testing.T) {
	a, repoID := recallApp(t)
	const proj = "Cerebro/Proyectos/proyecto"
	body := strings.Repeat("diagnóstico de bloqueos en oracle ", 100)
	makeNote(t, a, "_Índice proyecto", strings.Repeat("- [[Bloqueo 0]] bloqueos\n", 200), proj)
	for i := 0; i < 8; i++ {
		makeNote(t, a, fmt.Sprintf("Bloqueo %d", i), body, proj)
	}
	text, titles := a.brainRecall("c", "git", repoID, "bloqueos oracle", true)
	if len(titles) > recallMaxNotes+1 || titles[0] != "_Índice proyecto" {
		t.Errorf("títulos = %v", titles)
	}
	blocks := 0
	for _, n := range strings.Split(text, "## [[")[1:] {
		blocks += utf8.RuneCountInString("## [[" + n)
	}
	if blocks > recallMaxTotalChars+4 { // los separadores entre bloques
		t.Errorf("bloques = %d caracteres", blocks)
	}
}
