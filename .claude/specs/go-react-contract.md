# Contrato Go ↔ React

Superficie de binding del struct `App` (`app.go`). Regla general: el frontend nunca ve un DSN ni un password, solo IDs de conexión opacos; ningún método crudo de SQL sin pasar por la capa backend.

> Este documento se actualiza a mano en cada fase que añade o cambia métodos de `App`. Cuando `backend/claudemd/generator.go` exista (Fase 9), la versión que la app escribe en proyectos de terceros se genera por reflexión sobre `App` para que se auto-actualice; esta copia del propio repo mini-tools se mantiene manualmente porque describe la app en desarrollo, no un artefacto generado por ella.

| Área | Métodos | Fase que lo introduce |
|---|---|---|
| Ciclo de vida del vault | `IsVaultInitialized()`, `InitializeVault(password)`, `UnlockVault(password)` | Fase 2 |
| Backup/restore del vault | `BackupVault()`, `PickVaultBackupFile(currentPassword)` + `RestoreVaultBackupFromFile(path, backupPassword)` (restaurar sobre un vault existente), `PickVaultBackupFileFirstRun()` + `RestoreVaultBackupFirstRun(path, backupPassword)` (restaurar en primer arranque) | agregado fuera de fase (a pedido), antes de Fase 5; flujos de restore en dos pasos agregados post-lanzamiento |
| Conexiones | `TestConnection(cfg)`, `SaveConnection(cfg, force bool)`, `ListConnections()`, `DeleteConnection(id)`, `DisconnectConnection(id)`, `GetConnectionForEdit(id)`, `UpdateConnection(id, cfg, force)` | Fase 3 (`DisconnectConnection`/`GetConnectionForEdit`/`UpdateConnection` agregados post-lanzamiento — ver nota abajo) |
| Metadata | `GetSchemaMetadata(connID, forceRefresh bool)`, `ListSchemas(connID)`, `SetConnectionSchemas(connID, schemas)` | Fase 6 (`ListSchemas`/`SetConnectionSchemas` agregados post-lanzamiento — ver nota abajo) |
| Ejecución de queries | `ExecuteQuery(connID, queryID, sqlText)`, `CancelQuery(queryID)`, `BeginTransaction(connID)`, `CommitTransaction(connID)`, `RollbackTransaction(connID)`, `HasOpenTransaction(connID)` | Fase 3 (mínimo) → completo en Fase 5 (split multi-statement, PL/SQL, DBMS_OUTPUT) → transacciones explícitas agregadas post-lanzamiento (ver nota abajo) |
| ~~Historial de queries~~ | ~~`ListQueryHistory` / `ClearQueryHistory` / `DeleteQueryHistoryEntry`~~ | Fase 5, **retirados post-lanzamiento**: la consola de ejecución cubre el caso con más contexto, así que dejó de registrarse el historial (los tres executores reciben el `HistorySink` en `nil`). La tabla `query_history` sigue creándose porque el `CREATE TABLE` de `store.go` es la definición congelada de la versión 1 |
| Archivos | `OpenSQLFileDialog()`, `OpenSQLFilePath(path)`, `SaveSQLFile(path, content)`, `SaveSQLFileAs(suggestedName, content)`, `ListRecentFiles()`, `ClearRecentFiles()` | Fase 6 (`OpenSQLFilePath` no estaba en el plan original — hace falta para "click en recent reabre tab directo" sin mostrar diálogo) |
| Explain | `ExplainQuery(connID, sqlText, analyze bool)`, `ListExplainHistory(connID)` | Fase 8 |
| Export | `ExportResult(columns, rows, format)`, `ExportTableDDL(connID, schema, table)`, `ExportSchemaDDL(connID, schema)`, `ExportConnectionConfig(connID)` | Fase 7 (`ExportResult` toma `columns`/`rows` en vez de `queryID`/`destPath` — ver nota abajo) |
| Settings | `GetSettings()`, `SetTheme(themeName)`, `SetUIFontScale(pct)`, `SetOpenTabs(paths)` | Fase 10 (`GetSettings`/`SetTheme`/`SetUIFontScale` son los únicos métodos que NO llaman `requireUnlocked`; `SetOpenTabs` sí lo requiere — ver nota abajo) |
| CLAUDE.md | `GenerateProjectDocs(projectRootPath, connID, schema)`, `RegenerateProjectDocs(projectRootPath, connID, schema)` | Fase 9, `schema` agregado post-lanzamiento — ver nota abajo |
| SFTP (transferencia de archivos) | `OpenSftpBrowse(sessionID, connID)`, `ListSftpDir(sessionID, dir)`, `SftpHomeDir(sessionID)`, `MakeSftpDir(sessionID, dir)`, `DeleteSftpPath(sessionID, path)`, `RenameSftpPath(sessionID, old, new)`, `SftpPathPermissions(sessionID, path)`, `ChmodSftpPath(sessionID, path, mode)`, `CloseSftpBrowse(sessionID)`, `StartSftpTransfer(input)`, `CancelSftpTransfer(transferID)` | Post-lanzamiento — ver nota SFTP abajo |

Estado actual (Fase 8 — completa): además del ciclo de vida del vault, `app.go` implementa `TestConnection`, `SaveConnection`, `ListConnections`, `DeleteConnection`, `ExecuteQuery`, `CancelQuery`, `GetSchemaMetadata`, los métodos de archivos, los 4 métodos de export, y ahora `ExplainQuery`/`ListExplainHistory`, todos detrás de `requireUnlocked()` (falla con `vaultgate.ErrLocked` si el vault está bloqueado). Los 3 conectores están implementados (`backend/db/{sqlite,postgres,oracle}.go`).

**EXPLAIN PLAN** (`backend/explain/`): `tree.go` define `PlanNode`/`Plan`, un árbol común pese a que los 3 motores devuelven formatos completamente distintos. SQLite: `EXPLAIN QUERY PLAN` da filas planas `(id, parent, notused, detail)`, reconstruidas en árbol por `id`/`parent`. Postgres: `EXPLAIN (FORMAT JSON[, ANALYZE])` ya devuelve un árbol anidado, solo hay que mapear los campos (con `ANALYZE`, `ActualTotalTime`/`ExecutionTime` son tiempos reales de ejecución — la query corre de verdad). Oracle: `EXPLAIN PLAN SET STATEMENT_ID = '...' FOR <query>` + `SELECT ... FROM plan_table WHERE statement_id = ...` en una única `*sql.Conn` reservada del pool (mismo patrón que `DBMS_OUTPUT` — un `statement_id` único además evita colisión con EXPLAINs concurrentes de otras sesiones); no verificado contra una instancia real.

**Bug real encontrado y corregido durante la verificación:** la detección de full table scan en SQLite originalmente buscaba el substring `"SCAN TABLE"` en el detail — pero SQLite moderno lo escribe solo como `"SCAN people"` (sin la palabra "TABLE"), así que la detección nunca disparaba. Verificado con una tabla real: `SELECT * FROM people` (sin índice) no se marcaba como full scan hasta corregir `isSQLiteFullScan` para chequear el prefijo `"SCAN"` (excluyendo `"USING INDEX"`/`"USING COVERING INDEX"`, que son scans de un índice, no de la tabla). Este era exactamente el tipo de bug que la verificación contra una instancia real (no solo compilar) está pensada para atrapar.

`App.ExplainQuery` guarda cada resultado en `explain_history` (tabla sin cifrar) vía `vault.Store.RecordExplainPlan`, best-effort (una falla al persistir no oculta el plan que el usuario ya tiene). Verificado end-to-end contra SQLite real (full scan vs SEARCH indexado) y Postgres real en Docker (Seq Scan vs Index Scan, `ANALYZE` con timing real vs sin `ANALYZE` con `DurationMs=0`).

**Linter SQL** (`frontend/src/lib/linter.ts`): heurística — split naive por `;` (no reusa `backend/query/splitter.go`, los falsos positivos/negativos son aceptables porque solo afectan un warning, no la ejecución real) + regex para `SELECT *` y `UPDATE`/`DELETE` sin `WHERE`. Se aplica en dos lugares: como Monaco markers (subrayado, `MonacoSQLEditor.tsx` vía `monaco.editor.setModelMarkers`) en cada cambio de contenido, y como diálogo de confirmación (`window.confirm`) antes de ejecutar — pero **solo** en los entry points iniciados por el usuario (Ctrl+Enter/Ctrl+Shift+Enter/botones "Ejecutar"/"Bloque"), no en las queries auto-generadas (LIMIT 100 por doble-click, sort-by-column) que se ejecutan con `runText` directo — de lo contrario el diálogo aparecería en cada doble-click a una tabla.

**Export** (`backend/export/`): `ExportResult(columns, rows, format)` recibe los datos directamente del frontend en vez de un `queryID` — el executor nunca retiene resultados después de emitirlos (arquitectura de streaming de la Fase 5), así que no hay nada que buscar server-side por `queryID`; el frontend ya tiene todo en memoria tras el streaming, y reenviarlo es tan barato como el streaming original. `csv.go`/`json.go`/`xlsx.go` (con `excelize`) escriben el archivo; `ddl_sqlite.go` lee `sqlite_master` directo; `ddl_postgres.go` reconstruye DDL desde `information_schema` (columnas + PK + FK — no reproduce check constraints, unique no-PK, tipos custom, particionado); `ddl_oracle.go` usa `DBMS_METADATA.GET_DDL` (no verificado en vivo). `connection_export.go` (`RedactDSN`) aprovecha que las 3 DSN son URLs (`scheme://user:pass@host/...`) para sacar el password con `net/url` sin necesitar guardar los params originales por separado. "Copiar como INSERT" quedó **solo en el frontend** (`frontend/src/lib/sqlGenerate.ts`) — es formateo de texto + clipboard, no I/O, así que no amerita un viaje a Go; desviación del plan original que tenía `backend/export/sqlgen.go`. Verificado end-to-end contra SQLite real (CSV/JSON/XLSX válidos, DDL correcto) y Postgres real en Docker (DDL con PK+FK correctos, redacted DSN sin password).

**Metadata de schema** (`backend/db/metadata.go`, `GetSchemaMetadata`): unifica tablas/columnas/nullable/PK/FK de los 3 motores en `db.SchemaMetadata`. SQLite vía `PRAGMA table_info`/`PRAGMA foreign_key_list`; Postgres vía `information_schema` (columns + table_constraints + key_column_usage + constraint_column_usage); Oracle vía `user_tab_columns`/`user_constraints`/`user_cons_columns` (patrón estándar de mapeo FK→PK por `position`, no verificado contra una instancia Oracle real). `App` cachea el resultado en memoria por `connID` (`a.metadataCache`), `forceRefresh=true` lo recalcula — F5 en el frontend llama esto. Verificado end-to-end contra SQLite real y contra un Postgres real en Docker (tablas con FK, nullable, PK) — ver historial de verificación en la skill del proyecto.

**Escaneo de esquemas restringido** (post-lanzamiento, Postgres únicamente): en catálogos con 100+ esquemas, escanear `information_schema` completo puede ser lento. `connections.metadata_schemas` (columna agregada por `schema_migrations` versión 2, ver `.claude/specs/vault-migrations.md`) guarda una lista opcional de esquemas a los que restringir el fetch — `NULL`/vacío sigue significando "todos", el comportamiento histórico. `App.ListSchemas(connID)` devuelve solo los nombres de esquema (query barata, nunca toca `information_schema.columns`) para poblar el picker sin pagar el costo del fetch completo primero; `App.SetConnectionSchemas(connID, schemas)` persiste la restricción y invalida el cache de metadata de esa conexión. `db.FetchSchemaMetadata` recibió un parámetro `schemas []string` nuevo — ignorado por SQLite/Oracle (sin catálogo multi-schema equivalente que restringir), aplicado como `AND table_schema IN (...)` en las 3 queries de Postgres. Ambas queries de listado de esquemas excluyen `pg_catalog`/`information_schema` y cualquier esquema `pg_%` (incluye `pg_toast`, encontrado durante la verificación contra un Postgres real con 2 esquemas de usuario). Verificado end-to-end contra un Postgres real en Docker: `ListSchemas` excluye correctamente los esquemas de sistema, un fetch sin filtro ve ambos esquemas de usuario, un fetch filtrado a uno ve solo ese, y el round-trip `SetConnectionSchemas`/`ConnectionMetadataSchemas`/`ListConnections` persiste y limpia correctamente.

**Editar conexión existente** (post-lanzamiento): `backend/db/connector.go`'s `Connector` interface ganó `ParseDSN(dsn string) (map[string]string, error)` — el inverso de `BuildDSN`, implementado por los 3 conectores (Postgres/Oracle vía `net/url.Parse`, ya que tanto la URL que arma `postgresConnector.BuildDSN` como la que arma `go_ora.BuildUrl` son URLs estándar; SQLite con trim manual de `file://`/query string). `ParseDSN` **incluye el password** — a propósito, ver su doc comment — es responsabilidad de quien lo llama redactarlo antes de que llegue al frontend. `App.GetConnectionForEdit(id)` decripta el DSN guardado, lo parsea, y borra `password` del mapa antes de devolverlo — así `ConnectionDialog.tsx` puede precargar el formulario de edición sin violar la regla de "el frontend nunca ve un password" (`.claude/rules/technical.md` punto 9). `App.UpdateConnection(id, cfg, force)` reconstruye el DSN desde `cfg.Params`; si `cfg.Params["password"]` llega vacío (el usuario no lo tocó — el frontend nunca tuvo el real para reenviarlo) lo rellena internamente parseando el DSN *actual* de esa conexión antes de reconstruir, así que "dejar en blanco" significa "mantener el password existente", nunca "borrarlo". Igual que `DisconnectConnection`, cierra el pool y limpia el cache de metadata de `id` después de actualizar (el destino pudo haber cambiado). El frontend deshabilita el selector de "Tipo" al editar (cambiar de motor mid-edit no tiene un mapeo de campos sensato) y el botón "Test Connection" cuando el password quedó en blanco (probar con un password vacío daría un falso negativo — el ping real ocurre al Guardar, con el password ya mergeado). Verificado end-to-end contra un Postgres real en Docker: `ParseDSN` recupera host/port/user/dbname/sslmode correctamente y el password real cuando se necesita internamente; el flujo completo de editar con password en blanco preserva el password original Y el DSN resultante conecta de verdad (no solo que las strings coincidan); los 3 modos de Oracle (`service_name`/`sid`/`tns`) hacen roundtrip correcto en `ParseDSN` (sin instancia Oracle real, mismo límite que el resto del código Oracle).

**Restaurar pestañas abiertas** (post-lanzamiento): `settings.open_tabs` (columna agregada por `schema_migrations` versión 3) guarda un JSON array de paths de archivo, en orden de tabs — nunca contenido, un tab scratch sin guardar no tiene nada en disco para reabrir. `Settings.OpenTabs` viaja en el mismo `GetSettings()` ya usado para el tema; `App.SetOpenTabs(paths)` es un método nuevo, y a diferencia de `GetSettings`/`SetTheme` **sí** requiere `requireUnlocked` — a diferencia del tema, no hace falta que funcione en la pantalla de desbloqueo. `Workspace.tsx` restaura los tabs al montar (un solo `useEffect` con `[]`, corre una vez tras el desbloqueo): para cada path guardado intenta `OpenSQLFilePath`, junta los que fallan (archivo borrado del disco) en una lista, y muestra un modal de advertencia una sola vez — al cerrarlo, esos paths ya no vuelven a aparecer porque la lista persistida se actualiza sin ellos apenas se detectan. Un segundo `useEffect`, con key derivada de `tabs.map(t => t.path).join(' ')` (no de `tabs` completo — el array cambia de referencia en cada tecla tipeada por `updateActiveTabContent`, y sólo el *set* de paths importa), persiste el listado actual cada vez que cambia. Un `useRef` (`hasRestoredRef`) evita que este segundo efecto pise el `open_tabs` recién leído con la lista vacía del tab scratch inicial, antes de que la restauración asíncrona termine — sin este guard, cada arranque borraría lo que se acababa de restaurar.

**Editor Monaco** (`frontend/src/monaco/`): `setup.ts` importa solo `monaco-editor/esm/vs/editor/editor.api` + `basic-languages/sql/sql.contribution`, sin `@monaco-editor/react` ni CDN, worker de Vite cableado a mano (`?worker` import) — ningún otro lenguaje se bundlea (confirmado: el build solo genera un chunk `sql-*.js` de ~10KB además del core, nada de json/html/ts/css). `sqlLanguage.ts` agrega keywords Oracle/Postgres + snippets vía un `registerCompletionItemProvider` separado. `completionProvider.ts`/`hoverProvider.ts` leen de `metadataStore.ts` (un holder mutable simple, no Zustand — los providers de Monaco son globales al lenguaje, no por instancia de editor, así que se registran una sola vez y `Workspace.tsx` solo actualiza el holder cuando cambia la conexión seleccionada, cambia el schema activo, o se refresca). `MonacoSQLEditor.tsx` es el wrapper de React; `EditorTabs.tsx` maneja tabs de archivos abiertos + queries sueltas; `RecentFilesMenu.tsx` lista/abre/limpia recientes. Atajos: Ctrl+Enter ejecuta selección o línea actual, Ctrl+Shift+Enter ejecuta el tab completo, Ctrl+S guarda (a `SaveSQLFile` si el tab ya tiene path, si no `SaveSQLFileAs`), F5 refresca metadata.

**Autocomplete consciente del contexto** (post-lanzamiento, `frontend/src/monaco/sqlContext.ts`): `completionProvider.ts` dejó de sugerir siempre "todas las tablas + todas las columnas de todo" — ahora analiza el statement donde está el cursor (split ingenuo por `;` de nivel superior, sin conciencia de comillas/comentarios, mismo criterio de tolerancia que `linter.ts`) para decidir: tras FROM/JOIN/INTO/UPDATE sugiere solo nombres de tabla; tras SELECT/WHERE/SET/ON/AND/OR/GROUP·ORDER BY sugiere solo columnas de las tablas que el FROM/JOIN de *ese* statement realmente referencia (no todas las tablas del schema activo); `"alias."`/`"tabla."` acota a las columnas de esa tabla puntual (resolviendo el alias contra el FROM/JOIN del mismo statement); `"esquema."` acota a las tablas de ese esquema. Nunca sugiere *menos* que el comportamiento anterior — cualquier forma de statement que no reconoce específicamente cae al fallback de sugerir todo. Ver `.claude/skills/mini-tools-patterns/SKILL.md` para el detalle de diseño y la verificación standalone (13 casos, sin tests nuevos — mismo patrón de script efímero en Node que ya usa `connStringParser.ts`).

