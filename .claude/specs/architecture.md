# Arquitectura actual — mini-tools

> Esto documenta el estado ACTUAL del código, mantenido a mano fase a fase. Para la intención funcional original (lo que se planeó construir, no siempre idéntico a lo que terminó existiendo — ver notas de desviación en [go-react-contract.md](go-react-contract.md) y en el [SKILL](../skills/mini-tools-patterns/SKILL.md)), ver [docs/SPEC.md](../../docs/SPEC.md).

## Stack

- Backend: Go 1.26 + Wails v2
- Frontend: React + TypeScript + Vite + Tailwind CSS v4 (estrategia `dark` por clase, ver `@custom-variant dark` en `frontend/src/styles/globals.css`)
- Oracle: `github.com/sijms/go-ora/v2` (driver `database/sql` `"oracle"`)
- PostgreSQL: `github.com/jackc/pgx/v5/stdlib` (driver `database/sql` `"pgx"`)
- SQLite: `modernc.org/sqlite` (driver `database/sql` `"sqlite"`, puro Go, sin cgo)

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

/build
  appicon.png   ícono maestro 1024x1024 (con fondo transparente fuera del rounded-square) — `wails build` genera el .icns/.ico de cada plataforma a partir de este archivo. Reemplazar este archivo (y borrar build/windows/icon.ico si existe) para cambiar el ícono de la app.
  /darwin       Info.plist / Info.dev.plist de macOS
  /windows      manifest, info.json, instalador NSIS

/frontend
  /img          assets de origen sin procesar (ej. el mockup completo del logo) — no se importan directo en el código
  /public       archivos estáticos servidos tal cual por Vite (favicon.png)
  /src/assets   assets optimizados que sí se importan desde componentes (logo.png recortado/con transparencia, ~256px)

/frontend/src
  /hooks        useTheme.ts (única fuente de verdad del tema, llamado una vez en App.tsx) — no hay stores de Zustand, ver la nota de desviación abajo
  /lib          detección/formato/lint de SQL en cliente (sin wrapper de wailsClient — los componentes importan ../../wailsjs/go/main/App directo)
  /monaco       Monaco recortado a SQL (sin CDN), completion/hover providers
  /components   lock, sidebar, connections, editor, results, explain — sin carpeta /layout ni /settings dedicadas (el toggle de tema vive inline en el toolbar de Workspace.tsx, no hay un SettingsDialog separado)
```

**Desviación del plan original:** la superficie de estado global se planeó con Zustand (`/state`) y un wrapper `wailsClient.ts`. En la práctica ninguno de los dos se necesitó — todo el estado del frontend es `useState`/props (ver `Workspace.tsx`), y los componentes importan `../../wailsjs/go/main/App` directamente. Ver [.claude/skills/mini-tools-patterns/SKILL.md](../skills/mini-tools-patterns/SKILL.md) sección "Fase 10" para el detalle de por qué se mantuvo así.

Ver el contrato completo de bindings Go↔React en [go-react-contract.md](go-react-contract.md), y el historial de decisiones/desviaciones fase por fase ahí mismo y en el SKILL del proyecto.
