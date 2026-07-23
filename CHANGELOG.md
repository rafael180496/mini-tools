# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versionado: [SemVer](https://semver.org/), fuente de verdad en [VERSION](VERSION).

## [Unreleased]

## [0.5.1] - 2026-07-22

### Agregado

- **Abrir / Nuevo / Clonar en el módulo Git**: el botón `+` del sidebar (y una pantalla inicial cuando el módulo está vacío) ofrece las tres formas de sumar un repositorio — **abrir** uno que ya existe en disco, **crear** uno nuevo (`git init` en una carpeta elegida), o **clonar** desde una URL. El diálogo de clonar deriva el nombre de la carpeta del URL y usa automáticamente el token guardado del host para repos privados.
- **Soporte de SQLite cifrada con SQLCipher** (solo lectura): toggle "Base cifrada (SQLCipher)" + campo de clave en el diálogo de conexión SQLite. Detecta automáticamente SQLCipher 3 y 4, acepta passphrase o clave raw (`x'…'`), y "Test Connection" verifica la clave antes de guardar. **Sin cgo** — el driver clásico de SQLCipher lo requiere y está prohibido por la regla técnica (rompería el cross-compile de Windows desde Mac); en su lugar se descifra en Go puro (solo stdlib: PBKDF2 + AES-256-CBC) a una copia temporal de solo lectura que abre el `modernc.org/sqlite` normal, borrada al cerrar la conexión. La clave viaja cifrada en el DSN del vault, nunca en texto plano ni al frontend. Cripto verificada byte a byte contra el CLI real de SQLCipher 4.17.
- **Selector de archivo + auto-detección de cifrado en SQLite**: botón "Elegir…" que abre el diálogo nativo del SO (filtrado a `.db/.sqlite/.sqlite3/.db3`) en vez de tener que tipear la ruta. Al elegir (o escribir) un archivo, la app detecta sola si está cifrado con SQLCipher —leyendo solo los primeros 16 bytes, un archivo SQLite normal empieza con `SQLite format 3\0` y uno cifrado no— y prende el toggle de cifrado en consecuencia.

## [0.5.0] - 2026-07-22

### Agregado

- **Módulo Git**: cliente Git integrado, estilo Sublime Merge, como tercer módulo del sidebar junto a Conexiones y SSH. Se agrega un repositorio que ya existe en disco (si elegís una subcarpeta, registra el repositorio completo) y doble-click lo abre en su propia pestaña. Cada repositorio se expande en el sidebar mostrando **ramas, remotos, tags y stashes**, cargados solo al expandirlo. Click derecho sobre un remoto: fetch, renombrar, cambiar URL, copiar URL y eliminar.
- **Pestaña de repositorio en tres paneles**: a la izquierda el conmutador Commits/Cambios más la lista de ramas (doble-click hace checkout); al centro el **grafo de commits** con carriles de colores, badges de rama/tag y marca de HEAD; a la derecha el detalle del commit (autor, fecha, hash, padres), sus archivos con `+/−` por archivo, y el **visor de diff**. La pestaña conserva su estado al cambiar de pestaña —commit elegido, archivo, scroll— igual que las de SSH y SFTP.
- **Vista de cambios y commit**: lista de archivos staged y sin stagear con su código de estado de git explicado en el tooltip, stage/unstage por archivo o todo junto, descarte de cambios (con confirmación que aclara que no queda en el reflog) y caja de mensaje para commitear.
- **Menús de operaciones remotas** con las variantes completas y una explicación al lado de cada una: `fetch` (`--all`, `--tags`, `--prune`), `pull` (`--ff-only`, `--rebase`, `--rebase --autostash`) y `push` (`--set-upstream`, `--tags`, `--force-with-lease`, `--force`, `--no-verify`, estas tres marcadas como destructivas).
- **Visor de diff con dos modos, sin dependencias nuevas**: *unificado* sobre CodeMirror 6 (líneas agregadas/borradas y cabeceras de hunk coloreadas con los tokens del tema, sigue claro/oscuro) y *lado a lado*, que reagrupa el mismo parche en dos columnas alineadas — una corrida de borrados seguida de una de agregados se empareja línea a línea, así una línea modificada se lee como modificación y no como un borrado suelto más un agregado suelto; el lado más corto se rellena para que las columnas no se desalineen. Los archivos binarios se avisan como tales en vez de intentar mostrarse como texto.
- **Menús contextuales (click derecho) en todo el árbol**:
  - *Ramas locales*: checkout, merge en la rama actual, renombrar, set/unset upstream, copiar nombre, borrar.
  - *Ramas remotas*: checkout, copiar, borrar en el servidor.
  - *Commits*: crear rama acá, crear tag acá (con mensaje opcional → tag anotado), checkout del commit, revert, cherry-pick, copiar hash, y los tres resets (`--soft`, `--mixed`, `--hard`) listados por separado, de menos a más destructivo.
  - *Tags*: crear rama desde el tag, checkout, copiar, push, borrar local y borrar de origin como acciones **separadas**.
  - *Stashes*: aplicar, pop, descartar.