El executor ahora es el motor completo: `backend/query/detect.go` clasifica cada statement (SQL plano vs PL/SQL) y `splitter.go` divide un script en statements respetando comillas/comentarios/dollar-quoting Postgres/anidamiento BEGIN-END Oracle (ver el `SKILL.md` del proyecto para el detalle y las limitaciones aceptadas — CREATE PACKAGE BODY con múltiples miembros no se garantiza que divida bien). Cada statement se ejecuta y emite su propia secuencia columns/rows/done bajo el mismo `queryID` pero con `statementIndex`/`totalStatements` en el `Event`, para que el frontend arme un result-tab por statement (`ResultTabs.tsx`). Un bloque PL/SQL Oracle corre vía `backend/query/dbmsoutput.go` (`runOraclePLSQLBlock`, sobre una única `*sql.Conn` reservada del pool para que `DBMS_OUTPUT.ENABLE/PUT_LINE/GET_LINE` vean la misma sesión) y sus líneas de salida viajan en `Event.DBMSOutput`. Una cancelación detiene el script completo (no sigue con los statements restantes); un error en un statement individual NO detiene el script (coincide con el comportamiento por defecto de sqlplus/mysql — los statements siguientes igual corren). Cada resultado terminal (done/error/cancelled) se ofrecía a `query.HistorySink` para persistirlo en `query_history`; **el sink hoy va en `nil`** (historial retirado, ver la fila tachada de la tabla de arriba) y el tipo se conserva porque los tres executores ya lo tratan como opcional.

**Limitación conocida, no verificada en vivo:** el bloque PL/SQL + DBMS_OUTPUT no se pudo probar contra una instancia Oracle real (no disponible en este entorno) — se verificó por inspección de código y, para la parte DB-agnóstica (split de statements), con un script efímero cubriendo bloques DECLARE/BEGIN/END, IF/END IF anidado, CREATE PROCEDURE, y dollar-quoting Postgres. El streaming multi-statement, la cancelación de scripts, y una query de 5000 filas sí se verificaron end-to-end contra SQLite real.

**Transacciones explícitas / auto-commit toggle** (post-lanzamiento, `backend/query/executor.go`): `BeginTransaction` reserva un único `*sql.Conn` del pool para `connID` (`Executor.txns map[string]*sql.Conn`, protegido por `txMu`) y, para Postgres/SQLite, manda un `BEGIN` explícito sobre esa conexión — Oracle no lo necesita, su transacción arranca implícita con el primer statement. **Deliberadamente un `*sql.Conn` crudo, no el `*sql.Tx` de Go** — un `COMMIT`/`ROLLBACK` que el usuario escriba a mano, o que viva dentro de un bloque PL/SQL, tiene que comportarse exactamente igual que en psql/sqlplus (la sesión sigue viva, arranca una transacción implícita nueva después), y el wrapper `*sql.Tx` se pelearía con eso. Mientras `connID` tiene una conexión reservada, `run()` enruta cada statement (`runQuery`/`runExec`, y `runPLSQLBlock` para Oracle vía la MISMA conexión que ya tenía DBMS_OUTPUT reservada) a través de ella en vez del pool compartido — ver la interfaz `queryExecer` (satisfecha tanto por `*sql.DB` como por `*sql.Conn`). `CommitTransaction`/`RollbackTransaction` mandan `COMMIT`/`ROLLBACK` sobre esa conexión y la liberan (`conn.Close()`, vuelve al pool) — el auto-commit queda "de vuelta activado" simplemente porque ya no hay conexión reservada para ese `connID`, no hay un booleano separado que sincronizar. `App.HasOpenTransaction(connID)` deja que el frontend resincronice su UI (`Workspace.tsx`) contra el estado real del backend en vez de asumir que su estado local sigue vigente. Cierre de conexión (`DisconnectConnection`/`DeleteConnection`) y cierre de la app (`shutdown()` → `Executor.RollbackAll`) hacen rollback best-effort de cualquier transacción abierta antes de cerrar el pool — de otra forma la conexión reservada quedaría filtrada (`sql.DB.Close()` no fuerza el cierre de conexiones que un caller ya sacó del pool vía `Conn()` y no devolvió).

Verificado end-to-end contra un Postgres real en Docker (aislado, nunca el `local-postgres-1` del usuario): un insert dentro de una transacción abierta es invisible desde una conexión separada hasta el commit; 100 inserts en una sola transacción no se ven hasta el commit final (el caso literal que motivó la feature: "tengo 100 insert, hacer commit hasta el último"); rollback descarta todo, confirmado consultando por fuera; doble `BeginTransaction` falla limpio; `Commit`/`Rollback` sin transacción abierta fallan limpio sin panic; y el caso de `COMMIT` inline dentro del script — el insert se ve inmediatamente aunque la UI nunca clickeó Commit, `HasOpenTransaction` sigue en `true` (la conexión sigue reservada), y el `Rollback` posterior de la UI es un no-op seguro sobre una conexión sin nada pendiente.

**Nota de tamaño de binario:** añadir Postgres+Oracle llevó el binario de ~12MB a ~31MB (Oracle solo agrega ~15MB por `crypto/tls`/FIPS 140-3, no opcional en `go-ora`). El target de <20MB del spec original se revisó primero a <35MB (Fase 4, Oracle/crypto-tls), luego a <45MB (Fase 6, Monaco), a <60MB (agregado de Redis) y finalmente a **<80MB** (0.4.0, con SQL Server + MongoDB; medición real: macOS 47.2MB, Windows 51.2MB) — ver [.claude/rules/technical.md](../rules/technical.md) punto 8, que es la fuente de verdad del número.

**Backup/restore del vault:** `BackupVault()` pide destino con `runtime.SaveFileDialog` y llama `vault.Store.Backup` (usa `VACUUM INTO` para un snapshot consistente de `vault.db` + copia de `salt.bin`, empaquetados en un zip `.mtbackup`) — requiere `requireUnlocked()`.

El **restore es de dos pasos** (el picker de archivo va primero, la clave del backup después — pedir "la clave del backup" antes de elegir el archivo es al revés), en dos contextos:

- **Sobre un vault existente** (Configuración, `RestoreVaultDialog.tsx`): `PickVaultBackupFile(currentPassword)` verifica la clave maestra ACTUAL (prueba que el usuario está autorizado a destruir el vault) y abre el picker; `RestoreVaultBackupFromFile(path, backupPassword)` verifica la clave del backup, cierra sesiones SSH/pools, reemplaza `vault.db`/`salt.bin`, reabre y **bloquea el gate** (el frontend manda al usuario a desbloquear con la clave del backup). Ambos requieren `requireUnlocked()`.
- **En primer arranque** (pantalla "Crear clave maestra", `UnlockScreen.tsx`): `PickVaultBackupFileFirstRun()` abre el picker directo — **no** hay clave actual que confirmar, el campo "Clave maestra" de esa pantalla es solo para crear un vault nuevo, el restore nunca lo toca; `RestoreVaultBackupFirstRun(path, backupPassword)` verifica la clave del backup, cierra el `*vault.Store` vacío, restaura y reabre. Ambos solo permitidos si `IsInitialized()` es `false`. Tras el éxito el vault queda inicializado con la clave del backup, así que la pantalla cambia a "Desbloquear".

`vault.RestoreBackup` extrae ambos archivos y limpia `-wal`/`-shm` viejos; `VerifyBackupPassword` (`backend/vault/backup.go`) valida la clave contra el backup antes de tocar nada en disco, así que una clave equivocada falla limpio sin dejar un vault inaccesible. Verificado manualmente con un script efímero: backup → borrar vault.db/salt.bin reales → restore → `Unlock` con la clave original tiene éxito → la conexión guardada sigue ahí y su DSN desencripta igual.

**CLAUDE.md del proyecto conectado (Fase 9, `backend/claudemd/`):** desviación de alcance decidida explícitamente por el usuario vía `AskUserQuestion` — el CLAUDE.md que genera mini-tools documenta el **schema de la base de datos conectada** (tablas/columnas/nullable/PK/FK, convenciones de SQL del motor), no la arquitectura de mini-tools mismo. `generator.go` expone `Generate(dir, info) (wrote bool, err error)` (no pisa un `CLAUDE.md` existente — retorna `wrote=false` sin error si ya hay uno) y `Regenerate(dir, info) error` (siempre sobreescribe, la acción explícita "Regenerar"). Ambas escriben 4 archivos: `CLAUDE.md`, `.claude/specs/database-schema.md` (tabla markdown por tabla, con FKs), `.claude/rules/sql-conventions.md` (placeholders/paginación/particularidades por motor — distinto contenido para SQLite/Postgres/Oracle), `.claude/skills/mini-tools-database/SKILL.md`. `templates.go` tiene las 4 funciones `render*`; ninguna referencia jamás un DSN o password — `ProjectInfo{ConnectionName, DBType, Metadata}` solo lleva datos ya seguros de mostrarse en el frontend.

**Desviación de firma:** el plan original tenía `GenerateProjectDocs(projectRootPath)` de un solo argumento. `App` no tiene noción server-side de "la conexión activa" — eso es estado solo-frontend en `Workspace.tsx` (`selected`) — así que ambos métodos llevan un segundo parámetro `connID` explícito. `app.go` resuelve el nombre de la conexión vía `vault.ListConnections()` (nunca via `ConnectionDSN`, que expondría el DSN) y la metadata vía el `GetSchemaMetadata` ya existente (reusa el cache).

**Trigger automático:** `Workspace.tsx` llama `GenerateProjectDocs(dirName(path), selected.id, activeSchema ?? '')` best-effort (errores silenciados, nunca bloquean el flujo) después de abrir un archivo (`openTabForFile`) y después de guardar (`saveActiveTab`, en ambas ramas: guardar sobre el path existente y "Guardar como"). Solo muestra un `statusMessage` si `wrote===true` (evita ruido cuando ya existe un CLAUDE.md y se skipeó). Un botón "Regenerar CLAUDE.md" en la toolbar llama la acción explícita, habilitado solo si hay conexión seleccionada, el tab activo tiene `path`, y no hay una regeneración ya en curso. No existe `path.dirname` en el contexto Vite/browser — `dirName()` en `Workspace.tsx` replica a mano el mismo patrón que el `fileTitle()` ya existente (split manual por separador).

**`schema` (post-lanzamiento):** tercer parámetro agregado a ambos métodos — el esquema activo del dropdown de la toolbar (`activeSchema ?? ''`, `""` significa "toda la conexión, sin filtrar"). `app.go`'s `buildClaudeMDInfo` filtra `db.SchemaMetadata.Tables` a `t.Schema == schema` cuando no está vacío, y `claudemd.ProjectInfo.Schema` lo pasa a los templates para que el CLAUDE.md/schema-spec/skill generados digan explícitamente qué esquema cubren — evita que el usuario crea que un documento cubre toda la base cuando en realidad solo tiene un esquema. `regenerateProjectDocs()` (la acción explícita, no el trigger automático) además pide confirmación con `window.confirm()` antes de sobreescribir, porque es destructivo sobre cualquier archivo ya generado.

Verificado con un script efímero (`go run ./tmp_claudemdverify`, borrado tras correr): `Generate` escribe la primera vez y no pisa un `CLAUDE.md` existente en la segunda llamada; `Regenerate` siempre sobreescribe con contenido nuevo; los 4 archivos existen con la estructura esperada; el schema spec documenta tablas/columnas/FKs reales; ninguno de los 4 archivos contiene los substrings `password`/`dsn`/`postgres://`/`sqlite3:`; metadata vacía (conexión sin tablas) no rompe el render y muestra el fallback "Sin tablas detectadas"; las convenciones SQLite difieren de las de Postgres.

## Eventos (streaming)

Los resultados de queries no viajan como valor de retorno de `ExecuteQuery` — se emiten como eventos vía un `query.EmitFunc` inyectado (en producción, un closure sobre `runtime.EventsEmit(ctx, queryID, chunk)`; en tests, un stub — `runtime.EventsEmit` exige un contexto real inyectado por Wails y mata el proceso sin uno, así que el executor nunca lo llama directamente). El frontend debe llamar `EventsOn(queryID, ...)` **antes** de invocar `ExecuteQuery` (el `queryID` lo genera el cliente, no el backend) para no perder el primer chunk.

El evento `"columns"` incluye `SQLText` (el texto exacto del statement que lo generó, no el script completo que mandó el frontend) — agregado en Fase 7 para que el sort por columna pueda reemitir la query envuelta en `SELECT * FROM (<original>) AS mt_sort ORDER BY "col" ASC|DESC` sin que el frontend tenga que duplicar la lógica de split de `backend/query/splitter.go`. `Workspace.tsx` guarda ese `sourceSql` por result-tab y lo usa al hacer click en un header de columna (`ResultGrid.tsx` nunca ordena en cliente, solo emite `onSort`).

## Grid y árbol (Fase 7)

`ResultGrid.tsx` usa `@tanstack/react-table` + `@tanstack/react-virtual` (windowing real — miles de filas sin lag, verificado a nivel backend con streaming de 50000 filas en ~11ms; el scroll fluido en sí no se pudo probar interactivamente en este entorno sandboxed sin permiso de captura de pantalla). Columnas redimensionables (`columnResizeMode: 'onChange'`), sin estado controlado explícito — TanStack Table administra el resize internamente.

`ConnectionTree.tsx` pasó de lista plana a árbol conexión→tablas: recibe `metadata` como prop (ya cacheada en `Workspace.tsx` vía `GetSchemaMetadata`, sin fetch duplicado), muestra las tablas de la conexión seleccionada, y doble-click en una tabla llama `onOpenTable` → arma `SELECT * FROM tabla LIMIT 100` (o `WHERE ROWNUM <= 100` en Oracle) y lo ejecuta de una — spec "doble click tabla en árbol → SELECT * LIMIT 100 auto". Botones hover-only (`cfg`/`DDL`) exponen `ExportConnectionConfig`/`ExportTableDDL` por ítem sin necesitar un menú contextual.

## Theming, lazy-load, y seguridad (Fase 10)

**Toggle dark/light** (`backend/vault/settings_repo.go` + `frontend/src/hooks/useTheme.ts`): tabla `settings` de una sola fila (mismo patrón singleton que `vault_meta`), `theme TEXT NOT NULL DEFAULT 'dark'`, sembrada por `INSERT OR IGNORE` en `store.go` al abrir. `App.GetSettings()`/`App.SetTheme(theme)`/`App.SetUIFontScale(pct)` son los **únicos** métodos de `App` que deliberadamente NO llaman `requireUnlocked()` — ninguno de los tres es sensible (no hay DSN ni datos de fila involucrados), y gatearlos detrás de la clave maestra causaría un flash de tema incorrecto en la pantalla de desbloqueo sin ningún beneficio de seguridad real; el gate existe para proteger `encrypted_dsn`/resultados de query, no preferencias cosméticas.

`SetUIFontScale` (tamaño de letra de toda la interfaz, en porcentaje; columna `ui_font_scale`, migración 50) se agregó a esa lista por un motivo más fuerte que el del tema: es un ajuste de **accesibilidad**, y si solo valiera con el vault abierto, quien no puede leer la app tampoco podría leer el formulario que le pide la clave para arreglarlo. Se aplica desde `hooks/useUIFontScale.ts`, llamado una sola vez en `App.tsx` igual que `useTheme`.

`useTheme.ts` es la única fuente de verdad del tema — se llama **una vez** en `App.tsx` (nunca en `UnlockScreen.tsx`/`Workspace.tsx` directamente) y se pasa hacia abajo por props (`theme`, `onToggleTheme`), evitando fetches duplicados de `GetSettings` y manteniendo un solo estado consistente entre la pantalla de desbloqueo y el workspace (que de todas formas nunca coexisten). Aplica la clase `dark` en `document.documentElement` (Tailwind v4 `@custom-variant dark (&:where(.dark, .dark *))`, ver `frontend/src/styles/globals.css`) y sincroniza el tema de Monaco vía `monaco.editor.setTheme('vs-dark' | 'vs')` — el tema de Monaco es un singleton global compartido por todas las instancias de editor, no por-instancia, así que `MonacoSQLEditor.tsx` **no** debe pasar `theme:` en las opciones de `editor.create()` (pasar uno ahí llama `setTheme()` internamente y pisaría silenciosamente lo que `useTheme.ts` ya aplicó desde la preferencia guardada).

**Desviación de arquitectura:** el plan original mencionaba Zustand para un `uiStore` — la implementación real de todo el proyecto nunca terminó usando Zustand en ningún lado (todo el estado es `useState`/props, ver `Workspace.tsx`), así que el tema sigue el mismo patrón establecido: un hook (`useTheme.ts`) + prop drilling, sin introducir una librería de estado global solo para un booleano.

**Conversión de clases a light/dark:** el frontend se escribió originalmente asumiendo dark-only (clases `bg-neutral-950`/`border-neutral-800`/etc. sin condicional). Para Fase 10 se convirtieron ~155 ocurrencias en 10 archivos a pares `light dark:dark` usando una escala de grises invertida simétrica alrededor de 500 (`50↔950, 100↔900, 200↔800, 300↔700, 400↔600, 500` sin cambio) vía un script Python de un solo uso (no commiteado) que hace la sustitución token por token respetando prefijos de variante (`hover:`, `focus:`, `odd:`, `even:`, sufijos de opacidad `/40`). Los colores de acento (`red`/`emerald`/`amber`) usados como texto plano sobre el fondo de la página se ajustaron a mano con la misma idea (p.ej. `text-red-400` → `text-red-600 dark:text-red-400`); los botones sólidos con texto blanco (`bg-emerald-700`, `bg-red-800`, etc.) se dejaron sin cambios porque ya tienen contraste suficiente en ambos temas. Si se agrega un componente nuevo, seguir el mismo patrón (par `light dark:` por cada clase estructural bg/border/text de la escala neutral) en vez de asumir un tema fijo.

