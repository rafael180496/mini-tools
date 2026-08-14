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

> Esta sección venía anotando solo la versión 2 y quedó **veintiocho versiones
> atrás** del código. No se reconstruyó el historial completo hacia atrás —
> `backend/vault/migrations.go` es la fuente de verdad y cada entrada lleva su
> propio `desc` y su comentario— pero sí se corrigió el número, que era lo que
> hacía engañosa la sección: leerla daba a entender que agregar una migración
> era todavía territorio inexplorado.

- **Versión actual: 32.** El slice de `migrations.go` es la lista completa y
  autoritativa; cada entrada explica en su comentario por qué existe.
- **Versión 2** (primera migración real del framework):
  `ALTER TABLE connections ADD COLUMN metadata_schemas TEXT` — restringe qué
  esquemas escanea `GetSchemaMetadata` en Postgres (ver
  [go-react-contract.md](go-react-contract.md), sección "Escaneo de esquemas
  restringido"). Verificada contra un Postgres real en Docker con el patrón de
  script efímero de arriba.
- **Versión 32** (ajustes del chat): `agent_chats.model/effort/mode`, para que
  retomar una conversación la continúe con lo que se venía usando. El modo se
  guarda pero **los permisivos no se restauran solos** — reactivar "podía
  editar" porque se reabrió una pestaña sería conceder un permiso que nadie
  volvió a dar. Verificada en `HOME=$(mktemp -d)`.
- **Versión 31** (historial de chats con agentes): `agent_chats`, con el
  **título cifrado** (se deriva de lo que se le escribió al agente) y el resto
  en claro (ids opacos y fechas). Guarda el PUNTERO a la conversación del CLI,
  no los mensajes. **Hallazgo al verificarla:** su `ON DELETE CASCADE` **no se
  dispara** — este vault no activa `PRAGMA foreign_keys = ON`, así que SQLite
  no aplica las FK. `RemoveGitRepo` borra los chats explícitamente. **El mismo
  defecto afecta a `ssh_command_history`** (migración 29), que declara el mismo
  CASCADE y por lo tanto deja historial huérfano al borrar una conexión: no se
  tocó acá para no arrastrar un cambio ajeno a esta feature, pero está
  pendiente.
- **Versión 30** (banco de trabajo agéntico de la pestaña Git):
  `git_repos.open_files` (rutas de las pestañas del editor, `DEFAULT '[]'` —
  **rutas, nunca contenido**: al reabrir se lee el archivo como está en el
  disco, que es lo único correcto si un agente lo tocó mientras tanto) y
  `git_repos.default_agent` (`DEFAULT ''` = preguntar). Verificada con la
  receta de arriba en un `HOME=$(mktemp -d)`: los defaults llegan bien a una
  fila preexistente, el round-trip sobrevive al reinicio, las columnas
  anteriores quedan intactas y `Unlock` con la clave original sigue
  funcionando — o sea que `vault_meta.verifier` no fue tocado.