- **Salida de conflictos**: si el repositorio queda a medio merge, cherry-pick o revert, aparece un aviso con botón para abortar y volver al estado anterior — sin eso, un conflicto dejaba al usuario sin salida dentro de la app.
- **Configuración de Git por repositorio** (ícono de engranaje en la barra de la pestaña), con dos secciones:
  - *Identidad*: muestra arriba de todo **qué nombre y email va a llevar tu próximo commit y de dónde sale** — si el repositorio tiene identidad propia o está heredando la global. Esa distinción es justamente la causa habitual de "¿por qué este commit quedó con el email equivocado?". Se edita eligiendo explícitamente el alcance: solo este repositorio (`.git/config`) o global (`~/.gitconfig`). Vaciar un campo **borra** la clave en vez de guardarla en blanco, así el repo vuelve a heredar el valor global — guardar un email vacío produce commits que todos los forges rechazan.
  - *Tokens*: guarda un Personal Access Token **por servidor** (un token de github.com sirve para todos tus repos de ahí, no hay que repetirlo por proyecto). Se puede pegar la URL completa del repo: se normaliza al host, incluyendo formas `git@host:owner/repo` y URLs que ya traen un token embebido.
- **Los tokens guardados se usan solos**: fetch, pull, push, push de tags y borrado de ramas/tags remotos resuelven la credencial mirando el host del remoto. Si no hay ninguna guardada, git sigue resolviendo como siempre (llavero del sistema, credential helper, ssh-agent) — no guardar nada es una opción válida, no un error.
- Los diálogos destructivos explican qué se pierde y qué no: `reset --hard` aclara que lo no commiteado no queda en el reflog; borrar un tag distingue local de remoto; borrar una rama remota aclara que borra en el servidor, no tu copia.
- **Carpetas para organizar los repositorios Git**, igual que en Conexiones y SSH: botón de nueva carpeta en el header del módulo, carpetas anidables con contador, y "mover a carpeta" por repo. Reutiliza la tabla `folders` compartida con un scope nuevo (`'git'`), independiente de los árboles de DB/SSH aunque compartan nombre. Eliminar una carpeta reubica sus repos a la contenedora, nunca los quita ni borra nada del disco.
- **Visor de diff configurable**, persistido en el vault: líneas de contexto (git `-U`, ± en la barra), *ignorar espacios* (`-w`, para cuando un reformateo tapa el cambio real) y ajuste de línea. Al seleccionar un commit se auto-selecciona su primer archivo, así el diff aparece de una en vez de dejar el panel vacío.
- **Paneles de la pestaña Git redimensionables**, con el ancho guardado (arrastre de las divisiones izquierda/derecha). El arrastre escucha en `window` para no cortarse al salir de la franja, guarda solo al soltar, y clampea el ancho en el backend para que un panel arrastrado a cero no quede inutilizable tras reiniciar.
- **`git status` en vivo**: mientras la pestaña Git está activa y la ventana enfocada, relee el estado del working tree cada pocos segundos, así los cambios hechos por fuera de la app (editar un archivo en otro editor) se reflejan en el contador "Cambios (N)" —ahora con badge de color— sin tocar Refrescar. Solo status, nunca el grafo, así no parpadea; pausado cuando la ventana no tiene foco.
- **"Ocultar rama" en el menú de commit**, para sacar ramas ruidosas del grafo sin borrarlas (un chip "N ocultas" en la barra las restaura), y **"Agregar remoto"** desde el header de REMOTOS del sidebar.
- **Estados de carga con spinner y color** (historial, diff, detalle del sidebar, "ejecutando git …"), consistentes con el resto de la app en vez del texto gris apagado anterior.

