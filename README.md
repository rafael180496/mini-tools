# mini-tools

![Versión](https://img.shields.io/badge/versi%C3%B3n-1.3.1-6750A4)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Go](https://img.shields.io/badge/go-1.26-00ADD8)
![Wails](https://img.shields.io/badge/wails-v2-DF0000)
![Binario](https://img.shields.io/badge/binario-50MB-success)
![Sin telemetría](https://img.shields.io/badge/telemetr%C3%ADa-ninguna-informational)

### Tu cliente de base de datos, tu terminal, tu cliente Git y tus agentes de IA — en un solo binario de 50 MB.

Sin Electron. Sin JVM. Sin cuenta. Sin telemetría. Tus credenciales cifradas en tu máquina y nada saliendo a ningún lado.

**Oracle · PostgreSQL · SQLite · SQL Server · Redis · MongoDB · SSH · SFTP · Git · Claude Code · Codex · Antigravity**

<p align="center">
  <img src="docs/screenshots/ui-workspace.png" width="900" alt="mini-tools: sidebar con conexiones de base de datos, SSH y repositorios Git; editor SQL al centro y panel de resultados abajo">
</p>

---

## Novedades — 1.3.0

**La versión que convierte a mini-tools en un cliente agéntico.** Hasta la 1.2.0 los agentes eran una terminal más; ahora son parte de la herramienta:

- **Chat nativo** con Claude Code, Codex y Antigravity sobre el repositorio abierto, con cada acción visible y los tokens de cada turno.
- **Cinco modos de permiso**, incluida la **aprobación acción por acción**: el agente te pregunta antes de cada cosa y espera.
- **Modo carpeta**: entrar a lo agéntico despeja ramas, grafo y diff y deja el árbol del proyecto con los indicadores de cambio.
- **Consumo de tokens y plan** de cada CLI, con desglose por modelo y cuánto se fue en *este* repositorio.
- **Servidores MCP** de los tres agentes, leídos de los cinco lugares donde cada uno los guarda, con los remotos marcados.
- **Historial de chats** por repositorio, agrupado por agente, renombrable y retomable.
- **Editor de archivos** con más de treinta lenguajes y vista previa de Markdown en tres modos.

La **1.3.1** es correctiva sobre esa base y es la que hay que descargar: arregla que ningún agente arrancara desde la app instalada (el `PATH` mínimo que hereda una app abierta desde Finder), que Claude Code informara "Not logged in" con la sesión iniciada (le faltaba `HOME`), y suma el listado de **las conversaciones que el CLI ya tenía de este repositorio** — las mismas que ves en la extensión de VS Code.

Detalle completo en [CHANGELOG.md](CHANGELOG.md).

---

## Lo que lo hace distinto

**Un solo programa para todo el día.** La consulta a Oracle, el `tail -f` por SSH, el rebase, el archivo que hay que subir por SFTP y la charla con el agente: todo en la misma ventana, con los mismos atajos y el mismo tema.

**Los agentes de IA como parte de la herramienta, no como una pestaña de navegador.** Claude Code, Codex y Antigravity corren sobre el repositorio abierto, con el diff al lado. Podés chatear con ellos, ver **qué hace cada acción antes de autorizarla**, y saber cuántos tokens llevás gastados y con qué plan.

**Nada se va de tu máquina.** El vault es un SQLite local con los DSN cifrados columna a columna (AES-256-GCM, clave derivada con Argon2id). No hay servidor, no hay cuenta, no hay telemetría. Sin la clave maestra no hay acceso — y no hay bypass.

**Pesa lo que pesa un binario nativo.** 50 MB, arranque instantáneo, sin un runtime de Node ni una JVM detrás.

---

## Trabajar con agentes, de verdad

<p align="center">
  <img src="docs/screenshots/ui-repo.png" width="900" alt="Pestaña Git con ramas plegables, grafo de commits y el panel de agentes abierto abajo mostrando instrucciones del proyecto y skills">
</p>

Abrí un repositorio y el panel **Agentes** te dice lo que ningún otro cliente te dice:

- **Qué tiene preparado este repo** para un agente: sus skills, sus subagentes, sus comandos — y **cuáles archivos de instrucciones le faltan**. Cada CLI lee el suyo y no el de los otros: un repo impecablemente documentado en `CLAUDE.md` no le dice *nada* a Codex. Eso es invisible hasta que alguien lo dibuja.
- **Qué herramientas MCP ve cada agente**, de dónde salen, y cuáles son remotas — las que mandan contexto de tu repo fuera de la máquina. Podés agregar y quitar servidores desde acá.
- **Cuántos tokens llevás gastados**, con qué modelo, cuánto se fue en *este* repositorio, y **con qué plan** estás.

### Modo agente: un botón que despeja la pantalla

<p align="center">
  <img src="docs/screenshots/ui-agentmode.png" width="900" alt="Modo agente activo: sin panel de ramas, sin grafo de commits y sin diff; en su lugar el árbol de archivos del proyecto con indicadores de cambio y el panel de agentes abajo">
</p>

Cuando trabajás con un agente no te importan las ramas, el grafo ni el diff — te importa **qué archivos hay** y **qué está haciendo**. El botón **Agente** esconde el resto del módulo Git y deja eso: el árbol del proyecto, con la letra de git en cada archivo modificado y el conteo de cambios en cada carpeta, más la conversación. El mismo botón te devuelve todo tal como lo tenías.

### Chat con permisos que se entienden

<p align="center">
  <img src="docs/screenshots/ui-chat.png" width="760" alt="Chat con un agente: mensaje del usuario destacado, la llamada a herramienta plegada mostrando el archivo leído, y la barra de controles con modo, esfuerzo, imagen y modelo">
</p>

El chat muestra **qué está haciendo** el agente: cada llamada a herramienta con su archivo y su tamaño, plegable, y los tokens de cada turno. Arriba de la caja de texto elegís qué le permitís:

| Modo | Qué puede hacer |
|---|---|
| **Solo consulta** | Lee, razona y propone. No toca nada. |
| **Plan** | Explora y arma un plan, explícitamente sin editar. |
| **Aprobar cada acción** | Trabaja, pero **te pregunta antes de cada acción** y espera tu respuesta. |
| **Automático** | Aprueba lo que pasa su propio control de seguridad y frena en lo riesgoso. |
| **Aplicar ediciones** | Modifica archivos sin preguntar. |

Los tres últimos **se aprueban una vez, explícitamente**, con un diálogo que dice qué vas a permitir. Y hay una línea que no se cruza: **nunca se le pasa al CLI la bandera que saltea todos los permisos**, ni en el modo más suelto — esa cubre también ejecutar comandos arbitrarios, y no es lo mismo que editar archivos versionados.

Cuando el agente termina de trabajar solo, te dice **cuántos archivos tocó** y te lleva a revisarlos. Caen en el árbol de trabajo de git: los ves en Cambios y los descartás con un clic.

### Y lo que se espera de un chat

Pegá una captura con `⌘V` en cualquier parte del panel, escribí `@` para referenciar un archivo del repo, retomá una conversación de la semana pasada con **el mismo modelo y esfuerzo** con los que la venías trabajando, o abrí **dos agentes en paralelo** — uno escribiendo, otro revisando lo que el primero hizo.

---

## Git, completo

<p align="center">
  <img src="docs/screenshots/git-commit-graph.png" width="900" alt="Grafo de commits con carriles de colores, badges de rama y tag, y marca de HEAD">
</p>

Cliente Git estilo Sublime Merge sobre el `git` de tu sistema — así que tus credential helpers, tu `ssh-agent` y tus hooks siguen funcionando igual. Grafo de commits, diff unificado o lado a lado, stage por bloque, rebase interactivo, stashes, worktrees, resolutor de conflictos de tres vías, y un **log de los comandos exactos** que la app ejecutó por debajo, con su salida.

Además: **editor de archivos** con resaltado para más de treinta lenguajes, árbol plegable con los indicadores de cambio de git, y vista previa de Markdown en tres modos.

---

## Bases de datos, SSH y SFTP

<p align="center">
  <img src="docs/screenshots/ui-redis.png" width="900" alt="Redis Browser: lista de keys con badges de tipo (string, hash, json, list, zset, set, stream), stats de total y memoria, y panel de detalle con el hash editable campo a campo y su TTL">
</p>

Seis motores nativos sin instalar un cliente aparte, editor con autocompletado que **entiende el contexto** (sugiere columnas de las tablas que realmente referenciaste, resolviendo alias), ejecución con streaming y cancelación, `EXPLAIN PLAN` visual, y export a CSV/JSON/XLSX/DDL.

Terminal SSH real con `xterm.js`, transferencia SFTP de doble panel con cola y cancelación, y snippets reutilizables.

---

## Descargas

| Plataforma | Archivo | Notas |
|---|---|---|
| macOS (Apple Silicon) | **[⬇ mini-tools-v1.3.1.dmg](releases/macos/mini-tools-v1.3.1.dmg)** | Sin firmar — Gatekeeper avisa "desarrollador no identificado", ver [workaround](#distribución--empaquetado-macos) |
| Windows (x86-64) | **[⬇ mini-tools-v1.3.1-windows-amd64.exe](releases/windows/mini-tools-v1.3.1-windows-amd64.exe)** | Portable, sin instalador, sin firmar — SmartScreen avisa, ver [workaround](#distribución--empaquetado-windows). **Esta versión no se probó en una Windows real**, ver [detalle](releases/windows/README.md). |

Checksums, detalle de compatibilidad e instrucciones paso a paso en [releases/macos/README.md](releases/macos/README.md) y [releases/windows/README.md](releases/windows/README.md).

## Todo lo que trae

<details>
<summary><strong>Ver la lista completa de funcionalidades</strong></summary>

### Agentes de código

- **Tres CLIs integrados**: Claude Code, Codex CLI y Antigravity CLI, detectados solos en el PATH y en las rutas donde se instalan de verdad (`~/.local/bin`, npm, bun).
- **Dos formas de usarlos**: su terminal completa —con su propio render y su diálogo de permisos— o el **chat nativo**, que muestra cada acción y los tokens de cada turno.
- **Cinco modos de permiso**, del solo-consulta al aplicar-ediciones, cada uno aprobado explícitamente. La bandera que saltea *todos* los permisos no se pasa nunca.
- **Aprobación acción por acción** con un diálogo que dice qué está por hacer. Si algo falla en esa cadena, la respuesta es denegar: si no se pudo preguntar, no se pudo haber aprobado.
- **Consumo de tokens y plan** por agente, con el desglose por modelo y cuánto se fue en este repositorio.
- **Servidores MCP** de los tres CLIs, leídos de donde cada uno los guarda; se pueden agregar y quitar los que son archivos de configuración.
- **Skills, subagentes, comandos e instrucciones** que el repositorio le ofrece a un agente — incluidos los archivos que le faltan.
- **Historial de chats** por repositorio, agrupado por agente, con nombres editables y retomable después de cerrar la app.
- **Acciones agénticas en Git**: redactar el mensaje de commit desde el diff preparado, revisar antes de pushear, explicar un commit, describir un PR, asistir un conflicto, explicar un comando fallido.
- **Adjuntar imágenes** pegándolas o arrastrándolas, y referenciar archivos del repo con `@`.

### Bases de datos, terminal y Git

- **6 motores nativos**: Oracle (TNS / Easy Connect / SID / Service Name), PostgreSQL (SSL modes completos), SQLite y SQL Server (T-SQL, instancias con nombre, modos de encriptación) — vía `database/sql`, sin cliente Oracle/Postgres/SQL Server instalado aparte —, Redis (Standalone/Cluster/Sentinel, ACL, TLS) vía `go-redis`, con soporte de primera clase para RediSearch (`FT.SEARCH`/`FT.AGGREGATE`) y RedisJSON (`JSON.*`), y MongoDB (`mongodb://` y SRV/Atlas, replica sets) con lenguaje mongosh en el editor y explorador de documentos estilo Compass.
- **Vault cifrado local**: las conexiones se guardan en SQLite, con el DSN cifrado columna a columna (AES-256-GCM, clave derivada con Argon2id). Sin clave maestra correcta, no hay acceso — no hay bypass.
- **Backup/restore protegido por clave maestra**: exportar e importar el vault completo (conexiones + salt) como un solo archivo. Tanto generar el backup como restaurarlo piden tu clave maestra — se verifica contra el propio archivo antes de tocar nada, así que un backup que termine en otra máquina, USB o la nube no sirve de nada sin ella.
- **Pegar connection string**: copiá una URL de Postgres, un Easy Connect/SID/TNS de Oracle, un JDBC, o una ruta SQLite (directo de un `.env`) y el formulario de conexión se completa solo, detectando el motor.
- **Ícono real por motor y color de etiqueta por conexión**: cada conexión muestra el logo de Oracle/PostgreSQL/SQLite/Redis y un color a elección (elegible al crear o editar) — distinguís de un vistazo cuál es cuál sin leer el nombre, sobre todo útil con muchas conexiones abiertas.
- **Carpetas para organizar conexiones**: crear, renombrar, mover y reordenar carpetas desde el propio árbol — "Conexiones" es un módulo de acordeón colapsable en el sidebar.
- **Conexiones SSH** en su propio módulo de sidebar — "SSH", separado de "Conexiones" — con el mismo patrón de carpetas (crear/renombrar/mover/reordenar) pero un árbol completamente propio, nunca mezclado con las carpetas de base de datos. Auth por password o private key (+ passphrase opcional) más Agent Forwarding, y Test Connection antes de guardar como cualquier otro motor.
- **Terminal interactiva real (xterm.js)** por conexión SSH: se abre en su propia pestaña — reabrir la misma conexión enfoca esa pestaña en vez de duplicarla — con streaming de la sesión remota vía PTY y resize automático. Cerrar la pestaña corta la sesión del lado remoto, no la deja colgada.
- **Temas de terminal**: selector visual con muestra de paleta (Dracula, Nord, Solarized Dark/Light, Gruvbox, One Half, Tomorrow Night, GitHub Light…) o Automático siguiendo el tema de la app — un ajuste global que aplica a todas las sesiones SSH abiertas.
- **Snippets SSH**: comandos o scripts guardados, reutilizables en cualquier sesión SSH abierta (no atados a una conexión), con carpetas propias y buscador por nombre/contenido — botones Ejecutar (corre cada línea) y Pegar (los escribe sin confirmar).
- **Transferencia de archivos por SFTP** reutilizando tus conexiones SSH: explorador de doble panel (estilo Termius) que se abre desde el árbol SSH. Transferí en cualquier dirección — **local → remoto, remoto → local y remoto → remoto** (streaming a través de tu máquina) — arrastrando entre paneles o con el botón Enviar. Cola de transferencias con **porcentaje/bytes/archivos en vivo** y **cancelación** por transferencia; los lotes grandes se procesan en paralelo (pool de goroutines) y **no dejan procesos colgados** al cancelar o perder la conexión. Listado tipo Finder con columnas ordenables (Nombre, Fecha, Tamaño, Kind, Permisos), menú contextual (Enviar/Renombrar/Eliminar/Nueva carpeta/Refrescar) y diálogo de **permisos (chmod)** con toggles Lectura/Escritura/Ejecución para Propietario/Grupo/Otros.
- **Guardar sin depender de un ping**: crear o editar una conexión nunca exige que el Test Connection haya sido exitoso — guardás igual si el servidor está apagado ahora pero lo vas a usar más tarde. Test Connection sigue ahí como verificación opcional.
- **Selector de esquemas al crear la conexión**: en Postgres, después de un Test Connection exitoso elegís qué esquemas escanear — clave en catálogos con cientos de esquemas donde un escaneo completo es lento. Editable después desde el árbol de conexiones.
- **Editor** (CodeMirror 6, sin CDN) con syntax highlighting real para SQL y para comandos Redis, tabs reordenables por drag-and-drop, archivos recientes, y pestañas restauradas automáticamente al reabrir la app — incluidas las pestañas del Redis Browser.
- **Redis Browser**: pestaña de ventana completa por conexión Redis — filtro por tipo con badges de color, buscador por patrón, stats de header (total de keys / memoria), selección múltiple con exportación a JSON/CSV, y edición inline del valor (string, JSON, hash, list, set, zset — streams de solo lectura) que siempre preserva el TTL existente.
- **Scanner de objetos de esquema**: procedures, functions y triggers (PostgreSQL, Oracle) y packages (Oracle) además de tablas, agrupados en categorías colapsables por schema. Un click muestra el DDL actual en un visor con syntax highlighting (CodeMirror), botón de copiar y de exportar a `.sql`.
- **Autocompletado consciente del contexto**: sugiere tablas después de `FROM`/`INSERT INTO`/`UPDATE` y columnas acotadas a las tablas realmente referenciadas después de `SELECT`/`WHERE`/`SET`; resuelve alias y esquema al tipear un punto (`u.` → columnas de `users` si `u` es su alias).
- **Transacciones explícitas**: auto-commit es un checkbox, Commit/Rollback siempre visibles (deshabilitados cuando no aplican) — nunca hay ambigüedad sobre si un cambio quedó confirmado.
- **Ejecución con streaming**: resultados en vivo statement por statement, cancelación en caliente, soporte de scripts multi-statement y bloques PL/SQL de Oracle (con `DBMS_OUTPUT` capturado). Múltiples resultados (uno por statement) en pestañas que se cierran individualmente o todas juntas.
- **Consola de ejecución** (estilo DataGrip/SQL Developer): pestaña propia junto a Resultados/Historial que registra cada statement de un script con su texto completo y una línea de resultado con hora (`N filas obtenidas en Xms`, `completado en Xms`, o el `ERROR` completo sin recortar) — se activa sola en cualquier script de más de un statement.
- **Historial de ejecuciones** por conexión: SQL exacto, estado, duración y error completo de cada statement corrido — filtrable, borrable entero o fila por fila.
- **Grid de resultados** virtualizado para miles de filas sin lag, columnas redimensionables/ordenables (el sort reemite la query con `ORDER BY`, no ordena en cliente). Seleccionar una fila habilita copiarla como texto, `INSERT` o `UPDATE` listos para pegar en el editor.
- **Árbol de conexiones** colapsable a una barra de solo íconos, con buscador que cubre tablas y también procedures/functions/triggers/packages, categoría de tablas colapsable y siempre ordenada alfabéticamente (probado con un schema real de 342 tablas), export de DDL (objeto puntual o esquema completo) desde el propio árbol, y layout (sidebar colapsado, alto del editor) recordado entre sesiones.
- **Configuración centralizada**: backup del vault y "recordar clave maestra" viven en un modal de Configuración propio, abierto desde el ícono de engranaje — no sueltos en la barra de herramientas.
- **EXPLAIN PLAN visual**: árbol de plan de ejecución para los 3 motores, con detección de full table scan resaltada.
- **Linter SQL básico**: marca `SELECT *` como sugerencia visual (no bloquea) y `UPDATE`/`DELETE` sin `WHERE` con confirmación antes de ejecutar.
- **Export**: CSV, JSON, XLSX, DDL de tabla/schema completo, y config de conexión (sin password) — más "copiar como INSERT" desde el grid.
- **Tooltips contextuales** en cada control, pensados para alguien que abre la app por primera vez. Toda confirmación (borrar historial, backup del vault) usa un modal propio con el tema de la app, nunca un diálogo nativo del navegador.
- Interfaz Material Design 3, dark/light con toggle persistido, tipografías e íconos empaquetados con la app (sin depender de internet para renderizar).

</details>

## Requisitos

- [Go](https://go.dev/dl/) 1.26 o superior
- [pnpm](https://pnpm.io/) — nunca `npm` ni `yarn`
- Node.js (solo para compilar el frontend; no hay runtime Node en producción)
- [Wails CLI v2](https://wails.io/) (el script de instalación de abajo lo instala si falta)

## Instalación

```bash
git clone https://github.com/rafael180496/mini-tools.git
cd mini-tools
./scripts/install.sh
```

## Comandos

```bash
./scripts/install.sh      # toolchain (Wails CLI si falta) + deps de Go y frontend
./scripts/start-dev.sh    # wails dev — backend Go + frontend Vite con hot reload
./scripts/build.sh        # wails build -clean — build de producción, binario objetivo <80MB
./scripts/start.sh        # corre el binario ya compilado en build/bin/, sin recompilar
./scripts/clean.sh        # borra build/bin + frontend/dist (--all también node_modules y cache de Go)
```

Equivalentes directos, por si hace falta correrlos sin los wrappers:

```bash
wails dev
wails build -clean

cd frontend && pnpm install   # pnpm siempre, nunca npm/yarn
cd frontend && pnpm build

go build ./...
go vet ./...
go test ./...
```

Detalle de cada script en [scripts/README.md](scripts/README.md).

## Empaquetar una versión nueva

```bash
./scripts/bump-version.sh patch   # opcional — bumpea VERSION antes de empaquetar
./scripts/package-all.sh          # empaqueta macOS + Windows juntos (default)
```

`package-all.sh` corre `package-macos.sh` (salteado automáticamente si no
se ejecuta desde macOS) y `package-windows.sh` en una sola pasada. Para
empaquetar un solo SO puntual, correr su script directo — ver el detalle
de cada plataforma abajo.

## Distribución / Empaquetado macOS

```bash
./scripts/bump-version.sh patch   # opcional — bumpea VERSION antes de empaquetar
./scripts/package-macos.sh        # genera build/bin/mini-tools-vX.Y.Z.dmg
```

El `.dmg` resultante **no está firmado** (sin Apple Developer ID ni notarización) — al abrirlo en otra Mac, Gatekeeper va a mostrar "desarrollador no identificado". Workaround: clic derecho sobre la app → Abrir, o `xattr -cr /Applications/mini-tools.app`, o Ajustes del Sistema → Privacidad y Seguridad → Abrir de todas formas.

`package-macos.sh` solo genera el `.dmg` localmente — no crea releases ni sube nada a ningún lado, eso es manual.

### Última versión empaquetada

| Campo | Valor |
|---|---|
| Versión | 1.3.1 |
| Plataforma | macOS — **Apple Silicon (`arm64`) únicamente**, no corre en Mac Intel ni vía Rosetta |
| Compatible desde | macOS 11 (Big Sur) en la práctica — es la primera versión de macOS con hardware Apple Silicon; el `Info.plist` de Wails declara `10.13.0` por plantilla genérica (heredada de cuando también soportaba Intel), no es una garantía real |
| Archivo | **[⬇ Descargar mini-tools-v1.3.1.dmg](releases/macos/mini-tools-v1.3.1.dmg)** |
| SHA-256 | `3388923f455a4436f5a3dfb609acd5ffea0a41a49a9dfabeb6d2e358c598566a` |
| Firma | Sin firmar (ver workaround de Gatekeeper arriba) |

## Distribución / Empaquetado Windows

```bash
./scripts/bump-version.sh patch   # opcional — bumpea VERSION antes de empaquetar
./scripts/package-windows.sh      # genera build/bin/mini-tools-vX.Y.Z-windows-amd64.exe
```

Cross-compilado desde macOS/Linux con `wails build -platform windows/amd64` — ninguno de los conectores de base de datos usa CGO, así que no hace falta un toolchain de Windows. **Portable, sin instalador** (no arma NSIS) y **sin firma Authenticode** — SmartScreen va a avisar "Windows protegió su PC" al abrirlo; workaround: "Más información" → "Ejecutar de todas formas".

> ⚠️ **La 1.3.1 NO se corrió en una Windows real** — solo se confirmó que cross-compila limpio. Lo más expuesto en esta versión es todo lo agéntico: lanzar los CLIs como procesos hijos y leerles la salida en streaming es otro camino de código en Windows, y la **aprobación acción por acción de Claude Code usa un socket Unix**, que en Windows no existe — falta confirmar si degrada limpio o falla. Se suman las migraciones 30, 31 y 32 del vault, que al primer arranque tocan el `vault.db` que ya está en la máquina, y la terminal integrada, que usa ConPTY. La 1.1.0, la 1.2.0 y la 1.3.0 tampoco se verificaron, así que lo pendiente se acumula: lo último que corrió de verdad en Windows 10 y 11 fue la 1.0.0. Detalle en [releases/windows/README.md](releases/windows/README.md).

`package-windows.sh` solo genera el `.exe` localmente — no crea releases ni sube nada a ningún lado, eso es manual.

### Última versión empaquetada

| Campo | Valor |
|---|---|
| Versión | 1.3.1 |
| Plataforma | Windows — **`amd64` (x86-64) únicamente**, cross-compilado desde macOS y **no verificado** en una Windows real |
| Archivo | **[⬇ Descargar mini-tools-v1.3.1-windows-amd64.exe](releases/windows/mini-tools-v1.3.1-windows-amd64.exe)** |
| SHA-256 | `de65effc3198665894a496c65dd2aeb8c595e71a756e10644f058b545688226c` |
| Firma | Sin firmar (SmartScreen va a avisar, ver workaround arriba) |

Detalle completo, checksum de verificación e instrucciones de instalación paso a paso en [releases/windows/README.md](releases/windows/README.md).

## Estructura del proyecto

```text
/backend        crypto (Argon2id + AES-256-GCM), vault (SQLite cifrado columna a columna),
                 conectores de los 6 motores de base de datos (Oracle/PostgreSQL/SQLite/SQL Server/Redis/MongoDB),
                 ejecución de queries (streaming/cancelación), sshconn (sesiones SSH interactivas vía PTY),
                 EXPLAIN PLAN, export, generador de CLAUDE.md
/frontend       React + TypeScript + Vite + Tailwind v4, editor CodeMirror 6, terminal xterm.js
app.go          superficie completa de binding Go ↔ React
main.go         bootstrap de Wails, embed de frontend/dist
```

Detalle completo (stack, estructura fase a fase, contrato de bindings) en [CLAUDE.md](CLAUDE.md) → [.claude/specs/architecture.md](.claude/specs/architecture.md).

## Sobre las capturas de este README

Las imágenes `ui-*.png` **no son de una instalación real**: salen de
`./scripts/uishot.sh`, que monta los componentes en un navegador headless con
datos inventados. No hay rutas, repositorios, hosts ni credenciales de nadie —
no porque se hayan borrado después, sino porque nunca estuvieron ahí. Es
también la razón por la que ninguna está borroneada: no hay nada que tapar.

## Seguridad

- El DSN de cada conexión se cifra con AES-256-GCM antes de guardarse; la clave se deriva de tu clave maestra con Argon2id y nunca se persiste en ningún lado. Para SSH esto incluye el password, la private key completa y su passphrase — mismo tratamiento que el DSN de cualquier otro motor, nunca un campo aparte sin cifrar.
- Sin clave maestra correcta, la app no arranca — no hay bypass, ni siquiera desde las bindings internas.
- El DSN (y las credenciales SSH) nunca llegan al frontend ni se loguean, tampoco en modo debug — "Exportar configuración" redacta password/private key/passphrase antes de escribir el archivo.
- Los backups del vault están atados a la clave maestra: generarlos y restaurarlos piden la clave, verificada contra el propio archivo de backup — no contra la instalación local, porque un backup puede restaurarse en otra máquina.

## Licencia

[MIT](LICENSE)
