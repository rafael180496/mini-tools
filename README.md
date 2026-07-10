# mini-tools

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Go](https://img.shields.io/badge/go-1.26-00ADD8)
![Wails](https://img.shields.io/badge/wails-v2-DF0000)

Cliente SQL de escritorio para **Oracle, PostgreSQL y SQLite** — tipo DataGrip, pero minimalista. Go + Wails v2 en el backend, React + Tailwind en el frontend. Sin Electron, sin JVM, sin telemetría.

> El spec funcional completo vive en [docs/SPEC.md](docs/SPEC.md); la arquitectura y convenciones actuales del código en [CLAUDE.md](CLAUDE.md).

## Capturas

<p align="center">
  <img src="docs/screenshots/editor.png" width="900" alt="Editor SQL de mini-tools con autocompletado, tabs reordenables, transacciones explícitas y configuración centralizada">
</p>

<p align="center"><em>Editor Monaco con autocompletado consciente del contexto, tabs que se reordenan arrastrando, transacciones explícitas siempre visibles y un ícono de Configuración a un click de distancia.</em></p>

<table>
  <tr>
    <td align="center" width="34%">
      <img src="docs/screenshots/schema-tree.png" width="260" alt="Árbol de conexiones con ícono por motor y color de etiqueta por conexión"><br>
      <sub>Cada conexión con el ícono real de su motor y un color de etiqueta a elección — reconocible de un vistazo, sin leer el nombre</sub>
    </td>
    <td align="center" width="66%">
      <img src="docs/screenshots/new-connection.png" width="560" alt="Diálogo de nueva conexión con selector visual de motor y color, y detección de connection string"><br>
      <sub>Nueva conexión: pegá una connection string y se completa sola, elegí el motor con un click y ponele un color propio</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/unlock-vault.png" width="520" alt="Pantalla de desbloqueo del vault cifrado">
</p>

<p align="center"><em>Conexiones cifradas en un vault local — sin la clave maestra, no hay acceso.</em></p>

> El diálogo de nueva conexión y la pantalla de desbloqueo son ejemplos ficticios. El editor y el árbol de conexiones muestran una conexión real con el nombre y los nombres de tabla difuminados a propósito — el resto de la interfaz (toolbar, tabs, ícono por motor, colores) es exactamente como se ve en uso normal.

## Por qué

La mayoría de clientes SQL multi-motor son pesados (JVM, Electron, cientos de MB). mini-tools apunta a lo contrario: un binario nativo liviano, dark por defecto, sin telemetría, con las conexiones cifradas en un vault local — nada más.

## Features

- **3 motores nativos**: Oracle (TNS / Easy Connect / SID / Service Name), PostgreSQL (SSL modes completos), SQLite — todos vía `database/sql`, sin cliente Oracle/Postgres instalado aparte.
- **Vault cifrado local**: las conexiones se guardan en SQLite, con el DSN cifrado columna a columna (AES-256-GCM, clave derivada con Argon2id). Sin clave maestra correcta, no hay acceso — no hay bypass.
- **Backup/restore protegido por clave maestra**: exportar e importar el vault completo (conexiones + salt) como un solo archivo. Tanto generar el backup como restaurarlo piden tu clave maestra — se verifica contra el propio archivo antes de tocar nada, así que un backup que termine en otra máquina, USB o la nube no sirve de nada sin ella.
- **Pegar connection string**: copiá una URL de Postgres, un Easy Connect/SID/TNS de Oracle, un JDBC, o una ruta SQLite (directo de un `.env`) y el formulario de conexión se completa solo, detectando el motor.
- **Ícono real por motor y color de etiqueta por conexión**: cada conexión muestra el logo de Oracle/PostgreSQL/SQLite y un color a elección (elegible al crear o editar) — distinguís de un vistazo cuál es cuál sin leer el nombre, sobre todo útil con muchas conexiones abiertas.
- **Guardar sin depender de un ping**: crear o editar una conexión nunca exige que el Test Connection haya sido exitoso — guardás igual si el servidor está apagado ahora pero lo vas a usar más tarde. Test Connection sigue ahí como verificación opcional.
- **Selector de esquemas al crear la conexión**: en Postgres, después de un Test Connection exitoso elegís qué esquemas escanear — clave en catálogos con cientos de esquemas donde un escaneo completo es lento. Editable después desde el árbol de conexiones.
- **Editor SQL** (Monaco, recortado solo a SQL, sin CDN) con tabs reordenables por drag-and-drop, archivos recientes, y pestañas restauradas automáticamente al reabrir la app.
- **Autocompletado consciente del contexto**: sugiere tablas después de `FROM`/`INSERT INTO`/`UPDATE` y columnas acotadas a las tablas realmente referenciadas después de `SELECT`/`WHERE`/`SET`; resuelve alias y esquema al tipear un punto (`u.` → columnas de `users` si `u` es su alias).
- **Transacciones explícitas**: auto-commit es un checkbox, Commit/Rollback siempre visibles (deshabilitados cuando no aplican) — nunca hay ambigüedad sobre si un cambio quedó confirmado.
- **Ejecución con streaming**: resultados en vivo statement por statement, cancelación en caliente, soporte de scripts multi-statement y bloques PL/SQL de Oracle (con `DBMS_OUTPUT` capturado). Múltiples resultados (uno por statement) en pestañas que se cierran individualmente o todas juntas.
- **Historial de ejecuciones** por conexión: SQL exacto, estado, duración y error completo de cada statement corrido — filtrable, borrable entero o fila por fila.
- **Grid de resultados** virtualizado para miles de filas sin lag, columnas redimensionables/ordenables (el sort reemite la query con `ORDER BY`, no ordena en cliente). Seleccionar una fila habilita copiarla como texto, `INSERT` o `UPDATE` listos para pegar en el editor.
- **Árbol de conexiones** colapsable a una barra de solo íconos, con buscador de tablas/esquema, export de DDL (tabla puntual o esquema completo) desde el propio árbol, y layout (sidebar colapsado, alto del editor) recordado entre sesiones.
- **Configuración centralizada**: backup del vault y "recordar clave maestra" viven en un modal de Configuración propio, abierto desde el ícono de engranaje — no sueltos en la barra de herramientas.
- **EXPLAIN PLAN visual**: árbol de plan de ejecución para los 3 motores, con detección de full table scan resaltada.
- **Linter SQL básico**: marca `SELECT *` como sugerencia visual (no bloquea) y `UPDATE`/`DELETE` sin `WHERE` con confirmación antes de ejecutar.
- **Export**: CSV, JSON, XLSX, DDL de tabla/schema completo, y config de conexión (sin password) — más "copiar como INSERT" desde el grid.
- **CLAUDE.md automático**: al abrir/guardar un archivo `.sql` en una carpeta, mini-tools genera (o regenera a pedido, con confirmación) un `CLAUDE.md` con el schema de la base conectada — tablas, columnas, foreign keys y convenciones de SQL del motor, acotado al esquema activo cuando aplica — para que Claude Code tenga contexto real al trabajar ese proyecto.
- **Tooltips contextuales** en cada control, pensados para alguien que abre la app por primera vez. Toda confirmación (borrar historial, backup del vault) usa un modal propio con el tema de la app, nunca un diálogo nativo del navegador.
- Interfaz Material Design 3, dark/light con toggle persistido, tipografías e íconos empaquetados con la app (sin depender de internet para renderizar).

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
./scripts/build.sh        # wails build -clean — build de producción, binario objetivo <45MB
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
| Versión | 0.1.1 |
| Plataforma | macOS — **Apple Silicon (`arm64`) únicamente**, no corre en Mac Intel ni vía Rosetta |
| Compatible desde | macOS 11 (Big Sur) en la práctica — es la primera versión de macOS con hardware Apple Silicon; el `Info.plist` de Wails declara `10.13.0` por plantilla genérica (heredada de cuando también soportaba Intel), no es una garantía real |
| Archivo | **[⬇ Descargar mini-tools-v0.1.1.dmg](releases/macos/mini-tools-v0.1.1.dmg)** |
| SHA-256 | `ccb0e27d78fe34921959b79fd33b2ef24e5cb064813a1fd9e86596995d32e4b8` |
| Firma | Sin firmar (ver workaround de Gatekeeper arriba) |

Detalle completo, checksum de verificación e instrucciones de instalación paso a paso en [releases/macos/README.md](releases/macos/README.md).

## Estructura del proyecto

```text
/backend        crypto (Argon2id + AES-256-GCM), vault (SQLite cifrado columna a columna),
                 conectores de los 3 motores, ejecución de queries (streaming/cancelación),
                 EXPLAIN PLAN, export, generador de CLAUDE.md
/frontend       React + TypeScript + Vite + Tailwind v4, editor Monaco recortado a SQL
app.go          superficie completa de binding Go ↔ React
main.go         bootstrap de Wails, embed de frontend/dist
```

Detalle completo (stack, estructura fase a fase, contrato de bindings) en [CLAUDE.md](CLAUDE.md) → [.claude/specs/architecture.md](.claude/specs/architecture.md).

## Seguridad

- El DSN de cada conexión se cifra con AES-256-GCM antes de guardarse; la clave se deriva de tu clave maestra con Argon2id y nunca se persiste en ningún lado.
- Sin clave maestra correcta, la app no arranca — no hay bypass, ni siquiera desde las bindings internas.
- El DSN nunca llega al frontend ni se loguea, tampoco en modo debug.
- Los backups del vault están atados a la clave maestra: generarlos y restaurarlos piden la clave, verificada contra el propio archivo de backup — no contra la instalación local, porque un backup puede restaurarse en otra máquina.

## Licencia

[MIT](LICENSE)