### Notas técnicas

- El motor es el **binario `git` del sistema vía `os/exec`, no `go-git`**: cero dependencias nuevas (el binario pasó de 47.2 a 47.5 MB, todo frontend), y el `git` del sistema ya resuelve credential helpers del SO, ssh-agent y PATs —que `go-git` no cubre— correctamente en cada plataforma. A cambio, requiere git instalado: el módulo lo detecta al arrancar y muestra un estado degradado explícito en vez de fallar operación por operación.
- Un token **nunca** viaja por la línea de comandos ni por la URL del remote. `GIT_ASKPASS`/`SSH_ASKPASS` apuntan al propio binario de mini-tools re-ejecutado, que responde el prompt y sale.
- Las URLs de remoto se **redactan** antes de llegar al frontend: un remote configurado como `https://<token>@github.com/...` guarda el PAT en texto plano en `.git/config`, y mostrarlo pondría la credencial en la UI. La única excepción es "Copiar URL", donde el valor real es lo que se pidió.
- `vault.db` migración 18: tabla `git_repos` con rutas y nombres únicamente, sin credenciales. Quitar un repositorio del sidebar no toca nada en disco.
- `vault.db` migración 19: tabla `git_credentials`. A diferencia de `git_repos`, esta **sí** guarda un secreto, así que el token va cifrado a nivel de columna con AES-256-GCM (`encrypted_token` + `nonce`), el mismo esquema que `connections.encrypted_dsn`. Verificado en un vault sandboxeado: el token no aparece en texto plano en el archivo. El struct que cruza al frontend no tiene campo de token — solo host y usuario.
- `vault.db` migraciones 20 y 21: anchos de los paneles de la pestaña Git (`git_side_width`/`git_diff_width`, clampeados) y preferencias del visor de diff (`git_diff_context`/`git_diff_ignore_ws`/`git_diff_wrap`). Todas aditivas, con DEFAULT que preserva el layout previo.
- El módulo Git sumó apenas ~0.3 MB al binario (de 47.2 a 47.5 MB), casi todo frontend — la decisión de `exec` sobre `go-git` mantiene `go.mod` sin dependencias nuevas. Medición 0.5.0: macOS `arm64` ~19 MB (`.dmg`), Windows `amd64` ~51 MB (`.exe`), lejos del techo de 80 MB.

### Corregido

- **Pantalla en blanco al abrir un repositorio / desplegar el árbol Git.** Varias funciones del backend devolvían slices `nil` de Go, que cruzan el binding como `null` en JS; el primer `.map` sobre uno de ellos tiraba abajo todo el árbol de React sin ningún mensaje. Ahora ninguna devuelve `nil` (siempre `[]`), con defensas `?? []` en el frontend y un *error boundary* alrededor del módulo Git para que un fallo de un panel no se lleve toda la app.
- **El diff no se veía al seleccionar un commit.** Bug de flexbox anidado: la raíz de la pestaña no tenía `min-w-0`, así que no encogía y empujaba el panel de diff (520 px, fijo) fuera de la ventana, donde el `overflow-hidden` lo recortaba. Con `min-w-0` en la cadena de flex el panel queda siempre dentro (verificado midiendo el layout headless).
- **Diff obsoleto tras descartar/rollback un archivo.** El working tree quedaba limpio pero el panel seguía mostrando el diff viejo. Ahora, en la vista de Cambios, cuando el estado cambia se revalida la selección: si el archivo ya no tiene cambios se limpia el diff, y si sigue teniéndolos se refresca en silencio (sin parpadeo).
- `SchemaObjectsList.tsx` usaba el ícono `inventory_2`, que no existe en el subset de Material Symbols que embebe la app y por lo tanto se renderizaba como texto roto. (Detectado al validar los íconos del módulo Git contra la fuente; **el ícono en sí sigue sin corregirse** — se documenta acá para que no se pierda.)

## [0.4.0] - 2026-07-22

### Agregado

