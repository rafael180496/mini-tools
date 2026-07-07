# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versionado: [SemVer](https://semver.org/), fuente de verdad en [VERSION](VERSION).

## [Unreleased]

### Agregado

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

- `SELECT *` ya no bloqueaba la ejecución con una confirmación — ahora es solo una marca visual, igual que cualquier otro warning de estilo.
- El grid de resultados mostraba un área blanca desbordada cuando había demasiadas columnas para el ancho de la ventana.

## [0.1.0] - 2026-07-07

Primera versión versionada del proyecto.

### Agregado

- Archivo `VERSION` como fuente única de la versión de la app.
- `scripts/package-macos.sh` — empaqueta `build/bin/mini-tools.app` en un `.dmg` sin firmar, solo local (sin publicación automática).
- `scripts/bump-version.sh` — bumpea `VERSION` (`patch`/`minor`/`major`).
- Framework de migraciones del vault (`backend/vault/migrations.go`, tabla `schema_migrations`) — sin migraciones reales todavía, listo para futuros cambios de schema retrocompatibles. Ver [.claude/specs/vault-migrations.md](.claude/specs/vault-migrations.md).
