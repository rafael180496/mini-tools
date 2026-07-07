# Contrato Go ↔ React

Superficie de binding del struct `App` (`app.go`). Regla general: el frontend nunca ve un DSN ni un password, solo IDs de conexión opacos; ningún método crudo de SQL sin pasar por la capa backend.

> Este documento se actualiza a mano en cada fase que añade o cambia métodos de `App`. Cuando `backend/claudemd/generator.go` exista (Fase 9), la versión que la app escribe en proyectos de terceros se genera por reflexión sobre `App` para que se auto-actualice; esta copia del propio repo mini-tools se mantiene manualmente porque describe la app en desarrollo, no un artefacto generado por ella.

| Área | Métodos | Fase que lo introduce |
|---|---|---|
| Ciclo de vida del vault | `IsVaultInitialized()`, `InitializeVault(password)`, `UnlockVault(password)` | Fase 2 |
| Conexiones | `TestConnection(cfg)`, `SaveConnection(cfg, force bool)`, `ListConnections()`, `DeleteConnection(id)`, `ExportConnectionConfig(id)` | Fase 3-4 |
| Metadata | `GetSchemaMetadata(connID, forceRefresh bool)` | Fase 6 |
| Ejecución de queries | `ExecuteQuery(queryID, connID, sqlText)`, `CancelQuery(queryID)` | Fase 5 |
| Archivos | `OpenSQLFileDialog()`, `SaveSQLFile(path, content)`, `SaveSQLFileAs(suggestedName, content)`, `ListRecentFiles()`, `ClearRecentFiles()` | Fase 6 |
| Explain | `ExplainQuery(connID, sqlText, analyze bool)`, `ListExplainHistory(connID)` | Fase 8 |
| Export | `ExportResultToFile(queryID, format, destPath)`, `ExportTableDDL(connID, schema, table)`, `ExportSchemaDDL(connID, schema)` | Fase 7 |
| Settings | `GetSettings()`, `SetTheme(themeName)` | Fase 10 |
| CLAUDE.md | `GenerateProjectDocs(projectRootPath)`, `RegenerateProjectDocs(projectRootPath)` | Fase 9 |

Estado actual (Fase 2 — completa): `IsVaultInitialized()`, `InitializeVault(password)` y `UnlockVault(password)` implementados en `app.go` sobre `backend/vault.Store` + `backend/vaultgate.Gate`. El `Greet` de demo fue eliminado. Ningún método más existe todavía, así que el "no bypass" real del gate se prueba a partir de Fase 3, cuando aparezcan los primeros métodos que deban revisar `a.gate`/`a.vault` antes de tocar datos de conexión.

## Eventos (streaming)

Los resultados de queries no viajan como valor de retorno de `ExecuteQuery` — se emiten como eventos `runtime.EventsEmit(ctx, queryID, chunk)` desde una goroutine en el backend. El frontend debe llamar `EventsOn(queryID, ...)` **antes** de invocar `ExecuteQuery` (el `queryID` lo genera el cliente, no el backend) para no perder el primer chunk.
