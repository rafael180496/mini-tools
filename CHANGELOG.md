# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versionado: [SemVer](https://semver.org/), fuente de verdad en [VERSION](VERSION).

## [Unreleased]

## [0.2.2] - 2026-07-15

### Cambiado

- "Abrir"/"Recientes" pasan de la barra de herramientas por-pestaña a la franja de tabs, como acciones globales — antes se repetían idénticas arriba de cada pestaña aunque no dependen de cuál esté activa.
- Rediseño visual de la fila de acciones (Guardar/Ejecutar/Bloque/Cancelar/Explain/Explain Analyze/Refrescar) y de la fila de conectividad (conexión, schema, transacción, DBMS_OUTPUT): agrupadas en clusters con separadores y pills con color de fondo para el estado activo, en vez de una fila plana de botones sin jerarquía visual.
- "+ Nueva pestaña" vuelve a estar pegado a la franja de tabs — es la acción de mayor uso ahí, y había quedado detrás del cluster Abrir/Recientes tras el reordenamiento anterior.

### Quitado

- Botón "Regenerar CLAUDE.md" del toolbar del editor — no se usaba en la práctica; la generación automática de `CLAUDE.md` al abrir o guardar un archivo sigue funcionando igual.

### Corregido

- El splitter de SQL interpretaba mal el `END` de una expresión `CASE` (sin el sufijo `CASE`) como si cerrara un bloque `BEGIN`/`IF`/`LOOP`, fragmentando scripts PL/SQL grandes en decenas de statements inválidos — causaba errores `ORA-00900` en procedures válidos, y explicaba también el síntoma de "Cancelar no responde": no era un bug del cancelado, sino la ejecución en cadena de decenas de fragmentos rotos.
- Un módulo de sidebar expandido con poco contenido (p. ej. un par de carpetas SSH) se estiraba para ocupar toda la altura restante del sidebar en vez de ajustarse a su propio contenido, empujando el header del siguiente módulo detrás de un hueco vacío — en 0.2.1 se había corregido el mismo síntoma solo para el estado colapsado; este era el caso expandido.
- `RecentFilesMenu` se recortaba verticalmente al abrirse cerca del borde de la franja de tabs (`overflow-x-auto` fuerza el otro eje a comportarse como `overflow: auto` también) — ahora se renderiza en un portal con posición fija, mismo patrón que `MoveToFolderMenu`.

## [0.2.1] - 2026-07-15

### Agregado

- **Módulo SSH**, como quinto tipo de conexión: auth por password o private key (+ passphrase opcional) más Agent Forwarding, con Test Connection antes de guardar — igual que los motores de base de datos, guardar nunca depende de un ping exitoso.
- **Terminal interactiva real (xterm.js)** por conexión SSH: se abre en una pestaña (dedup por conexión — reabrir enfoca la misma pestaña en vez de duplicarla), streaming de la sesión remota vía PTY, resize automático, y la sesión se corta al cerrar la pestaña.
- **SSH tiene su propio módulo de sidebar**, separado de "Conexiones" — mismo patrón de acordeón colapsable y árbol de carpetas (crear/renombrar/mover/reordenar), pero con un árbol de carpetas completamente independiente del de conexiones de base de datos: una carpeta SSH y una de base de datos nunca comparten contenido aunque tengan el mismo nombre.
- Crear una conexión desde el módulo SSH abre el diálogo ya bloqueado en tipo SSH (sin el selector de motor ni el textbox de pegar connection string, que no aplican a un tipo fijo).

### Corregido

- `Exportar configuración (sin password)` de una conexión SSH exponía en texto plano el password, la private key completa y la passphrase en el archivo exportado — esos campos viajan en el query string del DSN (no en el userinfo de la URL, a diferencia de los demás motores) y no se estaban redactando ahí.
- Editar una conexión SSH y cambiar el método de auth (password → key o viceversa) con el campo nuevo vacío arrastraba la credencial del método anterior al DSN reconstruido en vez de dejarlo vacío.
- Un módulo de sidebar colapsado (p. ej. "Conexiones" con el módulo SSH agregado al lado) seguía reservando la mitad de la altura del sidebar como espacio vacío en vez de reducirse a solo su header — los dos módulos ahora se apilan de forma compacta, como un árbol.

