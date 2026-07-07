# Contrato Go ↔ React

Superficie de binding del struct `App` (`app.go`). Regla general: el frontend nunca ve un DSN ni un password, solo IDs de conexión opacos; ningún método crudo de SQL sin pasar por la capa backend.

> Este documento se actualiza a mano en cada fase que añade o cambia métodos de `App`. Cuando `backend/claudemd/generator.go` exista (Fase 9), la versión que la app escribe en proyectos de terceros se genera por reflexión sobre `App` para que se auto-actualice; esta copia del propio repo mini-tools se mantiene manualmente porque describe la app en desarrollo, no un artefacto generado por ella.

| Área | Métodos | Fase que lo introduce |
|---|---|---|
| Ciclo de vida del vault | `IsVaultInitialized()`, `InitializeVault(password)`, `UnlockVault(password)` | Fase 2 |
| Conexiones | `TestConnection(cfg)`, `SaveConnection(cfg, force bool)`, `ListConnections()`, `DeleteConnection(id)` | Fase 3 (`ExportConnectionConfig(id)` queda para Fase 7, junto al resto de export) |
| Metadata | `GetSchemaMetadata(connID, forceRefresh bool)` | Fase 6 |
| Ejecución de queries | `ExecuteQuery(connID, queryID, sqlText)`, `CancelQuery(queryID)` | Fase 3 (mínimo, un solo statement) → se completa en Fase 5 (PL/SQL, multi-statement) |
| Archivos | `OpenSQLFileDialog()`, `SaveSQLFile(path, content)`, `SaveSQLFileAs(suggestedName, content)`, `ListRecentFiles()`, `ClearRecentFiles()` | Fase 6 |
| Explain | `ExplainQuery(connID, sqlText, analyze bool)`, `ListExplainHistory(connID)` | Fase 8 |
| Export | `ExportResultToFile(queryID, format, destPath)`, `ExportTableDDL(connID, schema, table)`, `ExportSchemaDDL(connID, schema)` | Fase 7 |
| Settings | `GetSettings()`, `SetTheme(themeName)` | Fase 10 |
| CLAUDE.md | `GenerateProjectDocs(projectRootPath)`, `RegenerateProjectDocs(projectRootPath)` | Fase 9 |

Estado actual (Fase 4 — completa): además del ciclo de vida del vault, `app.go` implementa `TestConnection`, `SaveConnection`, `ListConnections`, `DeleteConnection`, `ExecuteQuery` y `CancelQuery`, todos detrás de `requireUnlocked()` (falla con `vaultgate.ErrLocked` si el vault está bloqueado — el "no bypass" del gate ya se ejerce de verdad, no solo con los métodos de ciclo de vida). Los 3 conectores están implementados (`backend/db/{sqlite,postgres,oracle}.go`) — `db.ConnectorFor` ya no devuelve error para ningún `db_type` válido. El executor (`backend/query/executor.go`) sigue siendo mínimo: clasifica SELECT-like vs todo lo demás con un heurístico simple (sin detectar bloques PL/SQL ni dividir multi-statement todavía — eso es Fase 5).

**Nota de tamaño de binario:** añadir Postgres+Oracle llevó el binario de ~12MB a ~31MB (Oracle solo agrega ~15MB por `crypto/tls`/FIPS 140-3, no opcional en `go-ora`). El target de <20MB del spec original se revisó a <35MB — ver [.claude/rules/technical.md](../rules/technical.md) punto 8.

## Eventos (streaming)

Los resultados de queries no viajan como valor de retorno de `ExecuteQuery` — se emiten como eventos vía un `query.EmitFunc` inyectado (en producción, un closure sobre `runtime.EventsEmit(ctx, queryID, chunk)`; en tests, un stub — `runtime.EventsEmit` exige un contexto real inyectado por Wails y mata el proceso sin uno, así que el executor nunca lo llama directamente). El frontend debe llamar `EventsOn(queryID, ...)` **antes** de invocar `ExecuteQuery` (el `queryID` lo genera el cliente, no el backend) para no perder el primer chunk.
