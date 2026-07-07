---
name: mini-tools-patterns
description: Patrones de conectores de base de datos y de ejecución de queries usados en mini-tools. Consultar antes de añadir un motor de BD nuevo, tocar el pool manager, o modificar el executor de queries (streaming/cancelación/detección PL-SQL).
---

# Patrones de conectores

Los 3 motores (Oracle, PostgreSQL, SQLite) se registran como drivers de `database/sql` en vez de usarse con sus SDKs nativos o con `sqlx`:

| Motor | Import | Driver name |
|---|---|---|
| Oracle | `github.com/sijms/go-ora/v2` | `"oracle"` |
| PostgreSQL | `github.com/jackc/pgx/v5/stdlib` | `"pgx"` |
| SQLite | `modernc.org/sqlite` | `"sqlite"` |

Esto permite que `backend/db/connector.go` defina una única interfaz `Connector` y que `pool_manager.go` (`PoolManager`) mantenga un solo `map[connID]*sql.DB` sin importar el motor. Solo SQLite está implementado hoy (`backend/db/sqlite.go`); `ConnectorFor` devuelve error explícito para Postgres/Oracle hasta Fase 4. Cada archivo de conector debe blank-importar su propio driver (`_ "modernc.org/sqlite"`, etc.) — no asumir que otro paquete ya lo registró, o los tests de ese paquete en aislamiento fallan con "unknown driver". Al añadir un motor nuevo:

1. Implementar `Connector` en `backend/db/<motor>.go` (builder de DSN a partir de la config de conexión, nunca aceptando un DSN crudo desde el frontend).
2. Registrar el pool en `pool_manager.go` — un pool por conexión activa, nunca reabrir por query.
3. Añadir las queries de metadata (`backend/db/metadata.go`) para poblar el árbol del sidebar y el autocomplete de Monaco.
4. Cerrar el pool explícitamente al eliminar o cambiar la conexión.

SQLite siempre en modo WAL al abrir (`PRAGMA journal_mode=WAL`). Postgres soporta el set completo de `sslmode` vía `pgx.ParseConfig`. Oracle soporta TNS, Easy Connect, SID y Service Name en el DSN builder.

# Patrones de ejecución de queries

Hoy (Fase 3) `backend/query/executor.go` solo clasifica el texto con un heurístico simple — SELECT-like (`SELECT`/`WITH`/`PRAGMA`/`EXPLAIN`) vs todo lo demás — sin bloques PL/SQL ni multi-statement. `detect.go`/`splitter.go` (detección real de bloques PL/SQL vía `BEGIN`/`DECLARE`, split respetando comillas/comentarios/anidamiento) llegan en Fase 5; hasta entonces, no asumir que existen.

Streaming de resultados: como los bindings de Wails v2 son petición/respuesta, `executor.go` nunca llama `runtime.EventsEmit` directamente — recibe un `query.EmitFunc` inyectado (`func(event string, data interface{})`) por quien lo construye. En producción (`app.go`) ese `EmitFunc` envuelve `runtime.EventsEmit(ctx, event, data)`; en tests es un stub que empuja a un channel. Esto es necesario porque `runtime.EventsEmit` exige un `context.Context` inyectado por el ciclo de vida real de Wails y llama `log.Fatalf` (mata el proceso) sin uno — no se puede testear el executor invocándolo directo. El **frontend genera el `queryID`** y llama `EventsOn(queryID, ...)` antes de invocar `ExecuteQuery(connID, queryID, sql)` — si el backend generara el ID habría una carrera entre el primer emit y la suscripción.

Cancelación: cada `queryID` en curso tiene un `context.CancelFunc` registrado; `CancelQuery(queryID)` lo invoca y limpia el registro. El pool debe quedar sano después de cancelar (no cerrar la conexión subyacente, solo el statement en curso) — verificado en `backend/query/executor_test.go` con una CTE recursiva larga.
