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
| `HttpHistory` / `HttpClearHistory` | Tope de 50 por ítem, **no global**: quien depura corre la misma petición veinte veces y un tope global le borraría el historial de todas las demás. La URL se archiva con los parámetros que parecen secretos reemplazados por `***` |
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

Cinco bindings: `HttpImportPostman`, `HttpExportPostman`, `HttpImportCurl`,
`HttpCodeLanguages`, `HttpGenerateCode`.

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
| `SetMCPNotesWrite(enabled)` | post-2.1.0 | Permiso de ESCRITURA del servidor MCP sobre las notas (`settings.mcp_notes_write`, migración 44, nace en 0). Interruptor aparte del que enciende el servidor: apagado, `vault_create_note`/`vault_update_note` **no se declaran** en el catálogo y una llamada en curso se rechaza. Editar exige además autoría del agente (`vault.AgentCanEdit` sobre el frontmatter) y pasa por `NoteForAI`, así que una nota privada tampoco se puede escribir. `MCPServerStatus` lo devuelve en `notesWrite` |

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
| `AgentChatHistory(agentID, conversationID)` | Mensajes de una conversación anterior, leídos del transcript del CLI (Claude Code, Codex y Antigravity). Vacío NO es error: una conversación borrada desde el propio CLI abre en blanco y sigue encadenando |
| `SaveChatAttachment(name, dataBase64)` | Guarda una imagen pegada/subida FUERA del repositorio y devuelve su ruta |
| `AgentChatModes(agentID)` | Modos de permisos que soporta ESE agente, de menos a más permisivo. No son los mismos para todos (`auto` es solo de Claude Code) |
| `SendAgentChat(sessionID, repoID, agentID, prompt, mode, effort, model)` | Vuelve enseguida; la respuesta llega como `agentchat.Event` en el evento de Wails llamado `sessionID`. **Suscribirse ANTES**, misma carrera que la terminal y las queries. `agentchat.Event` NO está en `wailsjs/go/models` —viaja por evento, no por retorno— así que el frontend lo espeja a mano en `AgentChat.tsx`, igual que `LocalTermEvent` |
| `AskAgentOnce(repoID, agentID, prompt)` | Un turno de **una sola vez que devuelve el texto**, para las acciones agénticas del módulo Git (redactar el commit). Sin conversación ni estado; `agentchat.Ask` **rechaza los modos que editan**, así que un botón nunca puede tocar archivos. Con tope de tiempo: bloquea un formulario |
| `CancelAgentChat(sessionID)` / `ResetAgentChat(sessionID)` | Cortar el turno / olvidar la conversación |
| `GitAgentUsage(repoID, days)` | Consumo de tokens por agente (`backend/agentusage`), total y atribuido al repo. Los porcentajes son **proporciones de lo consumido, nunca fracciones del límite de un plan** (ese dato no existe en disco). Solo Claude Code tiene lector verificado; los demás devuelven `available:false` con nota |

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
