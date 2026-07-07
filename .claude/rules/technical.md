# Regla técnica — restricciones duras de mini-tools

Estas restricciones son no negociables; cualquier cambio que las viole necesita discutirse explícitamente con el usuario antes de implementarse, no asumirse.

1. **Sin cgo.** Toda dependencia de acceso a datos debe ser pure-Go. `modernc.org/sqlite` sí, SQLCipher o cualquier driver que requiera cgo no. Esto es lo que permite compilar sin toolchain de C y mantener el binario portable.
2. **`database/sql` como única capa de acceso a datos.** Los tres motores (Oracle vía `go-ora/v2`, Postgres vía `pgx/v5/stdlib`, SQLite vía `modernc.org/sqlite`) se registran como drivers `database/sql`. Prohibido usar `sqlx` o el SDK nativo de un motor directamente fuera de `backend/db/`.
3. **Vault: cifrado a nivel de columna, no de archivo.** `vault.db` es una SQLite normal; solo la columna `encrypted_dsn` (+ `nonce`) va cifrada con AES-256-GCM. Cifrar el archivo completo (tipo SQLCipher) está descartado porque requiere cgo.
4. **Derivación de clave: Argon2id, salt fijo por instalación.** La clave maestra nunca se persiste en ningún lado; el salt sí se persiste (en `appdata/salt.bin`) pero por separado del vault.
5. **Gate del vault aplicado server-side.** Cada método bindeado en `App` que toque datos de conexión o del vault debe verificar el flag `unlocked` de `vaultgate` — la UI puede reforzarlo mostrando la pantalla de unlock, pero la verificación real vive en Go.
6. **Monaco recortado a SQL, sin CDN.** Importar solo `monaco-editor/esm/vs/editor/editor.api` + `basic-languages/sql/sql.contribution`; el worker de Vite se cablea a mano. Nunca usar el loader por defecto de `@monaco-editor/react` que descarga desde CDN — la app debe funcionar offline.
7. **Sin librería de parsing SQL.** La detección de PL/SQL, el split de statements y el linter básico son hechos a mano (`backend/query/detect.go`, `splitter.go`, `frontend/src/lib/linter.ts`). Librerías tipo vitess sqlparser / pg_query_go / gramáticas ANTLR quedan descartadas por peso y por no cubrir Oracle+Postgres+SQLite a la vez.
8. **Binario de producción <20MB.** Verificar con `wails build` + `ls -lh build/bin/*` (macOS) en cada fase que añade una dependencia grande (Monaco, `excelize`, etc.). Estado actual del scaffold (Fase 1): ~7.6MB.
9. **El frontend nunca ve un DSN ni un password.** Solo IDs de conexión opacos cruzan el binding Go↔React.
10. **Nunca loguear un DSN ni resultados de queries**, tampoco en modo debug.
11. **pnpm únicamente** para el frontend; sin Node como runtime en producción.
