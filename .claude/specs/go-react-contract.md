# Contrato Go ↔ React

Superficie de binding del struct `App` (`app.go`). Regla general: el frontend nunca ve un DSN ni un password, solo IDs de conexión opacos; ningún método crudo de SQL sin pasar por la capa backend.

> Este documento se actualiza a mano en cada fase que añade o cambia métodos de `App`. Cuando `backend/claudemd/generator.go` exista (Fase 9), la versión que la app escribe en proyectos de terceros se genera por reflexión sobre `App` para que se auto-actualice; esta copia del propio repo mini-tools se mantiene manualmente porque describe la app en desarrollo, no un artefacto generado por ella.

| Área | Métodos | Fase que lo introduce |
|---|---|---|
| Ciclo de vida del vault | `IsVaultInitialized()`, `InitializeVault(password)`, `UnlockVault(password)` | Fase 2 |
| Backup/restore del vault | `BackupVault()`, `RestoreVaultBackup()` | agregado fuera de fase (a pedido), antes de Fase 5 |
| Conexiones | `TestConnection(cfg)`, `SaveConnection(cfg, force bool)`, `ListConnections()`, `DeleteConnection(id)` | Fase 3 (`ExportConnectionConfig(id)` queda para Fase 7, junto al resto de export) |
| Metadata | `GetSchemaMetadata(connID, forceRefresh bool)` | Fase 6 |
| Ejecución de queries | `ExecuteQuery(connID, queryID, sqlText)`, `CancelQuery(queryID)` | Fase 3 (mínimo) → completo en Fase 5 (split multi-statement, PL/SQL, DBMS_OUTPUT) |
| Historial de queries | `ListQueryHistory(connID, limit)` | Fase 5 |
| Archivos | `OpenSQLFileDialog()`, `SaveSQLFile(path, content)`, `SaveSQLFileAs(suggestedName, content)`, `ListRecentFiles()`, `ClearRecentFiles()` | Fase 6 |
| Explain | `ExplainQuery(connID, sqlText, analyze bool)`, `ListExplainHistory(connID)` | Fase 8 |
| Export | `ExportResultToFile(queryID, format, destPath)`, `ExportTableDDL(connID, schema, table)`, `ExportSchemaDDL(connID, schema)` | Fase 7 |
| Settings | `GetSettings()`, `SetTheme(themeName)` | Fase 10 |
| CLAUDE.md | `GenerateProjectDocs(projectRootPath)`, `RegenerateProjectDocs(projectRootPath)` | Fase 9 |

Estado actual (Fase 5 — completa): además del ciclo de vida del vault, `app.go` implementa `TestConnection`, `SaveConnection`, `ListConnections`, `DeleteConnection`, `ExecuteQuery`, `CancelQuery` y `ListQueryHistory`, todos detrás de `requireUnlocked()` (falla con `vaultgate.ErrLocked` si el vault está bloqueado). Los 3 conectores están implementados (`backend/db/{sqlite,postgres,oracle}.go`).

El executor ahora es el motor completo: `backend/query/detect.go` clasifica cada statement (SQL plano vs PL/SQL) y `splitter.go` divide un script en statements respetando comillas/comentarios/dollar-quoting Postgres/anidamiento BEGIN-END Oracle (ver el `SKILL.md` del proyecto para el detalle y las limitaciones aceptadas — CREATE PACKAGE BODY con múltiples miembros no se garantiza que divida bien). Cada statement se ejecuta y emite su propia secuencia columns/rows/done bajo el mismo `queryID` pero con `statementIndex`/`totalStatements` en el `Event`, para que el frontend arme un result-tab por statement (`ResultTabs.tsx`). Un bloque PL/SQL Oracle corre vía `backend/query/dbmsoutput.go` (`runOraclePLSQLBlock`, sobre una única `*sql.Conn` reservada del pool para que `DBMS_OUTPUT.ENABLE/PUT_LINE/GET_LINE` vean la misma sesión) y sus líneas de salida viajan en `Event.DBMSOutput`. Una cancelación detiene el script completo (no sigue con los statements restantes); un error en un statement individual NO detiene el script (coincide con el comportamiento por defecto de sqlplus/mysql — los statements siguientes igual corren). Cada resultado terminal (done/error/cancelled) se persiste vía `query.HistorySink` en `query_history` (tabla sin cifrar, ver `backend/vault/history_repo.go`).

**Limitación conocida, no verificada en vivo:** el bloque PL/SQL + DBMS_OUTPUT no se pudo probar contra una instancia Oracle real (no disponible en este entorno) — se verificó por inspección de código y, para la parte DB-agnóstica (split de statements), con un script efímero cubriendo bloques DECLARE/BEGIN/END, IF/END IF anidado, CREATE PROCEDURE, y dollar-quoting Postgres. El streaming multi-statement, la cancelación de scripts, y una query de 5000 filas sí se verificaron end-to-end contra SQLite real.

**Nota de tamaño de binario:** añadir Postgres+Oracle llevó el binario de ~12MB a ~31MB (Oracle solo agrega ~15MB por `crypto/tls`/FIPS 140-3, no opcional en `go-ora`). El target de <20MB del spec original se revisó a <35MB — ver [.claude/rules/technical.md](../rules/technical.md) punto 8.

**Backup/restore del vault:** `BackupVault()` pide destino con `runtime.SaveFileDialog` y llama `vault.Store.Backup` (usa `VACUUM INTO` para un snapshot consistente de `vault.db` + copia de `salt.bin`, empaquetados en un zip `.mtbackup`) — requiere `requireUnlocked()`. `RestoreVaultBackup()` pide origen con `runtime.OpenFileDialog`, solo permitido si `IsInitialized()` es `false` (nunca pisa un vault existente sin que el usuario borre/respalde el actual primero); cierra el `*vault.Store` actual, llama `vault.RestoreBackup` (extrae ambos archivos, limpia `-wal`/`-shm` viejos), y reabre un `Store` nuevo. Verificado manualmente con un script efímero: backup → borrar vault.db/salt.bin reales → restore → `Unlock` con la clave original tiene éxito → la conexión guardada sigue ahí y su DSN desencripta igual.

## Eventos (streaming)

Los resultados de queries no viajan como valor de retorno de `ExecuteQuery` — se emiten como eventos vía un `query.EmitFunc` inyectado (en producción, un closure sobre `runtime.EventsEmit(ctx, queryID, chunk)`; en tests, un stub — `runtime.EventsEmit` exige un contexto real inyectado por Wails y mata el proceso sin uno, así que el executor nunca lo llama directamente). El frontend debe llamar `EventsOn(queryID, ...)` **antes** de invocar `ExecuteQuery` (el `queryID` lo genera el cliente, no el backend) para no perder el primer chunk.
