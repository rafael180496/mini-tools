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
- Estado cross-cutting (tabs abiertas, conexión activa, resultados en streaming, tema) vive en stores de Zustand bajo `src/state/`, no en Context ni prop-drilling.
- Componentes no críticos para el arranque (Settings, Export dialogs) se cargan con `React.lazy` + `Suspense`.
- El cliente de Wails se envuelve en `src/lib/wailsClient.ts`; los componentes no importan `../wailsjs/go/main/App` directamente salvo casos triviales de scaffold/smoke-test.
- Tailwind: usar la clase `dark` en `<html>` como fuente de verdad del tema (ver `@custom-variant dark` en `globals.css`), nunca depender de `prefers-color-scheme` como estado real de la app.

## Testing

- **No escribir tests, ni en backend (`_test.go`) ni en frontend**, para ahorrar tokens. Verificar cada fase manualmente: `go build ./...`, `go vet ./...`, `wails build`, y correr la app (`scripts/start.sh` o `wails dev`) para probar el flujo real.
- Los tests de las Fases 1-3 (`backend/**/*_test.go`) ya existen y se dejan como están — no se borran retroactivamente — pero no se agregan tests nuevos a partir de esta regla en adelante.

## Commits / PRs

- Cada fase del plan (`.claude/specs/`, ver historial de planning) es idealmente un commit o PR separado, con su propio criterio de "listo" verificado antes de pasar a la siguiente.
