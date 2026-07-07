# Migraciones del vault

`vault.db` (SQLite) se crea vía `CREATE TABLE IF NOT EXISTS` en `backend/vault/store.go`'s `Open()` — eso solo alcanza para agregar tablas nuevas. Si una actualización futura necesita agregar una columna a una tabla que un usuario ya tiene, o cualquier cambio que no sea "crear si no existe", hace falta un paso explícito que se aplique una sola vez y de forma segura sobre datos reales. Ese es el trabajo de este sistema.

## Diseño

**Tabla de versión — `schema_migrations`, no `vault_meta`:**
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
```
`vault_meta` (que guarda `verifier`/`verifier_nonce`) es exactamente lo único que una migración no debe tocar nunca — mantener el versionado en su propia tabla hace estructuralmente imposible que una migración choque con esa fila. Sigue además la convención de `golang-migrate`/`goose`.

**El schema de hoy = versión 1, permanente.** Todo lo que ya existe en el `CREATE TABLE IF NOT EXISTS` de `store.go` (vault_meta, connections, query_history, recent_files, explain_history, settings) es la base — nunca se reescribe como una migración retroactiva. `Open()` siembra `schema_migrations` con `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, strftime('%s','now'))` en el mismo `db.Exec` que crea las tablas.

**Instalación nueva y actualización comparten el mismo camino.** Un usuario nuevo crea las tablas base Y queda en versión 1 en el mismo `Open()`, después cae por el mismo loop de migraciones (`applyMigrations`, en `backend/vault/migrations.go`) que un usuario existente — para él es un no-op porque no hay migraciones pendientes. No hay una rama de código separada para "fresh install" vs "upgrade".

**Aplicación — una transacción por migración**, no un solo batch: si la migración 3 de 5 falla, las 1-2 quedan aplicadas y registradas de forma durable, así que el próximo arranque solo reintenta desde la 3.

## Cómo agregar una migración nueva

1. En `backend/vault/migrations.go`, agregar una entrada al slice `migrations`:
   ```go
   var migrations = []migration{
       {
           version: 2,
           desc:    "agrega columna font_size a settings",
           apply: func(tx *sql.Tx) error {
               _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN font_size INTEGER NOT NULL DEFAULT 13`)
               return err
           },
       },
   }
   ```
2. **Reglas duras** (ver también `.claude/rules/technical.md`):
   - Solo aditivo: `CREATE TABLE IF NOT EXISTS` nueva, o `ALTER TABLE x ADD COLUMN y ... DEFAULT ...`. Nunca `DELETE`/`DROP TABLE`/mutar filas existentes.
   - Nunca tocar `vault_meta.verifier` ni `vault_meta.verifier_nonce`. No hay guard técnico para esto (parsear el SQL de una migración violaría la regla de "sin librería de parsing SQL" — ver `technical.md` punto 7) — se cuida por convención y code review.
   - `modernc.org/sqlite` trae una versión moderna de SQLite (soporta `ADD COLUMN` sin problema). Si algún día hiciera falta `DROP`/`RENAME COLUMN`, usar el patrón de copiar a tabla nueva y renombrar en vez de confiar en soporte parcial de `ALTER TABLE`.
3. Verificar con el patrón de script efímero (abajo) **antes** de commitear.
4. `codegraph sync` después de tocar `migrations.go`.

## Verificación (sin `_test.go` nuevos)

Este proyecto no agrega tests nuevos (`.claude/rules/conventions.md`) — se verifica con un script efímero, sandboxeado para no tocar el vault real:

```bash
mkdir -p tmp_migrationverify
# ... escribir main.go que importe mini-tools/backend/vault y vaultgate ...
HOME=$(mktemp -d) go run ./tmp_migrationverify
rm -rf tmp_migrationverify
```

`HOME=$(mktemp -d)` es obligatorio — `backend/appdata/paths.go` usa `os.UserConfigDir()`, que en Darwin resuelve vía `$HOME`, y no tiene ningún mecanismo de override. Un script sin sandbox escribe en la ruta real del usuario (`~/Library/Application Support/mini-tools/`) — ver el near-miss documentado en `.claude/skills/mini-tools-patterns/SKILL.md`, sección Fase 10.

**Receta mínima** (la que se corrió para verificar el framework en su estado actual, sin migraciones reales todavía):
1. `Open()` en frío → verificar `SELECT MAX(version) FROM schema_migrations` == 1 y que hay exactamente 1 fila (bootstrap de instalación nueva).
2. `Initialize(password)`, guardar una conexión falsa (`SaveConnection`), `SetTheme("light")`, `Close()`.
3. `Open()` de nuevo (simula reinicio/actualización) → sin error, `schema_migrations` sigue con exactamente 1 fila (idempotencia — no se re-aplica en cada arranque), la conexión falsa y el tema siguen ahí, y `Unlock(password)` con la clave original sigue funcionando (prueba que `vault_meta.verifier` no fue tocado).

**Extender esta receta la próxima vez que se agregue una migración real:** abrir un store, insertar datos, aplicar la migración nueva (reabriendo con la migración ya en el slice), y verificar que la fila preexistente tiene el `DEFAULT` correcto en la columna nueva y que las columnas viejas quedan byte-idénticas. La receta de arriba solo prueba idempotencia y bootstrap — todavía no ejercita un `ADD COLUMN` real porque no hay ninguno pendiente.

## Estado actual

- **Versión 2** (`backend/vault/migrations.go`): `ALTER TABLE connections ADD COLUMN metadata_schemas TEXT` — restringe qué esquemas escanea `GetSchemaMetadata` en Postgres (ver `.claude/specs/go-react-contract.md`, sección "Escaneo de esquemas restringido"). Primera migración real del framework — verificada contra un Postgres real en Docker con el patrón de script efímero de arriba (además del round-trip de datos, específicamente contra que abrir un vault ya en versión 1 la aplica una sola vez y queda en versión 2).
