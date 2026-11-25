# Plan de Rediseño UX — `mini-tools` como Agent Development Environment (ADE)

> **Estado:** Completado (Fases F0–F8 + Fase 9 Unificación ADE F9.1–F9.4 + migración SQLite 66 implementadas y verificadas).
> **Propósito:** Evolucionar la UX de `mini-tools` hacia un **ADE de doble harness** que potencia al máximo ambos flujos agénticos:
> 1. **Chat Harness UX** (inspirado en *Deck*): chat limpio y enfocado en modo `Pareja` (lado a lado con editor/BD/diff) o `Chat` (pantalla completa), con tool-calls colapsables, aprobaciones y contexto `@`.
> 2. **Terminal Harness UX** (inspirado en *Herdr*): mosaico/grid multi-agente sobre terminales PTY reales (`backend/localterm` + `backend/agents` + `xterm.js`), para correr varios CLIs agénticos en paralelo (Claude Code, Codex, Antigravity, OpenCode, shells) con lista viva de agentes (`running` / `idle`) y paneles rápidos de `Files` y `Changes`.
>
> **Regla base:** Se conservan el **100% de los 6 módulos y features existentes** (`connections`, `ssh`, `git`, `notes`, `http`, `utilities`), nuestra paleta **Material Design 3** (claro y oscuro), la arquitectura pure-Go sin `cgo`, y el sistema de escalado y tamaños (`--ui-font-scale`, `auto size`, `custom size`).
>
> **Formato:** **9 fases independientes (F0–F8)** diseñadas para ejecutarse secuencialmente con cualquier LLM (Claude Code, Codex, Antigravity, OpenCode). Al terminar cada fase, actualizar la tabla de progreso abajo.

---

## Progreso por Fase (actualizar al cerrar cada fase)

| Fase | Nombre | Estado | Notas / Commit |
| --- | --- | --- | --- |
| F0 | Fundación de Tokens MD3, Layout State y `ResizeHandle` Bi-direccional | `[x] Completada` | `globals.css`, `useLayoutMode.ts`, `ResizeHandle.tsx` |
| F1 | Top Bar Unificada (`TitleBar` ADE + `⌘K` + 4 Modos + `Files`/`Changes`) | `[x] Completada` | `TitleBar.tsx`, `CommandPalette.tsx`, `App.tsx`, `Workspace.tsx`, `i18n`, `CHANGELOG.md`, `index.html`/`es/index.html` |
| F2 | Activity Rail Izquierdo + Explorador Limpio + Spaces & Agentes Vivos | `[x] Completada` | `ActivityRail.tsx`, `Sidebar.tsx`, `Workspace.tsx`, `i18n`, `CHANGELOG.md` (`SpacesAgentsPanel.tsx` se creó y la F9 lo absorbió en `ProjectExplorer.tsx`: ya no existe) |
| F3 | Chat Harness UX (Modos `Pareja` y `Chat`) | `[x] Completada` | `AgentChatHost.tsx`, `ToolCallCard.tsx`, `TitleBar.tsx`, `App.tsx`, `Workspace.tsx`, `CHANGELOG.md` |
| F4 | Terminal Harness UX: Multi-Agent PTY Grid (Modo `Terminales`) | `[x] Completada` | `TerminalGridHost.tsx`, `Workspace.tsx`, `ActivityRail.tsx`, `Sidebar.tsx`, `globals.css`, `i18n/terminal.ts`, `CHANGELOG.md` |
| F5 | Rail Derecho + Dock Inferior Unificado | `[x] Completada` | `Workspace.tsx`, `i18n/shell.ts` (`AgentRightRail.tsx` se creó y la F9 lo reemplazó por el explorador unificado: ya no existe; el dock inferior no se implementó) |
| F6 | Status Bar Inferior + Control Rápido de Escala y Estado Agéntico | `[x] Completada` | `StatusBar.tsx`, `Workspace.tsx`, `i18n/shell.ts`, `CHANGELOG.md` |
| F7 | Rediseño del Logo e Identidad Visual ADE | `[x] Completada` | Opción B (guacamaya ADE 3×3): `build/appicon.png`, `frontend/src/assets/logo.png`, `frontend/public/favicon.png`, `CHANGELOG.md` |
| F8 | Pulido de los 6 Módulos Existentes (Oscuro y Claro) + QA Final | `[x] Completada` | `index.html`, `es/index.html`, `design-system.md`, `Sidebar.tsx`, capturas `help-shots.sh` + QA `100%`/`150%` |
| F9.1 | Switcher `Proyectos ▾` en Top Bar + Explorador Unificado (Archivos / Ramas / Agentes) | `[x] Completada` | `TitleBar.tsx`, `ProjectExplorer.tsx`, `App.tsx`, `Workspace.tsx` |
| F9.2 | Layout Maestro tipo *Deck* en `GitRepoTab` (Editor + Terminal abajo + Agente a la derecha) | `[x] Completada` | `GitRepoTab.tsx` (`adeMode` + `openFileRequest`) |
| F9.3 | Experiencia de Edición y Lenguajes + Búsqueda de archivos en `⌘K` | `[x] Completada` | `CommandPalette.tsx` (grupo `files`), `Workspace.tsx` (`GitListWorkTree`) |
| F9.4 | Limpieza de duplicados (`hub` rail), SQLite migración 66 y QA | `[x] Completada` | `ActivityRail.tsx`, `migrations.go` (v66), `settings_repo.go`, `app.go`, `useSidebarVisibility.ts`, `CHANGELOG.md` |

### Bitácora de avances (Handoff entre LLMs)
> **Regla obligatoria para cada agente/LLM:** Al terminar una fase (o dejar trabajo en progreso), actualiza el estado en la tabla superior (`[x] Completada` / `[~] En progreso`) y agrega una entrada abajo con:
> - **Fase y fecha**
> - **Archivos creados / modificados**
> - **Decisiones técnicas o desviaciones respecto al plan**
> - **Verificaciones corridas** (`pnpm build`, `i18n-check.sh`, `go test`, `uishot.sh`)
> - **Siguiente paso exacto** para el próximo LLM

