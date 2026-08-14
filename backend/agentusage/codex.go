package agentusage

import (
	"database/sql"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// Codex CLI.
//
// # Qué se comprobó, con Codex instalado
//
// Codex guarda su estado en `~/.codex/`. Los transcripts crudos están en
// `sessions/AAAA/MM/DD/rollout-*.jsonl`, pero **no hace falta leerlos**: la
// base `state_5.sqlite` tiene una tabla `threads` con una fila por
// conversación y, entre sus columnas, `tokens_used`, `cwd`, `model` y las
// fechas. Es el mismo dato ya agregado por el propio CLI.
//
// Leer esa tabla en vez de sumar los rollouts evita de raíz el error que este
// paquete venía advirtiendo: en los transcripts los contadores de uso son
// **acumulativos por turno**, así que sumarlos multiplicaría el total. Acá el
// número ya viene sumado y por conversación.
//
// El nombre del archivo lleva la versión del esquema (`state_5`), así que una
// versión futura de Codex puede crear `state_6` y dejar de escribir en este.
// Por eso se busca el más nuevo que exista en vez de fijar el nombre: si
// aparece uno con otro número, se lee ese.
const codexDir = ".codex"

func readCodex(home, repoRoot string, since time.Time) AgentUsage {
	dir := filepath.Join(home, codexDir)
	u := AgentUsage{Agent: "codex", Source: dir}

	if _, err := os.Stat(dir); err != nil {
		u.Note = "No se encontró Codex CLI en esta máquina."
		return u
	}

	dbPath := latestStateDB(dir)
	if dbPath == "" {
		u.Note = "Codex está instalado pero todavía no registró conversaciones."
		return u
	}
	u.Source = dbPath

	// Solo lectura: es la base viva de otro programa, que puede estar
	// corriendo al mismo tiempo.
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		u.Note = "No se pudo leer la base de conversaciones de Codex."
		return u
	}
	defer db.Close()

	rows, err := db.Query(`SELECT COALESCE(tokens_used, 0), COALESCE(cwd, ''), COALESCE(model, ''), COALESCE(updated_at, 0) FROM threads`)
	if err != nil {
		// Un esquema distinto del esperado NO se reporta como "sin consumo":
		// decirlo es lo que permite darse cuenta de que hay que actualizar
		// esto, en vez de mostrar un cero que parece un dato.
		u.Note = "La base de Codex tiene un formato que esta versión no sabe leer."
		return u
	}
	defer rows.Close()

	byModel := map[string]*Bucket{}
	byDay := map[string]*Bucket{}

	for rows.Next() {
		var tokens, updated int64
		var cwd, model string
		if err := rows.Scan(&tokens, &cwd, &model, &updated); err != nil {
			continue
		}
		if tokens <= 0 {
			continue
		}
		ts := time.Unix(updated, 0)
		if updated == 0 || ts.Before(since) {
			continue
		}

		// Codex informa UN total por conversación, sin abrirlo por clase de
		// token: no se puede saber cuánto fue entrada, salida o caché. Se
		// carga entero como entrada —que es de lejos la mayor parte— y se
		// deja el resto en cero en vez de inventar un reparto.
		add(&u.All, tokens, 0, 0, 0)
		if repoRoot != "" && cwd == repoRoot {
			add(&u.Repo, tokens, 0, 0, 0)
		}

		if model == "" {
			model = "desconocido"
		}
		bump(byModel, model, tokens)
		bump(byDay, ts.Local().Format("2006-01-02"), tokens)
	}
	if rows.Err() != nil {
		u.Note = "No se pudo terminar de leer la base de Codex."
		return u
	}

	u.Available = u.All.Messages > 0
	if !u.Available {
		u.Note = "Codex no registró consumo en el período leído."
		return u
	}

	u.ByModel = finish(byModel, u.All.Total, 0)
	u.ByDay = finish(byDay, u.All.Total, 0)
	sortByKey(u.ByDay)
	if len(u.ByDay) > 0 {
		u.FirstDay, u.LastDay = u.ByDay[0].Key, u.ByDay[len(u.ByDay)-1].Key
	}
	// Sin desglose por clase de token no hay porcentaje de caché que calcular.
	// Se deja en cero, que la UI muestra como tal.
	u.Note = "Codex informa un total por conversación, sin separar entrada, salida ni caché."
	return u
}

// latestStateDB devuelve la base de estado más nueva. El nombre lleva la
// versión del esquema (`state_5.sqlite`), y una versión futura del CLI puede
// empezar a escribir en otra: fijar el nombre haría que este lector deje de
// ver datos sin decir por qué.
func latestStateDB(dir string) string {
	matches, err := filepath.Glob(filepath.Join(dir, "state_*.sqlite"))
	if err != nil || len(matches) == 0 {
		return ""
	}
	best, bestMod := "", time.Time{}
	for _, m := range matches {
		info, err := os.Stat(m)
		if err != nil {
			continue
		}
		if info.ModTime().After(bestMod) {
			best, bestMod = m, info.ModTime()
		}
	}
	return best
}