## [0.2.0] - 2026-07-14

### Agregado

- **Redis como cuarto motor**, a la par de Oracle/PostgreSQL/SQLite: conexión Standalone/Cluster/Sentinel, usuario ACL, TLS, índice de base (0-15), autocompletado de comandos y de keys ya escaneadas, linter que confirma antes de correr `FLUSHALL`/`FLUSHDB`.
- **Redis Browser**: botón "Abrir en pestaña" en cualquier conexión Redis (o doble click a una key en el árbol) abre un explorador de keys en modo ventana completa — filtro por tipo con badges de color, buscador por patrón, stats de header (total de keys / memoria usada), selección múltiple con exportación masiva a JSON o CSV. El panel de detalle de cada key es editable: string y JSON con edición del valor completo (preservando el TTL existente), hash/list/set/zset con alta, edición y borrado por campo/elemento/miembro — streams quedan de solo lectura.
- **RediSearch y RedisJSON de primera clase**: autocompletado de `FT.SEARCH`/`FT.AGGREGATE`/`JSON.*` en el editor de comandos, resultados de búsqueda mostrados en tabla estructurada en vez de texto crudo.
- **Scanner de objetos de esquema**: además de tablas, se escanean procedures, functions y triggers (PostgreSQL, Oracle) y packages (Oracle), agrupados en categorías colapsables dentro de cada schema en el árbol de conexiones. Un click abre su DDL actual (`DBMS_METADATA.GET_DDL` / `pg_get_functiondef` / `pg_get_triggerdef`) en un visor con **syntax highlighting real vía CodeMirror** (mismo tema que el editor principal), botón de copiar y de exportar a archivo `.sql`.
- **Categoría "Tablas" colapsable** dentro de cada schema, con las tablas siempre ordenadas alfabéticamente — antes era una lista plana sin poder ocultarla, inmanejable en esquemas con cientos de tablas (probado con un schema real de 342).
- **Buscador transversal**: el filtro de objetos dentro de una conexión expandida ahora también busca procedures/functions/triggers/packages, no solo tablas, auto-expandiendo la categoría que tenga una coincidencia.
- **Folders + módulos de sidebar**: las conexiones guardadas se organizan en carpetas (crear/renombrar/mover/reordenar); "Conexiones" pasa a ser un módulo de acordeón colapsable en el sidebar, dejando espacio para futuros módulos.
- `scripts/package-windows.sh` — cross-compila `build/bin/mini-tools-vX.Y.Z-windows-amd64.exe` con `wails build -platform windows/amd64` desde macOS/Linux (ninguno de los conectores usa CGO, no hace falta toolchain de Windows). Portable, sin instalador NSIS ni firma Authenticode. **No verificado todavía en una Windows real** — ver [releases/windows/README.md](releases/windows/README.md).
- `scripts/package-all.sh` — orquesta `package-macos.sh` + `package-windows.sh` en una sola pasada; a partir de ahora es el default al preparar una versión nueva (ver [.claude/specs/releases.md](.claude/specs/releases.md)).

### Corregido

- Sincronizar el esquema activo (botón de sync por-schema) borraba en silencio los procedures/functions/triggers/packages ya escaneados de ese schema — el merge solo reasignaba las tablas.
- Una conexión sincronizada antes de esta versión servía su metadata cacheada en disco indefinidamente sin los nuevos procedures/functions/triggers/packages, incluso después de actualizar la app — el cache ahora versiona su formato y fuerza un refetch en vivo la primera vez que hace falta.

## [0.1.1] - 2026-07-10

### Agregado

