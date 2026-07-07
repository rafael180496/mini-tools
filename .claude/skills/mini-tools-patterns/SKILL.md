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

Esto permite que `backend/db/connector.go` defina una única interfaz `Connector` y que `pool_manager.go` (`PoolManager`) mantenga un solo `map[connID]*sql.DB` sin importar el motor. Los 3 conectores están implementados (`sqlite.go`, `postgres.go`, `oracle.go`) — `ConnectorFor` ya no devuelve error para ningún `db_type` válido. Cada archivo de conector blank-importa su propio driver (`_ "modernc.org/sqlite"`, `_ "github.com/jackc/pgx/v5/stdlib"`) — Oracle es la excepción porque `go_ora.BuildUrl` (no un blank import) es lo que se usa para construir el DSN, pero el driver igual se registra al importar el paquete. No asumir que otro paquete ya registró un driver — cada uno se registra a sí mismo, o los tests de ese paquete en aislamiento fallan con "unknown driver". Al añadir un motor nuevo:

1. Implementar `Connector` en `backend/db/<motor>.go` (builder de DSN a partir de la config de conexión, nunca aceptando un DSN crudo desde el frontend).
2. Registrar el pool en `pool_manager.go` — un pool por conexión activa, nunca reabrir por query.
3. Añadir las queries de metadata (`backend/db/metadata.go`) para poblar el árbol del sidebar y el autocomplete de Monaco.
4. Cerrar el pool explícitamente al eliminar o cambiar la conexión.

SQLite siempre en modo WAL al abrir (`PRAGMA journal_mode=WAL`). Postgres soporta el set completo de `sslmode` (disable/allow/prefer/require/verify-ca/verify-full) armando una URL `postgres://user:pass@host:port/db?sslmode=X` que pgx parsea. Oracle soporta los 4 modos de conexión del spec vía `params["mode"]`: `service_name`/`easy_connect` (misma forma DSN — Easy Connect ES literalmente `host:port/service`), `sid` (`go_ora.BuildUrl` con `service=""` + opción `SID=`), y `tns` (descriptor completo pegado de tnsnames.ora, pasado como opción `connStr=` — go-ora lo parsea y sus valores de host/protocolo/servicio pisan a los del DSN base). Ver `backend/db/oracle.go` para el detalle de cada modo.

**Costo de tamaño de binario de Oracle:** `go-ora` usa `crypto/tls` en su código core (soporte TCPS, no opcional, no excluible con build tags), y desde Go 1.24 eso arrastra el módulo FIPS 140-3 completo — agrega ~15MB al binario final. Esto ya forzó revisar el target de tamaño de <20MB a <35MB (ver [.claude/rules/technical.md](../../rules/technical.md) punto 8) — tenerlo en cuenta antes de añadir otra dependencia grande.

# Patrones de ejecución de queries

**Split de statements** (`backend/query/splitter.go`, `SplitStatements`): divide un script en statements por `;` a nivel top-level, respetando comillas simples/dobles, comentarios `--`/`/* */`, dollar-quoting Postgres (`$$...$$` / `$tag$...$tag$`), y anidamiento `BEGIN...END` de Oracle (incluyendo la sección `DECLARE` y el cuerpo `IS/AS...BEGIN...END` de `CREATE [OR REPLACE] PROCEDURE/FUNCTION/TRIGGER/TYPE`). Reglas clave si tocás esto:
- `awaitingBegin` bloquea el split en la sección declare/parámetros (antes del primer `BEGIN`); `blockDepth` cuenta `BEGIN`(+1)/`END` bare(-1) una vez dentro. `END IF`/`END LOOP`/`END CASE` NO son un `END` bare — no decrementan `blockDepth` (van con su propio IF/LOOP/CASE, no con un BEGIN).
- Entrar a un dollar-quote (`$$`/`$tag$`) limpia `awaitingBegin` — si no, un cuerpo Postgres `AS $$ BEGIN ... END; $$ LANGUAGE plpgsql;` nunca cerraría (el `BEGIN` interno nunca se "ve" porque está protegido dentro del dollar-quote).
- **Limitación aceptada:** `CREATE PACKAGE BODY` con múltiples procedimientos miembro (múltiples pares BEGIN/END independientes) no se garantiza que divida bien — cada miembro re-entra en modo "awaitingBegin" que este tokenizer no rastrea. Bloques anónimos DECLARE/BEGIN y unidades CREATE PROCEDURE/FUNCTION/TRIGGER individuales sí funcionan. Ver `.claude/rules/technical.md` punto 7 (hand-rolled, no gramática completa).

