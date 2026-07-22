# mini-tools — spec funcional completo

> Este es el spec funcional original del proyecto (features, arquitectura, reglas de código). El `README.md` en la raíz es la presentación pública del repo (instalación, uso); este documento es la fuente de verdad detallada que sigue Claude Code fase a fase — ver [CLAUDE.md](../CLAUDE.md) y [.claude/specs/go-react-contract.md](../.claude/specs/go-react-contract.md).

App escritorio. Go + Wails + React + Tailwind. Sin Electron.

Filosofía: simple, minimalista, fácil uso, rápido. No feature bloat.

## Stack

- Backend: Go + Wails v2
- Frontend: React + Tailwind, UX minimalista
- Oracle: github.com/sijms/go-ora (nativo, sin cliente Oracle instalado)
- PostgreSQL: jackc/pgx
- SQLite: modernc.org/sqlite (puro Go, sin cgo)

## Requisitos

- Go: última versión estable (go.mod `go 1.2X`, check release actual)
- pnpm. Nunca npm, nunca yarn
- Node solo para build frontend, no runtime en prod

## Performance / Peso

- Binario final target <80MB (revisado cuatro veces: Fase 4 — el conector Oracle vía `go-ora` obliga a `crypto/tls`, que desde Go 1.24 arrastra el módulo FIPS 140-3 completo, ~15MB extra inevitables sin renunciar a soporte Oracle nativo; Fase 6 — el core de Monaco recortado a SQL pesa ~4MB por sí solo, inherente a la librería; 45MB→60MB tras el agregado de Redis; 60MB→80MB en 0.4.0 con SQL Server + MongoDB. <20MB no es alcanzable con los motores nativos + editor en un solo binario. El número vigente y el detalle de cada medición viven en [.claude/rules/technical.md](../.claude/rules/technical.md) punto 8 — esta línea es un resumen, no la fuente de verdad)
- Sin librerías pesadas (no ag-grid enterprise, no lodash completo, tree-shake todo)
- Monaco: cargar solo lenguaje SQL, no bundle completo
- Lazy load componentes no críticos (settings, export dialogs)
- Deps mínimas backend Go, sin frameworks extra sobre Wails

## Dark mode

- Default: dark
- Toggle dark/light, Tailwind `dark:` class strategy
- Tema persiste en vault (config local, no encriptado)
- Monaco theme sync con tema app

## Conectores

- Test ping antes guardar. Botón "Test Connection"
- Sin ping ok → warning, guarda igual si usuario fuerza
- N conectores ilimitados, cada uno: nombre custom + tipo + icono color
- Lista conectores sidebar, buscar/filtrar por nombre

## Historial archivos

- Recent files: últimos .sql abiertos, path + fecha
- Click recent → reabre tab directo
- Persiste en vault (config local, no encriptado)
- Limpiar historial: botón manual

## Regla: CLAUDE.md

App debe generar CLAUDE.md en raíz proyecto, automático, no manual.

CLAUDE.md contiene:
- Stack, comandos build/dev
- Estructura carpetas
- Reglas código (pnpm only, dark default, no Electron, etc)
- Auto-genera: skill (patrones conectores/queries), spec (contrato Go↔React), rule (convenciones)

Claude Code lee CLAUDE.md primero, sigue reglas sin repetir contexto cada sesión.

## Vault de conexiones

Conn strings guardan en SQLite encriptado local.

- Inicio app → pide clave maestra
- Clave deriva key con Argon2id (salt fijo por instalación, guardado aparte)
- Vault descifra con AES-256-GCM en memoria, nunca disco plano
- Sin clave correcta → no arranca, no hay bypass
- Clave no se guarda en ningún lado. Se pierde → se pierde vault

Estructura tabla vault:

```sql
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  db_type TEXT NOT NULL, -- oracle | postgres | sqlite
  encrypted_dsn BLOB NOT NULL,
  nonce BLOB NOT NULL,
  created_at INTEGER
);
```

