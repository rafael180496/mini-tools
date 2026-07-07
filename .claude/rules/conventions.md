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

## Testing

- **No escribir tests, ni en backend (`_test.go`) ni en frontend**, para ahorrar tokens. Verificar cada fase manualmente: `go build ./...`, `go vet ./...`, `wails build`, y correr la app (`scripts/start.sh` o `wails dev`) para probar el flujo real.
- Los tests de las Fases 1-3 (`backend/**/*_test.go`) ya existen y se dejan como están — no se borran retroactivamente — pero no se agregan tests nuevos a partir de esta regla en adelante.

## Commits / PRs

- Cada fase del plan (`.claude/specs/`, ver historial de planning) es idealmente un commit o PR separado, con su propio criterio de "listo" verificado antes de pasar a la siguiente.

## CodeGraph

- Este repo tiene `.codegraph/` (índice de símbolos/edges). Después de agregar o eliminar un archivo de código, correr `codegraph sync` para mantener el índice al día antes de seguir trabajando.

## Migraciones del vault

- Para agregar una migración nueva: agregar una entrada `migration{version: N, ...}` en `backend/vault/migrations.go`, mantenerla aditiva (nunca `DELETE`/`DROP`/mutar filas, nunca tocar `vault_meta`), verificar con el patrón de script efímero sandboxeado (`HOME=$(mktemp -d) go run ./tmp_xxx`, nunca commiteado), y correr `codegraph sync` al final. Ver [.claude/specs/vault-migrations.md](../specs/vault-migrations.md) para el diseño completo y el porqué.
