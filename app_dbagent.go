package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"mini-tools/backend/agentctx"
	"mini-tools/backend/db"
	"mini-tools/backend/explain"
)

// IA agéntica sobre bases de datos: escribir una consulta desde lenguaje
// natural, explicar y corregir un error del motor, y analizar un plan de
// ejecución.
//
// Los tres son la misma forma: se arma un prompt con el contexto que la app ya
// tiene (esquema, error, plan) y se le pide UNA respuesta al agente activo con
// `AgentAsk` — que no puede editar archivos ni ejecutar nada. **El agente
// propone; ejecutar sigue siendo un clic del usuario.** Un asistente que corre
// contra la base la consulta que acaba de escribir es exactamente el producto
// que nadie pidió, y menos contra una conexión marcada como producción.
//
// Nada de esto abre una conexión nueva ni lee una sola fila: el esquema sale
// del cache de metadata que la app ya usa para el autocompletado, y el plan del
// historial de EXPLAIN.

// SQLSuggestion es una propuesta del agente lista para ofrecerse en el editor.
type SQLSuggestion struct {
	// Code es la consulta extraída del bloque de código, que es lo que se
	// aplica al editor.
	Code string `json:"code"`
	// Answer es la respuesta completa en Markdown: la explicación de por qué
	// hizo lo que hizo. Se muestra al lado y no se descarta — un reemplazo sin
	// explicación obliga a leer la consulta entera para entender qué cambió.
	Answer string `json:"answer"`
	// Dialect es el motor para el que se escribió, para poder decirlo en la UI.
	Dialect string `json:"dialect"`
	// Tables son las tablas cuyo DDL se le pasó al agente. Es la respuesta a
	// "¿qué le mandaste de mi base?", que tiene que poder contestarse.
	Tables []string `json:"tables"`
	// TotalTables es cuántas hay en la conexión, para poder decir que el
	// contexto se recortó en vez de dar a entender que se mandó todo.
	TotalTables int `json:"totalTables"`
}

// AgentGenerateSQL escribe una consulta a partir de un pedido en lenguaje
// natural, en el dialecto del motor de esa conexión.
//
// currentSQL es lo que hay en el editor: cuando no está vacío, el pedido se
// interpreta como una modificación de esa consulta, que es el caso más común
// ("agregale el filtro por fecha") y el que hace que la respuesta tenga que
// ser un reemplazo completo y no un fragmento suelto.
func (a *App) AgentGenerateSQL(connID, request, currentSQL string) (SQLSuggestion, error) {
	if err := a.requireUnlocked(); err != nil {
		return SQLSuggestion{}, err
	}
	if strings.TrimSpace(request) == "" {
		return SQLSuggestion{}, fmt.Errorf("app: el pedido está vacío")
	}

	dbType, schema, err := a.schemaContextFor(connID, request+"\n"+currentSQL)
	if err != nil {
		return SQLSuggestion{}, err
	}

	answer, err := a.AgentAsk(agentctx.GeneratePrompt(dbType, request, currentSQL, schema), "db", connID)
	if err != nil {
		return SQLSuggestion{}, err
	}
	return suggestionFrom(answer, dbType, schema), nil
}

// AgentFixSQL explica por qué falló una consulta y devuelve la corregida.
//
// El error va tal cual lo devolvió el motor: un `ORA-00942` lleva adentro más
// información que cualquier parafraseo, y el agente sabe leerlo.
func (a *App) AgentFixSQL(connID, sqlText, errText string) (SQLSuggestion, error) {
	if err := a.requireUnlocked(); err != nil {
		return SQLSuggestion{}, err
	}
	if strings.TrimSpace(sqlText) == "" || strings.TrimSpace(errText) == "" {
		return SQLSuggestion{}, fmt.Errorf("app: hace falta la consulta y el error para poder corregirla")
	}

	dbType, schema, err := a.schemaContextFor(connID, sqlText+"\n"+errText)
	if err != nil {
		return SQLSuggestion{}, err
	}

	answer, err := a.AgentAsk(agentctx.FixPrompt(dbType, sqlText, errText, schema), "db", connID)
	if err != nil {
		return SQLSuggestion{}, err
	}
	return suggestionFrom(answer, dbType, schema), nil
}

// AgentAnalyzePlan le pide al agente que explique el último plan de ejecución
// de una conexión y proponga cómo acelerarlo.
//
// Va acompañado de los hallazgos DETERMINISTAS que backend/explain ya calculó
// —nodos críticos, escaneos completos, estimaciones erradas, índices
// sugeridos—. Eso no es redundante: la app ya sabe DÓNDE está el problema, y
// lo que no puede saber es por qué pasa y qué conviene hacer, que es lo único
// que se le pregunta.
//
// Devuelve la respuesta en Markdown, sin extraer código: acá lo valioso es la
// explicación, y el `CREATE INDEX` que proponga se copia a mano a propósito —
// crear un índice es una escritura real sobre una base real.
func (a *App) AgentAnalyzePlan(connID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	entries, err := a.vault.ListExplainHistory(connID, 1)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return "", fmt.Errorf("app: todavía no se corrió ningún EXPLAIN en esta conexión")
	}
	e := entries[0]

	planJSON, err := json.Marshal(e.Plan)
	if err != nil {
		return "", err
	}

	dbType, schema, err := a.schemaContextFor(connID, e.SQLText)
	if err != nil {
		return "", err
	}

	return a.AgentAsk(
		agentctx.PlanPrompt(dbType, e.SQLText, string(planJSON), renderFindings(e.Plan.Insights), schema),
		"db", connID,
	)
}

