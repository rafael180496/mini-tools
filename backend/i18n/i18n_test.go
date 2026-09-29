package i18n

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestLanguageSwitch(t *testing.T) {
	defer SetLang("en")
	m := Msg{ES: "hola %s", EN: "hello %s"}
	SetLang("")
	if got := T(m, "x"); got != "hello x" {
		t.Errorf("sin elegir debería ser inglés, dio %q", got)
	}
	SetLang("es")
	if got := T(m, "x"); got != "hola x" {
		t.Errorf("es: %q", got)
	}
}

func TestLazyErrorFollowsLanguageAndKeepsIdentity(t *testing.T) {
	defer SetLang("en")
	errX := New(Msg{ES: "falló", EN: "failed"})
	wrapped := fmt.Errorf("ctx: %w", errX)
	SetLang("es")
	if !errors.Is(wrapped, errX) || errX.Error() != "falló" {
		t.Errorf("es: %q, Is=%v", errX.Error(), errors.Is(wrapped, errX))
	}
	SetLang("en")
	if errX.Error() != "failed" {
		t.Errorf("en: %q", errX.Error())
	}
}

func TestCodeSurvivesWrappingAndIsInvisible(t *testing.T) {
	errC := NewCoded("remote-changed", Msg{ES: "cambió", EN: "changed"})
	for _, e := range []error{errC, fmt.Errorf("guardar: %w", errC), fmt.Errorf("guardar: %v", errC)} {
		if Code(e) != "remote-changed" {
			t.Errorf("código perdido en %q", e.Error())
		}
	}
	if strings.TrimPrefix(errC.Error(), codeMark+"remote-changed"+codeMark) != "changed" {
		t.Errorf("el texto visible no es el mensaje: %q", errC.Error())
	}
	if Code(errors.New("otro")) != "" {
		t.Error("un error sin código devolvió código")
	}
}

var verbRe = regexp.MustCompile(`%[-+# 0-9.*]*[a-zA-Z%]`)

// TestMessagesAreComplete recorre todo el código Go del repo y verifica cada
// literal i18n.Msg{…}: los dos idiomas presentes y los mismos verbos de
// formato en el mismo orden. Es lo que en el frontend hace el compilador
// (Messages<typeof es>): un mensaje con un idioma vacío o con un %s de menos
// no llega a la app.
func TestMessagesAreComplete(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	checked := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if name == "node_modules" || name == "frontend" || name == "build" || name == "releases" || (strings.HasPrefix(name, ".") && path != root) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			return nil
		}
		ast.Inspect(f, func(n ast.Node) bool {
			cl, ok := n.(*ast.CompositeLit)
			if !ok || !isMsgType(cl.Type) {
				return true
			}
			checked++
			vals := map[string]string{}
			for _, el := range cl.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				key, _ := kv.Key.(*ast.Ident)
				if key == nil {
					continue
				}
				if s, ok := stringValue(kv.Value); ok {
					vals[key.Name] = s
				} else {
					vals[key.Name] = "<expr>"
				}
			}
			pos := fset.Position(cl.Pos())
			es, en := vals["ES"], vals["EN"]
			if strings.TrimSpace(es) == "" || strings.TrimSpace(en) == "" {
				t.Errorf("%s:%d: i18n.Msg sin uno de los idiomas (ES=%q, EN=%q)", rel(root, pos.Filename), pos.Line, es, en)
				return true
			}
			if es != "<expr>" && en != "<expr>" {
				if a, b := strings.Join(verbRe.FindAllString(es, -1), " "), strings.Join(verbRe.FindAllString(en, -1), " "); a != b {
					t.Errorf("%s:%d: verbos distintos entre idiomas: ES [%s] vs EN [%s]", rel(root, pos.Filename), pos.Line, a, b)
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%d mensajes revisados", checked)
}

func isMsgType(e ast.Expr) bool {
	switch x := e.(type) {
	case *ast.SelectorExpr:
		id, ok := x.X.(*ast.Ident)
		return ok && id.Name == "i18n" && x.Sel.Name == "Msg"
	case *ast.Ident:
		return x.Name == "Msg"
	}
	return false
}

func stringValue(e ast.Expr) (string, bool) {
	switch x := e.(type) {
	case *ast.BasicLit:
		if x.Kind == token.STRING {
			s, err := strconv.Unquote(x.Value)
			return s, err == nil
		}
	case *ast.BinaryExpr:
		if x.Op == token.ADD {
			a, ok1 := stringValue(x.X)
			b, ok2 := stringValue(x.Y)
			return a + b, ok1 && ok2
		}
	}
	return "", false
}

func rel(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return p
	}
	return r
}
