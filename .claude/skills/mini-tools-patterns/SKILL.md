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

Esto permite que `backend/db/connector.go` defina una única interfaz `Connector` y que `pool_manager.go` mantenga un solo `map[connID]*Pool` sin importar el motor. Al añadir un motor nuevo:

1. Implementar `Connector` en `backend/db/<motor>.go` (builder de DSN a partir de la config de conexión, nunca aceptando un DSN crudo desde el frontend).
2. Registrar el pool en `pool_manager.go` — un pool por conexión activa, nunca reabrir por query.
3. Añadir las queries de metadata (`backend/db/metadata.go`) para poblar el árbol del sidebar y el autocomplete de Monaco.
4. Cerrar el pool explícitamente al eliminar o cambiar la conexión.

SQLite siempre en modo WAL al abrir (`PRAGMA journal_mode=WAL`). Postgres soporta el set completo de `sslmode` vía `pgx.ParseConfig`. Oracle soporta TNS, Easy Connect, SID y Service Name en el DSN builder.

# Patrones de ejecución de queries

`backend/query/detect.go` clasifica el texto como SQL plano o bloque PL/SQL (`BEGIN`/`DECLARE`/`CREATE OR REPLACE`). `splitter.go` divide un script en statements respetando comillas, comentarios y anidamiento `BEGIN...END` — sin librería de parsing externa (ver [.claude/rules/technical.md](../../rules/technical.md)).

Streaming de resultados: como los bindings de Wails v2 son petición/respuesta, `executor.go` emite los resultados por chunks vía `runtime.EventsEmit`, no como el valor de retorno del binding. El **frontend genera el `queryID`** y llama `EventsOn(queryID, ...)` antes de invocar `ExecuteQuery(queryID, connID, sql)` — si el backend generara el ID habría una carrera entre el primer emit y la suscripción.

Cancelación: cada `queryID` en curso tiene un `context.CancelFunc` registrado; `CancelQuery(queryID)` lo invoca y limpia el registro. El pool debe quedar sano después de cancelar (no cerrar la conexión subyacente, solo el statement en curso).