## Reglas de conexión

- Un pool por conexión activa, no reabrir cada query
- Timeout default: 30s. Configurable por conexión
- Oracle: soporta TNS, Easy Connect, SID y Service Name
- Postgres: soporta SSL modes completos vía pgx config
- SQLite: modo WAL activado siempre
- Cerrar pool al cambiar/eliminar conexión

## Ejecución de queries

- Query normal y bloque PL/SQL en mismo editor, detecta tipo por sintaxis (BEGIN/END, DECLARE)
- Oracle: ejecuta bloques anónimos vía go-ora, captura DBMS_OUTPUT si está habilitado
- Resultados: streaming a UI, no cargar todo en memoria si son muchas filas
- Cancelación de query en curso obligatoria (context.CancelFunc)
- Historial de queries por conexión, guardado en el mismo SQLite vault (tabla separada, no encriptada)

## Estructura proyecto

```
/backend
  /db
    oracle.go
    postgres.go
    sqlite.go
    vault.go
  /crypto
    argon2.go
    aesgcm.go
  main.go
/frontend
  /src
    /components
    /hooks
    App.tsx
  tailwind.config.js
wails.json
```

## Editor SQL

- Monaco Editor (motor VSCode), no CodeMirror
- Abrir archivo .sql local, editar, guardar (Ctrl+S)
- Múltiples tabs: archivos abiertos + queries sueltas sin guardar
- Syntax highlight SQL + PL/SQL
- Intellisense:
  - Autocomplete tablas/columnas/schemas desde metadata conexión activa
  - Autocomplete keywords SQL, funciones Oracle/Postgres
  - Snippets: SELECT, INSERT, procedimientos PL/SQL
  - Hover tooltip: tipo columna, nullable, FK
  - Cache metadata por conexión, refresh manual (botón/F5)
- Format SQL (prettier-sql o sql-formatter)
- Multi-cursor, find/replace, minimap igual VSCode

## Export

- Grid resultados: CSV, JSON, Excel (xlsx), copiar INSERT/UPDATE
- Export estructura tabla: DDL (CREATE TABLE)
- Export schema completo: script DDL todas tablas/vistas/índices
- Export conexión (sin password): para compartir config

## Análisis SQL

- EXPLAIN PLAN / EXPLAIN ANALYZE integrado, botón dedicado
- Mostrar plan como árbol visual, no solo texto crudo
- Detectar full table scan, warning visual
- Estadísticas post-ejecución: filas, tiempo, I/O si el motor lo expone
- Historial de planes por query guardado en vault (tabla local)
- Linter básico SQL: detectar SELECT *, falta WHERE en UPDATE/DELETE, warning antes de ejecutar

## UI tipo DataGrip

- Sidebar izq: árbol conexiones → schemas → tablas/vistas
- Panel centro: editor SQL, tabs, una tab por query
- Panel resultados abajo: grid tabla, resize columna, sort click header
- Grid virtualizado, miles filas sin lag
- Múltiples result-tabs si bloque PL/SQL devuelve varios cursores
- Barra estado: filas devueltas, tiempo ejecución, conexión activa
- Export grid: CSV, JSON, copiar como INSERT
- Doble click tabla en árbol → SELECT * LIMIT 100 auto
- Atajo: Ctrl+Enter ejecuta línea/selección, Ctrl+Shift+Enter ejecuta bloque

Stack grid: @tanstack/react-table + virtualización manual. Nada ag-grid enterprise, pesado.

## Bindings Go → React

Exponer solo métodos necesarios en struct App. Nada de SQL crudo desde frontend sin pasar por capa backend. Frontend nunca ve el DSN, solo id de conexión.

## Seguridad

- No loguear DSN nunca, ni en debug
- No loguear resultados de queries a disco
- Limpiar buffers de memoria con clave tras derivar (zero out)
- Sin clave hardcodeada, sin default password