- **Motor MongoDB**: soporte completo como base documental, en un path nativo paralelo (igual que Redis, no pasa por `database/sql`) usando el driver oficial `go.mongodb.org/mongo-driver/v2`. La conexión acepta la forma estándar (`mongodb://`, con host único o lista de hosts para replica set) o SRV/Atlas (`mongodb+srv://`), con usuario/contraseña/authSource/replicaSet/TLS opcionales; el diálogo también reconoce una URI pegada. El árbol lateral navega **todas las bases de datos → colecciones (con conteo aproximado) → índices**, como Compass. Nuevo lenguaje **mongosh** en el editor: se escribe `db.coleccion.find({ ... })` y demás métodos (find/findOne/aggregate/insert/update/delete/count/distinct/createIndex/getIndexes…), con autocompletado de colecciones, métodos y operadores `$`. El parser es tolerante a la sintaxis real de mongosh — claves sin comillas, comillas simples y helpers `ObjectId(...)`, `ISODate(...)`, `NumberLong(...)`, etc.— así que pegar una consulta de Compass funciona.
- **Vista de resultados JSON con color para MongoDB**: cada comando muestra sus documentos como JSON coloreado y colapsable, con los tipos de Mongo (`ObjectId`, fechas, números largos) renderizados de forma legible como en Compass; se exportan a CSV/JSON/XLSX igual que el resto.
- **Explorador de documentos MongoDB**: doble-click en una colección abre una pestaña con la lista paginada de documentos, filtro por Extended JSON, y edición o borrado de un documento (por su `_id`). Además un **asistente visual de búsqueda (find)** que arma la consulta con campo/operador/valor, proyección, orden y límite —pensado para quien no conoce el lenguaje de MongoDB— y la inserta en el editor o la ejecuta. Los índices de cada colección se muestran en el árbol.
- **Motor SQL Server (Transact-SQL)**: cuarto motor relacional de primera clase, junto a PostgreSQL/Oracle/SQLite. Usa el driver oficial de Microsoft `github.com/microsoft/go-mssqldb` (pure-Go, sin cgo, sobre `database/sql` como el resto), autenticación SQL Server (usuario/contraseña). El diálogo de conexión suma sus campos: host/puerto (1433 por defecto), instancia con nombre opcional (la resuelve el SQL Server Browser, por eso ignora el puerto), base de datos, modo de encriptación (`disable`/`false`/`true`/`strict`) y "confiar en el certificado del servidor". El pegado de connection string reconoce las formas `sqlserver://`/`mssql://`, JDBC (`jdbc:sqlserver://…`) y ADO/.NET (`Server=…;Database=…;User Id=…`). Autocompletado y resaltado con el dialecto T-SQL real de CodeMirror; el árbol del sidebar lista tablas/columnas/PK/FK, procedimientos, funciones y triggers, con selector de esquemas (por defecto `dbo`). Doble-click en una tabla genera `SELECT TOP 100`.
- **T-SQL en el editor**: el separador de lotes `GO` (solo en su propia línea, con conteo opcional `GO 5`) se respeta como frontera de statement, igual que `sqlcmd`/SSMS — nunca se envía al servidor. Un bloque `BEGIN…END` se ejecuta como un único lote (preserva el scope de variables `DECLARE @x`). Las transacciones explícitas (Auto-commit off / Commit / Rollback) usan `BEGIN TRANSACTION`. También hay exportación de DDL (reconstrucción de `CREATE TABLE` desde `INFORMATION_SCHEMA` y `OBJECT_DEFINITION` para procedimientos/funciones/triggers), plan de ejecución estimado (`SET SHOWPLAN_ALL`), y convenciones T-SQL en el `CLAUDE.md` generado. Nota: la integración se verificó por inspección de código y pruebas de la lógica pura (DSN, redacción de contraseña, split de `GO`), pero aún no contra una instancia SQL Server real.
- **Auto-guardado de los editores**: nuevo toggle en Configuración → Preferencias que, activado, guarda automáticamente a disco las pestañas con archivo asociado cada tantos segundos (elegible: 5s a 10min). Las pestañas nuevas sin guardar no se tocan (no aparece ningún diálogo). El guardado manual con Ctrl+S sigue igual.
- **Autocompletado inteligente en la terminal SSH**: sugerencia "fantasma" en gris del comando más reciente del historial de la sesión que coincide con lo que estás tipeando (estilo fish/warp); Tab o → la acepta. Reconstruye la línea del lado del cliente y es conservador — si no puede seguir la línea con confianza (completado del shell con Tab, historial con ↑/↓), no sugiere nada en vez de sugerir mal. El historial es solo en memoria de la sesión (no se persiste, por seguridad).
- **Funciones SQL en el autocompletado**: el editor ahora sugiere las funciones incorporadas de cada motor (COUNT/COALESCE genéricas, más NVL/DECODE/TO_CHAR de Oracle, GETDATE/ISNULL de SQL Server, NOW/DATE_TRUNC de Postgres, STRFTIME/IFNULL de SQLite, etc.), además de las tablas/columnas/keywords que ya sugería.

