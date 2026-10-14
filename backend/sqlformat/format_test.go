package sqlformat

import (
	"strings"
	"testing"

	"mini-tools/backend/sqlintel"
)

func TestFormatSelectLayout(t *testing.T) {
	got := Format("select a, b.c, count(*) total from t1 a join t2 b on b.id = a.id and b.x = 1 where a.f between 1 and 5 and a.g in (1, 2) or a.h is null group by a, b.c order by 3 desc")
	want := `SELECT a,
       b.c,
       count(*) total
FROM t1 a
JOIN t2 b ON b.id = a.id
  AND b.x = 1
WHERE a.f BETWEEN 1 AND 5
  AND a.g IN (1, 2)
  OR a.h IS NULL
GROUP BY a, b.c
ORDER BY 3 DESC`
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatSubqueryAndUpdate(t *testing.T) {
	got := Format(`update BATCH_CTRL_MODULO set IND_ESTADO =1, DESCRIP_ERROR='Simulado  por problemas' where IND_ESTADO in (select x from y where z = 2);`)
	want := `UPDATE BATCH_CTRL_MODULO
SET IND_ESTADO =1,
    DESCRIP_ERROR='Simulado  por problemas'
WHERE IND_ESTADO IN (
    SELECT x
    FROM y
    WHERE z = 2
);`
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

// PL/SQL, DDL and the text between statements come out byte for byte.
func TestFormatLeavesBlocksAndSeparatorsAlone(t *testing.T) {
	block := `DECLARE
    v_cant NUMBER; v_ret NUMBER;
BEGIN
    SGCPRO.PR_INFORMANTE(p_cant => v_cant,   p_retorno => v_ret);
END;
/`
	src := "-- cabecera\n" + block + "\n\nselect * from dual;\n\ncreate table x (a number);\n"
	got := Format(src)
	if !strings.Contains(got, block) {
		t.Fatalf("the block changed:\n%s", got)
	}
	if !strings.HasPrefix(got, "-- cabecera\n") || !strings.Contains(got, "create table x (a number);") {
		t.Fatalf("text outside plain SQL changed:\n%s", got)
	}
	if !strings.Contains(got, "SELECT *\nFROM dual;") {
		t.Fatalf("the SELECT was not formatted:\n%s", got)
	}
}

// The guarantee: the token stream is unchanged except for keyword case.
func TestFormatPreservesTokens(t *testing.T) {
	inputs := []string{
		"select q'[it's]', 'a  b', \"Mixed Col\", x::int, a<>b, :p1, -1 from t -- trailing\n where c >= 2",
		"with a as (select 1 n from dual), b as (select n from a) select * from b union all select 2 from dual",
		"merge into t using s on (t.id = s.id) when matched then update set t.v = s.v when not matched then insert (id) values (s.id)",
		"select case when a = 1 and b = 2 then 'x' else 'y' end, sum(v) over (partition by k order by d) from t",
	}
	for _, in := range inputs {
		out := Format(in)
		a, b := tokensOf(in), tokensOf(out)
		if len(a) != len(b) {
			t.Fatalf("token count changed for %q:\n%s", in, out)
		}
		for i := range a {
			if !strings.EqualFold(a[i], b[i]) || (a[i] != b[i] && strings.ToUpper(a[i]) != b[i]) {
				t.Fatalf("token %d changed %q → %q in:\n%s", i, a[i], b[i], out)
			}
		}
	}
}

func tokensOf(s string) []string {
	var out []string
	for _, t := range sqlintel.Tokenize([]rune(s)) {
		out = append(out, t.Text)
	}
	return out
}