- *(2026-11-25)* **Plan inicial creado (F0–F8).** Spec guardado en `.claude/specs/ux-ade-redesign.md` e indexado en `CLAUDE.md`. Siguiente paso: iniciar **Fase 0**.
- *(2026-11-25)* **Fase 0 completada.**
  - **Archivos creados/modificados:**
    - `frontend/src/styles/globals.css`: utilidades `@utility ade-pane`, `ade-pane-sunken`, `ade-tile` (con `[data-focused='true']`) y `ade-rail-btn` (con `[data-active='true']`), todas sobre tokens MD3 y `var(--radius-xl)`.
    - `frontend/src/hooks/useLayoutMode.ts` *(nuevo)*: estado de 4 modos ADE (`work` | `pair` | `chat` | `terminals`), visibilidad de paneles (`leftOpen`, `bottomOpen`, `rightOpen`, `gridFilesOpen`, `gridChangesOpen`), tamaños explícitos `auto`/`custom` (`PanelSize`, `GridRatioSize`), helpers (`resolvePanelSize`, `autoPanelPx`, `clampPx`) y persistencia defensiva en `localStorage` (`mini-tools:ade-layout:v1`).
    - `frontend/src/components/ResizeHandle.tsx`: extendido con `orientation?: 'vertical' | 'horizontal'`, `edge?: 'right' | 'left' | 'top' | 'bottom'`, `isAuto`, `onResetAuto` (doble clic / Enter vuelve a `auto`) y `unit` configurable, manteniendo 100% compatibilidad con usos existentes.
  - **Verificaciones:** `cd frontend && pnpm build` (`tsc && vite build`, OK en 332ms) y `./scripts/i18n-check.sh` (0 pendientes).
  - **Siguiente paso:** Iniciar **Fase 1 — Top Bar Unificada (`TitleBar.tsx`, `CommandPalette.tsx`, 4 modos ADE + botones `Files`/`Changes` en modo `Terminales`)**.
- *(2026-11-25)* **Fase 1 completada.**
  - **Archivos creados/modificados:**
    - `frontend/src/components/CommandPalette.tsx` *(nuevo)*: modal `⌘K` / `Ctrl+K` con búsqueda sin acentos y navegación por teclado (`↑`/`↓`/`Enter`/`Esc`), agrupando modos ADE, pestañas abiertas, conexiones y acciones rápidas.
    - `frontend/src/components/TitleBar.tsx`: Top Bar ADE cuando el vault está desbloqueado (logo + pill de contexto activo, trigger `⌘K`, switcher de 4 modos `Trabajo | Pareja | Chat | Terminales`, y botones `Archivos`/`Cambios` en modo `Terminales`), respetando `TITLE_BAR_MAC_INSET = 72` en macOS y controles de ventana en Windows/Linux.
    - `frontend/src/App.tsx` y `frontend/src/components/Workspace.tsx`: estado `useLayoutMode()` elevado a `App.tsx` y conectado con props opcionales a `Workspace` (100% compatible con `uishot.tsx`), atajos globales `⌘K` y `⇧⌘1–4`.
    - `frontend/src/i18n/{es,en}/shell.ts`: textos completos de Top Bar ADE y Command Palette.
    - `CHANGELOG.md` (`[Unreleased]`): entradas de dependencias actualizadas y Top Bar ADE + `⌘K`.
    - `index.html` y `es/index.html` (`#atajos`): documentados `⌘K` y `⇧⌘1–4` en ambos idiomas.
  - **Verificaciones:** `cd frontend && pnpm build`, `./scripts/i18n-check.sh` (0 pendientes) y paridad de `id`s entre `index.html` y `es/index.html`.
  - **Siguiente paso:** Iniciar **Fase 2 — Activity Rail Izquierdo + Explorador Limpio + Panel de Spaces y Agentes Vivos**.
- *(2026-11-25)* **Fase 2 completada.**
  - **Archivos creados/modificados:**
    - `frontend/src/components/sidebar/ActivityRail.tsx` *(nuevo)*: rail vertical permanente (`w-11`) con los 6 módulos originales, badges de búsqueda/actividad, botón dedicado de **Espacios y Agentes** (`hub`) con badge `tertiary`/`secondary`, y controles globales al pie (tema, ayuda, configuración, marca).
    - `frontend/src/components/sidebar/SpacesAgentsPanel.tsx` *(nuevo)*: panel lateral estilo *Herdr* con lista de **Espacios** (`GitListRepos`) y **Agentes vivos** (`useAgentSessions()`) ordenados por prioridad (`awaiting_approval` → `running` → `error` → `idle`), tiempo transcurrido y clic para enfocar/abrir sesión.
    - `frontend/src/components/sidebar/Sidebar.tsx`: refactorizado para montar `ActivityRail` + panel Explorador colapsable sin desmontar los 6 árboles, y usando `ResizeHandle` con `auto`/`custom` size (doble clic / Enter vuelve a `SIDEBAR_WIDTH_DEFAULT`).
    - `frontend/src/components/Workspace.tsx`: cableado de `ResizeHandle` (`onResizeWidth`, `onCommitWidth`, `isAutoWidth`, `onResetAutoWidth`) y `SpacesAgentsPanel`.
    - `frontend/src/i18n/{es,en}/shell.ts` y `CHANGELOG.md` (`[Unreleased]`).
  - **Verificaciones:** `cd frontend && pnpm build` y `./scripts/i18n-check.sh` (0 pendientes).
  - **Siguiente paso:** Iniciar **Fase 3 — Chat Harness UX (Estilo Deck — Modos `Pareja` y `Chat`)**.