### Mejorado

- **Build de Windows verificado en Windows real**: hasta ahora el `.exe` se cross-compilaba desde macOS y se publicaba con la advertencia de que nadie lo había corrido en una Windows de verdad. Esta versión se probó en **Windows 10 y Windows 11**: arranca sin instalar el WebView2 Runtime aparte, con DPI scaling y diálogos nativos correctos. La advertencia se retiró de la documentación; sigue sin firma Authenticode, así que SmartScreen avisa igual en el primer arranque.
- **UI de MongoDB**: selector de base de datos activa en la barra de herramientas (se ve y se cambia a qué base apunta `db.` sin tener que expandir el árbol); botón para refrescar bases/colecciones/índices en el árbol; en los resultados, un toggle para ver los documentos como JSON con color o como tabla, más un buscador que filtra los documentos por texto; y el editor de documentos ahora tiene resaltado de sintaxis JSON con validación en vivo (el botón Guardar se deshabilita si el JSON es inválido) en vez del textarea plano.

## [0.3.0] - 2026-07-20

### Agregado

- **Backup automático del vault**: nuevo toggle en Configuración → Preferencias que, activado, guarda una copia del vault cada 1 a 23 horas (elegible con un select) en una carpeta elegida con el picker nativo de carpetas — cada corrida reemplaza el archivo anterior (`mini-tools-auto-backup.mtbackup`), a diferencia del backup manual que arma un archivo con timestamp por corrida. Corre en segundo plano (un ticker por proceso, arrancado al iniciar la app si ya estaba activado y detenido al cerrarla) y no vuelve a pedir la clave maestra en cada corrida — el backup a nivel de archivo solo copia bytes ya cifrados, no necesita desbloquear nada.
- **Aviso de nueva versión disponible**: al abrir la app se compara la versión del binario contra el archivo `VERSION` publicado en el repo (chequeo de solo lectura por HTTP contra la API pública de GitHub, con timeout corto y fallo silencioso si no hay red — nunca toca el vault ni bloquea el arranque). Si hay una versión más nueva, aparece un punto sobre el ícono de Configuración y, dentro del modal, la línea de versión del pie se vuelve un link que abre el repositorio en el navegador.

### Corregido

- El menú "Recientes" ya no recorta el nombre del archivo: antes cada entrada mostraba el path completo en una sola línea truncada, y como el truncado corta por el final se perdía justo el nombre (todos se veían iguales, `…/logs/…`). Ahora cada reciente muestra el nombre del archivo en una línea prominente y la carpeta debajo como texto secundario truncado; el menú es un poco más ancho (288→360 px) y el tooltip sigue mostrando el path completo.

## [0.2.5] - 2026-07-17

### Cambiado

- Rediseño del diálogo de conexión (crear/editar, DB y SSH): header fijo con el ícono del motor, título y subtítulo + botón de cerrar; cuerpo scrolleable y footer fijo (Cancelar/Guardar siempre visibles); Test Connection con estilo de botón. Mismo lenguaje visual que Configuración y el modal de esquemas.
- Controles de formulario unificados y temados en toda la app: se reemplazaron todos los `<select>` nativos (schema del toolbar, chip de conexión/lenguaje de la pestaña, motor/modo/auth/SSL de la conexión, filtro de tipo en Redis, tema del editor) por un dropdown propio (`Select`) con menú en portal; y los checkboxes de opciones booleanas (Auto-commit, DBMS_OUTPUT, Agent Forwarding, TLS, Recordar clave) por un switch propio (`Toggle`). Ambos siguen el tema claro/oscuro de la app, a diferencia de los controles nativos que se veían fuera de lugar.
- Rediseño del modal "Esquemas a escanear": más ancho, con header/búsqueda/pie fijos y la lista scrolleable, buscador con ícono, contador de seleccionados + botones "Todos/Ninguno", y filas con un check propio en vez del checkbox nativo. Mismo tratamiento a la lista de esquemas dentro del diálogo de conexión.
- Rediseño del diálogo de Configuración: más ancho, con las opciones agrupadas en secciones ("Vault", "Preferencias") y cada una en su tarjeta con ícono, título y descripción; "Recordar clave" pasa de checkbox a un toggle. El selector de tema del editor pasa de un `<select>` nativo (que no respetaba el tema de la app) a un dropdown propio, temado, con menú en portal (no lo clippea el modal). Contenido compactado para que el modal no muestre scroll en pantallas normales. Header con subtítulo y pie con la versión. Mismos tokens MD3 del resto de la app.

