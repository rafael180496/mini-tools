package agentapprove

import "testing"

func TestDescribe(t *testing.T) {
	cases := []struct {
		name, input, summary, detail string
	}{
		{"shell con workdir", `{"command":"git status","workdir":"/repo"}`, "git status", ""},
		{"read por path", `{"path":"/repo/a.go"}`, "/repo/a.go", ""},
		{"write con contenido", `{"filePath":"/repo/a.go","content":"a\nb"}`, "/repo/a.go", "2 líneas"},
		{"grep con carpeta", `{"pattern":"TODO","path":"/repo"}`, "TODO", "/repo"},
		{"glob sin carpeta", `{"pattern":"**/*.go"}`, "**/*.go", ""},
		{"patch de un archivo", `{"patchText":"*** Begin Patch\n*** Update File: /repo/a.rb\n@@\n-x\n+y\n*** End Patch"}`, "/repo/a.rb", ""},
		{"patch de varios", `{"patchText":"*** Begin Patch\n*** Add File: /repo/n.go\n+a\n*** Delete File: /repo/o.go\n*** Update File: /repo/n.go\n*** End Patch"}`, "/repo/n.go", "2 archivos"},
		{"patch unificado", `{"patch":"--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b"}`, "x.txt", ""},
		{"todowrite", `{"todos":[{"content":"uno","status":"completed"},{"content":"dos","status":"in_progress"},{"content":"tres","status":"pending"}]}`, "dos", "1/3"},
		{"todowrite sin en curso", `{"todos":[{"content":"uno","status":"pending"}]}`, "uno", "0/1"},
		{"webfetch", `{"url":"https://example.com","format":"markdown"}`, "https://example.com", ""},
		{"execute una línea", `{"code":"return 1 + 1"}`, "return 1 + 1", ""},
		{"execute varias", `{"code":"const a = 1\nreturn a"}`, "const a = 1", "2 líneas"},
		{"skill", `{"name":"chatwoot-dev"}`, "chatwoot-dev", ""},
		{"vacío", ``, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, d := Describe(c.input)
			if s != c.summary || d != c.detail {
				t.Fatalf("Describe(%s) = %q, %q; quería %q, %q", c.input, s, d, c.summary, c.detail)
			}
		})
	}
}