`backend/query/detect.go` (`IsPLSQLBlock`) clasifica un statement como `KindSQL` o `KindPLSQLBlock` reusando la misma lógica de arranque que el splitter.

**Ejecución por statement, no por script:** `Executor.run` parte el `sqlText` con `SplitStatements` y corre cada uno por separado, emitiendo su propia secuencia `columns`/`rows`/`done` (o `error`/`cancelled`) bajo el mismo `queryID` pero con `Event.StatementIndex`/`TotalStatements` — así el frontend arma un result-tab por statement (`ResultTabs.tsx`) en vez de mezclar resultados de varios statements en un solo grid. Un error en un statement **no** detiene el script (siguen corriendo los demás, como sqlplus/mysql por default); una cancelación sí lo detiene por completo — el chequeo `ctx.Err()` al tope del loop hace `break`, no `continue` (un bug real de la primera versión: `continue` emitía un evento "cancelled" fantasma por cada statement restante en vez de simplemente dejar de correrlos).

**Bloques PL/SQL Oracle** (`backend/query/dbmsoutput.go`): un statement `KindPLSQLBlock` contra una conexión Oracle corre vía `runOraclePLSQLBlock`, que reserva una única `*sql.Conn` del pool (`pool.Conn(ctx)`) para `ENABLE`, ejecutar el bloque, y `GET_LINE` — todo en la MISMA sesión, porque el estado de `DBMS_OUTPUT` es por sesión; usar conexiones distintas del pool para cada paso simplemente no vería nada. Las líneas capturadas viajan en `Event.DBMSOutput`. Esta ruta no se pudo probar contra una instancia Oracle real (no disponible en el entorno de desarrollo) — solo por inspección de código.

Streaming de resultados: como los bindings de Wails v2 son petición/respuesta, `executor.go` nunca llama `runtime.EventsEmit` directamente — recibe un `query.EmitFunc` inyectado (`func(event string, data interface{})`) por quien lo construye. En producción (`app.go`) ese `EmitFunc` envuelve `runtime.EventsEmit(ctx, event, data)`; en tests es un stub que empuja a un channel. Esto es necesario porque `runtime.EventsEmit` exige un `context.Context` inyectado por el ciclo de vida real de Wails y llama `log.Fatalf` (mata el proceso) sin uno — no se puede testear el executor invocándolo directo. El **frontend genera el `queryID`** y llama `EventsOn(queryID, ...)` antes de invocar `ExecuteQuery(connID, queryID, sql)` — si el backend generara el ID habría una carrera entre el primer emit y la suscripción.

**Historial de queries:** separado de `EmitFunc` hay un segundo callback, `query.HistorySink` (`func(connID, sqlText, status string, rowsAffected, durationMs int64, errMsg string)`), invocado al final de cada statement (done/error/cancelled). En `app.go` apunta a `vault.Store.RecordQueryHistory`, que persiste en la tabla `query_history` (sin cifrar, a diferencia de `connections`). El paquete `query` no importa `vault` — se mantiene desacoplado igual que con `EmitFunc`.

Cancelación: cada `queryID` en curso tiene un `context.CancelFunc` registrado; `CancelQuery(queryID)` lo invoca y limpia el registro. El pool debe quedar sano después de cancelar (no cerrar la conexión subyacente, solo el statement en curso) — verificado en `backend/query/executor_test.go` con una CTE recursiva larga, y con un script multi-statement efímero (cancelar detiene antes del segundo statement).