- Ícono real por motor de conexión (Oracle/PostgreSQL/SQLite) y color de etiqueta personalizable por conexión, elegible al crear o editar — de un vistazo distinguís cuál conexión es cuál sin leer el nombre.
- Guardar una conexión (crear o editar) ya no depende de que Test Connection haya sido exitoso — se puede guardar aunque el servidor no responda ahora mismo; Test Connection sigue disponible como verificación opcional aparte.
- Tabs del editor reordenables por drag-and-drop (`@dnd-kit`) — antes el orden era fijo, el único orden posible era el de apertura.
- Borrado individual de una entrada del historial de ejecuciones, además del borrado completo ya existente.
- Modal de Configuración (ícono de engranaje en el toolbar) que agrupa "Backup vault" y "Recordar clave" — antes sueltos en la barra de herramientas principal.
- Exportar DDL del esquema activo movido del toolbar del editor al árbol de conexiones, como opción de la conexión seleccionada (junto a Editar/Exportar config/Elegir esquemas/Desconectar).
- `scripts/rebuild.sh` — corre `clean.sh` + `build.sh` en un solo paso para iterar más rápido.
- `ConfirmDialog.tsx`, modal de confirmación genérico y temado — reemplaza los `window.confirm()` nativos, poco visibles dentro del webview de Wails.
- Backup/restore del vault ahora piden la clave maestra: se verifica contra el propio archivo de backup (no contra la instalación local) antes de tocar cualquier archivo real, así una clave incorrecta falla limpio en vez de dejar un vault restaurado pero inaccesible.
- Selector de esquemas al crear una conexión Postgres: después de un Test Connection exitoso, elegís qué esquemas escanear antes de guardar (además del selector ya existente desde el árbol de conexiones).
- Autocompletado consciente del contexto SQL: tablas después de `FROM`/`INSERT INTO`/`UPDATE`, columnas acotadas a las tablas referenciadas después de `SELECT`/`WHERE`/`SET`, resolución de alias y de `esquema.`/`tabla.` al tipear un punto.
- Transacciones explícitas: auto-commit como checkbox, botones Commit/Rollback siempre visibles (deshabilitados cuando no aplican).
- Editar conexiones existentes desde el árbol de conexiones.
- Restauración automática de las pestañas del editor abiertas al cerrar la app.
- Pegar una connection string (URL de Postgres, Easy Connect/SID/TNS de Oracle, JDBC, o ruta SQLite) autocompleta el formulario de conexión.
- Selección de fila en el grid de resultados, con copiar como texto, `INSERT` o `UPDATE`.
- Árbol de conexiones colapsable a una barra de solo íconos, buscador de tablas/esquema, y layout (sidebar, alto del editor) persistido entre sesiones.
- Indicadores de carga al cambiar de conexión/esquema.
- Tooltips en cada control interactivo de la app.
- Rediseño completo de la interfaz (Material Design 3): paleta clara/oscura derivada consistentemente, tipografías e íconos empaquetados con la app (sin depender de internet).
- `CLAUDE.md` generado ahora se puede acotar al esquema activo, y pide confirmación antes de regenerar (sobreescribe archivos existentes).

### Corregido

- El botón "Borrar historial" no parecía funcionar: usaba `window.confirm()` nativo, fácil de pasar por alto dentro del webview — reemplazado por un modal propio de la app.
- `SELECT *` ya no bloqueaba la ejecución con una confirmación — ahora es solo una marca visual, igual que cualquier otro warning de estilo.
- El grid de resultados mostraba un área blanca desbordada cuando había demasiadas columnas para el ancho de la ventana.

## [0.1.0] - 2026-07-07

Primera versión versionada del proyecto.

### Agregado

- Archivo `VERSION` como fuente única de la versión de la app.
- `scripts/package-macos.sh` — empaqueta `build/bin/mini-tools.app` en un `.dmg` sin firmar, solo local (sin publicación automática).
- `scripts/bump-version.sh` — bumpea `VERSION` (`patch`/`minor`/`major`).
- Framework de migraciones del vault (`backend/vault/migrations.go`, tabla `schema_migrations`) — sin migraciones reales todavía, listo para futuros cambios de schema retrocompatibles. Ver [.claude/specs/vault-migrations.md](.claude/specs/vault-migrations.md).