- *(2026-11-25)* **Fase 3 completada.**
  - **Archivos modificados:**
    - `frontend/src/components/agent/AgentChatHost.tsx`: integrado con `adeMode` (`pair` acopla a la derecha con `ResizeHandle` `auto`/`custom`, `chat` expande la misma instancia montada al 100% ocultando `children` por CSS sin desmontar streams ni el editor).
    - `frontend/src/components/agent/ToolCallCard.tsx`: tarjeta colapsable refinada al estilo limpio ADE sobre tokens MD3.
    - `frontend/src/components/TitleBar.tsx`, `frontend/src/App.tsx`, `frontend/src/components/Workspace.tsx`: `hasGitContext` en Top Bar para ocultar controles de repositorio (`Archivos`/`Cambios`) en módulos sin fuentes (SQL, Mongo, Redis, SSH, Notas, HTTP), y `isAutoSize`/`onResetAutoSize` en `AgentChatHost`.
    - `CHANGELOG.md` (`[Unreleased]`) y Matriz de Adaptación por Módulo añadida a este spec.
  - **Verificaciones:** `cd frontend && pnpm build` y `./scripts/i18n-check.sh` (0 pendientes).
  - **Siguiente paso:** Iniciar **Fase 4 — Terminal Harness UX: Multi-Agent PTY Grid (Modo `Terminales`)**.
