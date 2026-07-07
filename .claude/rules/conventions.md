# Convenciones — mini-tools

## Go

- Paquetes en minúsculas, sin guiones bajos (`vaultgate`, no `vault_gate`).
- Errores: envolver con contexto (`fmt.Errorf("...: %w", err)`), nunca silenciar un error de conexión/cifrado.
- IDs generados con `crypto/rand` + `encoding/hex.EncodeToString`, no `google/uuid` (mantiene mínimas las dependencias).
- Un solo `*sql.DB` por conexión activa, guardado en `pool_manager.go`; nunca abrir una conexión nueva por query.
- Todo método bindeado en `App` que toque el vault o una conexión debe revisar el flag `unlocked` del `vaultgate` antes de ejecutar.
- Nunca loguear (`fmt.Println`, `log.Print*`, etc.) un DSN, un password, ni filas de resultados — ni en rutas de debug.

## Frontend (React/TypeScript)

- Componentes en PascalCase, un componente por archivo, agrupados por dominio bajo `src/components/<dominio>/`.
- **Desviación del plan original:** el estado cross-cutting (tabs abiertas, conexión activa, resultados en streaming, tema) NO vive en Zustand — terminó siendo todo `useState`/props, mayormente concentrado en `Workspace.tsx` y pasado hacia abajo (ver `.claude/specs/architecture.md`). No introducir una librería de estado global nueva salvo que el prop-drilling se vuelva real problema, no solo "se ve feo".
- Componentes gateados por un booleano de mostrar/ocultar (no los que se renderizan siempre) se cargan con `React.lazy` + `Suspense` — ver `ConnectionDialog`/`ExplainPlanPanel` en `Workspace.tsx` como ejemplo. No envolver en lazy algo que se monta incondicionalmente, ni algo que hace falta de inmediato (Monaco).
- **Desviación del plan original:** no hay wrapper `wailsClient.ts` — los componentes importan `../../wailsjs/go/main/App` directamente, es el patrón establecido en todo el código existente.
- Tailwind: usar la clase `dark` en `<html>` como fuente de verdad del tema (ver `@custom-variant dark` en `globals.css`, aplicada por `frontend/src/hooks/useTheme.ts`), nunca depender de `prefers-color-scheme` como estado real de la app. El tema se persiste en el vault (`backend/vault/settings_repo.go`, tabla `settings` sin cifrar) vía `GetSettings`/`SetTheme` — los únicos métodos de `App` que no requieren el vault desbloqueado, ver [.claude/rules/technical.md](technical.md) punto 5.
- **Todo `<button>` (y cualquier otro control interactivo: `<select>`, checkboxes con significado no obvio, iconos clicables) debe llevar `title="..."`.** El texto tiene que explicar QUÉ hace y, cuando no sea obvio, POR QUÉ importa o cuándo usarlo — pensado para alguien que abre la app por primera vez y no conoce el dominio (transacciones, EXPLAIN, vault, etc.), no una repetición del label del botón (`title="Guardar"` sobre un botón "Guardar" no aporta nada). Si el botón cambia de comportamiento según estado (disabled, loading, condicional), el `title` debe reflejar ese estado — ver `regenerateProjectDocs`/el botón "Regenerar CLAUDE.md" en `Workspace.tsx` como ejemplo de tooltip descriptivo, o el botón "Test Connection" en `ConnectionDialog.tsx` como ejemplo de tooltip condicional (nunca dejar la rama "no aplica" en `undefined` — siempre hay que explicar algo). Esto aplica a **toda funcionalidad nueva** de acá en adelante, sin excepción — no es opcional ni se puede dejar "para después".
- **Sistema de diseño: Material Design 3 (post-lanzamiento), ver [.claude/specs/design-system.md](../specs/design-system.md) para el detalle completo — es de lectura obligatoria antes de tocar cualquier estilo.** Reemplazó la paleta neutral de Tailwind. En resumen, para todo componente nuevo o editado:
  - Colores: solo los tokens semánticos del `@theme` (`bg-primary`, `text-on-surface-variant`, `bg-surface-container-high`, etc.) — nunca `neutral-*`/`emerald-*`/`red-*`/`amber-*` de Tailwind directo, esos ya no existen en la paleta activa de la app.
  - Iconos: siempre `<Icon name="..." />` (`frontend/src/components/Icon.tsx`, Material Symbols Outlined self-hosted) — nunca emoji, nunca texto Unicode como ícono (✕, ▸, ⏻, etc.), nunca escribir el `<span className="material-symbols-outlined">` a mano. Verificar que el nombre del ícono existe antes de usarlo (fonts.google.com/icons, familia Outlined) — un nombre inválido renderiza como texto roto sin ningún error.
  - Tipografía: `font-sans` (Hanken Grotesk, texto de UI) y `font-mono` (JetBrains Mono, código/datos/rutas) ya están remapeados globalmente — no hace falta ni hay que declarar una fuente por componente.
  - Todo se sirve local (self-hosted) — la app es 100% offline, nunca agregar un `<link>` a Google Fonts ni ningún otro CDN de assets.

## Testing

- **No escribir tests, ni en backend (`_test.go`) ni en frontend**, para ahorrar tokens. Verificar cada fase manualmente: `go build ./...`, `go vet ./...`, `wails build`, y correr la app (`scripts/start.sh` o `wails dev`) para probar el flujo real.
- Los tests de las Fases 1-3 (`backend/**/*_test.go`) ya existen y se dejan como están — no se borran retroactivamente — pero no se agregan tests nuevos a partir de esta regla en adelante.

## Commits / PRs

- Cada fase del plan (`.claude/specs/`, ver historial de planning) es idealmente un commit o PR separado, con su propio criterio de "listo" verificado antes de pasar a la siguiente.

## CodeGraph

- Este repo tiene `.codegraph/` (índice de símbolos/edges). Después de agregar o eliminar un archivo de código, correr `codegraph sync` para mantener el índice al día antes de seguir trabajando.

## Migraciones del vault

- **Regla dura, no solo convención:** `vault.db` ya está instalado en varias máquinas con datos reales (conexiones, historial, settings). Toda columna o tabla nueva se agrega vía migración — nunca borrando/recreando la base, ni siquiera "momentáneamente" para probar algo local. Ver [.claude/rules/technical.md](technical.md) punto 13.
- Para agregar una migración nueva: agregar una entrada `migration{version: N, ...}` en `backend/vault/migrations.go`, mantenerla aditiva (nunca `DELETE`/`DROP`/mutar filas, nunca tocar `vault_meta`), verificar con el patrón de script efímero sandboxeado (`HOME=$(mktemp -d) go run ./tmp_xxx`, nunca commiteado), y correr `codegraph sync` al final. Ver [.claude/specs/vault-migrations.md](../specs/vault-migrations.md) para el diseño completo y el porqué.
- El `CREATE TABLE IF NOT EXISTS settings (...)` (y demás tablas) en `backend/vault/store.go` está congelado como la definición de la versión 1 — no se le agregan columnas directamente ahí ni para una instalación nueva. Una instalación nueva y una que actualiza deben terminar en el mismo camino: crear la tabla base (versión 1) y después aplicar las mismas migraciones que cualquier otra. Ver `open_tabs`/`sidebar_collapsed`/`editor_height` en `settings` como precedente — ninguna de las tres está en el `CREATE TABLE` de `store.go`, las tres llegaron por `ALTER TABLE ... ADD COLUMN` en `migrations.go`.
