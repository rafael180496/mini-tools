package agentusage

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Antigravity CLI (`agy`).
//
// # Lo que se comprobó en una instalación real, y por qué esto no reporta
// # tokens
//
// Antigravity guarda su estado en `~/.gemini/antigravity-cli/`. Se revisó
// entero: `conversations/`, `history.jsonl`, `log/`, `settings.json` y la base
// `conversation_summaries.db`. **En ninguno hay contadores de tokens.** Su
// tabla de conversaciones guarda título, vista previa, cantidad de pasos,
// workspace, agente y fechas — actividad, no consumo.
//
// El panel de "Models & Quota" que muestra el CLI —con el porcentaje restante
// del límite semanal y el de cinco horas, por grupo de modelos— lo contesta el
// servidor y no queda escrito en ningún archivo.
//
// **Eso sí se resolvió, pero en otro paquete y por otra vía**: no leyendo el
// disco ni imitando su gRPC, sino preguntándole al propio CLI con
// `agy --print "/usage" --output-format json`, que es su interfaz pública. Ver
// backend/agentlimits/query.go. Acá no cambia nada: este paquete mide TOKENS
// consumidos, y esos Antigravity sigue sin escribirlos en ningún lado.
//
// Por eso acá se reporta lo que SÍ está y es verdad: **actividad**
// (conversaciones y pasos, en total y sobre el repositorio abierto), con el
// campo de tokens vacío y una nota que dice dónde se ve la cuota de verdad.
// Un panel que dijera "0 tokens" para un agente que se usó todo el día sería
// simplemente falso.

// antigravityDir es dónde vive su estado. Vale la pena el comentario porque no
// es obvio: el binario se llama `agy`, pero cuelga de ~/.gemini.
const antigravityDir = ".gemini/antigravity-cli"

func readAntigravity(home, repoRoot string) AgentUsage {
	dir := filepath.Join(home, filepath.FromSlash(antigravityDir))
	u := AgentUsage{Agent: "antigravity", Source: dir}

	if _, err := os.Stat(dir); err != nil {
		u.Note = "No se encontró Antigravity CLI en esta máquina."
		return u
	}

	u.Note = "Antigravity no escribe los tokens consumidos en el disco. Lo que sí se puede leer acá es la actividad; la cuota se consulta con el botón de arriba."

	act, ok := readAntigravityActivity(filepath.Join(dir, "conversation_summaries.db"), repoRoot)
	if ok {
		u.Activity = &act
	}
	return u
}

// readAntigravityActivity lee la base de resúmenes de conversación.
//
// Se abre en modo **solo lectura** (`mode=ro`): es la base viva de otro
// programa que puede estar corriendo al mismo tiempo, y abrirla de otra forma
// arriesgaría bloquearlo o escribirle un journal. Cualquier fallo devuelve
// ok=false en vez de un error: que la base esté bloqueada o cambie de esquema
// no puede romper el panel entero.
func readAntigravityActivity(dbPath, repoRoot string) (Activity, bool) {
	if _, err := os.Stat(dbPath); err != nil {
		return Activity{}, false
	}

	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return Activity{}, false
	}
	defer db.Close()

	rows, err := db.Query(`SELECT COALESCE(step_count, 0), COALESCE(workspace_uris, ''), COALESCE(last_modified_time, '') FROM conversation_summaries`)
	if err != nil {
		return Activity{}, false
	}
	defer rows.Close()

	var act Activity
	var last time.Time

	for rows.Next() {
		var steps int
		var workspaces, modified string
		if err := rows.Scan(&steps, &workspaces, &modified); err != nil {
			continue
		}

		act.Conversations++
		act.Steps += steps

		// workspace_uris es una lista serializada de URIs; alcanza con buscar
		// la ruta del repositorio adentro, sin depender de su formato exacto
		// —que es justamente el tipo de detalle que cambia entre versiones—.
		if repoRoot != "" && strings.Contains(workspaces, repoRoot) {
			act.RepoConversations++
			act.RepoSteps += steps
		}

		if t, err := parseSQLiteTime(modified); err == nil && t.After(last) {
			last = t
		}
	}
	if rows.Err() != nil {
		return Activity{}, false
	}

	if !last.IsZero() {
		act.LastUsed = last.Local().Format("2006-01-02")
	}
	return act, true
}

// parseSQLiteTime prueba los formatos con los que un `datetime` puede haber
// quedado escrito. No hay uno solo: depende de la librería que lo escribió.
func parseSQLiteTime(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05",
	}
	var err error
	for _, l := range layouts {
		var t time.Time
		if t, err = time.Parse(l, v); err == nil {
			return t, nil
		}
	}
	return time.Time{}, err
}