- *(2026-11-25)* **Fase 4 completada.**
  - **Archivos creados/modificados:**
    - `frontend/src/components/terminal/TerminalGridHost.tsx` *(nuevo)*: mosaico multi-agente sobre `LocalTerminalPanel` (`go-pty` + `xterm.js`), lanzador en 1 clic de CLIs agénticos instalados + Shell local, selector de Space/Repo destino, presets `Auto` / `1×` / `2×` / `3×`, duplicar/maximizar/restaurar/cerrar por tile sin matar procesos PTY.
    - `frontend/src/components/Workspace.tsx`: montaje keep-alive de `TerminalGridHost` en modo `terminals` (ocultando el canvas normal por CSS sin desmontar editor ni chat) + framing visual ADE de paneles redondeados (`ade-pane` / `ade-pane-sunken` con `gap-1.5 p-1.5`).
    - `frontend/src/styles/globals.css`, `ActivityRail.tsx`, `Sidebar.tsx`: acabado visual alineado a las referencias *Deck*/*Herdr* (paneles redondeados con borde sutil sobre `bg-background` y botones circulares limpios en el rail sobre tokens MD3).
    - `frontend/src/i18n/{es,en}/terminal.ts` y `CHANGELOG.md` (`[Unreleased]`).
  - **Verificaciones:** `cd frontend && pnpm build` y `./scripts/i18n-check.sh` (0 pendientes).
  - **Siguiente paso:** Iniciar **Fase 5 — Rail Derecho + Dock Inferior Unificado**.
- *(2026-11-25)* **Fases 5 y 6 completadas.**
  - **Archivos creados/modificados:**
    - `frontend/src/components/agent/AgentRightRail.tsx` *(nuevo)*: rail derecho circular (`w-11`, `.ade-pane`) con accesos a Spaces/Agentes (badges `tertiary`/`secondary`), modos Pareja/Chat/Terminales, nueva ventana de Chat IA y ajustes de agentes (`SettingsDialog` sección `ai`).
    - `frontend/src/components/StatusBar.tsx` *(nuevo)*: barra de estado inferior (`h-7`) con repo/conexión BD activa, contador de agentes vivos, popover de escala UI (`90–150%` + input `custom` `80–200%` + reset `100%`) sincronizado con `useUIFontScale`, y versión (`AppVersion` + aviso de update).
    - `frontend/src/components/Workspace.tsx`, `frontend/src/i18n/{es,en}/shell.ts`, `CHANGELOG.md` (`[Unreleased]`).
  - **Verificaciones:** `cd frontend && pnpm build` y `./scripts/i18n-check.sh` (0 pendientes).
  - **Siguiente paso:** Iniciar **Fase 7 — Rediseño del Logo e Identidad Visual ADE** y luego **Fase 8 — Pulido de los 6 Módulos Existentes + QA Final**.
- *(2026-11-25)* **Mejora transversal de `Select.tsx` (buscador integrado + estilo MD3):**
  - `frontend/src/components/Select.tsx`: buscador automático sin acentos (`searchable`, activo por defecto en listas de 8+ opciones), navegación por teclado (`↑`/`↓`/`↵`/`Esc`), menú flotante `rounded-xl` con bordes y elevación MD3.
  - `frontend/src/components/terminal/TerminalGridHost.tsx`: reemplazado el `<select>` nativo de Espacios/Repositorios por `<Select searchable />`.
  - Propuestas de logo de guacamaya ADE (Opción A 2×2 y Opción B 3×3) listas para aprobación del usuario antes de reemplazar `build/appicon.png`, `frontend/src/assets/logo.png` y `frontend/public/favicon.png`.
- *(2026-11-25)* **Fase 7 completada (Rediseño de Logo — Opción B aprobada).**
  - **Archivos actualizados:**
    - `build/appicon.png` (`1024×1024`, RGBA con fondo exterior transparente alrededor del squircle).
    - `frontend/src/assets/logo.png` (`256×256`, RGBA transparente).
    - `frontend/public/favicon.png` (`64×64`, RGBA transparente).
    - Eliminado `build/windows/icon.ico` antiguo para que `wails build` lo regenere desde `build/appicon.png`.
    - `CHANGELOG.md` (`[Unreleased]`).
  - **Verificaciones:** `cd frontend && pnpm build`, `./scripts/i18n-check.sh`, `go build ./... && go vet ./...`.
  - **Siguiente paso:** Ejecutar **Fase 8 — Pulido de los 6 Módulos Existentes (Oscuro y Claro), actualización completa del Centro de Ayuda (`index.html`, `es/index.html` y capturas vía `./scripts/help-shots.sh`) y QA Final**.
- *(2026-11-25)* **Fase 8 completada (Plan ADE F0–F8 cerrado).**
  - **Archivos actualizados:**
    - `index.html` y `es/index.html`: documentado todo el nuevo UX ADE en `#la-ventana` (`#la-ventana--modos-ade`, `#la-ventana--terminales-grid`, `#la-ventana--rails-status`, `Select` con buscador y `ResizeHandle` `auto`/`custom`) con paridad 100% de `id`s.
    - `.claude/specs/design-system.md`: documentadas utilidades ADE, `Select.tsx` con buscador y nuevo logo de la guacamaya.
    - `frontend/src/components/sidebar/Sidebar.tsx`: eliminado `SidebarFooter` duplicado del explorador (ya cubierto por `ActivityRail` + `StatusBar`).
    - Capturas regeneradas en inglés y español (`ui-workspace`, `sidebar-modules`, `unlock-vault`) y QA visual en `UISHOT_SCALE=100` y `UISHOT_SCALE=150`.
  - **Verificaciones:** `cd frontend && pnpm build`, `./scripts/i18n-check.sh`, `diff` de `id`s en ayuda, `go build ./... && go vet ./...`.
- *(2026-11-25)* **Revisión posterior al cierre (bugs y deuda).**
  - **Atajos de modo:** `⌃⌘1–4` en macOS (⇧⌘3/⇧⌘4 son capturas de pantalla del sistema y nunca llegan a la app) y `Ctrl+Shift+1–4` en Windows/Linux, detectados por `e.code` (`Digit1`…): con Mayús, `e.key` es el símbolo y dependía del teclado. Helpers `adeModeShortcut` / `adeModeFromKeyEvent` en `useLayoutMode.ts`.
  - **`Ctrl+K`** no abre la paleta con el foco en una terminal (xterm): es «borrar hasta el final de la línea» de la shell.
  - **Paleta:** busca en todos los archivos del proyecto (antes cortaba a 400 ANTES de filtrar) y muestra hasta 50 por grupo; texto de búsqueda precalculado; foco atrapado (Tab), roles combobox/listbox con `aria-activedescendant` y la opción resaltada siempre visible.
  - **`Select`:** el buscador ya no se vacía con un re-render del padre (se resetea solo al abrir), las flechas saltan las opciones deshabilitadas y la resaltada queda a la vista.
  - **Mosaico:** cerrar una celda de agente pide confirmación (mata el proceso).
  - **Módulos ocultos:** si guardar en vault.db falla, la barra vuelve atrás y Configuración lo avisa; con Git oculto, abrir un repo ya no fuerza el módulo Git.
  - **Deuda:** `useLayoutMode` recortado a lo que se usa (modo y drawers del mosaico): `leftOpen`, `rightOpen`, `bottomOpen`, tamaños `auto`/`custom` y proporciones del grid no tenían consumidores. Test de la migración 66 y de `SetHiddenSidebarModules`; los tests de migraciones comparan contra `latestMigrationVersion()` en vez de `>= 65`.

---

## 1. Principios de Diseño y Reglas No Negociables

Antes de ejecutar cualquier fase, leer [design-system.md](design-system.md), [architecture.md](architecture.md) y [technical.md](../rules/technical.md).

1. **Cero pérdida de features:** Todos los módulos, bindings de `app.go`, vault cifrado, servidor MCP embebido e i18n (`en`/`es`) se mantienen intactos. Es un rediseño del shell y de la experiencia de los dos harness.
2. **Nuestra paleta MD3 (claro y oscuro, sin hardcodear colores de referencia):**
   - `primary` / `primary-container` → modo activo en Top Bar, tile/sesión enfocada en el grid de terminales, burbuja del usuario en chat, rail activo.
   - `secondary` (verde/menta) → agente activo/running, CTAs de ejecución (`Ejecutar`, `Commit`), tests en verde, conexión/MCP activos.
   - `tertiary` (naranja) → agente esperando aprobación (`waiting approval`), transacciones abiertas, warnings.
   - `error` → fallo de proceso/comando, errores, rollback, cerrar.
   - `surface-container-lowest` / `-low` / `-default` / `-high` / `-highest` + `border-outline-variant` → paneles tipo *card* y celdas del grid de terminales con bordes limpios tanto en modo oscuro como en modo claro.
3. **Escalado de interfaz (`--ui-font-scale`):**
   - Prohibido usar `text-[Npx]` fijos; usar siempre escala Tailwind (`text-xs`..`text-xl`) o `@utility text-ui-9..15`.
   - Todos los íconos vía `<Icon name="..." size={N} />` (Material Symbols Outlined self-hosted).
   - Las terminales PTY siguen usando `settings.terminalFontSize` de forma independiente al texto de la UI, con auto-fit (`@xterm/addon-fit`) al redimensionar cada tile.
4. **Sistema de tamaños (`size`, `auto size`, `custom size`):**
   - Todos los paneles y divisores del grid usan `ResizeHandle.tsx`:
     - **`auto size`:** distribución proporcional automática según modo ADE, número de tiles y tamaño de ventana (doble clic en cualquier divisor o botón reset vuelve a `auto`).
     - **`custom size`:** tamaño arrastrado manualmente (o con teclado) persistido con `clamp(min, max)` seguro.
5. **i18n obligatorio:** Todo texto nuevo entra en `frontend/src/i18n/{en,es}.ts` y debe pasar `./scripts/i18n-check.sh`.

---

## 2. Los 4 Modos ADE en la Top Bar

| Modo | Enfoque principal | Qué muestra |
| --- | --- | --- |
| **Trabajo** (`work`) | Editor / BD / HTTP / Notes / SSH | Rail Izquierdo + Explorador + Canvas Central + Dock inferior (Resultados / EXPLAIN / Terminal rápida). |
| **Pareja** (`pair`) | Código/BD + **Chat Harness** lado a lado | Canvas Central + Chat Harness acoplado a la derecha (`auto`/`custom` width). |
| **Chat** (`chat`) | **Chat Harness** a ancho completo | Conversaciones headless, tool calls colapsables, historial, `@` contexto y aprobaciones sin distracciones. |
| **Terminales** (`terminals`) | **Terminal Harness** (Multi-Agent PTY Grid) | Mosaico de N terminales agénticas PTY en paralelo (`1×1`, `2×1`, `2×2`, `3×2` o splits libres), lista de Spaces + Agentes vivos a la izquierda y drawers rápidos de `Files` y `Changes` a la derecha (solo si hay contexto Git). |

### Matriz de Adaptación por Módulo (qué se muestra y qué se oculta)

> **Regla clave de contexto:** Solo **Git** tiene árbol de código fuente y diffs. En el resto de los módulos (especialmente SQL/Mongo/Redis, donde se trabaja sobre archivos `.sql` o scratchpads ejecutables), **no** se muestran controles de fuentes/diffs y el Chat Harness actúa como asistente de consulta, análisis, EXPLAIN y diagnóstico.

| Módulo | ¿Tiene fuentes Git? | Controles que se ocultan | Rol del Chat Harness (`Pareja` / `Chat`) | Rol en `Terminales` (PTY Grid) |
| --- | --- | --- | --- | --- |
| **BD (SQL / Mongo / Redis)** | No | `Archivos`, `Cambios`, permisos de edición de repo | Asistente de consultas, análisis de resultados, EXPLAIN, inserción directa al editor (`working` = query actual) | CLIs agénticos + shells locales (`psql`, `sqlplus`, `mongosh`, `redis-cli`) con MCP del vault |
| **Git (Repositorios)** | Sí | Toolbar SQL, resultados de query | Ingeniería sobre código: edición con permisos paso a paso (`AgentApprovalDialog`), diffs, revisión cruzada | Grid multi-agente sobre el `cwd` del repo + drawers rápidos `Archivos` y `Cambios` |
| **SSH / SFTP** | No | `Archivos`/`Cambios` Git, toolbar SQL | Diagnóstico de errores desde scrollback (500 líneas) e inserción de comandos sin Enter | Grid combinando terminales locales, agentes CLI y sesiones SSH |
| **Vault Notes** | No | `Archivos`/`Cambios` Git, toolbar SQL | Redacción, resumen y consulta respetando cortafuegos `is_private` | Agentes trabajando con notas no privadas vía MCP |
| **HTTP Client** | No | `Archivos`/`Cambios` Git, toolbar SQL | Depuración de respuestas/payloads, generación de snippets y docs (sin exponer secretos) | Agentes + `curl`/scripts locales en paralelo |
| **Utilidades (Docker, Port Killer, Activity Monitor, Modelos)** | No | `Archivos`/`Cambios` Git, toolbar SQL | Diagnóstico de logs de Docker, procesos, puertos y consumo | Logs/CLI de Docker + agentes en paralelo |

---

## 3. Plan Segmentado por Fases

### Fase 0 — Fundación de Tokens MD3, Layout State y `ResizeHandle` Bi-direccional
**Objetivo:** Preparar estado de layout, contrato `auto`/`custom size` y estilos base sin romper la UI actual.

- **Alcance:**
  - Refinar utilidades de contenedor/panel en `frontend/src/styles/globals.css` (superficies limpias, bordes suaves para cards y celdas del grid, manteniendo `--ui-font-scale` y `rounded-full`).
  - Crear `frontend/src/hooks/useLayoutMode.ts`:
    - `mode: 'work' | 'pair' | 'chat' | 'terminals'`
    - visibilidad de paneles (`leftOpen`, `bottomOpen`, `rightOpen`, `gridFilesOpen`, `gridChangesOpen`)
    - tamaños con discriminación explícita `{ mode: 'auto' } | { mode: 'custom'; px: number }` (o proporción para splits del grid).
  - Extender `frontend/src/components/ResizeHandle.tsx` para soportar `orientation?: 'vertical' | 'horizontal'`, feedback visual de `auto`/`custom` y doble clic para reset a `auto`.
- **Verificación:** `cd frontend && pnpm build` + `go test ./...`.

---

### Fase 1 — Top Bar Unificada (Header ADE + `⌘K` + 4 Modos + Accesos `Files`/`Changes`)
**Objetivo:** Convertir `TitleBar.tsx` en la barra superior del ADE, respetando `TITLE_BAR_MAC_INSET` en macOS y controles de ventana en Windows/Linux.

- **Alcance:**
  - **Izquierda:** Logo compacto + **Space / Context Pill** (repo Git activo o conexión/workspace actual con dropdown para cambiar rápido).
  - **Centro:** Botón/trigger de **Command Palette (`⌘K` / `Ctrl+K`)** (`frontend/src/components/CommandPalette.tsx`) para buscar archivos, conexiones, notas, peticiones HTTP, sesiones de agente o comandos de layout.
  - **Derecha:**
    - Segmented control de los **4 modos**: `Trabajo` | `Pareja` | `Chat` | `Terminales` (con atajos de teclado).
    - En modo `Terminales`: botones rápidos `+` (nuevo agente/terminal), `Files` y `Changes` (inspirados en Herdr) para abrir/cerrar paneles laterales sin salir del grid.
- **Archivos:** `TitleBar.tsx`, `CommandPalette.tsx` *(nuevo)*, `App.tsx`, `Workspace.tsx`, `i18n/{en,es}.ts`.
- **Verificación:** `pnpm build`, `./scripts/i18n-check.sh`, `uishot.sh` en `100%` y `150%` (verificar cero solapamiento con semáforos macOS).

---

### Fase 2 — Activity Rail Izquierdo + Explorador Limpio + Panel de Spaces y Agentes Vivos
**Objetivo:** Separar el rail vertical permanente del explorador, e integrar la vista lateral de **Spaces + Agents activos** para los modos agénticos.

- **Alcance:**
  - Crear `frontend/src/components/sidebar/ActivityRail.tsx` (~44–48px):
    - Arriba: los 6 módulos existentes (`connections`, `ssh`, `git`, `notes`, `http`, `utilities`) con indicador activo `bg-primary-container` y badges de búsqueda/actividad.
    - Abajo: toggles de paneles (Explorador, Dock inferior, Panel derecho) + idioma + tema claro/oscuro + Configuración.
  - Refactorizar `Sidebar.tsx` para ser el **panel Explorador** con `ResizeHandle` (`auto` / `custom` persistido con `SetSidebarWidth`), manteniendo los 6 árboles montados.
  - Añadir sub-panel **Spaces & Agents** (visible en modo `Terminales` o seleccionable desde el rail):
    - **Spaces:** proyectos/repositorios y workspaces abiertos (`+` para añadir espacio).
    - **Agents:** lista en tiempo real de todas las sesiones activas (tanto PTY como Chat headless), agrupadas por estado (`running` con punto `secondary`, `waiting approval` en `tertiary`, `idle` en `on-surface-variant`), mostrando ícono del CLI, nombre y tiempo transcurrido (`<1m`, `3m`). Clic enfoca o maximiza esa sesión.
- **Archivos:** `ActivityRail.tsx` *(nuevo)*, `SpacesAgentsPanel.tsx` *(nuevo)*, `Sidebar.tsx`, `SidebarMasterMenu.tsx`, `Workspace.tsx`.
- **Verificación:** `uishot.sh sidebar`, `uishot.sh sidebaropen` en escala `100` y `150`.

---

### Fase 3 — Chat Harness UX (Estilo *Deck* — Modos `Pareja` y `Chat`)
**Objetivo:** Llevar el chat headless (`AgentChatHost` + `AgentChat` + `GitAgentPanel`) a una UX limpia de primera clase sin desmontar streams al cambiar de modo.

- **Alcance:**
  - **Header compacto en una fila:** selector de Agente/CLI (con health indicator), Modelo, Esfuerzo, Modo de permiso (`Consulta` | `Plan` | `Pareja` | `Auto`), botón `+` nueva sesión y botón `>_` (abrir ese mismo CLI/contexto en un tile del Terminal Harness).
  - **Sub-barra colapsable:** acordeón `▸ Agentes disponibles` (cambio rápido entre sesiones vivas) + dropdown de historial por fecha/título.
  - **Timeline limpio:**
    - Mensajes del usuario a la derecha con `bg-primary-container text-on-primary-container`.
    - Respuestas del agente a la izquierda sobre `bg-surface-container`.
    - Rediseñar `ToolCallCard.tsx` como fila compacta colapsable (`▸ Editar src/... +18 -6`, `▸ go test ... OK`) con colores semánticos (`secondary`/`tertiary`/`error`), expandible al hacer clic.
  - **Composer limpio:** textarea auto-grow, chips de `@` contexto y adjuntos, envío/detención.
  - **Persistencia de instancia única:** al alternar entre `Pareja` (acoplado a la derecha con `ResizeHandle` `auto`/`custom` vía `SetAgentLayout`) y `Chat` (canvas completo), se cambia el layout CSS sin desmontar `AgentChat` para no cortar streams.
- **Archivos:** `AgentChatHost.tsx`, `AgentChat.tsx`, `ToolCallCard.tsx`, `GitAgentPanel.tsx`, `Workspace.tsx`.
- **Verificación:** probar cambio `Pareja` ↔ `Chat` ↔ `Trabajo` durante una respuesta en streaming; probar `AgentApprovalDialog`, `@` picker y `uishot.sh chat` en escala `100` y `150`.

---

### Fase 4 — Terminal Harness UX: Multi-Agent PTY Grid (Estilo *Herdr* — Modo `Terminales`)
**Objetivo:** Construir el **mosaico/grid multi-agente de terminales PTY** aprovechando `backend/localterm`, `backend/agents` y `xterm.js` (que ya existen en `mini-tools`).

- **Alcance:**
  1. **Motor de Grid (`TerminalGridHost.tsx` + `TerminalTile.tsx`):**
     - Cada tile monta una instancia real de `xterm.js` conectada a una sesión PTY (`/localterm` con CLI agéntico lanzado desde `/agents`, shell local, o sesión `/sshconn`).
     - **Presets de `auto size`:** auto-distribución limpia según cantidad de tiles (`1` → `1×1`, `2` → `2×1`, `3–4` → `2×2`, `5–6` → `3×2`), recalculando `fitAddon.fit()` vía `ResizeObserver` con debounce.
     - **Splits y `custom size`:** cada fila y columna tiene `ResizeHandle` (vertical/horizontal) para ajustar proporciones manualmente; doble clic restablece a `auto`.
     - **Header minimalista por tile (~28px):**
       - Izquierda: ícono del agente/shell + nombre + `cwd` truncado + badge de estado (`running`/`idle`).
       - Derecha: split horizontal (`◫`), split vertical (`⬒`), **maximizar/restaurar tile** (`⛶` — enfoca 1 tile al 100% sin matar los demás), cerrar (`×`).
     - **Borde de foco:** el tile activo se destaca con borde `border-primary/70`; los demás con `border-outline-variant`.
  2. **Lanzador rápido de agentes en tile (`+`):**
     - Permite abrir en un clic: Claude Code, Codex, Antigravity, OpenCode, Shell local o SSH en el `cwd` del Space activo.
  3. **Drawers rápidos `Files` y `Changes` sobre el Grid:**
     - Desde la Top Bar (`Files`, `Changes`), abre un panel deslizable derecho (con `ResizeHandle` `auto`/`custom`) que reutiliza `GitFileEditor` y `ChangesPanel`/`DiffViewer` existentes para inspeccionar lo que los agentes están modificando en tiempo real sin salir del grid.
  4. **Supervivencia de sesiones PTY:**
     - Al cambiar de `Terminales` a `Trabajo`/`Pareja`/`Chat` y volver, las sesiones PTY siguen vivas en memoria (ocultas vía CSS/keep-alive, no desmontadas).
- **Archivos:** `frontend/src/components/terminal/TerminalGridHost.tsx` *(nuevo)*, `TerminalTile.tsx` *(nuevo)*, `TerminalLauncherMenu.tsx` *(nuevo)*, `Workspace.tsx`, `i18n/{en,es}.ts`.
- **Verificación:** abrir 4–6 terminales simultáneas (ej. Claude Code + Codex + shell local), verificar `fitAddon` al arrastrar divisores (`custom`), reset a `auto`, maximizar/restaurar tile, abrir `Files`/`Changes`, y cambiar de modo sin perder sesiones PTY.

---

### Fase 5 — Rail Derecho + Dock Inferior Unificado (para Modos `Trabajo` y `Pareja`)
**Objetivo:** Añadir el rail derecho delgado (~40px) y unificar el panel inferior en los modos de edición/BD.

- **Alcance:**
  - Crear `frontend/src/components/agent/AgentRightRail.tsx`: accesos rápidos a Chat Harness (con badge `tertiary` si hay aprobaciones pendientes), historial de sesiones (`AgentSessionsHost`), Terminal PTY rápida (toggle del dock inferior), y panel de Consumo/Límites/MCP (`AgentUsagePanel`, `AgentLimitBars`).
  - Crear `frontend/src/components/BottomDock.tsx`: wrapper limpio con pestañas (`Resultados`, `EXPLAIN`, `Terminal`, `Logs`) + botón `+` (nueva terminal) + botón minimizar `—` + `ResizeHandle` horizontal (`auto`/`custom` height).
- **Archivos:** `AgentRightRail.tsx` *(nuevo)*, `BottomDock.tsx` *(nuevo)*, `Workspace.tsx`.
- **Verificación:** redimensionar el dock en pestañas SQL, Mongo, Redis y Git; confirmar que la terminal del dock sobrevive al minimizar/reabrir.

---

### Fase 6 — Status Bar Inferior + Control Rápido de Escala y Estado Agéntico
**Objetivo:** Añadir una barra de estado delgada (24–28px) en la base con telemetría útil y acceso inmediato a la escala de UI.

- **Alcance:**
  - Crear `frontend/src/components/StatusBar.tsx`:
    - **Izquierda:** Rama Git + conteo de cambios (`main · 2 cambios`), conexión BD activa (punto `secondary` si está conectada), estado del servidor MCP (`MCP activo`).
    - **Centro/Derecha:** Resumen de agentes activos (`● 3 agents` — clic salta al modo `Terminales` o abre lista), **control rápido de escala (`Letra 100%`)** conectado a `useUIFontScale` (presets `90/100/115/130/150%` + valor `custom`), y versión (`AppVersion` + aviso de actualización).
- **Archivos:** `StatusBar.tsx` *(nuevo)*, `hooks/useUIFontScale.ts`, `Workspace.tsx`.
- **Verificación:** cambiar escala desde Status Bar y validar sincronización con `SettingsDialog` y persistencia tras reiniciar.

---

### Fase 7 — Rediseño del Logo e Identidad Visual ADE
**Objetivo:** Renovar el logo de `mini-tools` para reflejar su identidad de **Agent Development Environment** (limpio, geométrico, legible tanto en `16px` en la Top Bar como en `1024px` en el Dock de macOS y barra de tareas de Windows), alineado con nuestra paleta MD3 (`primary` `#4a8eff` + acento `secondary` menta).

- **Alcance:**
  1. **Concepto y variantes:** diseñar un isotipo minimalista y reconocible a tamaños pequeños (ej. monograma / símbolo de terminal+nodos/harness dentro de un *rounded-square* limpio), verificando legibilidad sobre fondo oscuro (`surface-container-low`) y claro (`background`).
  2. **Generación y reemplazo de assets oficiales:**
     - `build/appicon.png`: ícono maestro `1024×1024` con fondo transparente fuera del *rounded-square* (respetando la convención de macOS/Wails).
     - Eliminar `build/windows/icon.ico` si existe para que `wails build` lo regenere automáticamente desde `build/appicon.png`.
     - `frontend/src/assets/logo.png`: versión optimizada (`~256×256`, recortada con transparencia) usada en `TitleBar`, `UnlockScreen` y `SettingsDialog`/`About`.
     - `frontend/public/favicon.png`: favicon optimizado (`32×32` / `64×64`) para Vite y web.
     - Revisar referencias de logo en `index.html` (sitio de ayuda / GitHub Pages) y `README.md`.
  3. **Integración en la UI:**
     - Top Bar (`TitleBar.tsx`): logo nítido a `18–20px` (escalable con `--ui-font-scale`) junto al nombre `mini-tools`.
     - `UnlockScreen.tsx`: logo protagonista limpio sobre la pantalla de desbloqueo del vault (tema oscuro y claro).
- **Verificación:**
  - Comprobar nitidez en `16px`, `24px`, `64px` y `1024px` en modo **oscuro** y **claro**.
  - Correr `./scripts/build.sh` (o `wails build`) y verificar que el `.app` de macOS y el `.ico` de Windows tomen el nuevo ícono sin artefactos ni bordes cortados.

---

### Fase 8 — Pulido de los 6 Módulos Existentes (Oscuro y Claro) + QA Final
**Objetivo:** Alinear visualmente todos los módulos existentes con el nuevo shell ADE y cerrar con QA completo.

- **Alcance:**
  - Alinear pestañas, headers y bordes internos en:
    1. Editor SQL / Mongo / Redis (`EditorTabs.tsx`, toolbars de query).
    2. Git Workbench (`GitRepoTab`, `GitFileEditor`, `DiffViewer`, `ChangesPanel`).
    3. HTTP Client, Vault Notes, SSH/SFTP y Utilidades (Docker, Port Killer, Activity Monitor).
  - Revisar contraste en **modo oscuro** y **modo claro** (especialmente `surface-container-*` y `on-surface-variant`).
- **Checklist final de verificación:**
  - [ ] `./scripts/i18n-check.sh` en verde (`en` y `es`).
  - [ ] `cd frontend && pnpm build` sin errores.
  - [ ] `go build ./... && go vet ./... && go test ./...` en verde.
  - [ ] Capturas `./scripts/uishot.sh` (`workspace`, `files`, `agents`, `chat`, `sidebar`, `settings` + nueva vista `terminalgrid`) en `UISHOT_SCALE=100` y `UISHOT_SCALE=150`, en tema **oscuro** y **claro**.
  - [ ] Verificar persistencia de `auto size` y `custom size` en todos los paneles y divisores del grid.
  - [ ] Actualizar `.claude/specs/design-system.md` y `.claude/specs/architecture.md`.
  - [ ] **Centro de ayuda completo (`index.html` y `es/index.html`)**: actualizar todos los temas afectados por el nuevo UX ADE (Top Bar, 4 modos, Activity Rail, Spaces & Agentes, Terminal Harness Multi-Agente, Rail Derecho, Status Bar, Select con buscador y nuevo logo), verificar paridad exacta de `id`s (`diff`) y regenerar las capturas en ambos idiomas con `./scripts/help-shots.sh`.

---

### Fase 9 — Unificación ADE: Proyecto + Git + Archivos + Ramas + Agentes (Estilo *Deck*)
**Objetivo:** Eliminar la fragmentación entre `Git` y `Espacios y Agentes`, convirtiendo el módulo de proyectos/Git en un **verdadero Agent Development Environment unificado** (reutilizando `GitListWorkTree`, `GitReadWorkFile`/`GitWriteWorkFile`, `GitFileEditor`, `RepoRefsTree`, `ChangesPanel`, `CommitGraph`, `GitAgentPanel` y `LocalTerminalPanel`).

#### F9.1 — Switcher `Proyectos ▾` en Top Bar + Explorador Unificado
- **Top Bar:** selector `Proyectos (N) ▾` con `Select` buscable para cambiar de proyecto/carpeta + botón `Abrir carpeta`, mostrando al lado el nombre del proyecto activo y su rama actual (`prueba/editor`).
- **Explorador Izquierdo unificado (cuando hay un proyecto abierto):** cabecera con nombre del proyecto + rama + 3 vistas rápidas:
  1. **Archivos:** árbol real de carpetas y archivos (`GitListWorkTree`) con íconos por lenguaje, filtro rápido, refrescar y clic para abrir en el editor.
  2. **Git / Ramas:** `RepoRefsTree` (ramas, tags, stashes) + resumen de cambios (`ChangesPanel`).
  3. **Agentes:** sesiones vivas (Chat + PTY) y lanzador rápido sobre ese proyecto.

#### F9.2 — Layout Maestro tipo *Deck* dentro de `GitRepoTab`
- Conectar `adeMode` directamente dentro del workbench del proyecto:
  - **Trabajo (`work`):** Explorador + **Editor con pestañas (`GitFileEditor`)** arriba + **Terminal PTY colapsable** abajo (`ResizeHandle` `auto`/`custom`) + acceso rápido a Grafo/Diffs/Historial.
  - **Pareja (`pair`):** Editor + Terminal al centro + **Agente del proyecto (`GitAgentPanel`) acoplado a la derecha** (como la captura de *Deck*).
  - **Chat (`chat`):** Agente del proyecto a ancho completo sin desmontar archivos ni terminal.
  - **Terminales (`terminals`):** Multi-Agent PTY Grid sobre el proyecto + drawers `Archivos` y `Cambios`.

#### F9.3 — Compatibilidad de Lenguajes y Búsqueda de Archivos en `⌘K`
- Indexar los archivos del proyecto activo (`GitListWorkTree`) dentro de `CommandPalette` (`⌘K`) para abrir cualquier archivo por nombre desde el teclado.
- Mostrar el lenguaje detectado en la barra del editor con selector `Select` buscable para cambiar de modo/sintaxis al vuelo (`languageRegistry.ts`), más crear/renombrar archivo desde el árbol.

#### F9.4 — Limpieza de Duplicados, Ayuda y QA Visual
- Retirar el ícono separado `hub` del Activity Rail (fusionado en el módulo unificado de Proyectos/Git).
- Actualizar `CHANGELOG.md`, `index.html`, `es/index.html` y regenerar capturas con `./scripts/help-shots.sh`.

---

## 4. Plantilla de Prompt para Delegar Fases a Otros LLMs

```text
Lee `.claude/specs/design-system.md`, `.claude/rules/technical.md` y `.claude/specs/ux-ade-redesign.md`.
Ejecuta ÚNICAMENTE la Fase <N> (<Nombre de la fase>).

Reglas estrictas:
- Usa exclusivamente nuestros tokens MD3 (`frontend/src/styles/globals.css`), `<Icon>` y `--ui-font-scale` (cero `text-[Npx]`).
- Respeta `auto size` y `custom size` en paneles y divisores (`ResizeHandle.tsx`).
- No elimines ningún módulo ni feature existente; no rompas el cross-compile sin `cgo`.
- Las sesiones de chat en streaming y terminales PTY NO deben perderse al cambiar entre modos (`Trabajo | Pareja | Chat | Terminales`).
- Agrega todos los textos nuevos en `frontend/src/i18n/en.ts` y `es.ts` (en el módulo correspondiente bajo `i18n/{en,es}/`).
- Anota toda feature/cambio visible al usuario en `CHANGELOG.md` bajo `## [Unreleased]` (nunca en una versión ya publicada).
- Si cambia lo que el usuario puede hacer o agrega atajos, documenta en `index.html` (inglés) y `es/index.html` (español) manteniendo `id`s idénticos.
- Marca la fase como completada en la tabla de progreso y anota la bitácora en `.claude/specs/ux-ade-redesign.md` al terminar.

Al terminar, verifica con `cd frontend && pnpm build`, `./scripts/i18n-check.sh` y capturas `./scripts/uishot.sh` en escala 100 y 150.
```
