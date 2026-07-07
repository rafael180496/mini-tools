# mini-tools

App de escritorio tipo DataGrip para Oracle/PostgreSQL/SQLite. Go + Wails v2 + React + Tailwind. Sin Electron. Filosofía: simple, minimalista, sin feature bloat.

Ver [readme.md](readme.md) para el spec funcional completo y [.claude/specs/go-react-contract.md](.claude/specs/go-react-contract.md) para el contrato de bindings.

## Stack

- Backend: Go 1.26 + Wails v2
- Frontend: React + TypeScript + Vite + Tailwind CSS v4 (estrategia `dark` por clase, ver `@custom-variant dark` en `frontend/src/styles/globals.css`)
- Oracle: `github.com/sijms/go-ora/v2` (driver `database/sql` `"oracle"`)
- PostgreSQL: `github.com/jackc/pgx/v5/stdlib` (driver `database/sql` `"pgx"`)
- SQLite: `modernc.org/sqlite` (driver `database/sql` `"sqlite"`, puro Go, sin cgo)

## Comandos

Wrappers en [scripts/](scripts/) (ver [scripts/README.md](scripts/README.md) para el detalle de cada uno):

```bash
./scripts/install.sh      # toolchain (Wails CLI) + deps de Go y frontend
./scripts/start-dev.sh    # wails dev — hot reload
./scripts/build.sh        # wails build -clean — build de producción
./scripts/start.sh        # correr el binario ya compilado en build/bin/
./scripts/clean.sh        # borrar build/bin + frontend/dist (--all también node_modules y cache de Go)
```

Equivalentes directos, por si hace falta correrlos sin los wrappers:

```bash
wails dev
wails build -clean

cd frontend && pnpm install   # pnpm SIEMPRE, nunca npm/yarn
cd frontend && pnpm build

go build ./...
go vet ./...
go test ./...
```

## Estructura de carpetas

```
/backend
  /appdata      dir de datos de la app (vault.db, salt.bin)
  /crypto       Argon2id (KDF) + AES-256-GCM (AEAD), zero-out de buffers
  /vaultgate    gate de clave maestra (unlock/lock), key en memoria
  /db           Connector interface + oracle.go/postgres.go/sqlite.go + pool_manager.go + metadata.go
  /vault        store.go + repos (connections, history, plans, settings) sobre SQLite
  /query        detect.go/splitter.go (PL/SQL vs SQL plano) + executor.go (streaming, cancelación)
  /explain      EXPLAIN PLAN por motor → árbol común
  /export       CSV/JSON/XLSX/DDL/config export
  /claudemd     generador de CLAUDE.md + .claude/{skills,specs,rules} para proyectos DE TERCEROS abiertos en la app
app.go          struct App = TODA la superficie de binding Go↔React
main.go         bootstrap de Wails, embed de frontend/dist

/frontend/src
  /state        stores de Zustand (conexiones, tabs, queries, metadata, UI/tema)
  /lib          wailsClient, detección/formato/lint de SQL en cliente
  /monaco       Monaco recortado a SQL (sin CDN), completion/hover providers
  /components   layout, lock, sidebar, connections, editor, results, explain, settings, common
  /hooks        theme, shortcuts, event streaming, metadata
```

Ver el plan completo de fases en `.claude/specs/` y en el historial de planning del usuario.

## Reglas de código

- **pnpm únicamente.** Nunca `npm` ni `yarn`. Node solo se usa para build del frontend, no hay runtime Node en producción.
- **Dark por defecto.** Tailwind `dark` variant vía clase (`@custom-variant dark` en `globals.css`, clase `dark` en `<html>`), nunca `prefers-color-scheme` como fuente de verdad — el tema se persiste en el vault (`settings_repo`, tabla sin cifrar).
- **Sin Electron, sin frameworks extra sobre Wails.** Dependencias mínimas en el backend Go.
- **Sin cgo.** Todas las libs de acceso a datos deben ser pure-Go (`modernc.org/sqlite`, no SQLCipher ni drivers cgo).
- **`database/sql` como única capa de acceso a datos.** Nunca `sqlx` ni acceso directo por paquete de driver — los tres motores se registran como drivers `database/sql` para compartir una sola interfaz `Connector`, un solo pool manager y un solo executor.
- **El frontend nunca ve un DSN ni un password**, solo IDs de conexión opacos. Ningún método bindeado en `App` debe aceptar ni devolver un DSN crudo.
- **Nunca loguear un DSN ni resultados de queries**, ni siquiera en modo debug.
- **Binario de producción objetivo <35MB** (revisado en Fase 4: <20MB no es alcanzable con Oracle+Postgres+SQLite nativos en un solo binario — ver detalle en [.claude/rules/technical.md](.claude/rules/technical.md) punto 8). Verificar con `wails build` + `ls -lh build/bin/*` antes de dar por cerrada una fase que añade dependencias grandes (Monaco, XLSX, etc.).
- **El gate del vault se aplica en Go, server-side** (cada método bindeado revisa un flag `unlocked`), nunca solo en la UI.
- **CodeGraph.** Este repo tiene `.codegraph/` (índice de símbolos/edges). Cada vez que se agregue o elimine un archivo de código, correr `codegraph sync` para mantener el índice al día antes de seguir trabajando.
- **No escribir tests nuevos** (ni backend `_test.go` ni frontend), para ahorrar tokens — verificar cada fase manualmente (build + `wails build` + correr la app). Los tests de Fases 1-3 ya existentes se dejan como están.
- Ver reglas técnicas detalladas y no negociables en [.claude/rules/technical.md](.claude/rules/technical.md), y convenciones generales en [.claude/rules/conventions.md](.claude/rules/conventions.md).

## Skill del proyecto

Los patrones de conectores (interfaz `Connector`, un pool por conexión) y de ejecución de queries (detectar/dividir/streamear/cancelar) están documentados en [.claude/skills/mini-tools-patterns/SKILL.md](.claude/skills/mini-tools-patterns/SKILL.md) — consultarlo antes de añadir un motor o tocar el executor.