// schemaContextFor resuelve el motor de una conexión y arma el contexto de
// esquema relevante para un texto.
func (a *App) schemaContextFor(connID, hintText string) (db.DBType, agentctx.SchemaContext, error) {
	conn, err := a.connByNameOrID(connID)
	if err != nil {
		return "", agentctx.SchemaContext{}, err
	}
	dbType := db.DBType(conn.DBType)
	if dbType == "ssh" {
		return "", agentctx.SchemaContext{}, fmt.Errorf("app: %q es una conexión SSH, no una base de datos", conn.Name)
	}

	// Mongo y Redis no pasan por `database/sql` y por lo tanto tampoco por el
	// catálogo relacional (ver .claude/rules/technical.md punto 2): cada uno
	// arma su contexto con lo suyo, y con una regla de privacidad más estricta
	// — ver backend/agentctx/nosqlctx.go.
	switch dbType {
	case db.DBTypeMongo:
		return dbType, a.mongoContext(conn.ID, hintText), nil
	case db.DBTypeRedis:
		return dbType, a.redisContext(conn.ID), nil
	}

	// El esquema sale del cache que ya alimenta el autocompletado. Un fallo
	// leyéndolo NO cancela la consulta al agente: se le pide igual, con el
	// contexto que haya —una base a la que no se pudo leer el catálogo sigue
	// admitiendo una pregunta de sintaxis—, y el prompt dice que el esquema no
	// se pudo leer en vez de callarlo.
	meta, err := a.GetSchemaMetadata(conn.ID, false)
	if err != nil {
		meta = nil
	}
	return dbType, agentctx.BuildSchemaContext(meta, dbType, hintText), nil
}

// mongoContext arma el contexto de una conexión Mongo: colecciones, campos
// inferidos e índices. Nunca un documento ni un valor.
func (a *App) mongoContext(connID, hintText string) agentctx.SchemaContext {
	database, err := a.GetMongoDefaultDatabase(connID)
	if err != nil {
		return agentctx.SchemaContext{Text: "// (no se pudo resolver la base Mongo de esta conexión)"}
	}
	colls, err := a.ListMongoCollections(connID, database, false)
	if err != nil {
		return agentctx.SchemaContext{Text: "// (no se pudieron listar las colecciones)"}
	}

	out := make([]agentctx.MongoCollection, 0, len(colls))
	for _, c := range colls {
		mc := agentctx.MongoCollection{Name: c.Name, Count: c.EstimatedCount}
		// Los campos y los índices se piden SOLO de las colecciones que el
		// pedido menciona: muestrear documentos de todas es caro y, en una
		// base grande, lento de una forma que se nota.
		if strings.Contains(strings.ToLower(hintText), strings.ToLower(c.Name)) {
			if fields, err := a.SampleMongoFields(connID, database, c.Name); err == nil {
				for _, f := range fields {
					mc.Fields = append(mc.Fields, f.Path+" ("+strings.Join(f.Types, "|")+")")
				}
			}
			if idx, err := a.GetMongoIndexes(connID, database, c.Name); err == nil {
				for _, i := range idx {
					mc.Indexes = append(mc.Indexes, i.Name+" "+i.KeysJSON)
				}
			}
		}
		out = append(out, mc)
	}
	return agentctx.BuildMongoContext(database, out, hintText)
}

// redisContext arma el contexto de una conexión Redis a partir de una muestra
// de claves, colapsadas a patrones. Ver BuildRedisContext para por qué los
// nombres de clave no pueden ir tal cual.
func (a *App) redisContext(connID string) agentctx.SchemaContext {
	// Una sola página del SCAN: alcanza para reconocer los patrones y no
	// recorre una base entera para responder una pregunta.
	page, err := a.ListRedisKeys(connID, "", "*", "", 500)
	if err != nil {
		return agentctx.SchemaContext{Text: "# (no se pudieron muestrear las claves de esta conexión)"}
	}
	var total int64
	if stats, err := a.GetRedisStats(connID); err == nil {
		total = stats.TotalKeys
	}
	return agentctx.BuildRedisContext(page.Keys, total)
}

func suggestionFrom(answer string, dbType db.DBType, schema agentctx.SchemaContext) SQLSuggestion {
	return SQLSuggestion{
		Code:        agentctx.ExtractCode(answer),
		Answer:      answer,
		Dialect:     string(dbType),
		Tables:      schema.Included,
		TotalTables: schema.TotalTables,
	}
}

// renderFindings escribe los hallazgos deterministas del plan como texto para
// el prompt.
//
// Se incluye el SQL sugerido de cada uno (el CREATE INDEX que ya calculó
// backend/explain/suggest.go) para que el agente lo evalúe en vez de volver a
// derivarlo: si está de acuerdo lo confirma, y si no, explica por qué no —
// las dos respuestas son más útiles que una propuesta paralela.
func renderFindings(insights []explain.Insight) string {
	if len(insights) == 0 {
		return ""
	}
	var b strings.Builder
	for _, in := range insights {
		fmt.Fprintf(&b, "- [%s] %s", in.Severity, in.Title)
		if in.Node != "" {
			fmt.Fprintf(&b, " (nodo: %s)", in.Node)
		}
		b.WriteString("\n")
		if in.Detail != "" {
			fmt.Fprintf(&b, "  %s\n", in.Detail)
		}
		if in.SQL != "" {
			fmt.Fprintf(&b, "  Sugerencia que ya calculó la app: %s\n", in.SQL)
		}
	}
	return b.String()
}
