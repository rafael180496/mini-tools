package query

import "testing"

// El reconocimiento tiene que ser ESTRICTO: cada caso de acá que se colara
// como editable termina en un UPDATE contra la tabla equivocada.
func TestDetectEditSource(t *testing.T) {
	ok := []struct {
		sql    string
		schema string
		table  string
	}{
		{"select * from contacts;", "", "contacts"},
		{"SELECT id, name FROM public.contacts WHERE id = 4", "public", "contacts"},
		{"select * from contacts c order by id", "", "contacts"},
		{"select * from \"Public\".\"Contacts\"", "Public", "Contacts"},
		// Una cadena con la palabra join no descalifica nada.
		{"select * from contacts where name = 'left join'", "", "contacts"},
		// Un comentario tampoco.
		{"-- join con la otra tabla\nselect * from contacts", "", "contacts"},
	}
	for _, c := range ok {
		got, err := DetectEditSource(c.sql)
		if err != nil {
			t.Fatalf("DetectEditSource(%q) falló: %v", c.sql, err)
		}
		if got.Schema != c.schema || got.Table != c.table {
			t.Fatalf("DetectEditSource(%q) = %+v, quería %s.%s", c.sql, got, c.schema, c.table)
		}
	}

	no := []string{
		"select a.*, b.name from a join b on b.id = a.b_id",
		"select * from a, b",
		"select count(*) from contacts",
		"select distinct name from contacts",
		"select * from (select * from contacts) t",
		"select * from a union select * from b",
		"select name, count(*) from contacts group by name",
		"with x as (select 1) select * from x",
		"update contacts set name = 'x'",
		"select * from a; select * from b",
	}
	for _, sql := range no {
		if got, err := DetectEditSource(sql); err == nil {
			t.Fatalf("DetectEditSource(%q) devolvió %+v; tenía que rechazarla", sql, got)
		}
	}
}