**Lazy-load** (`Workspace.tsx`): `ConnectionDialog` y `ExplainPlanPanel` son ahora `React.lazy()` + `<Suspense fallback={null}>`, porque ambos están detrás de un flag booleano (`showDialog`/`showExplain`) y no hacen falta en el bundle inicial. Confirmado en el build: `ConnectionDialog-*.js` (~11KB) y `ExplainPlanPanel-*.js` (~2KB) ahora son chunks separados de `frontend/dist/assets/`. `ExportMenu` se dejó **sin** lazy-load — a diferencia de los otros dos, se renderiza incondicionalmente como parte del toolbar de resultados (no está gateado por un booleano), así que envolverlo en Suspense no ahorraría nada y solo agregaría un fallback innecesario. Monaco (~3.9MB, el grueso real del bundle) tampoco es candidato — el editor lo necesita de inmediato, no se puede diferir.

**Pasada de seguridad — 2 hallazgos reales corregidos** (el resto del grep de logging de DSN/filas de resultados salió limpio, ver `backend/export/connection_export.go`'s `RedactDSN` ya usado en `ExportConnectionConfig`, y que el único `runtime.EventsEmit` del código transmite resultados de query al frontend, nunca los loguea):

1. `vaultgate.Gate.Lock()` (que zeroea la clave derivada) estaba definido pero **nunca invocado** — no hay un `LockVault`/`Logout` bindeado (fuera de alcance de esta fase agregar esa UX), pero la clave sí debía zeroearse al cerrar la app. Corregido: `app.go`'s `shutdown()` ahora llama `a.gate.Lock()` después de `a.pools.CloseAll()`.
2. `Store.Unlock` con contraseña incorrecta derivaba la clave, la probaba contra el verificador, y retornaba `ErrWrongPassword` **sin zeroear la clave descartada** (nunca llegaba a `gate.Set`, así que nada más la referenciaba). Corregido en `backend/vault/store.go`: se llama `mtcrypto.Zero(key)` antes de retornar en el path de contraseña incorrecta. **Ojo:** en el path de éxito NUNCA se debe zeroear `key` después de `gate.Set(key)` — `Gate.Set` guarda el slice por referencia (no copia), así que zerearlo ahí zerearía la clave real que el gate acaba de guardar. También se agregó zeroeo de la copia `[]byte(password)` (la conversión string→[]byte sí copia) en `Initialize` y `Unlock`, aunque el `string password` original en sí no se puede zeroear (limitación del lenguaje — los strings son inmutables).

**Gotcha real encontrado verificando el fix de arriba:** `backend/appdata/paths.go` no tiene ningún mecanismo de override para la ruta de datos (usa `os.UserConfigDir()` directo, sin inyección de dependencias) — un script efímero de verificación que llama `vault.Open()` sin sandboxear termina escribiendo en la ruta REAL (`~/Library/Application Support/mini-tools`), no en un directorio temporal. Un primer intento de verificar el zero-out inicializó por accidente el vault real de este equipo con una contraseña de prueba (sin pérdida de datos reales porque el vault nunca había sido inicializado antes — no puede haber conexiones guardadas sin unlock previo — pero sí requirió borrar `vault.db`/`salt.bin` reales para devolver el estado a "no inicializado"). La forma correcta de sandbox: `os.UserConfigDir()` en Darwin respeta `$HOME`, así que cualquier script efímero que toque `vault.Open()`/`appdata.Dir()` debe correr con `HOME=$(mktemp -d) go run ./tmp_xxx`, nunca sin ese override.

## SFTP — transferencia de archivos (post-lanzamiento)

Módulo de transferencia de archivos por SFTP que **reutiliza las conexiones SSH ya guardadas** (mismo `connID` opaco que la terminal). Explorador de doble panel (estilo Termius): cada panel apunta a la máquina local o a un host remoto y se arrastran archivos entre paneles. Cubre los 4 sentidos: local→remoto, remoto→local y remoto→remoto (el remoto↔remoto se hace haciendo streaming a través de la máquina local — no hay copia servidor-a-servidor directa en SFTP). Backend: `backend/sftpx` (dep nueva `github.com/pkg/sftp`, pure-Go, +~1MB al binario → 42MB, dentro del techo vigente en ese momento, 60MB).

**Path nativo paralelo** — igual que `backend/redisquery` (Redis) y `backend/sshconn` (terminal), un browse/transfer SFTP no es una conexión `database/sql`, así que no pasa por `db.PoolManager`. Dialea vía `sshconn.Dial` (nuevo helper exportado que reusa `parseDSN`/`clientConfig` — mismo tradeoff `InsecureIgnoreHostKey`, mismo auth password/key) y habla SFTP con `pkg/sftp`. Dos managers en `app.go`:

- `sftpBrowse` (`*sftpx.BrowseManager`) — una sesión SFTP persistente por panel del explorador, keyed por un `sessionID` que genera el frontend (`sftp:<connId>`). El sentinela `"local"` (`sftpx.LocalSession`) enruta a `os.*` para el panel de la máquina local, sin sesión remota. Persistir la sesión evita re-dialear en cada cambio de carpeta.
- `sftpTransfers` (`*sftpx.TransferManager`) — transferencias con **pool de goroutines** (4 workers) y conexiones **dedicadas** (aisladas de los paneles de browse, así una transferencia lenta no bloquea el listado y cerrar un panel no mata una transferencia en curso). Robustez: `context` por transferencia + `io.Copy` context-aware (cancela entre chunks); watcher `ssh.Client.Wait()→cancel()` que corta la transferencia si cae la conexión (anti-zombie); `sync.WaitGroup` que garantiza que ningún worker toque un cliente ya cerrado; `CancelSftpTransfer(id)` y `CancelAll()` en shutdown.

**Contrato de eventos** — igual que la terminal / ejecución de queries: el frontend genera el `transferID`, hace `EventsOn(transferID, ...)` **antes** de `StartSftpTransfer`, y el backend emite `sftpx.ProgressEvent` (`start`/`progress`/`file-done` throttled a 150ms + exactamente un evento terminal `done`/`error`/`cancelled`) sobre el evento con nombre = `transferID`. `ProgressEvent` es event-only (nunca retorno/param de un binding), así que Wails no le genera clase — se declara a mano en `frontend/src/components/sftp/types.ts`, igual que `SshEvent`.

**Boundary de seguridad** — el frontend nunca ve un DSN: `StartSftpTransfer`/`OpenSftpBrowse` reciben `connId`s opacos y `app.go` resuelve el DSN vía `vault.ConnectionDSN` antes de llamar al manager. `sftpx` nunca importa `vault`. **Sin migraciones de `vault.db`** — el módulo no persiste nada nuevo.

**Permisos (chmod):** `SftpPathPermissions(sessionID, path)` devuelve `sftpx.PermInfo` (bits de permiso `0..0o777` + owner/group best-effort) y `ChmodSftpPath(sessionID, path, mode)` aplica el chmod (`os.FileMode(mode) & os.ModePerm`). La propiedad es **solo lectura**: SFTP solo expone UID/GID numéricos, y solo la máquina local los resuelve a nombres (helper con build-tag `unix`, `fs_owner_unix.go`/`fs_owner_other.go` — Windows muestra en blanco); no hay `chown` (frágil sobre SFTP, suele requerir root). En el frontend `SftpPermissionsDialog.tsx` mapea los bits a toggles owner/group/other × rwx y muestra el preview octal/simbólico.

Frontend: `components/sftp/` — `SftpTab.tsx` (contenedor de doble panel + cola de transferencias con barras de % y botón cancelar + cleanup en unmount que cierra sesiones y cancela transferencias; banner de error y errores de transferencia mostrados completos, con wrap), `SftpPane.tsx` (host picker, listado, drag&drop, **menú contextual** con Enviar/Renombrar/Eliminar/Refrescar/Nueva carpeta/Editar permisos), `SftpPermissionsDialog.tsx` (chmod), `types.ts` (tipos + helpers de path agnósticos de separador). Se abre desde el botón `swap_horiz` en `SshConnectionTree.tsx` (`TabKind` `'sftp'`, una pestaña por host, dedupe como la terminal). Las carpetas vacías no se recrean (los archivos llevan sus directorios padre vía `Create`+`MkdirAll`).

### Ampliaciones del módulo SSH/SFTP (6 fases, post-Git)

- **Conexión compartida** — `sshconn.ClientPool` (`app.go: a.sshPool`) reparte `ClientLease`s con refcount; `sshconn.NewSessionManager(emit, pool)`, `sftpx.NewBrowseManager(pool)` y `sftpx.NewTransferManager(emit, pool)` piden leases en vez de dialear. `sftpx.Endpoint` gana `ConnID` para poder unirse a la conexión del host. En `shutdown` el pool se cierra **después** de los tres managers.
- **Editor remoto** — `ReadFileForEdit(sessionID, path) sftpx.RemoteFile` y `WriteFileFromEdit(sessionID, path, content, expectedModTimeUnix) (int64, error)`; concurrencia optimista por mtime, `0` = sobrescribir igual. `TabKind` suma `'remote-file'` y `'ssh-hybrid'`; `EditorTab.remote?: RemoteFileRef`.
- **Conflictos de transferencia** — `CheckSftpConflicts(SftpTransferInput) []sftpx.Conflict` (pre-vuelo) y `SftpTransferInput.onConflict` (`""`=overwrite | `"newer"` | `"skip"` | `"rename"`). Velocidad y ETA NO viajan en `ProgressEvent`: se derivan en `lib/transferRate.ts`.
- **Drag & drop del escritorio** — `DragAndDrop{EnableFileDrop, CSSDropProperty:"--wails-drop-target", CSSDropValue:"drop"}` en `main.go`. `OnFileDrop` es un único callback global: se registra una sola vez en `lib/desktopFileDrop.ts` y se rutea por hit-test.
- **Entornos** — `connections.environment` (migración 24, `""`/`prod`/`staging`/`dev`) en `ConnectionSummary`/`ConnectionInput`/`ConnectionEditInfo`, más `ConnectionEnvironment(connID) string` para la terminal. Espejo TS en `lib/environments.ts`.
- **Key vault SSH** — tabla `ssh_keys` (migración 25). Bindings: `ListSSHKeys`, `SaveSSHKey(name, privateKey, passphrase)`, `RenameSSHKey`, `SSHKeyUsage(id) []string`, `DeleteSSHKey`. `vault.SSHKeySummary` **nunca** lleva material (misma regla que el DSN). El DSN SSH acepta `?keyId=` como alternativa a `privateKey`, resuelto por `App.resolveSSHKeyRef` justo antes de dialear (`a.sshDSN(connID)` es la vía única).
- **Production Guard** — enteramente frontend (`lib/productionGuard.ts` + `ProductionGuardDialog.tsx`), sin binding: es una confirmación de UX y corre en cada Enter.
- **Varias terminales por servidor** — `sshconn.SessionManager` pasó a indexar por **`sessionID`** y no por `connID`; `session.connID` queda guardado adentro. Bindings: `OpenSSHTerminal(sessionID, connID, cols, rows)`, `WriteSSHTerminal(sessionID, data)`, `ResizeSSHTerminal(sessionID, ...)`, `CloseSSHTerminal(sessionID)`. El **evento de Wails ahora se llama como el `sessionID`** (con el `connID` de nombre, dos pestañas del mismo host recibirían la salida de las dos). El `sessionID` lo arma el frontend con el id de la pestaña: `` `ssh-tab-${tabId}` `` (espejo de `` `local-tab-${id}` ``).
  - Los caminos que hablan de la **conexión** cierran con `SessionManager.CloseConn(connID)` — `UpdateConnection`, `DeleteConnection`, `DisconnectConnection`. Llamar `Close(connID)` ahí sería un no-op silencioso.
  - La lectura del scrollback (`SSHTail`, `SSHCwd`, `HasSession`, `TailRedacted`) pasa por `SessionManager.resolve(key)`, que acepta **sessionID o connID**: `@ssh:` y la herramienta MCP hablan de una conexión y no tienen pestaña, así que con varias abiertas leen la de `lastUsed` más reciente (se toca en cada `Write`). `Write`/`Resize` NO caen a eso: exigen el sessionID exacto.
  - `AnalyzeSSHError(connID, sessionID, selection, lines, agentID)` — el `sessionID` es opcional (`""` = resolver por conexión).
  - Frontend: `lib/sshSessionContext.ts` indexa por `sessionId` todo lo que describe UNA shell (cwd, vivo, `usedShells`) y por `connId` solo `homes`; `registerSession(sessionId, connId)`/`unregisterSession` unen las dos. `Workspace` guarda `liveSshSessionIds: Map<sessionId, connId>` y deriva de ahí el `Set` de conexiones vivas y el conteo por servidor.

## Módulo Git (post-lanzamiento)

Cliente Git estilo Sublime Merge. Backend: `backend/git`, bindings en
**`app_git.go`** (archivo propio en vez de engordar los ~2500 renglones de
`app.go`; Wails bindea todo método exportado de `*App` sin importar el archivo,
así que es la misma superficie de binding que documenta este spec).

**Motor: `os/exec` sobre el binario `git` del sistema, NO `go-git`.** Decisión
explícita, no camino de menor resistencia:

- **Tamaño de binario** (regla técnica 8): `go-git` arrastra un árbol de
  dependencias grande. `exec` suma **0 bytes** — `go.mod` no cambió.
- **Dependencias mínimas** (regla 12): ningún módulo nuevo.
- **Auth, el factor decisivo**: se necesitan credential helpers del SO, ssh-agent
  y PATs. El binario `git` implementa los tres correctamente y por plataforma;
  `go-git` no soporta credential helpers del SO en absoluto y su soporte de
  ssh-agent es parcial. Usarlo significaría reimplementar la parte más difícil
  del módulo con peor resultado.
- **Velocidad**: para grafos de commits y diffs grandes, git-en-C gana.

El costo es una **dependencia dura de que `git` esté instalado**, expuesta
honestamente en vez de escondida: `GitProbe()`/`GitRefreshProbe()` reportan
disponibilidad y versión, y el frontend renderiza un estado degradado en vez de
fallar operación por operación.

**Los secretos nunca tocan argv ni la URL del remote.** Un PAT en la línea de
comandos queda en la tabla de procesos; en la URL del remote queda en texto
plano dentro de `.git/config`. En su lugar, `GIT_ASKPASS`/`SSH_ASKPASS` apuntan
al **propio binario de mini-tools** re-ejecutado: `main()` chequea
`git.IsAskpassInvocation()` **antes de todo lo demás** (antes de abrir ventana,
tocar el vault o escribir en appdata) y delega en `git.AskpassMain()`, que
responde el prompt por stdout y sale. No hay que shippear ni escribir a disco un
helper aparte, y el secreto nunca aterriza en un archivo temporal.

`GIT_TERMINAL_PROMPT=0` es load-bearing, no higiene: sin eso, un `git` que
necesita credenciales se cuelga esperando una terminal que no existe dentro del
webview, y la UI muestra un spinner eterno en vez de un error accionable.
`LC_ALL=C` fija el idioma de los mensajes de error de git para que el parseo no
dependa del locale. `GIT_PAGER=cat` evita que git espere a un pager sin tty.

**Las URLs de remoto viajan sin tapar (excepción de la regla técnica 9).**
`GetRemotes` devuelve cada URL tal cual está en `.git/config`, token embebido
incluido (`https://<token>@github.com/…`). Durante la implementación esto se
hizo al revés —una función `redactURL` reemplazaba el userinfo por `REDACTED`,
y el caso se encontró en vivo en el propio repo de mini-tools— y **el usuario
decidió después, viéndolo en uso, que se muestre**. El motivo por el que la
máscara no valía la pena: el token ya está en texto plano en `.git/config` y
`git remote -v` lo imprime, así que no protegía nada que no revelara abrir el
archivo; lo que hacía era esconder, en la única pantalla que muestra remotos, el
dato sobre el que hay que actuar. Un remoto roto porque su token venció se veía
igual que uno sano. Lo que sí ofrece la app es **mudar ese token al vault** desde
el editor de remotos: se guarda cifrado por host y la URL queda limpia, sin
perder el acceso (el PAT llega a git por askpass). La consecuencia aceptada está
escrita en la regla 9: una URL de remoto en la UI puede llevar una credencial
viva.

`GitRemoteURLsForEdit` existe al lado de `GitRemotes` por **una** diferencia:
devuelve `pushUrl` vacío cuando el remoto no tiene override, mientras que
`remote -v` siempre imprime una línea de push igual a la de fetch. El editor
guarda lo que muestra, así que con el duplicado a la vista escribiría un
override que nadie pidió — y un override viejo es lo que hace que cambiar la URL
de fetch parezca funcionar mientras el push sigue yendo al servidor anterior.
Devuelve un `git.Remote` en vez de un tipo nuevo a propósito: la clase ya la
emite el generador por `GitRemotes`, así que agregar el binding no toca
`models.ts` (ver el incidente más abajo). Lee de `config --list` y no de
`remote get-url` porque `remote.<name>.pushurl` casi nunca existe, y preguntar
con `--get` por una clave ausente sale con 1 y pinta una línea roja en el log de
comandos cada vez que se abre el editor. `GitSetRemoteURLs` cierra el círculo:
una URL de push vacía (o igual a la de fetch) **borra** el override en lugar de
duplicarlo.

**Inyección de flags.** No hay shell (los argumentos van directo a `exec`), así
que un nombre de rama con metacaracteres es inerte. El vector que queda es un
argumento que empieza con `-` y se lee como flag: `checkRefArg` lo rechaza y las
rutas van siempre después de `--`.

**Vault — migración 18, `git_repos`.** Solo rutas, nombres, agrupación y orden:
**ninguna credencial**, así que no hay columna cifrada (a diferencia de
`connections`). El auth se resuelve en tiempo de operación por el credential
helper del SO / ssh-agent, no hay nada que persistir. `folder_id` reusa la tabla
`folders` compartida con un scope nuevo (`'git'`), igual que hicieron las
migraciones 12 (SSH) y 14 (snippets), en vez de un cuarto árbol paralelo.
`path` es UNIQUE — agregar dos veces el mismo repo da un error claro en lugar de
duplicar la entrada del sidebar. `RemoveGitRepo` **nunca** toca el working tree
en disco: quitar un proyecto de una lista jamás puede borrar el código del
usuario, mismo principio que `DeleteFolder` no borrando lo que contiene.

Todo binding pasa por `requireUnlocked` sin excepción, salvo `GitProbe`/
`GitRefreshProbe` (no revelan nada del usuario y el frontend los necesita para
decidir si renderizar el módulo). El frontend direcciona repos por **ID opaco**,
nunca por path — `App.gitRepo(repoID)` es el único lugar donde un ID se
convierte en una ruta de filesystem, espejando la indirección por `connID` que
ya usa el resto de la app.

**Bug real encontrado implementando:** git emite el bloque `--numstat`
**después** del separador de registro del `--pretty=format`, no antes. Con el
separador al final (lo intuitivo), los stats de cada commit caían en el registro
siguiente y `Stats` daba siempre `{0,0,0}`. Por eso `logFormat` **encabeza** con
el separador en vez de cerrarlo, a costa de un chunk vacío inicial. Verificado
contra este repo: v0.4.0 da 72 archivos, +6393/-203, idéntico a lo que reporta
Fork.

## IntelliSense del editor SQL (`backend/sqlintel`)

Seis bindings nuevos, todos detrás de `requireUnlocked` (el índice se arma a
partir del esquema de una conexión guardada: es dato gateado por la clave
maestra, no una preferencia de UI como el tema).

| Binding | Devuelve | Cuándo lo llama el frontend |
|---|---|---|
| `PrimeSchemaIndex(connID)` | `sqlintel.Status` | Al vincular una pestaña a una conexión (`CodeMirrorTabbedEditor`), y de nuevo si una respuesta llega con `indexing: true` |
| `GetSchemaIndexStatus(connID)` | `sqlintel.Status` | Aviso "Autocompletado sin esquema" en la fila de contexto del editor (`Workspace.tsx`): se lee al vincular la pestaña y otra vez con cada `sqlintel:index` |
| `CompleteSQL(sqlintel.Request)` | `sqlintel.Response` | Cada vez que CodeMirror abre/reabre el popup de completado |
| `SuggestInlineSQL(sqlintel.Request)` | `string` | Ghost text, 180 ms después de que el cursor se queda quieto |
| `RecordCompletionUse(connID, kind, name)` | `error` | Al aceptar una sugerencia de tabla/columna/esquema/rutina |
| `ResolveJoinCondition(connID, left, leftAlias, right, rightAlias)` | `[]sqlintel.JoinCondition` | "¿Cómo se unen estas dos tablas?" sin cursor de por medio |

Evento Wails: **`sqlintel:index`** con un `sqlintel.Status` cuando termina una
extracción en segundo plano. Lo consumen dos lugares, y ninguno es opcional:
`CodeMirrorTabbedEditor` vuelve a pedir el completado si el popup está
abierto (si no, una lista armada mientras el índice se construía se quedaba
en modo palabras clave hasta reescribir la palabra), y `Workspace.tsx`
refresca el aviso de índice fallido.

**Un `PrimeSchemaIndex` que falla se reintenta con un margen de 10 s**
(`primeSchemaIndex` en `sqlIntel.ts`). Sin eso, un catálogo ilegible deja el
índice vacío, cada respuesta vuelve con `indexing: true`, y el frontend
dispara un escaneo por tecla contra una base que ya no está respondiendo.
Volver a vincular la pestaña limpia el margen (`forgetPrimeCooldown`), para
que reconectar arregle el completado en el acto.

**El índice es asíncrono por diseño, y el completado nunca depende de que
esté listo.** `PrimeSchemaIndex` retorna al instante con `state: "loading"` y
la extracción corre en una goroutine — es una consulta de catálogo contra una
base posiblemente remota, y la UI no puede esperarla. Mientras tanto
`CompleteSQL` responde igual, degradado a keywords/funciones/snippets del
dialecto, y marca `indexing: true` para que el frontend sepa por qué todavía
no ve tablas. Nunca devuelve error por "índice no listo".

**`CompleteSQL` no falla con SQL inválido, y eso es deliberado.** La entrada
normal es un statement a medio escribir: el motor está escrito para degradar
a una lista más corta, jamás para errorear. Lo único que devuelve vacío a
propósito es un cursor dentro de un literal o de un comentario.

**Un literal sin cerrar se confina a su línea** (`token.go`). El tokenizador
recorre el buffer entero antes de acotarse a la sentencia del cursor, así que
una comilla suelta arriba del archivo hacía que TODO lo de abajo cayera en
"estás dentro de un literal" — el completado se apagaba en las consultas
siguientes sin nada en pantalla que lo explicara, y volvía solo al editar
más arriba. Un literal multilínea legítimo siempre cierra; uno que no, es un
error de tipeo y no puede contagiar al resto del archivo. Misma regla para
identificadores delimitados (`"`, `` ` ``, `[`). El *alternative quoting* de
Oracle (`q'[…]'`, `nq'!…!'`) se reconoce entero, porque su cuerpo puede
llevar comillas y leerlo como literal común desfasaba todo lo que seguía.

Un `/*` sin cerrar **sí** se lleva el resto del archivo, y la asimetría es
deliberada: un comentario de bloque multilínea es el caso normal, así que
confinarlo mentiría sobre qué está comentado. El arreglo alcanza también a
`SignatureSQL` y a las tablas que el script declara (`CREATE TABLE` de más
arriba, CTE de la sentencia actual), que comparten tokenizador y se apagaban
por el mismo motivo.

**Los offsets son unidades de código UTF-16, no bytes ni runas** — es lo que
son las posiciones de CodeMirror (índices de string de JavaScript).
`backend/sqlintel/offsets.go` convierte en ambas direcciones; `Response.from`
vuelve en UTF-16 para que el editor lo use directo. Un acento en un
comentario alcanza para que un offset en bytes quede mal, y un emoji para
que uno en runas quede mal — por eso se convierte exacto en vez de asumir
ASCII.

**Las claves JSON de `sqlintel.Item` son de una letra** (`l`/`k`/`d`/`a`/`i`/
`s`) a propósito: una respuesta lleva hasta 60 ítems y los nombres de campo
serían la mayor parte del payload que cruza el puente. Es la única estructura
del contrato con este criterio, justamente por su volumen; el resto
(`Request`, `Status`, `JoinCondition`) usa nombres normales.

**Dos `kind` de `Item` no salen del catálogo: `alias` y `expand`.** El resto
(`table`, `column`, `schema`, `function`, `routine`, `keyword`, `snippet`,
`join`) nombra algo que el índice o el dialecto conocen; estos dos los
propone el motor. `alias` es el nombre corto para la tabla recién escrita
(`FROM clientes |`) o un alias que el propio SELECT definió (`AS total`, que
no existe en ningún catálogo). `expand` es el `*` reemplazado por su lista de
columnas.

**`expand` se ofrece SOLO con `explicit: true`.** CodeMirror ata Enter a
aceptar la opción seleccionada, y en un popup que se abrió solo (`SELECT |`)
un Enter para ir a la línea siguiente pegaría la lista entera de columnas en
el buffer. Todas las demás sugerencias del motor miden un identificador,
donde ese error cuesta un backspace; esta puede medir tres mil caracteres.

**`SuggestInlineSQL` existe separado de `CompleteSQL` por payload, no por
lógica** — los dos corren el mismo motor. El ghost text se recalcula con cada
movimiento de cursor, no solo con el popup abierto, así que responderlo con
un string suelto en vez de la lista completa de ítems es lo que lo hace
viable como llamada frecuente.

**`RecordCompletionUse` es solo memoria de sesión, nunca se persiste.** Es una
pista de ranking (lo que esta sesión viene usando sube en la lista): perderla
al cerrar la app no cuesta nada y persistirla exigiría una migración de vault
para algo que se reaprende en tres clicks.

## Trampa del generador de bindings (incidente real, 21/08/2026)

**El generador de Wails solo emite en `models.ts` los tipos que alcanza
desde la firma de un binding.** Un tipo que solo viaja adentro de un JSON
opaco —guardado como columna de texto en el vault, por ejemplo— **nunca se
genera**, por más que exista en Go y esté perfectamente serializado.

Y escribirlo a mano en `models.ts` **no funciona**: `wails build` regenera
ese archivo entero y se lo lleva puesto. El síntoma es el peor posible —
`tsc --noEmit` y `vite build` pasan en local con el archivo editado a mano,
y el build de release falla recién al regenerar.

Pasó con `httpclient.Variable` y `httpclient.Computed`, que viven adentro de
`http_environments.variables` y `http_items.computed` como texto JSON.

**La regla:** un tipo que no está en ninguna firma de binding **se define en
el frontend**, no en los modelos generados — `components/http/httpShared.ts`
tiene `HttpVariable` y `HttpComputed` como ejemplo, con los nombres de campo
calcados de los tags JSON de Go. La alternativa (inventar un binding que
devuelva ese tipo solo para que se genere) sería mentirle a la superficie de
la API para satisfacer a una herramienta.

**Guarda automática:** `python3 scripts/check-bindings.py` compara App.js,
App.d.ts y los métodos de `*App`, y verifica que toda clase
`namespace.Clase` que el frontend usa exista en `models.ts`. Correrlo antes
de un release cuesta un segundo y ataja exactamente este fallo.

Dos avisos del generador son **preexistentes y benignos**: `db.Function` y
`db.Package` chocan con palabras reservadas de TypeScript, así que no se les
genera clase. Ningún componente las usa.

## Módulo HTTP — F1 (`backend/httpclient`, `app_http.go`)

Quince bindings, todos detrás de `requireUnlocked` (una colección guarda
cuerpos, headers y documentación del usuario) y direccionando por **ID
opaco**, igual que el módulo Git.

| Binding | Nota |
|---|---|
| `HttpListCollections` / `HttpSaveCollection` / `HttpDeleteCollection` | El borrado arrastra ítems e historial **en una transacción**: media colección borrada es peor que ninguna, y no hay claves foráneas declaradas que lo hagan solas |
| `HttpListItems` / `HttpGetItem` / `HttpSaveItem` / `HttpDeleteItem` / `HttpMoveItem` | Un solo tipo `HTTPItem` para carpetas y peticiones, distinguidas por `kind` — es la forma del formato de Postman, así que el import de F6 mapea uno a uno. `MoveHTTPItem` **rechaza** mover una carpeta dentro de su propio subárbol (la desconectaría del árbol sin ningún error visible) |
| `HttpSend(execID, itemID, request)` | Devuelve `HttpSendResult`, con el error **adentro** y no como error de Go: un 500, un timeout y un certificado inválido son resultados normales de probar un endpoint, no fallas de la app, y devolverlos como error dejaría a la UI sin la duración ni la URL que los produjo. `itemID` puede ir vacío (petición sin guardar) |
| `HttpCancel(execID)` | El `execID` lo elige el frontend para poder cancelar sin esperar a que `HttpSend` vuelva. Cancelar algo ya terminado no es error |
| `HttpHistory` / `HttpClearHistory` / `HttpHistoryAll` / `HttpDeleteHistoryEntry` / `HttpClearAllHistory` | Tope de 50 por ítem, **no global**: quien depura corre la misma petición veinte veces y un tope global le borraría el historial de todas las demás. La URL se archiva con los parámetros que parecen secretos reemplazados por `***` |
| `HttpFormatBody(lang, text)` | JSON con `json.Indent` (**no** un round-trip por `map`, que reordenaría las claves alfabéticamente y convertiría "formatear" en "reescribirme el cuerpo"). Un texto que no parsea vuelve **intacto y sin error**: el caso normal de apretar el botón es un JSON a medio escribir |
| `HttpDefaultSettings` | Vive en Go para que `verifyTls: true` tenga una sola definición |
| `HttpBuildRequest(itemID)` | Arma la petición ejecutable desde el ítem guardado. Existe como binding desde F1 —aunque hoy solo copie campos— porque es el punto donde F2 resuelve variables y F4 la auth heredada: que la UI ya llame acá significa que esas fases no tocan el frontend |

**El motor no comparte `http.Transport` entre peticiones**, a diferencia de
lo habitual. Cada una puede pedir otra configuración de TLS o de versión de
HTTP, y un transport compartido reusaría conexiones establecidas con la
configuración de otra — el bug de "apagué la verificación TLS y sigue
fallando", o peor, al revés.

**Los settings de redirección se implementan sobre `CheckRedirect`**, y dos
merecen nota: "conservar el método" contradice a propósito lo que hace Go
por defecto (convertir a GET en 301/302/303, que es lo que manda el
estándar), y "conservar el header Authorization al cambiar de host" vuelve a
poner a mano una credencial que `net/http` quita solo — mandar credenciales
a otro host es filtrarlas, así que nunca es el default y la UI lo marca en
rojo.

### F2 — variables y entornos

Seis bindings más: `HttpListEnvironments` / `HttpSaveEnvironment` /
`HttpDeleteEnvironment` / `HttpActiveEnvironment` /
`HttpSetActiveEnvironment` / `HttpResolvePreview`.

**La resolución ocurre en Go al ENVIAR, y el frontend manda el texto sin
resolver.** Lo guardado conserva siempre `{{HOST}}`; resolver al guardar
congelaría la petición contra el entorno que estaba activo cuando se
escribió, que es lo contrario de para qué existen los entornos.

**Precedencia: entorno → colección** (el orden de Postman). El documento del
plan decía "colección → entorno" y **estaba mal**: con la colección ganando,
cambiar de entorno no haría nada. Corregido en F2, en el plan y en el código.

**El entorno elegido es el ANCLADO a la colección si lo hay, y el activo si
no** — el anclaje es una decisión tomada sobre esa colección en particular,
el activo es la preferencia general. `SaveHTTPEnvironment` libera el anclaje
anterior de esa colección en la misma operación: con dos entornos anclados a
la misma colección, cuál gana dependería del orden de lectura.

**Una variable sin resolver se deja literal**, no se reemplaza por vacío
(`http:///dev/blocks` falla con un error del transporte que no nombra la
causa). `HttpResolvePreview` existe para que la UI la marque **antes** de
mandar, y devuelve los valores secretos ya enmascarados porque su resultado
se muestra en pantalla.

**`MaskSecrets` busca por VALOR, no por nombre**, y omite los secretos de
menos de cuatro caracteres —enmascararían media URL—. Es la última barrera
antes del historial: para entonces la sustitución ya ocurrió y el token está
adentro del texto.

### F3 — cuerpos y archivos

Dos bindings más: `HttpPickFile` y `HttpSaveResponseToFile(spillPath,
base64Body, textBody, suggestedName)` — recibe las **tres** formas en que
puede venir un cuerpo y elige la correcta; sin el caso del volcado, guardar
una descarga grande escribiría solo lo que entró en memoria.

**`buildBody` devuelve también el TAMAÑO**, y `Send` lo pone en
`Request.ContentLength` cuando se conoce. `net/http` solo lo deduce solo para
los lectores que reconoce (`strings.Reader`, `bytes.Reader`); un cuerpo que
sale de un archivo o de un pipe iría `chunked`, y hay servidores PHP y
proxies viejos que rechazan una subida chunked. Solo el multipart va
chunked, a cambio de no cargar el archivo en memoria.

**El multipart se arma sobre `io.Pipe` en una goroutine** que cierra
*siempre* con `CloseWithError`: irse sin cerrar deja al lector esperando y
cuelga la petición hasta el timeout sin decir por qué. Los archivos se abren
**antes** de arrancar el envío, para fallar nombrando el archivo en vez de a
mitad de la subida.

**Una respuesta que supera el tope se vuelca ENTERA a un temporal**
(`Response.SpillPath`), y `SizeBytes` pasa a ser el total real, no lo
mostrado. El archivo no se borra al terminar: la UI puede ofrecer guardarlo
minutos después, y limpiar el temporal del sistema es trabajo del sistema.

### F4 — autenticación con herencia

Tres bindings más: `HttpAuthPreview`, `HttpFetchOAuth2Token`,
`HttpAuthorizeOAuth2`. La cadena la arma el vault (`HTTPAuthChain`) en **una**
lectura del árbol, no una llamada por nivel, y trae un tope de profundidad de
64: un `parent_id` corrupto que apunte a un ancestro haría un ciclo, y un
bucle infinito ahí cuelga la aplicación.

**La auth se resuelve DESPUÉS de las variables**, y sus campos pasan por el
resolvedor: `{{token}}` adentro de un Bearer se resuelve igual que en un
header, que es lo que permite guardar el secreto en el entorno (cifrado,
enmascarado, fuera del export) en vez de repetirlo en cada petición.

**AWS SigV4 va escrito a mano** — el SDK sumaría decenas de MB por cuatro
hashes en un orden concreto, y la canonicalización (que es la parte difícil)
hay que escribirla igual. Dos detalles que invalidan la firma entera si se
copian de `url.QueryEscape`: el espacio va `%20` y no `+`, y la tilde queda
literal.

**Digest reintenta una vez** dentro de `Send` (necesita el nonce del
desafío), y para eso el cuerpo se materializa en memoria — igual que para
SigV4, que lo hashea. Solo en esos dos casos: el resto sigue en streaming.

**OAuth 2.0 authorization code**: loopback en puerto efímero (RFC 8252),
**PKCE S256 siempre**, y `state` comparado con `subtle.ConstantTimeCompare`.
`openBrowser` entra como parámetro de `AuthorizeOAuth2` en vez de llamarse
desde adentro, para que el paquete no dependa del runtime de Wails y el flujo
se pueda ejercitar sin abrir un navegador.

### F5 — variables calculadas (sin motor JS)

Sin bindings nuevos: las calculadas viajan dentro de `HTTPItem.computed` /
`HTTPCollection.computed` y se evalúan adentro de `HttpSend` y de
`HttpResolvePreview`, que ahora devuelven `computedErrors`.

**Orden de precedencia final**: calculadas → dinámicas → entorno → colección.
Las dinámicas (`{{$timestamp}}`, `{{$randomUUID}}`) se calculan **una vez por
llamada a `varScopes`** y no por aparición: un timestamp distinto en la URL y
en la firma haría que la firma no validara nunca.

**Todo lo calculado se marca `Secret: true`** automáticamente — lo que sale de
ahí es una firma o un token, y depender de que el usuario lo marque sería
depender de que se acuerde.

**Costo de binario: 0.** La decisión de no incorporar goja (+19,8 MB medidos)
está en `.claude/specs/http-client.md` con la tabla de mediciones.

### Trampa: un binding que entra en pánico deja la promesa colgada PARA SIEMPRE

Wails recupera el pánico por su cuenta (`internal/frontend/dispatcher.ProcessMessage`)
y responde con `Callback("")`. Esa cadena vacía el runtime de JavaScript no la
puede parsear, así que **la promesa de esa llamada no se resuelve ni se rechaza
nunca** — y `Call` no tiene tiempo límite (timeout 0 = infinito).

No es teórico: así se moría el autocompletado de SQL. CodeMirror no le vuelve a
preguntar a una fuente mientras haya una consulta suya pendiente, así que una
sola llamada sin respuesta lo mataba para esa pestaña hasta reabrirla —
comprobado en un banco con CodeMirror real: no se recuperaba ni con Ctrl+Espacio
ni escribiendo sesenta caracteres.

Regla, para cualquier binding en el camino de una interacción continua
(completado, ayuda de firma, sugerencias, cualquier cosa que se pregunte por
tecla):

1. **En Go**, `defer recoverEditorCall(nombre, fallback)`: un pánico se convierte
   en una respuesta vacía, se loguea, y deja de ser mortal.
2. **En el frontend**, la llamada va envuelta en `settled()`
   (`codemirror/sqlIntel.ts`), que le pone tope de tiempo y devuelve `null` tanto
   si falló como si tardó de más. Nunca lanza.

Las dos mitades, no una: la primera tapa el caso conocido, la segunda cualquier
otra forma de perder una respuesta.

### Peticiones HTTP rápidas (`itemId` vacío)

`HttpSend`, `HttpHistory`, `HttpClearHistory`, `HttpAuthPreview`,
`HttpResolvePreview` y `HttpGenerateCode` aceptan `itemID == ""`: es una petición
que se manda sin guardarla en ninguna colección.

Qué significa vacío, con precisión: sin colección → sin variables de colección y
**sin herencia de autenticación** (`authFor` con id vacío devuelve `none`, y solo
respeta el override que viene de la pantalla). Las variables del entorno activo
sí valen, porque el entorno es transversal a las colecciones.

El historial de las rápidas es un cajón compartido (`item_id` NULL) que se lee y
se poda como cualquier otro. Del lado del frontend, la pestaña pasa
`itemId: string | null`; guardar una rápida crea el ítem y avisa por `onSaved`,
que es lo que hace que la pestaña deje de serlo.

### F9 — runner de colección y cookies

Bindings: `HttpRunCollection(runID, collectionID, folderID, delayMs)` →
`HTTPRunSummary`, `HttpCancelRun(runID)`, `HttpCookies(collectionID)`,
`HttpClearCookies(collectionID, domain)`, `HttpSaveResponseExample(...)`.

**La corrida bloquea el binding y el progreso va por evento** (`http:run`, con
`runId`, `index`, `total` y el `HTTPRunResult`). Treinta peticiones tardan, y un
botón girando sin decir por cuál va no sirve. La UI filtra por `runId`: dos
paneles no pueden pisarse.

**El emisor se inyecta.** `HttpRunCollection` es una cáscara sobre
`runCollection(..., emit func(map[string]any))`. `runtime.EventsEmit` exige el
contexto del ciclo de vida de Wails —con cualquier otro aborta el proceso—, así
que una corrida que emitiera directo solo sería ejercitable con la ventana
abierta. Mismo patrón para cualquier binding largo que reporte progreso.

**Cancelar es cooperativo y entre peticiones.** La que está en vuelo se deja
terminar: ya salió, y cortarla del lado del cliente no la deshace del lado del
servidor. Lo que queda se informa como `skipped`, nunca como fallido.

**El tarro de cookies se elige por ENTORNO**, no por colección
(`scopesAndEnv` devuelve el id del entorno junto con los scopes, a propósito en
una sola función: dos recorridos separados serían la forma segura de que un día
las variables salgan de un entorno y las cookies de otro).

### F8 — IA sobre una petición

Cinco bindings: `AgentExplainHTTP`, `AgentDiagnoseHTTP`, `AgentGenerateHTTP`,
`AgentDraftHTTPDocs`, `AgentDraftHTTPTests`. Todos toman
`(itemID string, req httpclient.Request, resp httpclient.Response, …)`.

**La respuesta viaja como VALOR, no como puntero.** Wails no expresa `*T` del
lado de TypeScript (emite `Response`, no `Response | null`), así que la ausencia
de respuesta se dice con `status: 0` — ningún servidor contesta con 0. Un
puntero acá compila en Go y rompe el `tsc` del frontend.

**El filtrado de secretos vive en `app_httpagent.go`, nunca en `agentctx`.**
`agentctx` solo formatea texto y no tiene acceso al vault; si el filtro viviera
ahí, agregar un campo al prompt sería una forma silenciosa de filtrarlo.
`redactExchange` pasa TODOS los campos de texto de una sola vez y como último
paso, por la misma razón que en la documentación (F7): son ocho caminos hasta el
mismo prompt.

`AgentGenerateHTTP` devuelve `HTTPGenerated{answer, request?, curl}`. `request`
puede venir vacío: un cURL que no se pudo interpretar **no es un error de la
acción** — la explicación y el comando siguen sirviendo, y la UI ofrece copiarlo
en vez de fallar.

### F7 — documentación como nota del vault

Dos bindings: `HttpDocsPreview(collectionId)` y `HttpPublishDocs(collectionId)`
→ `HttpDocsResult{noteId, title, status, requests, markdown}`.

`status` es `"created"`, `"updated"` o `"skipped"`. **El markdown viaja también
cuando es `"skipped"`**: la UI necesita poder mostrar lo que se habría escrito,
porque una negativa sin el documento a la vista obliga al usuario a borrar la
nota para ver qué se estaba perdiendo.

**Regenerar no pisa una nota que editó una persona** — `vault.GeneratorCanEdit`
con `vault.HTTPDocsOriginMark`, el mismo contrato que tiene el agente por MCP.
`WithUserTouch` conoce ahora las dos marcas de origen: se aplica en el único
lugar por donde el usuario guarda una nota (`UpdateNote` en app_notes.go), así
que un generador nuevo queda cubierto registrando su marca ahí.

`HttpPublishDocs` escribe con `a.vault.UpdateNote` (el método del store) y **no**
con el binding `App.UpdateNote`: ese estampa `WithUserTouch`, y una regeneración
que se marque a sí misma como edición humana se bloquearía en la siguiente.

El vínculo colección↔nota es `http_collections.docs_note_id` (migración 49) y se
escribe SOLO con `SetHTTPCollectionNote`, fuera de `SaveHTTPCollection` — por la
misma razón que `postman_raw`: un guardado hecho con una copia leída antes de
publicar desvincularía la nota en silencio.

`HttpDocsResult` lo emite Wails como `main.HttpDocsResult` en models.ts porque
aparece en la firma de un binding. Nada que escribir a mano (ver la trampa de
F6 más abajo).

### F6 — interop (Postman, cURL, snippets)

Cuatro bindings: `HttpExportPostman`, `HttpImportCurl`, `HttpCodeLanguages`,
`HttpGenerateCode`. (`HttpImportPostman` existió hasta F10, que lo reemplazó
por el diálogo único de importar — ver abajo.)

**Round-trip por preservación, no por modelado completo.** Cada ítem guarda
su JSON original en `postman_raw` (cifrado) y el exportador **parte de ese
crudo y pisa solo lo modelado**. Así sobreviven las respuestas de ejemplo,
`protocolProfileBehavior` y lo que Postman agregue después, sin que este
código los conozca. Las columnas `postman_raw` se leen y escriben **aparte
del CRUD normal** (`SaveHTTPItemRaw`/`HTTPItemRaw`): meterlas en
`SaveHTTPItem` haría que cada guardado desde el editor arrastre —y pueda
pisar— un dato que no está editando.

**La URL tiene una sola fuente de verdad: `raw`.** Postman la guarda tres
veces (raw, host[]+path[], query[]) y mantener las tres sincronizadas al
exportar es una fuente de discrepancias silenciosas. Al importar se le quita
la query, que pasa a la tabla de params — dejarla en los dos lados la
duplicaría al enviar.

**El export nunca incluye secretos**: las variables marcadas secretas salen
declaradas y vacías (como hace Postman) y el `accessToken` de OAuth 2.0 no
viaja. Un archivo de colección se comparte por chat y se sube a repos.

**`HttpGenerateCode` vuelca la auth a headers** (`AuthAsHeaders`) para que el
snippet reproduzca la petición: un `fetch` de ejemplo sin el `Authorization`
que la app sí manda es un snippet que no funciona. Digest y OAuth 2.0 sin
token se omiten — inventar un header ahí sería mostrar algo que no es lo que
va a viajar.

**Qué se cifra en `http_items`**: cuerpo, auth, docs y el crudo de Postman.
`url`, `params` y `headers` quedan en claro porque son las columnas por las
que se lista y se busca el árbol, y cifrarlas obligaría a descifrar la
colección entera para dibujar la barra lateral. La contrapartida honesta es
que un `Bearer` escrito a mano en un header queda en claro dentro del
archivo del vault; el lugar para un token son las variables secretas de F2,
que sí se cifran.

### F10 — importar todo, historial global, favoritas

Nueve bindings: `HttpImportDetect(text)` → `httpclient.ImportDetection`,
`HttpImportText(text, collectionID)` y `HttpImportFiles(paths)` →
`main.HttpImportBatch`, `HttpImportPickFiles`, `HttpImportPickFolder`,
`HttpHistoryAll(search)`, `HttpDeleteHistoryEntry(id)`, `HttpClearAllHistory`,
`HttpSetCollectionFavorite(id, favorite)`.

**Detectar es su propio binding, y no devuelve error.** El diálogo lo llama
mientras se escribe (con 250 ms de respiro) para decir qué reconoció antes de
escribir nada; un formato que no se reconoce vuelve con `kind: ""` y un
`reason` que explica por qué. Importar a ciegas y después ir a buscar al árbol
qué entró es lo que hace que uno no se anime a arrastrar un archivo que no
recuerda qué tenía.

**El resultado es una LISTA, no un objeto.** Un volcado de Postman trae varias
colecciones y varios entornos, y una carpeta arrastrada trae veinte archivos:
`HttpImportBatch.items` lleva un `HttpImportOutcome` por cosa importada, con su
`error` propio cuando ese archivo no entró. Lo único que corta la importación
entera es un fallo de la bóveda (`vaultFailure`), que se distingue a propósito
de «este archivo no servía».

**`HttpImportText` recibe la colección destino** solo para lo que es UNA
petición (cURL, texto plano, URL). Vacío significa «creá una»: una petición
importada que no queda en ningún lado se pierde al cerrar la pestaña, que es lo
contrario de importarla.

**Los selectores devuelven rutas, no importan nada** (`HttpImportPickFiles`,
`HttpImportPickFolder`): el frontend las pasa a `HttpImportFiles`, el mismo
camino que usa el arrastre. Un segundo camino de importación terminaría
comportándose distinto.

**`HttpSetCollectionFavorite` va aparte de `HttpSaveCollection`**, igual que
`SetHTTPCollectionNote`: el editor no manda ese campo y meterlo en el UPDATE
haría que renombrar una colección leída antes de marcarla la desmarcara.

`HttpImportBatch`, `HttpImportOutcome` e `ImportDetection` aparecen en firmas de
bindings, así que Wails los emite en models.ts (acá se escribieron a mano, sin
CLI, y se validaron con `scripts/check-bindings.py`).

## EXPLAIN enriquecido (`backend/explain`)

Un binding nuevo, `CheckSQLMutation(sqlText) → bool`, detrás de
`requireUnlocked`. Responde si el script escribe algo (datos o esquema) para
que el frontend confirme antes de un Explain Analyze — que, a diferencia de
Explain, ejecuta la consulta de verdad.

Se resuelve en Go y no con un regex en el frontend porque reusa
`query.SplitStatements`, que ya entiende comillas, comentarios y
dollar-quoting: `-- delete esto` y `SELECT 'DELETE'` no son deletes, y
`WITH x AS (…) DELETE FROM …` sí lo es pese a empezar con `WITH`. Un regex
del lado del cliente se equivoca en los tres.

**La confirmación es la cortesía, no la garantía.** `explain.PostgresPlan`
envuelve un ANALYZE de un statement mutante en `BEGIN`/`ROLLBACK` sobre una
conexión reservada, siempre, y devuelve `Plan.RolledBack` para que la UI lo
diga. Aunque el usuario confirme, no se aplican cambios.

`explain.Plan` creció con métricas de cabecera (`planningTimeMs`,
`executionTimeMs`, `totalCost`, `estimatedRows`/`actualRows`, `nodeCount`,
`buffers`), el motor de origen (`engine`), si trae mediciones reales
(`analyzed`) y una lista de `insights` accionables. `explain.PlanNode` creció
con `actualRows`/`loops`, `selfTimeMs`/`selfCost`/`impactPct` (calculados,
no reportados por el motor), `rowsRatio`, `severity`, `isBottleneck`,
`indexName` y `filter`.

**`severity` no es "es un full scan sí/no"** — es qué tan fuerte debe
mostrarlo la UI, graduado por filas leídas y peso dentro del plan. Un
recorrido completo de una tabla de diez filas llega como `info`; el frontend
lo etiqueta pero no lo alarma. Los campos calculados los llena
`explain.Analyze`, que corre al final del builder de los cuatro motores;
ningún motor debe escribirlos.

`Insight.sql`, cuando viene, es una sentencia lista para copiar
(`CREATE INDEX …`, `ANALYZE …`). **Nunca se ejecuta desde la app** — crear un
índice es una escritura real con costo en disco y en escrituras, y el orden
correcto de las columnas depende de conocimiento que el backend no tiene.

## Muestreo de esquema MongoDB (`SampleMongoFields`)

`SampleMongoFields(connID, database, collection) → []db.MongoFieldInfo`,
detrás de `requireUnlocked` como el resto de los métodos de Mongo.

MongoDB no tiene catálogo que consultar, así que este binding **lee
documentos**: un `find().limit(50)` y un recorrido recursivo (hasta 3
niveles) de las claves. Es una aproximación por construcción — un campo
presente solo en documentos viejos puede no aparecer — y por eso el
resultado no es una lista de nombres sino, por cada ruta, `count`,
`frequency` (0-1) y `types` (los tipos BSON vistos, más común primero).

Ambos datos son para decidir, no decorativos: el frontend rankea por
frecuencia y **marca los campos con más de un tipo**, que es la causa más
común de un filtro que devuelve cero sin explicar por qué.

**Es un `find().limit(N)` y no un `$sample` a propósito:** `$sample` sobre
una colección grande escanea o depende de un cursor aleatorio interno, y
esto corre interactivamente cada vez que el usuario elige una colección en
el asistente. Es un autocompletado, no un trabajo estadístico.

Las rutas dentro de arrays de subdocumentos se registran **sin índice
numérico** (`pedidos.sku`, no `pedidos.0.sku`) porque así es como se
escribe el filtro correspondiente en Mongo.

## Redis: bindings de las 6 fases post-lanzamiento

Todos detrás de `requireUnlocked`.

| Binding | Fase | Nota |
|---|---|---|
| `SetRedisKeyTTL(connID, key, seconds)` | F1 | Rechaza 0/negativos: `EXPIRE 0` **borra** la clave en Redis |
| `PersistRedisKey(connID, key)` | F1 | Quitar el vencimiento es explícito, nunca un TTL centinela |
| `AnalyzeRedisPrefixes(connID, sep, sampleLimit, withMemory)` | F3 | Muestreo acotado por SCAN; devuelve `sampled` y `totalKeys` para que la UI no lo presente como censo |
| `DeleteRedisKeys(connID, keys)` | F3 | Chunkeado; el error informa cuántas ya se borraron |
| `GetRedisServerInfo(connID)` | F4 | Parseo de `INFO`; el frontend decide cuándo refrescar |
| `SubscribeRedisChannels(connID, monitorID, channels, patterns)` | F5 | Mensajes por evento Wails llamado `monitorID`, **en lotes** |
| `ReadRedisStream(connID, monitorID, key, fromID)` | F5 | `$` = solo lo nuevo, `0` = desde el principio |
| `StopRedisMonitor(monitorID)` | F5 | Detener uno inexistente **no** es error (la UI lo llama al desmontar) |
| `BeginRedisTransaction(connID)` | F6 | Reserva una conexión; rechaza Cluster |
| `ExecRedisTransaction(connID)` / `DiscardRedisTransaction(connID)` | F6 | Liberan la conexión reservada |
| `RedisTransactionStatus(connID)` | F6 | `{open, queued}` para el indicador |
| `CheckRedisLuaScript(connID, script)` | F6 | `SCRIPT LOAD`: compila **sin ejecutar** |
| `RunRedisLuaScript(connID, script, keys, args)` | F6 | Valida y ejecuta; se despacha por el runner de la transacción |

**Los payloads de F5 no tienen modelo TS generado.** Wails solo genera modelos para tipos que aparecen en la **firma** de un binding, y `redisquery.StreamEvent`/`StreamMessage` únicamente viajan como eventos emitidos — se espejan a mano en `RedisLiveMonitor.tsx`, igual que `Workspace.tsx` ya espeja `redisquery.Event` y `mongoquery.Event`.

**El frontend genera el `monitorID` y se suscribe al evento ANTES de llamar al backend**, misma carrera que ya evita el executor de queries: si el backend generara el id, el primer lote podría emitirse antes de que exista el listener.

**Con una transacción abierta, `ExecuteRedisCommand` encola en la conexión reservada.** No es un modo aparte: el executor rutea por `TxManager.Runner`, así que el mismo binding de siempre hace lo correcto. Cualquier binding nuevo que ejecute un comando Redis tiene que pasar por ese runner.

## Git: bindings de las 6 fases post-lanzamiento

Todos detrás de `requireUnlocked` y direccionando el repo por **ID opaco**,
nunca por path — `gitRepo(repoID)` sigue siendo el único lugar donde un ID
se convierte en una ruta.

| Binding | Fase | Nota |
|---|---|---|
| `GitLog` (campos nuevos en `LogOptions`) | F1 | `author`/`grep`/`since`/`until`; el filtro lo aplica git, no el cliente |
| `GitSetPinnedBranches(repoID, branches)` | F1 | Migración 23, `git_repos.pinned_branches`; solo nombres, ninguna credencial |
| `GitApplyPatch` (ya existía) | F2 | El patch parcial lo arma el frontend (`lib/gitPatch.ts`) |
| `GitStashDiff(repoID, ref)` | F3 | Reintenta con `--include-untracked` ante salida **vacía**, no ante error |
| `GitBlame(repoID, path, rev)` | F3 | `rev` vacío blamea el working tree |
| `GitConflictedFiles` / `GitReadConflictFile` / `GitResolveConflictFile` | F4 | Resolver **escribe y stagea** en un solo paso |
| `GitContinue(repoID, op)` | F4 | `op` es lo que reportó `GitInProgress`; nunca se adivina |
| `GitRebaseTodo` / `GitRebaseApply` | F5 | La lista va **oldest-first**, como el archivo de git |
| `GitRebase(repoID, upstream, autostash)` | post-2.2.0 | El rebase PLANO, aparte del interactivo: reaplica la rama actual sobre otra. Sin override de `core.editor` — un rebase no interactivo nunca abre editor, y ponerlo metería `-c` en `args[0]`, que es con lo que se etiqueta el error y el log |
| `GitFlowStatus` / `GitFlowInit` / `GitFlowStart(repoID, kind, name)` | post-2.2.0 | Git Flow **nativo**, sin el binario `git-flow` (no viene instalado en ninguna de las tres plataformas, así que envolverlo daría un módulo que a veces está). Escribe las mismas claves `gitflow.*`, así que la compatibilidad con el binario va en las dos direcciones. La rama de producción se resuelve mirando el repo (`main` vs `master`), no se asume. **`GitFlowStatus` cuesta 3 invocaciones de git y ninguna falla en el caso normal**, y eso es un requisito, no una casualidad: el frontend lo consulta en CADA refresco para saber si el menú dice "Inicializar" o "Nueva feature", así que preguntar clave por clave con `config --get` (que sale con 1 cuando la clave no está, o sea siempre en un repo que no usa Git Flow) metía 7 entradas rojas por refresco en el panel "Comandos ejecutados" — el mismo antipatrón que documenta `CheckoutBranch`. Se lee todo con un `config --local --list` y un `branch --list` con varios patrones. `finish` **no** está: son cuatro operaciones destructivas encadenadas y todas existen ya por separado con su confirmación |
| `GitCredentialHelper` / `GitSetCredentialHelper(repoID, helper, global)` | post-2.2.0 | El `credential.helper` de git, **aparte** del vault de la app: uno contesta "qué usa la terminal", el otro "qué manda esta app por askpass". Las opciones se filtran por `runtime.GOOS` — ofrecer `osxkeychain` en Linux deja una configuración que parece puesta y falla en el próximo fetch. Un helper no listado se reporta pero no se pisa; un helper desconocido se rechaza antes de escribir |
| `GitAbort(repoID, "rebase")` | post-2.2.0 | Faltaba: `GitAbort` aceptaba merge/cherry-pick/revert y rechazaba rebase, así que la UI escondía su propio botón de abortar para la única operación que reescribe historia |
| `GitWorktrees` / `GitAddWorktree` / `GitRemoveWorktree` / `GitPruneWorktrees` | F6 | — |
| `GitCommandLog` / `GitClearCommandLog` | F6 | Argumentos, **nunca** el entorno |
| `GitForgeInfo` / `GitOpenInBrowser` | F6 | Solo construcción de URL; `GitOpenInBrowser` restringe a http/https |
| `GitListWorkTree(repoID)` | F7 | Versionados + no rastreados **no ignorados**; sin `--exclude-standard` un repo de Node devuelve `node_modules` entero. Descuenta borrados y dedupe de conflictos (un path en conflicto sale 3 veces en `--cached`) |
| `GitReadWorkFile(repoID, path)` | F7 | Binario y "demasiado grande" se **reportan**, no se erroran — mismo contrato que `ReadSftpFileForEdit` |
| `GitWriteWorkFile(repoID, path, content, expectedModTimeUnix)` | F7 | `expectedModTimeUnix` 0 = "pisar igual". Escritura atómica, conserva permisos. Devuelve el mtime nuevo |
| `AgentDraftCommit(repoID, agentID)` | post-2.1.0 | Redacta el mensaje del commit **preparado** (`app_gitagent.go`). `agentID` vacío = agente activo de la app y, si no hay, el `default_agent` del repo. El contexto (parche recortado a 64 KB, archivos y últimos asuntos como referencia de estilo) lo arma Go, no el agente; devuelve además qué se le mandó, para poder decirlo en la UI |
| `AgentUsageLimits()` | post-2.1.0 | Porcentaje del **límite** por proveedor (`backend/agentlimits`), leído del caché que cada CLI deja en disco — no lo calcula la app. Complementa `AgentUsageAll`/`GitAgentUsage`, que miden consumo. Trae `measuredAt`: el dato es fechado, no en vivo |
| `AgentQueryLimits(agentID)` | post-2.1.0 | Le PREGUNTA el límite al CLI del agente que no lo deja en disco (hoy solo Antigravity: `agy --print "/usage" --output-format json`). Lo dispara un botón, no la apertura del panel — es un subproceso de varios segundos que además falla por red de a ratos. El resultado queda cacheado en memoria y `AgentUsageLimits` lo devuelve desde ahí |
| `GitSubmodules` / `GitAddSubmodule` / `GitUpdateSubmodules` / `GitUpdateSubmodule` / `GitSyncSubmodules` / `GitRemoveSubmodule` | post-2.2.0 | Repos anidados fijados en un commit (`backend/git/submodule.go`). `GitSubmodules` **no corre `git submodule status`** si no hay `.gitmodules`: un stat corta antes, porque no tener submódulos es el estado normal y un probe que falla llenaría de rojo el panel de comandos. `init` es un flag aparte en las dos variantes de update porque clona por red contra una URL que puede pedir credenciales, y eso tiene que ser una elección explícita. La ruta del alta es **opcional** (git usa el último tramo de la URL). `GitRemoveSubmodule` hace los tres pasos —`deinit`, `git rm` y borrar `.git/modules/<ruta>`— porque saltarse el tercero es lo que hace fallar un alta posterior del mismo submódulo; la ruta se revalida contra `.git/modules` antes de borrar nada, y es el único `RemoveAll` del paquete |
| `OpenLocalTerminalWith(sessionID, shellID, cols, rows)` | post-2.1.0 | Terminal local con un intérprete ELEGIDO, sin tocar el configurado en Configuración. `shellID` vacío = el configurado. Arranca en el home: no cuelga de ningún repositorio |
| `AppendLocalHistory` / `ListLocalHistory` / `ClearLocalHistory` | post-2.1.0 | Historial de las terminales locales, agrupado por **intérprete** y no por conexión (tabla `local_command_history`, migración 43). Mismo cifrado, mismo filtro de secretos y **mismo interruptor** (`ssh_history_enabled`) que el historial SSH |
| `SetMCPNotesWrite(enabled)` | post-2.1.0 | Permiso de ESCRITURA del servidor MCP sobre las notas (`settings.mcp_notes_write`, migración 44, nace en 0). Interruptor aparte del que enciende el servidor: apagado, `vault_create_note`/`vault_update_note`/`vault_append_to_note` **no se declaran** en el catálogo y una llamada en curso se rechaza. Editar exige además autoría del agente (`vault.AgentCanEdit` sobre el frontmatter) y pasa por `NoteForAI`, así que una nota privada tampoco se puede escribir. `MCPServerStatus` lo devuelve en `notesWrite` |
| `RenameNote(id, title)` | post-2.7.0 | Cambia solo el título, desde el menú contextual de la barra. Valida título único (`checkNoteTitleFree`, la misma regla que el alta) y emite `note:changed`, para que un editor con la nota abierta se recargue en vez de deshacer el renombre al autoguardar. No reescribe los `[[Título viejo]]` de otras notas |
| `DuplicateNote(id) → string` | post-2.7.0 | Copia cuerpo, frontmatter, carpeta, privacidad e imágenes con el título «X (copia)» / «X (copia N)». La copia nace con el `is_private` del original en el mismo INSERT (`vault.DuplicateNote`): pasar por `CreateNote` la dejaría legible para un agente hasta el `SetNotePrivacy` |
| `SetLanguage(lang)` | post-2.7.0 | Idioma de la interfaz (`'en' \| 'es'`, rechaza otro). **Sin `requireUnlocked`**, como `SetTheme`: la pantalla de desbloqueo también cambia de idioma. `GetSettings().language` lo devuelve (`''` = sin elegir → inglés). Ver `.claude/specs/i18n.md` |
| `SetNotePinned(id, pinned)` | post-2.7.0 | Fija la nota en la sección «Fijadas» de la barra (`vault_notes.pinned`, migración 55). `NoteHit.pinned` / `NoteSummary.pinned` lo devuelven por los dos caminos del buscador |
| `MergeNotes(srcID, dstID)` | post-2.7.0 | Funde src al final de dst y borra src, en una transacción. El resultado es privado si cualquiera lo era. Emite `note:removed` (`{id, mergedInto}`), `note:changed` del destino y, si el destino pasó a privado, `note:privacy` |
| `ExportNoteMarkdown(id) → string` | post-2.7.0 | Diálogo de guardado + `.md` con frontmatter y las imágenes incrustadas como `data:` URI. Devuelve la ruta, o "" si se canceló. Archivo `0600` |
| evento `note:removed` | post-2.7.0 | `{id, mergedInto?}`, desde `DeleteNote` y `MergeNotes`. El marco de pestañas cierra la de esa nota y, con `mergedInto`, abre la del destino |

**Dos funciones escriben en una ruta que nombra el frontend, y hacen cosas
distintas.**

`safeWorkingPath` (backend/git/conflict.go) valida **textualmente**: rechaza
rutas absolutas y las que se escapan con `..` después de limpiar. Alcanza para
lo que fue escrito, el resolutor de conflictos, porque ahí las rutas las
produce git (`ConflictedFiles`), no el usuario.

`editablePath` (backend/git/files.go) es la que usa el editor de archivos, y le
suma las dos guardas que la textual no da: **resuelve symlinks antes de
aprobar** —un symlink versionado que apunte a `~/.ssh/id_rsa` pasa una
comprobación de prefijo sin problema, y acá la ruta puede ser cualquiera que
el frontend pida— y **deja `.git/` afuera**, porque editar por accidente un
`config` o un hook desde un árbol de archivos rompe el repositorio o ejecuta
código en el próximo commit. Ambas cosas están cubiertas en `files_test.go`.

**`main()` despacha DOS re-exec antes de abrir la ventana**: el askpass de
`auth.go` y el sequence editor de `rebase.go`. Cualquier helper nuevo que git
tenga que re-ejecutar sigue ese mismo patrón y debe chequearse ahí, antes de
tocar el vault o appdata.

## Terminal local integrada (`backend/localterm`, `app_localterm.go`)

Shell interactiva sobre un PTY real en la máquina del usuario, expuesta hoy
en el cajón inferior de una pestaña Git (solapa "Terminal", hermana de
"Comandos ejecutados"). La forma de los bindings es **deliberadamente
idéntica** a la de `OpenSSHTerminal`/`WriteSSHTerminal`/`ResizeSSHTerminal`/
`CloseSSHTerminal`: el widget xterm.js del frontend es el mismo, y dos
contratos para el mismo stream de bytes obligarían a escribir dos veces el
decodificador base64 y el manejo de resize.

| Binding | Nota |
|---|---|
| `ListShells()` | Intérpretes del SO actual, instalados o no (`available` los distingue). Nombres y rutas de ejecutables del sistema, nada sensible |
| `DefaultShellID()` | Lo que usa `local_shell = ''`: `$SHELL` en Unix, el PowerShell más moderno instalado en Windows |
| `SetLocalShell(id)` | Migración 26, `settings.local_shell`. Sin validar contra una lista fija (mismo criterio "storage only" que `SetEditorTheme`) |
| `LocalShellLabel(id)` | Etiqueta del shell que **realmente** se abriría — el backend cae al default si el guardado no está instalado, y la barra tiene que decir la verdad |
| `OpenLocalTerminal(sessionID, repoID, cols, rows)` | `repoID` opaco, nunca una ruta — misma indirección que el resto del módulo Git. `repoID` vacío abre en el home |
| `WriteLocalTerminal` / `ResizeLocalTerminal` / `CloseLocalTerminal` | Espejo exacto de sus pares SSH |

**Todos pasan por `requireUnlocked`, sin excepción.** Una terminal local no
lee el vault, pero abre un proceso con todos los permisos del usuario: es la
superficie más potente que expone la app. La excepción documentada de
`GetSettings`/`SetTheme`/`SetUIFontScale` (punto 5 de las reglas técnicas) no aplica acá.

`sessionID` lo genera el frontend, es único por pestaña (dos pestañas del
mismo repo NO comparten shell) y es a la vez el nombre del evento de Wails:
suscribirse con `EventsOn` **antes** de llamar a `OpenLocalTerminal` evita la
carrera contra el primer chunk, mismo contrato que `ExecuteQuery`/`queryID`.

**`local_shell` guarda un id, nunca una ruta**, y `''` significa "el que ya
usa esta máquina", resuelto en cada apertura. El vault viaja entre máquinas
(backup/restore) y entre sistemas operativos: un id materializado al
configurarlo apuntaría a un shell que la otra máquina no tiene.

### Layout persistido de la pestaña Git (migración 27)

| Binding | Nota |
|---|---|
| `SetGitLayout(dock, size, tab, sideHidden, diffHidden)` | Un solo UPDATE para los cinco campos, mismo criterio que `GitSetPaneWidths`: se ajustan desde la misma pantalla y guardarlos por separado deja un layout a medio escribir |
| `SetTerminalFontSize(px)` | Compartido por la terminal local y las SSH — es el mismo widget |

**`SetGitLayout` sanea en vez de rechazar.** Lo escribe la UI en cada
arrastre y cada clic; devolver un error se traduciría en "el panel no se
guarda" sin que nada lo explique. Un `dock` desconocido —un vault escrito por
una versión más nueva— cae a `bottom`, que toda instalación entiende.

**El panel se mueve entre anclajes con CSS, nunca cambiando de lugar en el
árbol de React.** Está en `position:absolute` sobre el cuerpo de la pestaña y
el área principal le hace lugar con un margen. Si en cambio fuera un hermano
en el flujo, cambiar de dock lo movería de padre, React desmontaría el
subárbol y eso **mataría la shell** — el mismo motivo por el que el panel
sigue montado (oculto por CSS) cuando se cierra.

### Agentes de código (`backend/agents`, migración 28)

| Binding | Nota |
|---|---|
| `ListAgents()` | Catálogo resuelto contra la máquina y la config. **Nunca** la API key, solo `hasKey` — misma regla que `SSHKeySummary` con el material de la llave |
| `SetAgentCommand(agentID, command)` | Vacío restaura el default del catálogo |
| `SetAgentKey(agentID, apiKey)` / `ClearAgentKey(agentID)` | AES-GCM bajo la clave maestra, mismo esquema que `encrypted_dsn` y `ssh_keys` |
| `OpenAgentSession(sessionID, repoID, agentID, cols, rows, runCommand)` | Abre una sesión de `localterm` con el agente adentro. `runCommand=false` la abre sin arrancarlo |
| `SetGitPanelSessions(sessions)` | Qué sesiones tenía abiertas el panel (intención, no procesos) |
| `GitAgentContext(repoID)` | Skills/subagentes/comandos/instrucciones que ve el repo (`backend/agentctx`). Solo lectura; informa también los archivos de instrucciones **ausentes**, que es la mitad útil de la respuesta |
| `GitMCPConfig(repoID)` | Servidores MCP por agente y scope (`backend/mcpconf`). **Los valores de `env` NO cruzan, solo sus nombres** — misma regla que el DSN (punto 9), aplicada a una credencial que esta app ni siquiera administra. Informa también dónde miró y qué archivo está roto |
| `AgentChatSupported(agentID)` | Si hay adaptador **verificado** (`backend/agentchat`). La UI ofrece el chat solo donde funciona; duplicar la lista en el frontend se desincronizaría |
| `AgentPlans()` | Plan de cada agente (`backend/agentplan`). Del JWT de Codex se extrae **solo** el claim del plan; el token nunca cruza |
| `AgentModelCatalog(agentID)` | Modelos y esfuerzos que informa cada CLI (`backend/agentmodels`), no una lista escrita a mano |
| `AgentChatHistory(agentID, conversationID)` | Mensajes de una conversación anterior. Lee primero los que guardó la app (`AgentChatMessages`, ubicando el chat por su id de conversación) y, si el chat no tiene ninguno, el transcript del CLI (Claude Code, Codex y Antigravity). Vacío NO es error: una conversación borrada desde el propio CLI abre en blanco y sigue encadenando |
| `AgentChatMessages(chatID)` | Historial genérico guardado en el vault (migración 58) para cualquier proveedor: `{seq, role: user\|assistant\|tool, content, toolName, usage?, attachments, createdAt}` (`attachments`: ver «Adjuntos del chat»). Dentro de un turno las herramientas van antes de la respuesta; un error del turno es una fila `assistant` con `content` que empieza con `⚠ `. Se guarda lo que se escribió, sin expandir las `@referencias` |
| `ModelServerUsage(days)` | Consumo de los servidores de modelos desde el historial (`days <= 0` = 30). `{days, firstDay, lastDay, servers: [{agentId: 'llm:<id>', name, kind, isLocal, deleted, totals: {input, output, total, turns, conversations}, byModel: [{model, totals, percent, tokensPerSec}], byDay: [{day: 'YYYY-MM-DD' local, total, turns}] (todos los días, con ceros), tokensPerSec (0 = no se sabe), lastUsedAt (segundos Unix, 0 = ninguno)}]}`. Sin costo: un servidor no informa precio. `model: ''` = turnos anteriores a que se guardara el modelo. Cada turno se atribuye al proveedor que lo atendió (`agentId` del usage), no al agente actual del chat |
| `SetAgentChatAgent(chatID, agentID)` | Pasa un chat `llm:` a otro servidor de modelos (cambia `agent_chats.agent_id` y **vacía `model`**; `effort`/`mode` se conservan). Falla con error i18n si: el chat no existe, el agente actual o el destino no son `llm:` (un chat con CLI no se reasigna), el destino no existe o está desactivado. Mismo proveedor = no-op. Llamarlo **antes** del siguiente `SendAgentChat` con el id nuevo; la memoria de la sesión se conserva y el consumo ya hecho queda con el proveedor que lo produjo (`agentchat.Usage.agentId`, nuevo, opcional) |
| `SearchAgentChats(query)` | Chats (`vault.AgentChat`) cuyo título o mensajes contienen todas las palabras, sin acentos ni mayúsculas, más recientes primero (máx. 200). Descifra y filtra en Go. Consulta vacía → lista vacía |
| `SaveChatAttachment(name, dataBase64)` | Guarda una **imagen** pegada/subida FUERA del repositorio y devuelve su ruta. Se conserva por compatibilidad; para cualquier adjunto usar `SaveChatFile` («Adjuntos del chat», abajo) |
| `AgentChatModes(agentID)` | Modos de permisos que soporta ESE agente, de menos a más permisivo. No son los mismos para todos (`auto` es solo de Claude Code) |
| `SendAgentChat(sessionID, repoID, agentID, prompt, mode, effort, model)` | Vuelve enseguida; la respuesta llega como `agentchat.Event` en el evento de Wails llamado `sessionID`. **Suscribirse ANTES**, misma carrera que la terminal y las queries. `agentchat.Event` NO está en `wailsjs/go/models` —viaja por evento, no por retorno— así que el frontend lo espeja a mano en `AgentChat.tsx`, igual que `LocalTermEvent` |
| `AskAgentOnce(repoID, agentID, prompt)` | Un turno de **una sola vez que devuelve el texto**, para las acciones agénticas del módulo Git (redactar el commit). Sin conversación ni estado; `agentchat.Ask` **rechaza los modos que editan**, así que un botón nunca puede tocar archivos. Con tope de tiempo: bloquea un formulario |
| `CancelAgentChat(sessionID)` / `ResetAgentChat(sessionID)` | Cortar el turno / olvidar la conversación (también borra los mensajes guardados de ese chat; la entrada del historial queda) |
| `GitAgentUsage(repoID, days)` | Consumo de tokens por agente (`backend/agentusage`), total y atribuido al repo. Los porcentajes son **proporciones de lo consumido, nunca fracciones del límite de un plan** (ese dato no existe en disco). Solo Claude Code tiene lector verificado; los demás devuelven `available:false` con nota |

**Adjuntos del chat** (spec `ia-ollama-chat-utilidades` → «Adjuntos del chat (fase 8)»; migración 64). Todos exigen la bóveda desbloqueada.

| Contrato | Detalle |
| --- | --- |
| `SaveChatFile(name, dataBase64) → agentchat.Attachment` | `dataBase64` acepta base64 pelado o data URL. `{path, name, kind, mime, size}`: `path` es absoluta (dentro de `<datos>/adjuntos/`), `name` el nombre original saneado, `kind` `"image"\|"pdf"\|"text"\|"other"` (en la práctica nunca `other`: se rechaza), `mime` p. ej. `image/png`, `application/pdf`, `text/plain`, `application/json`, `size` en bytes. El tipo sale del **contenido**, no del nombre. Rechaza con error legible: binario desconocido, imagen que no sea PNG/JPG/GIF/WebP, texto que no sea UTF-8, vacío, y sobre el tope (imagen 5 MB · PDF 32 MB · texto 512 KB). Los adjuntos de más de 24 h se borran solos |
| `AgentAttachmentCapabilities(agentID, model) → agentchat.AttachmentCaps` | `{images, pdf, text: bool, known: bool, maxImageBytes, maxPdfBytes, maxTextBytes: number, maxCount: number, note: string}`. `model` vacío = el del proveedor (para un CLI se ignora). `known=true`: lo informó el proveedor; `false`: es una suposición y un «no» **no bloquea** (la UI avisa pero deja enviar). `text` es siempre `true`. `note` está en el idioma de la app y explica el porqué (modelo sin visión, PDF no soportado…); puede ir vacía. Puede tardar (consulta HTTP al proveedor, cacheada 10 min en Go): llamarla al elegir agente/modelo, no por tecla. Agente desconocido o proveedor apagado → error. **Si cambia el modelo hay que volver a pedirla** |
| `SendAgentChat(..., images)` | `images` lleva **las rutas de TODOS los adjuntos** (imágenes, PDF y texto; el nombre quedó por compatibilidad), tal como las devolvió `SaveChatFile`/`SaveChatAttachment`. Rutas fuera de la carpeta de adjuntos, borradas o que ya no cumplan los topes → error y el turno **no** empieza (sin eventos ni fila de chat). Más de 10 → error. Un PDF a un destino que no lo lee, o una imagen a un modelo con `known=true && !images` → error nombrando `proveedor · modelo`. Mensaje vacío con adjuntos → «Revisá los archivos adjuntos.» |
| `AgentChatMessage.attachments` | `{name, kind, size}[]` — **siempre una lista** (vacía si no hubo). Solo las filas `user` tienen. Nunca trae contenido ni rutas: para dibujar chips. En `content` va únicamente lo que escribió la persona (sin el texto de los archivos, que se pega en el turno pero no se guarda) |
| `PastTurn.attachments` | Mismo `{name, kind, size}[]`, **opcional** (`attachments?`): `AgentChatHistory` lo trae en los turnos `role:"user"` cuando salen del vault; los transcripts de los CLIs no lo tienen |
| Adjuntos y turnos siguientes | Un adjunto no se reenvía después del turno en que se mandó (solo sus nombres, como texto). Si la conversación necesita volver a ver una imagen o PDF, la UI tiene que volver a adjuntarlo |
| Tipos TS | `agentchat.Attachment`, `agentchat.AttachmentCaps`, `agentchat.AttachmentMeta` en `wailsjs/go/models` |

**Servidores de modelos (`llm:<id>`) con herramientas** (spec `ia-ollama-chat-utilidades`, fases 4 y 5):

| Contrato | Detalle |
| --- | --- |
| `ModelServer.isLocal` | `true` si el host de `baseUrl` es de loopback (`localhost`, `127.x`, `::1`, `0.0.0.0`). Lo calcula Go; no se guarda. Un servidor remoto lo dice también en la `Note` del agente. Para advertir antes de usar herramientas de archivos |
| `AgentChatModes("llm:<id>")` | Siempre `["", "plan", "approve", "edit", "auto"]`: la aprobación de un servidor de modelos es en proceso y no depende del canal de los CLIs |
| `SendAgentChat(..., module, contextId, ...)` con `llm:` | Respeta `mode`. Herramientas del turno = MCP (si el servidor MCP está encendido; mismo catálogo y auditoría que el puente) + archivos/comandos si hay raíz de trabajo. Raíz: `module "git"` con `contextId` = id de repo, o `module "utilities"` con `contextId` = id del repo elegido, o **`ws:<id>` de una carpeta de trabajo en cualquier módulo** (si no es un proyecto conocido o la carpeta ya no existe, no hay herramientas de archivos y el cwd es el de consultas) |
| Modos → herramientas | `""`/`plan`: `read_file`, `list_dir`, `search`, `glob` (y `skill`/`read_skill_file` si hay skills). `approve`: + `write_file`, `edit_file`, `run_command`, y las tres preguntan cada vez. `edit`: escritura sin preguntar, comandos preguntan. `auto`: todo sin preguntar salvo la lista de riesgo (`workspace.Risk`), que pregunta en todos los modos |
| Eventos `tool` | Mismo `agentchat.Event{kind:"tool", tool:{name,input,summary,detail}}` que los CLIs, emitido antes de ejecutar. `summary` = ruta / comando / patrón / título; `detail` = «N líneas» en escrituras |
| `agent-approval` | Mismo evento y mismo `RespondAgentApproval(id, allow, reason)` que el canal de los CLIs; los ids de estas preguntas empiezan con `llm-approve-`. Vence a los 5 min (deniega) y también al cancelar el turno |
| `agent-approval-dismiss` | **Nuevo.** Payload: el `id` (string) de una pregunta que ya no espera respuesta (turno cancelado o plazo vencido). La UI puede cerrar su diálogo; responder tarde se ignora de todos modos |
| Aviso «sin herramientas» | Si el servidor rechaza las herramientas («does not support tools»), el turno sigue sin ellas y se emite **una línea `text`** en cursiva (`_⚠ …_`) al comienzo de la respuesta, una vez por sesión y modelo |

**Proyectos, carpetas, instrucciones y skills** (spec `ia-ollama-chat-utilidades` → «Proyectos y carpetas, instrucciones y skills (estilo OpenCode)»; migración 61). Todos pasan por `requireUnlocked`:

```go
type AgentWorkspace struct {          // solo CARPETAS; los repos git siguen viniendo de GitListRepos
    ID     string `json:"id"`
    Name   string `json:"name"`
    Path   string `json:"path"`
    IsGit  bool   `json:"isGit"`      // la carpeta tiene .git
    Exists bool   `json:"exists"`     // sigue en el disco (si no, se lista igual para poder quitarla)
}
type WorkspaceContextInfo struct {
    Root         string                     `json:"root"`         // ruta real; "" si el chat no tiene proyecto
    IsGit        bool                       `json:"isGit"`
    Branch       string                     `json:"branch"`       // "" si no es repo; "HEAD@abc1234" si está desacoplado
    Instructions []agentctx.InstructionInfo `json:"instructions"` // siempre arreglo
    Skills       []agentctx.SkillInfo       `json:"skills"`       // siempre arreglo
    TotalChars   int                        `json:"totalChars"`   // caracteres de instrucciones que entraron (tope 32000)
}
// agentctx.InstructionInfo: {path, scope, chars, truncated}   path relativo a la raíz, o "~/…" si es global
// agentctx.SkillInfo:       {name, description, scope, path}  path del SKILL.md, relativo o "~/…"
// scope: "project" | "global"
```

| Contrato | Detalle |
| --- | --- |
| `ListAgentWorkspaces()` | Carpetas registradas, en el orden en que se agregaron |
| `PickAgentWorkspaceFolder()` | Diálogo nativo de carpeta. `""` si se cancela. No valida ni guarda |
| `AddAgentWorkspace(path, name)` | `path` absoluta, existente y carpeta. Rechaza (error i18n con el motivo) la raíz del disco, el home y cualquier ancestro del home («demasiado amplia»). Idempotente: la misma carpeta (ruta limpia o real) devuelve la ya registrada. `name` vacío = nombre de la carpeta (máx. 80) |
| `RemoveAgentWorkspace(id)` | La quita **y borra sus chats y mensajes** (`context_id = "ws:<id>"`), como un repo. No toca el disco |
| `contextId` | `<id de repo>` (módulos `git`/`utilities`) o `ws:<id>` (cualquier módulo). Es lo que se manda en `SendAgentChat`, `CreateAgentChat`, `AgentWorkspaceContext`… |
| `AgentWorkspaceContext(module, contextId)` | Qué se le pasa al modelo del proyecto, sin texto. Sin proyecto → todo vacío (`instructions: []`, `skills: []`), no error. Las instrucciones omitidas por el tope viajan con `chars: 0, truncated: true` |
| `AgentChatModes("llm:<id>")` | **No cambia** y no depende del contexto: `["", "plan", "approve", "edit", "auto"]` |
| Herramientas nuevas | `glob(pattern, path?)`, `skill(name)`, `read_skill_file(skill, path, start_line?, end_line?)`; eventos `tool` con `summary` = patrón / nombre del skill / `skill/ruta` |

**Servidores remotos: chequeo previo, cabeceras y TLS** (spec `ia-ollama-chat-utilidades` → «Servidores remotos»; migración 60):

| Contrato | Detalle |
| --- | --- |
| `SaveModelServer(s, token, clearToken, headers, replaceHeaders)` | `headers` es `Record<string,string>` (nombre → valor). `replaceHeaders=false` conserva las guardadas e ignora `headers`; `true` las reemplaza (`{}` = borrar todas). `s.insecureTls` se guarda. Rechaza nombres inválidos o reservados (`Host`, `Content-Length`, `Content-Type`, `Accept`, `Transfer-Encoding`, `Connection`…), valores con saltos de línea, más de 20 cabeceras y `Authorization` si el servidor queda con token |
| `TestModelServer(kind, baseUrl, token, serverId, insecureTls, headers)` | Con `serverId` y `token == ""` usa el token guardado; con `serverId` y `headers == null` usa las guardadas (un `{}` explícito prueba sin cabeceras). `insecureTls` es el del formulario. Los fallos van en `error`, no como excepción |
| `ModelServerHealth(id)` | Devuelve `ModelServerProbe`. Usa el caché de chequeos (30 s); vencido, hace uno nuevo con 4 s de plazo. Un servidor caído o un id inexistente viajan en `error` con `ok:false`, no como excepción. Los fallos no se cachean |
| `ModelServer.insecureTls` / `headerNames` | `insecureTls`: no verificar el certificado de ese servidor. `headerNames`: solo nombres, siempre arreglo (nunca `null`); los valores no cruzan nunca hacia el frontend, igual que el token |
| `ModelServerProbe.latencyMs` / `checkedAt` | Lo que tardó el chequeo (ms) y cuándo se hizo (unix ms); con el caché, `checkedAt` dice cuán vieja es la respuesta. `models` es siempre arreglo |
| `ModelServer.contextTokens` (migración 62) | Ventana de contexto que se le pide a Ollama (`options.num_ctx` en `/api/chat`). `0` = la del servidor (no se manda `options`). Solo vale para `kind: "ollama"`: en un servidor OpenAI se guarda siempre 0. `SaveModelServer` lo persiste (un negativo queda en 0; el tope es 4 194 304). Un Ollama nuevo arranca en 16384 desde el formulario. Si el prompt estimado (caracteres / 4) la supera, el turno emite **una línea `text`** `_⚠ …_` por sesión sugiriendo subirla (mismo mecanismo que el aviso «sin herramientas»); no bloquea nada |
| `ModelServerModels(serverId)` | `llm.ManagedModel[]`: `{name, size, modifiedAt, digest, family, parameterSize, quantizationLevel, format}`. En un servidor OpenAI devuelve la lista de `/models` con los campos que no informa vacíos; Anthropic, la de `/v1/models` con `modifiedAt` = fecha de creación |
| `ModelServerRunning(serverId)` | `llm.RunningModel[]`: `{name, size, sizeVram, expiresAt, contextLength}` (modelos cargados en memoria). Lista vacía —no error— si el servidor no lo informa (OpenAI) |
| `ModelServerShowModel(serverId, model)` | `llm.ModelDetails`: `{name, family, parameterSize, quantizationLevel, format, parameters, template, license, contextLength, capabilities}`. `contextLength` es la ventana con la que se entrenó (0 = no se sabe). Solo Ollama |
| `ModelServerPull(serverId, model)` | Devuelve el `pullId` (string) y descarga en segundo plano; no se corta al cerrar la pestaña. Solo Ollama. Progreso por el evento de Wails **`model-pull:<pullId>`** con un `ModelPullEvent` `{pullId, serverId, model, status, completed, total, percent, done, error, cancelled, startedAt}` (máx. ~10 por segundo; `percent` 0..100 no retrocede; el último trae `done: true`, con `error` vacío y `cancelled` falso si terminó bien) |
| `ModelServerPulls()` | `ModelPullEvent[]` con el último estado de las descargas en curso y de las terminadas hace menos de 10 min (para quien abre la pestaña después) |
| `ModelServerCancelPull(pullId)` / `ModelServerDismissPull(pullId)` | Corta una descarga en curso (lo ya bajado queda en el servidor) / olvida una terminada |
| `ModelServerDeleteModel(serverId, model)` / `ModelServerUnload(serverId, model)` | Borra el modelo del disco del servidor / lo descarga de la memoria sin borrarlo. Solo Ollama; ambos invalidan el caché de salud. En un servidor OpenAI devuelven un `UnsupportedError` con el motivo (la interfaz ya esconde las acciones: Utilidades → Modelos es **solo lectura** para OpenAI) |

**Proveedores de IA estilo Hermes** (spec `ia-ollama-chat-utilidades` → «Proveedores de IA (estilo Hermes)»; migración 63):

| Contrato | Detalle |
| --- | --- |
| `ModelServer.kind` | `"ollama"` · `"openai"` · `"anthropic"`. `SaveModelServer`/`TestModelServer` aceptan `anthropic`; cualquier otro valor se rechaza. El vendor del catálogo de agentes es `"Ollama"`, `"OpenAI-compatible"` o `"Anthropic"` (los nombres de las APIs alojadas —OpenRouter, Groq…— son presets del frontend por URL base) |
| `ModelServer.baseUrl` (Anthropic) | Vacío al guardar = `https://api.anthropic.com`; un `/v1` final se quita. `TestModelServer("anthropic", "", token, …)` también usa la oficial |
| `ModelServer.enabled` (bool) | `true` por defecto. **`SaveModelServer` lo ignora**: se cambia con `SetModelServerEnabled`. Un proveedor apagado sigue en `ListModelServers` pero **no** en `ListAgents` (ni en los selectores ni en `AgentAsk*`); un chat que lo usaba falla con «el proveedor «X» está desactivado…» (los tres caminos: `SendAgentChat`, `AgentAskWith`, `AskAgentOnce`) |
| `ModelServer.defaultModel` (string) | Modelo para un turno sin modelo. **`SaveModelServer` lo persiste** (se recorta). Resolución: el del turno → `defaultModel` → el propio del cliente (Anthropic: `claude-opus-5-5`) → el primero que liste el servidor. El ítem «Por defecto» de `AgentModelCatalog("llm:<id>")` lo nombra en su `description` |
| `ModelServer.sortOrder` (int) | Posición en la lista. **`SaveModelServer` lo ignora**: se cambia con `ReorderModelServers`. `ListModelServers` ordena por `sortOrder` y, a igualdad, por nombre; un alta va al final |
| `SetModelServerEnabled(id string, enabled bool) error` | Prende o apaga. `requireUnlocked`. Error si el id no existe. No toca `updatedAt` ni el caché de salud |
| `ReorderModelServers(ids []string) error` | Fija el orden: los ids dados, en ese orden, y detrás los no mencionados en el orden que ya tenían. Ids repetidos o desconocidos se ignoran. `requireUnlocked` |
| Anthropic: salud y administración | Sin endpoint de versión: `ModelServerProbe.version == ""`; `TestModelServer` y `ModelServerHealth` usan la lista de modelos. `ModelServerModels` lista (`name`, `modifiedAt`; el resto vacío); `ModelServerRunning`/`ShowModel`/`Pull`/`DeleteModel`/`Unload` devuelven `UnsupportedError` («Anthropic»): Utilidades → Modelos es solo lectura, igual que OpenAI |
| `agentchat.Usage.cacheWrite` | Tokens escritos en la caché del prompt (Anthropic). `input` ya incluye `cacheRead` y `cacheWrite`; `thinking` es la parte de `output` que fue razonamiento |
| `ModelUsageTotals.cacheRead` / `cacheWrite` | Suma de los tokens de caché del prompt (parte de `input`; 0 en los proveedores que no la informan y en turnos anteriores). `ModelServerUsage.kind` puede ser `"anthropic"` |
| Eventos del chat con Anthropic | Mismos que cualquier `llm:`: `start` (con el `model` real), `thinking` (resumen del razonamiento, `display: "summarized"`), `text`, `tool`, `done` (con `usage`), `error`. Un refusal llega como `error` («Anthropic rechazó este pedido por sus filtros de seguridad (categoría: …)») |
| Evento `window` `mini-tools:models-changed` | `{serverId}`. Lo publica Utilidades → Modelos tras bajar o borrar un modelo (`frontend/src/lib/modelsChanged.ts`). Los selectores de modelo del chat (`AiChatTab`, `AgentChat`) relean `AgentModelCatalog` si el `serverId` coincide con el agente `llm:<serverId>` elegido |
| Error de `SendAgentChat` / `AgentAsk*` / `AskAgentOnce` con `llm:` | Si el servidor no responde al chequeo previo (4 s), la llamada **devuelve el error** y el turno no empieza: ni eventos ni fila de chat. Texto: `No se pudo usar el servidor «nombre» (host:puerto): <causa>. Revisá que esté encendido y accesible desde esta máquina.` (un fallo de certificado lleva en su lugar la sugerencia «Aceptar certificado autofirmado») |
| Tope de vueltas | 25 por turno (`agentchat.DefaultToolRounds`). Al llegar: evento `error` con el motivo y `usage` acumulado; lo ya hecho queda hecho |
| `AgentAsk*` / `AskAgentOnce` | **Sin herramientas** a propósito: los botones de un turno son de solo texto y rápidos |

**Cerebro: escritura automática de notas** (spec `ia-ollama-chat-utilidades`, fase 6; migración 59):

```go
type BrainStatus struct {
    MCPEnabled bool   `json:"mcpEnabled"` // servidor MCP encendido
    NotesWrite bool   `json:"notesWrite"` // mcpNotesWrite activo
    Root       string `json:"root"`       // carpeta raíz (default "Cerebro")
}
func (a *App) BrainStatus() (BrainStatus, error)
func (a *App) GetBrainRoot() (string, error)
func (a *App) SetBrainRoot(root string) error                   // "" vuelve a "Cerebro"
func (a *App) SetAgentChatBrain(chatID string, enabled bool) error
// vault.AgentChat gana:  Brain bool `json:"brain"`  (ListAgentChats, ListAllAgentChats, SearchAgentChats)
```

| Contrato | Detalle |
| --- | --- |
| `SetBrainRoot(root)` | Nombre (`Cerebro`) o ruta (`Notas/Cerebro`). Se guarda canónica (segmentos recortados, separados por `/`). Rechaza segmentos vacíos, `.`, `..`, caracteres de control, >80 caracteres por nivel y >8 niveles (`vault.ErrBadFolderPath`). Vive en `settings.brain_root`, pero **no** está en `vault.Settings`: solo por estos dos bindings. Las notas ya escritas no se mueven |
| `SetAgentChatBrain(chatID, enabled)` | Encender **falla** con un error i18n claro si el servidor MCP está apagado o si `mcpNotesWrite` está apagado; apagar nunca falla. **No exige que el chat exista**: sin fila en `agent_chats` el pedido queda en memoria y se persiste (`agent_chats.brain`) al terminar el primer `SendAgentChat` que crea la fila. Con fila, se guarda de inmediato y no toca `updated_at`. La UI puede llamarlo antes del primer envío |
| `AgentChat.brain` | Lo que recuerda la conversación (per-chat, nace en `false`). Es la bandera guardada: si después se revoca un permiso global, `brain` sigue en `true` pero el turno **deja de llevar las instrucciones** (el cerebro efectivo = bandera ∧ MCP encendido ∧ `mcpNotesWrite`). Para explicarlo: `BrainStatus()` |
| `BrainStatus()` | Estado de los dos permisos globales y la raíz, para explicar por qué el control está deshabilitado y a qué carpeta escribe |
| Instrucciones por turno | Con el cerebro efectivo encendido, `SendAgentChat` agrega el texto del cerebro (es/en según el idioma de la app): `llm:*` → `Turn.System`; `claude` → `--append-system-prompt` (el mismo valor que el idioma de respuesta, detrás de él); `codex`/`antigravity` → antepuesto al prompt que recibe el CLI. **El historial guarda solo lo que escribió el usuario** |
| Proyecto vs. tema | `module git` / `utilities` con `contextId` = id de un repo conocido → proyecto = nombre del repo; `db` / `ssh` con `contextId` = id o alias de conexión → proyecto = alias; cualquier otro (o recurso borrado) → tema. Una `/` o `\` del nombre se cambia por `-` para no partir la ruta. Carpeta: `<root>/Proyectos/<proyecto>` o `<root>/Temas/<tema>` (el tema lo elige el agente) |

**Herramientas de notas del MCP** (puente MCP y `CallTool` de los `llm:*`; la escritura solo se declara con `mcpNotesWrite`):

| Herramienta | Argumentos | Devuelve / regla |
| --- | --- | --- |
| `vault_search_notes` | `query` (req.), `folder?`, `tag?` | Hasta 10: `- título — carpeta — #tags` + fragmento. `folder` = esa carpeta y sus descendientes; `tag` sin `#`. `tag:x` dentro del texto vale como filtro. Carpeta inexistente → mensaje (no error) que remite a `vault_list_folders` |
| `vault_read_note` | `title` (req.) | Cabecera (`Título`, `Carpeta`, `Etiquetas`, `Actualizada`, `Enlaza a`, `Enlazada desde`, y con escritura habilitada `Escrita por`) + `---` + Markdown. Los enlaces listan solo títulos de notas **no privadas**; un enlace a una nota inexistente se marca |
| `vault_list_folders` | — | Carpetas de notas como rutas con `N notas (T con subcarpetas)` y la raíz. **Solo cuentan y solo aparecen carpetas con notas visibles**: una carpeta con solo notas privadas (o vacía) no se lista |
| `vault_list_notes` | `folder?`, `recursive?` | Títulos alfabéticos con etiquetas y fecha (máx. 100). Sin `folder`: notas sueltas de la raíz; con `recursive` y sin `folder`: toda la base. Solo no privadas |
| `vault_create_note` | `title`, `content`, `folder?` | `folder` = ruta; crea las que falten (scope `note`). Rechaza traversal/segmentos vacíos y un título repetido **antes** de crear carpetas |
| `vault_append_to_note` | `title`, `content`, `heading?` | **Nueva.** Agrega una sección (`## heading` opcional) al final de una nota que creó un agente y el usuario no editó (`vault.AgentCanEdit`); privadas fuera (misma puerta `NoteForAI`); reindexa enlaces; el resultado no puede pasar de 64 KB |
| `vault_update_note` | `title`, `content` | Sin cambios de regla |

Etiquetas (`vault.NoteTags`): `#tag` en el cuerpo (fuera de bloques y código en línea) o en el frontmatter, y la clave `tags:` (`[a, b]`, `a, b` o lista `- a`); sin distinguir tildes ni mayúsculas.

**La API key entra por el ENTORNO del proceso, nunca por la línea de
comandos** — ahí quedaría visible en `ps` para cualquier proceso de la
máquina y en el historial del shell. `vault.AgentKey` no tiene binding: solo
la lee `app.go` para armar ese entorno.

**El agente corre DENTRO del shell, no en lugar del shell.**
`localterm.OpenWith` escribe el comando en el PTY como si lo hubiera tecleado
el usuario, tras una espera corta (un shell interactivo todavía está armando
su prompt cuando `Shell()` retorna, y escribir antes hace que se vea el eco a
medias). Así, cuando el agente termina, queda la terminal viva en el mismo
directorio en lugar de una sesión muerta.

**Un agente nunca se relanza al restaurar el layout** (`runCommand=false`):
consume cuota, y arrancarlo tiene que ser un clic, no un efecto de reabrir la
app.

**Lo que esta app NO hace: gestionar las cuentas de los agentes.** Cada CLI
maneja su propio login y guarda sus credenciales donde decida. Leerlas,
replicarlas o interceptarlas sería frágil y una responsabilidad que nadie
pidió — la única credencial que la app guarda es la API key opcional de
arriba, para quien usa el modo por variable de entorno.


## Utilidades: Port Killer y Activity Monitor (`backend/portkill`, `backend/procmon`, `app_utilities.go`)

Módulo **Utilidades** de la barra lateral: una lista de herramientas, cada una se
abre en su propia pestaña (`kind: 'utility'`, una sola por herramienta). Hoy hay
dos. Todos los métodos pasan por `requireUnlocked`: terminar un proceso es una
acción con los permisos del usuario sobre la máquina entera, la misma razón por
la que la terminal local está detrás de la clave maestra.

| Método | Nota |
|---|---|
| `ListListeningPorts()` → `[]portkill.Listener` | Puertos TCP en escucha: `port`, `address`, `pid`, `process`, `protected`. Ordenados por puerto. `process` vacío = el SO no lo reveló. `protected` marca lo que no se ofrece terminar (pid ≤ 1, procesos del sistema de Windows, esta misma app, no identificados) |
| `KillProcess(pid, force)` → `bool` | Termina con los permisos de la app. `force=false` = SIGTERM, `true` = SIGKILL; **en Windows ambos son TerminateProcess**. Devuelve si el proceso ya había salido a los 2 s (un servidor puede atrapar SIGTERM: ahí la UI ofrece Forzar) |
| `KillProcessElevated(pid, force)` → `bool` | Lo mismo pidiendo permisos de administrador al SO (`osascript` / `pkexec` / `Start-Process -Verb RunAs`). Tope de 2 min para que el usuario responda. **Solo se llama después de que `KillProcess` respondió `permission` y el usuario lo confirmó** |

| `ProcessSnapshot()` → `procmon.Snapshot` | Procesos (`pid`, `ppid`, `name`, `user`, `cpu`, `memory`, `protected`) + totales (`cpuTotal` 0-100, `memUsed`/`memTotal`, `netRx`/`netTx` en bytes/s, `cores`, `hasUser`, `me`). `cpu` es el % de UN núcleo (200 = dos núcleos). **Un % de CPU son dos lecturas**: el `Sampler` guarda la anterior; la primera llamada (o la primera tras un reset) toma dos lecturas con 400 ms de por medio, así que tarda ese tiempo. Una lectura anterior de más de 30 s se descarta |
| `StopProcessMonitor()` | Suelta la lectura anterior del `Sampler`. La pestaña lo llama al salir de la vista o cerrarse: con la utilidad fuera de pantalla el backend no retiene nada |

`KillProcess`/`KillProcessElevated` los usan las dos utilidades (el Port Killer
por el puerto, el Activity Monitor por la lista de procesos): terminan por pid y
no saben de dónde viene.

**Qué lee `procmon` en cada sistema** (sin cgo ni dependencias nuevas): macOS
`ps` (tiempo de CPU acumulado, de donde sale el % instantáneo), `vm_stat`,
`sysctl hw.memsize` y `netstat -ib`; Linux `/proc` (`stat`, `meminfo`,
`net/dev`); Windows Toolhelp32 + `GetProcessTimes` + `GetProcessMemoryInfo` +
`GlobalMemoryStatusEx` + `netstat -e`. **No hay disco ni red por proceso**
(no existen sin privilegios ni de forma portable) y en Windows los procesos no
traen dueño (`hasUser=false`: la UI oculta la columna y el filtro «Míos»).

Errores con código (`i18n.NewCoded`, el frontend los lee con `errorCode()`):
`protected`, `permission`, `not-found`, `elevation-denied`, `no-tool`.

`portkill.Listener` aparece en `models.ts` porque está en la firma de
`ListListeningPorts`; no hay tipo espejo a mano.

**Costo cero con la pestaña cerrada.** No hay goroutines ni caché en el
backend: cada llamada es un `lsof`/`ss`/`netstat` que arranca y termina. El
temporizador de refresco vive en el efecto de `PortKillerTab`, solo corre con la
pestaña a la vista y la ventana visible, y la pestaña se carga con `React.lazy`.

**Costo cero también en el Activity Monitor**: el temporizador vive en el efecto
de `ActivityMonitorTab`, corre solo con la pestaña a la vista y la ventana
visible, y el historial de los gráficos (60 puntos) vive en el componente.

**Cómo se agrega otra utilidad**: id e ícono en `components/utilities/utilities.ts`,
sus textos en `utilities.tools.<id>` (es/ y en/), el componente de su pestaña
cargado con `lazy` y montado en el bloque `kind === 'utility'` de `Workspace.tsx`
y, si necesita backend, un paquete en `backend/` con sus bindings en
`app_utilities.go`.

## Utilidades: Docker (`backend/dockerctl`, `app_docker.go`)

Tercera utilidad del módulo. Todos los métodos pasan por `requireUnlocked`: operar
contenedores es una acción sobre la máquina entera. Habla con la CLI `docker`, no
con el socket (ver `architecture.md`).

| Método | Nota |
|---|---|
| `DockerStatus()` → `dockerctl.Status` | `installed`, `path`, `version`, `serverVersion`, `running`, `context`, `error`, `launcher`. **No es un error de API** que Docker no esté instalado o no responda: viaja en el estado y la UI decide qué mostrar |
| `DockerStartApp()` | Abre Docker Desktop / OrbStack / Rancher Desktop (macOS) o Docker Desktop (Windows). En Linux devuelve `no-launcher`: el motor es un servicio del sistema |
| `DockerContainers()` / `DockerImages()` / `DockerVolumes()` / `DockerNetworks()` | Listados. Los contenedores traen `project`/`service` (etiquetas de Compose) y vienen ordenados por proyecto, con los sueltos al final. Imágenes y volúmenes traen cuántos contenedores los usan |
| `DockerStats()` → `[]dockerctl.Stat` | CPU y memoria de los que corren. **Aparte de la lista** porque `docker stats` muestrea ~2 s. La clave es el id CORTO (12), no el completo |
| `DockerAction(op, ids)` → `string` | `op` es de una lista cerrada (`container.start|stop|restart|pause|unpause|kill|remove`, `image.remove`, `volume.remove`, `network.remove`). **La UI manda el nombre de la operación, nunca una línea de comandos.** Los ids se validan (`bad-id`) |
| `DockerInspect(kind, id)` → `string` | JSON de `docker <kind> inspect`, ya indentado |
| `DockerLogsStart(sessionID, containerID, tail)` | Abre `docker logs -f` y vuelve. Las líneas llegan por el evento de Wails llamado `sessionID` como `{lines: string[], end: bool, error: string}`, agrupadas cada 100 ms. **Suscribirse ANTES** (misma carrera que las terminales). `LogEvent` NO está en `models.ts`: viaja por evento, el frontend lo espeja en `DockerLogs.tsx`. `tail` se acota a 1-5000 |
| `DockerLogsStop(sessionID)` | Termina el flujo. También lo termina `shutdown` (`dockerLogs.CloseAll`) |

| `DockerCompose(op, project)` → `string` | `op` ∈ `up`/`down`/`stop`/`start`/`restart`. **Los archivos NO los manda la interfaz**: el backend los lee de las etiquetas (`com.docker.compose.project.working_dir` / `config_files`) de los contenedores del proyecto, así solo se puede volver a operar lo que ya existe. `down` conserva los volúmenes (sin `-v`). `up` tiene tope de 15 min, el resto 3 |
| `DockerPickComposeFile()` → `string` | Diálogo nativo para elegir un `.yml`/`.yaml`. Vacío si se cancela |
| `DockerComposeUpFile(path)` → `string` | `docker compose -f path up -d` de un proyecto NUEVO. Valida ruta absoluta, extensión y que exista |
| `DockerCounts()` → `dockerctl.Counts` | Totales de contenedores, imágenes, volúmenes, redes y builds para los contadores del submenú de la barra lateral. Solo ids (`-q`) y en paralelo (~250 ms). **-1 = no se pudo contar** (p. ej. builds sin buildx nuevo): la UI no muestra número. Se pide con cada actualización de la pestaña, solo con la pestaña a la vista |
| `DockerBuilds()` → `[]dockerctl.Build` | Historial de `docker buildx history ls`. `ref` es el id corto: con la ruta `builder/ctx/id` que informa `ls`, `logs` responde «no record found». Sin buildx ≥ 0.20 devuelve `no-buildx` |
| `DockerBuildLogs(ref)` → `{text, truncated}` | Log de un build para mostrar. Tope de 2 MB: si pasa, se conserva el FINAL (ahí está el error) |
| `DockerExportContainerLogs(id, name, lines)` / `DockerExportBuildLogs(ref, name, lines)` / `DockerSaveText(name, content, lines)` → `{path, bytes, lines}` | Abren el diálogo de guardado (nombre sugerido `<slug>-<tipo>-AAAAMMDD-HHMMSS.log`, en Descargas si existe) y escriben. **`path` vacío = el usuario canceló.** **`lines` se acota a 100-10000 en el backend** (`dockerctl.ClampExportLines`), aunque la interfaz ya lo acote: es el backend quien decide cuánto se escribe a disco. Se exportan las ÚLTIMAS `lines` (`docker logs --tail`; para builds, que no tienen `--tail`, se recorta el log leído). El contenedor se transmite a disco sin pasar por memoria. `lines` en el resultado es lo que se escribió de verdad, que puede ser menos que el límite. Archivo con permisos 0600; si falla a mitad se borra |

Errores con código: `not-installed`, `bad-id`, `bad-op`, `no-launcher`, `bad-project`, `no-project`, `bad-compose-file`, `no-buildx`.

**La sección de Docker la elige el submenú de la barra lateral, no la pestaña.** `Workspace.tsx` guarda `dockerSection` y se lo pasa a `DockerTab` (`section`); la pestaña informa los totales con `onCounts` y el submenú los muestra (null mientras la pestaña no está abierta). `UtilitiesTree` dibuja el submenú con la misma `TreeRow` que Git; las secciones viven en `components/utilities/docker/sections.ts`.

**La entrada «Docker» de la lista de Utilidades se deshabilita** (con el motivo) si `DockerStatus` dice que no está instalado o que el motor no responde. `Workspace.tsx` comprueba solo mientras esa lista está a la vista, cada 10 s mientras no sirve, y de nuevo al hacer clic en la entrada. Un error de la propia consulta NO la deshabilita: no es lo mismo que Docker apagado.

**Cada apertura del flujo de logs usa un `sessionID` nuevo.** Reabrir con el mismo
nombre (cambiar el `tail`, reanudar) hacía que el aviso de cierre del flujo VIEJO
—que llega después de pedir su cierre— se leyera como el cierre del nuevo y lo
dejara en pausa.

**Costo cero con la pestaña cerrada**: la lista se actualiza solo con la pestaña a la vista;
el único proceso que queda abierto es el `docker logs -f` del panel de logs, y se termina al cerrarlo.