### Agregado

- El diálogo de Configuración ahora muestra la versión actual de la app (`mini-tools vX.Y.Z`) en un pie, leída del binario (`main.appVersion`, estampada en build por `-ldflags`). En un build sin estampar (`wails dev`) muestra `dev`.

### Corregido

- `DBMS_OUTPUT` no mostraba ninguna línea aunque estuviera activado, en bloques PL/SQL de Oracle que sí emiten `DBMS_OUTPUT.PUT_LINE`: (1) el bind del parámetro de salida `VARCHAR2` de `DBMS_OUTPUT.GET_LINE` no llevaba `Size`, y go-ora necesita el tamaño para un OUT string — sin él fallaba (ORA-06502) y el error se tragaba, devolviendo cero líneas; se fijó `Size: 32767`. (2) La pestaña "Consola" no renderizaba las líneas de `DBMS_OUTPUT` (solo estaban en la pestaña "Resultados"); ahora se muestran también en la Consola, debajo del texto del statement, como en un cliente SQL de escritorio.
- La pestaña del editor ya no se "va en modo movimiento" (arrastre) al vincularle una conexión: el menú de conexión se renderiza en un portal de React, y como los portales propagan los eventos por el árbol de React (no por el DOM), el `pointerdown` sobre el `<select>` subía hasta el `<div>` de la pestaña y arrancaba un arrastre de dnd-kit, dejando la pestaña pegada al cursor. El menú tenía `onClick` con `stopPropagation` pero no `onPointerDown` (dnd-kit activa con `pointerdown`). Se agregó `onPointerDown` con `stopPropagation` al menú y su backdrop.
- Seleccionar una conexión en la pestaña del editor ya no muestra un error cada vez: la carga automática de metadata del esquema (que alimenta el autocompletado) fallaba en silencio antes, pero mostraba el error crudo de la base en la barra de estado en cada cambio de conexión. Ahora la auto-carga es silenciosa (el autocompletado simplemente queda vacío si el escaneo falla) y solo el refresh explícito (F5) muestra el error.

### Quitado

- Generación automática de `CLAUDE.md` al abrir/guardar un archivo `.sql`: la app ya no escribe `CLAUDE.md` ni el árbol `.claude/` dentro de la carpeta del proyecto por su cuenta. Recreaba los archivos que el usuario había borrado a propósito y escribía en carpetas de proyectos ajenos; el botón manual "Regenerar" ya se había quitado en 0.2.2, así que esto completa la baja de la función.

## [0.2.4] - 2026-07-17

### Agregado

- **Módulo de transferencia de archivos SFTP**: explorador de doble panel (estilo Termius) que reutiliza las conexiones SSH ya guardadas — se abre desde el árbol SSH del sidebar. Transfiere en ambos sentidos entre la máquina local y un host remoto, y también remoto↔remoto (haciendo streaming a través de la máquina local, ya que SFTP no copia servidor-a-servidor directo). Arrastrar y soltar entre paneles o botón "Enviar", con una cola de transferencias que muestra el progreso por porcentaje/bytes/archivos y deja cancelar cada una. Procesa lotes de muchos archivos en paralelo (pool de goroutines acotado) y no deja procesos colgados al cancelar o al perder la conexión (cancelación por contexto + cierre ordenado de las conexiones dedicadas de cada transferencia).
- **Explorador SFTP con columnas ordenables**: Nombre, Fecha de modificación, Tamaño, Kind y Permisos, con headers clickeables para ordenar ascendente/descendente (carpetas siempre primero).
- **Gestión de archivos por SFTP**: menú contextual (click derecho) con Enviar, Renombrar, Eliminar, Refrescar y Nueva carpeta, más un diálogo "Editar permisos" (chmod) con toggles de Lectura/Escritura/Ejecución para Propietario/Grupo/Otros y preview octal/simbólico en vivo; la propiedad (usuario/grupo) se muestra como solo lectura (SFTP no expone nombres, y cambiar dueño suele requerir root).
- El selector de host de cada panel del explorador SFTP lista solo Local + las conexiones SSH (las conexiones de base de datos no tienen superficie SFTP).

