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
- **Configuración general de la app (no de una conexión particular) vive en `SettingsDialog.tsx`, abierto desde el ícono de engranaje en la esquina del toolbar (`Workspace.tsx`) — nunca sueltos en el toolbar principal.** Backup vault y "Recordar clave" se movieron ahí desde la fila de acciones del toolbar por esta regla. Cualquier preferencia nueva de la app (no de una conexión ni de una tabla puntual) se agrega dentro de ese modal, no como botón/checkbox nuevo en el toolbar.
- **Nunca `window.confirm()`/`window.alert()` nativos — usar `ConfirmDialog.tsx` (genérico) o `PasswordConfirmDialog.tsx` (si hace falta reconfirmar la clave maestra).** Un `window.confirm()` dentro del webview de Wails no se percibe obviamente como un diálogo — ya causó confusión real dos veces: el linter de `SELECT *` ("no me deja ejecutar") y el botón de borrar historial ("no borra", cuando en realidad el usuario nunca confirmaba un diálogo nativo poco visible). Cualquier acción que necesite confirmación usa el modal temado, consistente con el resto de la UI.

## Testing

- **No escribir tests, ni en backend (`_test.go`) ni en frontend**, para ahorrar tokens. Verificar cada fase manualmente: `go build ./...`, `go vet ./...`, `wails build`, y correr la app (`scripts/start.sh` o `wails dev`) para probar el flujo real.
- Los tests de las Fases 1-3 (`backend/**/*_test.go`) ya existen y se dejan como están — no se borran retroactivamente — pero no se agregan tests nuevos a partir de esta regla en adelante.

## Commits / PRs

- **Regla dura: nunca `git add`/`git commit`/`git push` de forma automática, bajo ningún proceso ni trigger (incluido el de Releases más abajo).** El usuario hace todos los commits y el staging manualmente, siempre — incluso después de haber pedido explícitamente en una conversación que se suba algo puntual (eso no crea un precedente que se repita solo). Dejar los cambios listos en el working tree y avisar qué archivos tocar; nunca stagear/commitear/pushear por iniciativa propia.
- Cada fase del plan (`.claude/specs/`, ver historial de planning) es idealmente un commit o PR separado, con su propio criterio de "listo" verificado antes de pasar a la siguiente — pero el commit en sí lo arma el usuario.

## CodeGraph

- Este repo tiene `.codegraph/` (índice de símbolos/edges). Después de agregar o eliminar un archivo de código, correr `codegraph sync` para mantener el índice al día antes de seguir trabajando.

## CHANGELOG — todo cambio se acumula en `[Unreleased]` primero

- **Regla dura: todo feature, fix o mejora se anota en `CHANGELOG.md` bajo
  `## [Unreleased]` en el momento en que se hace, como parte de la misma
  tarea** — no al final, no "cuando se empaquete", y **nunca directamente
  bajo una sección de versión**. `[Unreleased]` es el changelog temporal
  donde se junta todo lo que todavía no salió.
- **Al sacar una versión, ese contenido se mueve** (no se copia) de
  `[Unreleased]` a una sección nueva `## [X.Y.Z] - AAAA-MM-DD`, y
  `[Unreleased]` queda como encabezado vacío para la próxima tanda. Ese
  volcado es el paso 7 del proceso de [releases.md](../specs/releases.md);
  esta regla es la otra mitad: lo que garantiza que haya algo correcto
  para volcar.
- **Una sección de versión ya publicada no se toca nunca más.** Si la
  versión ya está commiteada/tageada, su sección es historia: un cambio
  posterior va a `[Unreleased]`, aunque la versión sea de hace cinco
  minutos y todavía no se haya pusheado.
- **Por qué existe esta regla (error real, no hipotético):** en la sesión
  de 0.5.0 se agregaron features *después* de empaquetar y commitear esa
  versión, y se escribieron directamente bajo `## [0.5.0]` en vez de
  `[Unreleased]`. Resultado: la sección de una versión ya publicada
  decía cosas que ese binario no tenía, y hubo que reconstruir a mano qué
  entraba en 0.5.0 y qué en 0.5.1 leyendo el historial de git. Anotar en
  `[Unreleased]` sobre la marcha hace que el corte de versión sea mecánico
  en vez de arqueológico.
- Formato de cada entrada: una línea por feature/fix, agrupada bajo
  `### Agregado` / `### Corregido` / `### Mejorado` según corresponda, con
  el mismo nivel de detalle que las entradas existentes (qué cambió y por
  qué le importa a quien lo lee) — nunca "varias mejoras" ni "fixes
  varios".

## Releases

- **Cualquier mención de "empaquetar"/"empaquetá"/"empaquete" u "oficial" en el contexto de compilar es un trigger fijo, no se interpreta caso a caso:** ejecutar el proceso completo de [.claude/specs/releases.md](../specs/releases.md) — no alcanza con correr `package-macos.sh` y listo. Incluye bumpear la versión (`bump-version.sh patch` por default, ya no es opcional en este flujo), armar/actualizar `releases/<os>/` con el `.dmg`, su checksum SHA-256, un `README.md` con compatibilidad real (arquitectura verificada + nota sobre `LSMinimumSystemVersion` del plist vs. el piso real de macOS), reflejar esos datos (con link directo al `.dmg`) en el `README.md` raíz, **y volcar `CHANGELOG.md` (mover `[Unreleased]` a `[X.Y.Z] - fecha`, con los features/fixes nuevos de la sesión)**.
- El `.dmg`/artefacto empaquetado **sí se versiona en git** dentro de `releases/<os>/` — no agregarlo a `.gitignore`. Decisión explícita del usuario: el link del README tiene que bajar el binario directo desde GitHub.
- **El `git add`/`commit`/`push` de todo esto lo hace el usuario, nunca Claude** — ver la regla dura en "Commits / PRs" arriba, sin excepción para este trigger tampoco. Dejar el `.dmg` + docs actualizadas en el working tree y listo.

## Migraciones del vault

- **Regla dura, no solo convención:** `vault.db` ya está instalado en varias máquinas con datos reales (conexiones, historial, settings). Toda columna o tabla nueva se agrega vía migración — nunca borrando/recreando la base, ni siquiera "momentáneamente" para probar algo local. Ver [.claude/rules/technical.md](technical.md) punto 13.
- Para agregar una migración nueva: agregar una entrada `migration{version: N, ...}` en `backend/vault/migrations.go`, mantenerla aditiva (nunca `DELETE`/`DROP`/mutar filas, nunca tocar `vault_meta`), verificar con el patrón de script efímero sandboxeado (`HOME=$(mktemp -d) go run ./tmp_xxx`, nunca commiteado), y correr `codegraph sync` al final. Ver [.claude/specs/vault-migrations.md](../specs/vault-migrations.md) para el diseño completo y el porqué.
- El `CREATE TABLE IF NOT EXISTS settings (...)` (y demás tablas) en `backend/vault/store.go` está congelado como la definición de la versión 1 — no se le agregan columnas directamente ahí ni para una instalación nueva. Una instalación nueva y una que actualiza deben terminar en el mismo camino: crear la tabla base (versión 1) y después aplicar las mismas migraciones que cualquier otra. Ver `open_tabs`/`sidebar_collapsed`/`editor_height` en `settings` como precedente — ninguna de las tres está en el `CREATE TABLE` de `store.go`, las tres llegaron por `ALTER TABLE ... ADD COLUMN` en `migrations.go`.