### Corregido

- Restaurar un backup del vault en la pantalla de creación (primer arranque) mostraba un error como si hubiera fallado, aunque la restauración sí se completaba en disco: el formulario no avanzaba tras el éxito y un segundo intento chocaba con "ya existe un vault inicializado". Ahora, tras restaurar, pasa directo a la pantalla de desbloqueo. Además, el botón "Restaurar desde backup…" ahora abre el selector de archivo primero y recién después pide la clave con la que se hizo *ese* backup — antes exigía escribir una clave en el campo de creación de vault nuevo antes de siquiera elegir el archivo.
- Los errores de operaciones SFTP (transferencias, permisos, etc.) se muestran completos en la interfaz (banner y cola), sin recortar el mensaje.

## [0.2.3] - 2026-07-17

### Agregado

- **Consola de ejecución**: nueva pestaña "Consola" en el panel inferior (junto a Resultados/Historial), estilo DataGrip/SQL Developer — al correr un script de varios statements, cada uno aparece con su texto completo y una línea de resultado con hora (`N filas obtenidas en Xms`, `completado en Xms`, o `ERROR: <mensaje completo>`, nunca cortado). Se activa sola en cualquier script de más de un statement.
- **Snippets genéricos en el editor SQL**: tipear `ins`/`up`/`del`/`sel`/etc. ofrece la plantilla completa (`INSERT`, `UPDATE`, `DELETE`, `SELECT`, `SELECT ... JOIN`, `CREATE TABLE`, `CASE`) con tab-stops para completar los campos; para Oracle además `DECLARE/BEGIN/END` (bloque PL/SQL anónimo) y `MERGE`.
- **Módulo de Snippets SSH**: comandos o scripts guardados, reutilizables en cualquier sesión SSH abierta (no atados a una conexión) — botones Ejecutar (corre cada línea) y Pegar (los escribe sin confirmar la última línea), con carpetas propias para organizarlos y buscador por nombre/contenido.
- **Temas de color para la terminal SSH**: selector visual con muestra de paleta (Dracula, Solarized Dark/Light, Gruvbox Dark, One Half Dark/Light, Tomorrow Night, GitHub Light, o Automático) — un ajuste global que aplica a todas las sesiones SSH abiertas.
- **Restaurar backup del vault desde Configuración**: antes solo se podía restaurar un backup en la pantalla de desbloqueo inicial con el vault vacío; ahora también reemplaza un vault ya inicializado. Flujo en dos pasos — primero la clave maestra actual y elegir el archivo `.mtbackup`, y recién con el archivo ya elegido pide la clave con la que se hizo *ese* backup (nunca antes de saber a cuál corresponde), para poder reintentar sin volver a elegir el archivo si la clave es incorrecta.

### Corregido

- Editar una conexión SSH existente mostraba el selector genérico de motor (sin SSH, ya que está excluido a propósito de ahí) más el textarea de "pegar connection string" — ninguno de los dos aplica a SSH. El bloqueo de tipo (`typeLocked`) solo se activaba al crear una conexión nueva, nunca al editar.
- El detector de cláusula SQL (autocompletado de tablas/columnas y snippets) no reconocía el `;` de cierre de un statement anterior — tipear al inicio de un statement nuevo, en un script de varios statements, seguía viendo el último `SELECT`/`WHERE` del statement previo.
- Borrar una carpeta de snippets SSH no reparentaba los snippets que tenía adentro (solo subcarpetas y conexiones) — quedaban con una carpeta inexistente asignada: no se borraban, pero se volvían invisibles en la interfaz.

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
