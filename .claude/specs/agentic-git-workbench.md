# Plan — Git como banco de trabajo agéntico

> Estado: **el plan está implementado, de S0 a S9**, incluidos S4.7 (escritura
> de configs MCP, acotada a los archivos que son configuración y sin
> dependencias nuevas) y la **aprobación por acción** del chat, que terminó
> resolviéndose con un hook `PreToolUse` y un socket Unix en vez del servidor
> MCP que preveía el plan — `--permission-prompt-tool` ya no existe en el CLI
> instalado. Ver "Estado de implementación" abajo, y **"Investigado y NO
> implementado"** para las dos cosas que quedaron afuera con su porqué
> (re-dibujar mensajes al retomar, y aprobación por acción en Codex y
> Antigravity). Segmentación de la feature pedida:
> editar código en el módulo Git con CodeMirror multi-lenguaje, y potenciar la
> integración con los CLIs agénticos (Claude Code, Codex, Gemini) — skills del
> repo, configurador de MCP, edición de los `.md` agénticos, y abrir un chat
> con el agente seleccionado.

## Hallazgos previos (estado real del código, verificado)

Estos cuatro determinan la segmentación; sin ellos el plan sería otro.

1. **El módulo Git no tiene editor de archivos, en absoluto.** `app_git.go`
   expone `GitFileAtCommit` (lectura por commit, solo mostrar),
   `GitReadConflictFile`/`GitResolveConflictFile` (únicamente para conflictos)
   y nada más. No hay listado del árbol de trabajo ni lectura/escritura de un
   archivo del working tree. `DiffViewer.tsx` usa CodeMirror **solo para pintar
   el patch**, en modo lectura. Entonces "editar código en Git" es construcción
   nueva, no una mejora de algo existente.

2. **CodeMirror hoy soporta tres lenguajes y ninguno es de propósito general.**
   `package.json` trae `@codemirror/lang-sql` y `@codemirror/lang-json`; Redis y
   mongosh están escritos a mano en `frontend/src/codemirror/`. El tipo
   `TabLanguage` (`editor/EditorTabs.tsx:12`) es una unión cerrada de
   `'sql' | 'redis-cli' | 'mongosh'`. Ese editor es el del workspace de base de
   datos y **no** hay que forzarlo a ser también el editor de archivos: son dos
   productos distintos con props distintas.

3. **Lo agéntico existe pero es superficial y correcto en su alcance.**
   `backend/agents/registry.go` es un catálogo de tres CLIs con detección en
   PATH, comando configurable y API key opcional cifrada; `OpenAgentSession`
   los arranca en el PTY de `backend/localterm`. **Cero MCP** (no hay una sola
   referencia en el repo) y **cero descubrimiento de skills** — lo único que
   toca `.claude/skills/` es `backend/claudemd`, que *escribe* un skill de base
   de datos para proyectos de terceros, no lee los que ya existen.

4. **Las capturas de referencia implican algo que un PTY no puede dar.** El
   chat con tool-calls plegables, indicador de "Thought for Ns", selector de
   modo (Manual/Plan/Auto), effort, cambio de modelo y "Attach file" es UI
   estructurada sobre eventos tipados. Un PTY entrega bytes con escapes ANSI:
   se puede *mostrar*, no *entender*. Llegar a esa UI exige el modo headless de
   cada CLI (`claude -p --output-format stream-json`, `codex exec --json`,
   `gemini -p`), que es un **segundo path de ejecución** en paralelo al PTY —
   y contradice de frente la decisión fundacional del doc de
   `backend/agents`: *"un agente NO se integra por su API, se ejecuta como el
   programa de terminal que ya es"*. Esa decisión hay que enmendarla
   explícitamente (S6-B), no darla por revocada en silencio.

## Restricciones que atraviesan todos los segmentos

De [.claude/rules/technical.md](../rules/technical.md), aplican sin excepción:

- **Punto 5** — todo binding nuevo en `App` pasa por `requireUnlocked()`.
  Leer y **escribir** archivos arbitrarios del disco es, junto a la terminal,
  la superficie más potente de la app.
- **Punto 8** — binario <80MB. S1 suma paquetes de lenguaje al bundle: se mide
  con `wails build` el delta real antes de mergear, y por eso los lenguajes se
  cargan con `import()` dinámico y no estático.
- **Punto 13** — cualquier estado nuevo persistido (agente por defecto del
  repo, pestañas de archivo abiertas) va por migración aditiva en
  `backend/vault/migrations.go`. La última es la **29**; la siguiente es la 30.
- **Punto 12** — dependencias Go mínimas. El frontmatter de los `SKILL.md` y
  el `config.toml` de Codex se resuelven a mano antes que sumar un parser YAML
  y uno TOML al binario.
- **Punto 9/10** — un config de MCP puede traer tokens en su bloque `env`. No
  se loguean, se enmascaran en la UI y **no** se importan al vault: son
  archivos del usuario, la app los edita donde están.

---

## Segmento 0 — Acceso al árbol de trabajo (habilitador)

Sin esto no hay editor. Es la pieza que hoy no existe.

| # | Tarea | Archivos |
|---|---|---|
| 0.1 | `ListWorkTree(repo)`: archivos versionados + no rastreados respetando `.gitignore` (`git ls-files -co --exclude-standard`), como árbol | `backend/git/files.go` (nuevo) |
| 0.2 | `ReadWorkFile`: valida que la ruta resuelta caiga **dentro** del repo (anti path traversal), corta por tamaño máximo, detecta binario (NUL en el primer bloque) y devuelve contenido + `mtime` | `backend/git/files.go` |
| 0.3 | `WriteWorkFile`: escritura con `expectedModTime` para detectar cambio externo, y escritura atómica (temp + rename) | `backend/git/files.go` |
| 0.4 | Bindings `GitListWorkTree` / `GitReadWorkFile` / `GitWriteWorkFile`, todos con `requireUnlocked` | `app_git.go` |

Se copia el contrato ya probado de `ReadSftpFileForEdit`/`WriteSftpFileFromEdit`
(`app.go:1610`) en vez de inventar uno: la app ya resolvió "abrir un archivo
remoto, editarlo y guardarlo detectando que cambió abajo".

**Verificación:** `go build ./...`; probar que `../../../etc/passwd` como ruta
es rechazado; abrir un binario y ver que responde "binario", no basura.

---

## Segmento 1 — Registro multi-lenguaje de CodeMirror

| # | Tarea | Archivos |
|---|---|---|
| 1.1 | `languageRegistry.ts`: mapa extensión/nombre → *loader* `() => import(...)`, con fallback a texto plano | `frontend/src/codemirror/languageRegistry.ts` (nuevo) |
| 1.2 | Deps: `@codemirror/lang-{javascript,python,go,rust,java,php,html,css,markdown,xml,cpp,yaml,vue}` | `frontend/package.json` |
| 1.3 | `@codemirror/legacy-modes` para el resto (shell, dockerfile, toml, ini, lua, ruby, perl, powershell, diff, properties) — un solo paquete cubre decenas de modos | `languageRegistry.ts` |
| 1.4 | Carga perezosa real: el `Compartment` de lenguaje arranca vacío y se reconfigura cuando el `import()` resuelve. Sin esto, el chunk inicial crece con lenguajes que nadie abrió | `languageRegistry.ts` |
| 1.5 | Medir el binario con `wails build` y anotar el delta en la regla 8 | `.claude/rules/technical.md` |

El registro es **independiente** de `TabLanguage`: las pestañas del workspace
de base de datos siguen con su unión cerrada de tres y su lógica de conexión.
Mezclarlas obligaría a que cada pestaña de archivo cargue el aparato de
`connId`/`schemaMetadata`/`sqlIntel` que no le sirve de nada.

**Verificación:** `pnpm build`; `wails build` + `ls -lh build/bin/*` contra el
techo de 80MB.

---

## Segmento 2 — Editor de archivos en la pestaña Git

| # | Tarea | Archivos |
|---|---|---|
| 2.1 | Extraer de `CodeMirrorTabbedEditor.tsx` la máquina de "una vista compartida, un `EditorState` por pestaña" a un hook reusable — hoy son ~120 líneas acopladas a props de SQL, y duplicarlas es peor que extraerlas | `frontend/src/codemirror/useCodeMirrorTabs.ts` (nuevo) |
| 2.2 | `GitWorkTree.tsx`: árbol del working tree en el panel lateral, con badge de estado (modificado/nuevo/ignorado) reusando `GitStatus` | `components/git/GitWorkTree.tsx` (nuevo) |
| 2.3 | `GitFileEditor.tsx`: pestañas de archivo + editor sobre el hook de 2.1 y el registro de 1.1, con el tema ya existente (`resolveEditorTheme`) | `components/git/GitFileEditor.tsx` (nuevo) |
| 2.4 | Nueva vista central `'files'` en `CenterView` (`GitRepoTab.tsx:149`), junto a commits/changes/stash/conflicts | `components/git/GitRepoTab.tsx` |
| 2.5 | Guardar (`Cmd/Ctrl+S`), indicador de sucio, confirmación al cerrar sin guardar, refresco de `GitStatus` post-guardado para que el archivo aparezca como modificado al instante | `GitFileEditor.tsx`, `GitRepoTab.tsx` |
| 2.6 | Abrir el archivo desde el diff y desde la lista de cambios ("editar este archivo"), que es de donde va a salir el 80% de los usos | `DiffViewer.tsx`, `GitRepoTab.tsx` |
| 2.7 | Migración **30**: pestañas de archivo abiertas por repo, para restaurar el layout | `backend/vault/migrations.go`, repo nuevo en `backend/vault/` |

**Verificación:** `pnpm build`; abrir un repo, editar un `.go` y un `.ts`,
guardar, ver el archivo aparecer en Changes y su diff correcto.

---

## Segmento 3 — Descubrimiento agéntico del repo (skills, agentes, comandos)

Lo que hoy no existe: la app no sabe qué le ofrece el repo a un agente.

| # | Tarea | Archivos |
|---|---|---|
| 3.1 | Paquete `backend/agentctx` (nuevo): escanea el repo abierto y el home | `backend/agentctx/scan.go` |
| 3.2 | Skills: `.claude/skills/*/SKILL.md` del repo + `~/.claude/skills/` del usuario, marcando el alcance de cada uno | `agentctx/skills.go` |
| 3.3 | Subagentes y comandos: `.claude/agents/*.md`, `.claude/commands/*.md` | `agentctx/scan.go` |
| 3.4 | Archivos de instrucciones, los tres dialectos: `CLAUDE.md`, `AGENTS.md` (Codex), `GEMINI.md`, más `.github/copilot-instructions.md` si está | `agentctx/scan.go` |
| 3.5 | Lector de frontmatter a mano (solo `name` y `description`) — no vale sumar un parser YAML al binario por dos campos | `agentctx/frontmatter.go` |
| 3.6 | Binding `GitAgentContext(repoID)` → skills[], agents[], commands[], instrucciones[], servidores MCP[] | `app_git.go` |
| 3.7 | Solapa **"Agentes"** en el panel de la pestaña Git (tercera junto a `terminal`/`commands`, `PanelTab` en `GitRepoTab.tsx:155`): qué skills ve este repo, qué agente los soporta, y qué archivos de instrucciones faltan | `components/git/GitAgentPanel.tsx` (nuevo) |

Los formatos de estos directorios los define cada CLI y cambian entre
versiones: se leen tolerando lo desconocido (un `SKILL.md` sin frontmatter se
lista igual, por su ruta) y nunca se reescriben como efecto secundario de
leerlos.

**Verificación:** `go build ./...`; apuntar al propio repo de mini-tools, que
ya tiene `.claude/skills/mini-tools-patterns/SKILL.md`, y contra
`support-lab`, que tiene `.github/skills/` — dos layouts distintos a propósito.

---

## Segmento 4 — Configurador de MCP

| # | Tarea | Archivos |
|---|---|---|
| 4.1 | Paquete `backend/mcpconf` (nuevo): localizar los configs por agente y alcance | `backend/mcpconf/locate.go` |
| 4.2 | Claude Code: `.mcp.json` (proyecto), `.claude/settings.json`, `~/.claude.json` (usuario) | `mcpconf/claude.go` |
| 4.3 | Codex: `~/.codex/config.toml`, bloques `[mcp_servers.<nombre>]` | `mcpconf/codex.go` |
| 4.4 | Gemini: `.gemini/settings.json` y `~/.gemini/settings.json`, clave `mcpServers` | `mcpconf/gemini.go` |
| 4.5 | Modelo común normalizado (nombre, comando, args, env, alcance, agente) para que la UI sea una sola | `mcpconf/types.go` |
| 4.6 | **Lectura primero**: vista de solo lectura de qué servidores MCP ve cada agente en este repo, con los valores de `env` enmascarados | `components/git/GitAgentPanel.tsx` |
| 4.7 | Escritura conservadora, después: preservar claves desconocidas del archivo, escribir atómico y hacer backup previo. TOML necesita escritor propio — a mano, acotado a la forma que genera este módulo | `mcpconf/write.go` |

Riesgo real a manejar: estos archivos son del usuario y otros programas los
tocan. Una escritura que reordene o pierda claves ajenas rompe el setup de
alguien fuera de esta app. Por eso 4.6 va entero antes que 4.7.

**Verificación:** `go build ./...`; test de round-trip que meta claves
inventadas en cada formato y verifique que sobreviven a un guardado.

---

## Segmento 5 — Edición de los `.md` agénticos

Apoyado en S1 (markdown) + S2 (editor) + S3 (descubrimiento).

| # | Tarea | Archivos |
|---|---|---|
| 5.1 | Acceso directo desde el panel Agentes a cada archivo de instrucciones/skill, abriéndolo en el editor de S2 | `GitAgentPanel.tsx` |
| 5.2 | Vista previa Markdown lado a lado (render mínimo propio, sin sumar una librería de markdown) | `components/git/MarkdownPreview.tsx` (nuevo) |
| 5.3 | Validación de frontmatter en `SKILL.md`/agentes: avisar si falta `name` o `description`, que es lo que hace que un CLI lo ignore en silencio | `codemirror/frontmatterLint.ts` (nuevo, sobre `lintAdapter.ts`) |
| 5.4 | Extender `backend/claudemd/templates.go` para emitir también `AGENTS.md` y `GEMINI.md`, de modo que un repo quede compatible con los tres CLIs desde la app | `backend/claudemd/templates.go`, `generator.go` |

**Verificación:** generar en un repo temporal sandboxeado
(`HOME=$(mktemp -d)`, nunca sobre `~/Library/Application Support/mini-tools`),
abrir los tres archivos y confirmar que cada CLI los levanta.

---

## Segmento 6 — Chat con el agente seleccionado

Acá está la decisión grande. Se parte en dos niveles porque el primero es
barato y compatible con la arquitectura actual, y el segundo es un producto
nuevo.

### S6-A — Sesión con contexto (sobre el PTY que ya existe)

| # | Tarea | Archivos |
|---|---|---|
| A.1 | Selector de agente en la barra del panel, y "agente por defecto" por repo (migración 30) | `GitRepoTab.tsx`, `vault` |
| A.2 | "Chatear con…" en el menú contextual de un archivo, un diff, un commit o un skill: abre o enfoca la sesión de ese agente y le **escribe** un prompt inicial con ese contexto (ruta, rango de líneas, diff) | `GitRepoTab.tsx`, `app_localterm.go` |
| A.3 | Nombrar las sesiones por agente y por tarea, en vez de "terminal 1/2/3" | `GitRepoTab.tsx` |
| A.4 | Pasar los skills/instrucciones detectados en S3 como parte del prompt inicial cuando el usuario elige uno | `GitAgentPanel.tsx` |
| A.5 | **Adjuntar / mencionar archivo**: selector sobre el árbol del working tree (S0.1) que inserta la referencia en el prompt. Sobre PTY se inserta como **ruta relativa al repo**, no como contenido pegado — los tres CLIs leen archivos por sí mismos, y volcar 2000 líneas en un prompt gasta contexto y rompe el pegado del PTY | `GitAgentPanel.tsx`, `GitRepoTab.tsx` |
| A.6 | Adjuntar una **selección** del editor de S2 (ruta + rango de líneas) y un **diff** (archivo, staged, o commit) como bloque de contexto acotado | `GitFileEditor.tsx`, `DiffViewer.tsx` |

Da el 70% del valor percibido sin tocar el modelo de ejecución. `OpenAgentSession`
ya acepta comando y entorno; escribir un prompt inicial es `WriteLocalTerminal`.

### S6-B — Chat nativo (lo de las capturas)

Requiere **enmendar la decisión fundacional** del doc de `backend/agents`.
Antes de escribir código:

| # | Tarea | Archivos |
|---|---|---|
| B.1 | Verificar, CLI por CLI y contra su versión instalada, el modo headless y el formato de eventos. **Avance real:** Antigravity (`agy`) expone `--print --output-format text\|json\|stream-json`, más `--mode`, `--model`, `--effort` y `--json-schema` — o sea que los controles de las capturas se corresponden con banderas que existen de verdad. Claude Code tiene `-p --output-format stream-json`. Falta comprobar Codex, que no está instalado. Aun así los tres formatos de evento difieren y ninguno es estable entre versiones | investigación, sin código |
| B.2 | `backend/agentchat` (nuevo): tercer path de ejecución, ni `localterm` ni `sshconn` — proceso con stdout NDJSON, un normalizador por agente hacia un evento común (mensaje, tool-call, resultado, uso de tokens) | `backend/agentchat/` |
| B.3 | Streaming al frontend por el mismo contrato `Event`/`EmitFunc` que ya usan `query`/`redisquery`/`localterm` — no inventar un cuarto | `backend/agentchat/session.go` |
| B.4 | UI de chat: burbujas, tool-calls plegables con entrada/salida, indicador de pensamiento | `components/git/AgentChat.tsx` (nuevo) |
| B.4b | Adjuntar archivo, ahora sí con el contenido cuando el formato del CLI lo admite como bloque de entrada: chips de adjunto removibles, autocompletado `@ruta` sobre el árbol del repo, y arrastrar un archivo del árbol al chat | `AgentChat.tsx` |
| B.5 | Controles por sesión: modelo, effort, modo de permisos — **solo los que el CLI realmente expone por bandera**. Un selector que no cambia nada es peor que no tenerlo | `AgentChat.tsx` |
| B.6 | Aprobación de ediciones: el CLI pide confirmación; en modo headless esa confirmación la tiene que dar la UI. Es la parte más delicada de todo el segmento | `agentchat`, `AgentChat.tsx` |

**Costo honesto:** B es comparable en tamaño a S0–S5 juntos, y su superficie
depende de programas de terceros que cambian su salida sin aviso. B.1 es
condición de entrada: si el formato de alguno de los tres no alcanza, ese
agente se queda en S6-A y la UI tiene que tolerar que un agente tenga chat y
otro no.

---

## Segmento 7 — Git agéntico: el módulo Git operado por el agente

Los segmentos anteriores ponen al agente **al lado** del módulo Git. Este lo
mete **adentro**: acciones agénticas colgadas de las operaciones Git que ya
existen, en el lugar donde el usuario ya está trabajando.

| # | Tarea | Punto de enganche |
|---|---|---|
| 7.1 | **Mensaje de commit desde el diff staged**: botón junto al campo de mensaje que le pasa el diff al agente y devuelve el mensaje. Debe respetar el prefijo de tipo/scope que el módulo ya arma (`GitRepoTab.tsx:2704-2722`), no reemplazarlo | caja de commit |
| 7.2 | **Revisar antes de push**: pasarle al agente el rango `@{upstream}..HEAD` y mostrar sus observaciones antes de confirmar el push | `GitPush` |
| 7.3 | **Explicar este commit / este hunk**: acción de menú contextual sobre el grafo de commits y sobre un hunk del diff | `CommitGraph.tsx`, `DiffViewer.tsx` |
| 7.4 | **Asistir un conflicto**: el resolutor ya lee y escribe el archivo en conflicto (`GitReadConflictFile`/`GitResolveConflictFile`); el agente propone la resolución y el usuario la aplica o la descarta — nunca se escribe sin confirmación | `GitConflictResolver.tsx` |
| 7.5 | **Describir un PR**: la info de forge ya existe (`GitForgeInfo`, `backend/git/forge.go`); el agente redacta título y cuerpo desde los commits de la rama | `forge.go`, `GitRepoTab.tsx` |
| 7.6 | **Explicar un fallo de comando**: el log de comandos ya guarda salida y error (`backend/git/commandlog.go`); ofrecer "preguntarle al agente" sobre una entrada fallida | `GitCommandLog.tsx` |

Dos reglas para todo este segmento, que es donde es fácil hacer daño:

- **Ninguna acción escribe en el repositorio por su cuenta.** El agente
  propone; commitear, pushear, resolver o aplicar sigue siendo un clic del
  usuario. Un asistente que commitea solo porque interpretó bien un diff es
  exactamente el producto que nadie pidió.
- **Cada acción necesita que el agente pueda responder algo estructurado**, no
  una sesión interactiva. Sobre PTY (S6-A) esto se resuelve mandando el prompt
  y dejando que el usuario copie; **completo solo con S6-B**, que es lo que
  permite capturar la respuesta y ponerla en el campo correcto. Es decir: 7.1
  a 7.6 son útiles a medias sin S6-B, y ese es el argumento más fuerte a favor
  de encarar B.

## Segmento 8 — Cierre (por cada segmento anterior, no al final de todo)

- Entrada en `CHANGELOG.md` bajo `[Unreleased]`, en el estilo narrativo del
  archivo.
- `codegraph sync`.
- Actualizar [architecture.md](architecture.md) (paquetes y carpetas nuevas),
  [go-react-contract.md](go-react-contract.md) (bindings nuevos),
  [vault-migrations.md](vault-migrations.md) (migración 30) y la medición de
  tamaño en [technical.md](../rules/technical.md).

---

## Orden sugerido y dependencias

```
S0 ──┬── S2 ── S5
S1 ──┘         │
S3 ──┬── S4    │
     └── S6-A ─┘
              S6-B  (requiere decisión explícita + B.1)
```

S0 y S1 son independientes entre sí y se pueden hacer en paralelo; los dos
bloquean S2. S3 bloquea a S4 y aporta a S6-A. S6-B no arranca sin la enmienda
a `backend/agents` y sin B.1 verificado.

## Estado de implementación

**Hechos: S0, S1 y S2.** La solapa **Archivos** de la pestaña Git abre y guarda
archivos del árbol de trabajo con resaltado para más de treinta lenguajes.

- S0 — `backend/git/files.go` (`ListWorkTree`/`ReadWorkFile`/`WriteWorkFile`,
  `editablePath`, escritura atómica) + `files_test.go` + los tres bindings en
  `app_git.go`.
- S1 — `frontend/src/codemirror/languageRegistry.ts`, 13 `@codemirror/lang-*`
  más `@codemirror/legacy-modes`, todos por `import()` dinámico. Binario
  medido: **49MB** contra el techo de 80MB.
- S2 — `components/git/GitFileEditor.tsx` y la vista `'files'` en
  `GitRepoTab.tsx`.

**Dos desviaciones respecto de lo planeado acá, ambas deliberadas:**

1. **La tarea 2.1 (extraer un hook `useCodeMirrorTabs` compartido) no se
   hizo.** `GitFileEditor` implementa su propia mecánica de "una vista, un
   `EditorState` por pestaña". El motivo: lo que dispara una reconfiguración es
   distinto en cada uno —en el editor de base de datos es la conexión y su
   metadata, acá es un `import()` de lenguaje que resuelve tarde— así que el
   hook compartido habría sido la unión de ambos juegos de props con la mitad
   inaplicable en cada caso. Extraerlo con un solo consumidor real también
   choca con la regla de no introducir abstracciones para un solo uso. Queda
   como refactor con su propia justificación si aparece un tercer editor.
2. **La tarea 2.2 (`GitWorkTree.tsx` como componente aparte) quedó dentro de
   `GitFileEditor.tsx`.** La lista de archivos no se usa en ningún otro lado;
   separarla ahora sería un archivo más sin un segundo consumidor.

- S2.6 — botón **Editar** en la barra del diff, solo para diffs del working
  tree. `GitFileEditor` recibe un `request: {path, token}`; el token existe
  porque pedir dos veces el mismo archivo tiene que volver a enfocarlo.
- S3 — `backend/agentctx` (`scan.go` + `frontmatter.go` + `scan_test.go`),
  binding `GitAgentContext` en `app_localterm.go` y solapa **Agentes** en el
  panel (`components/git/GitAgentPanel.tsx`). Verificado contra los dos
  layouts reales: mini-tools (`.claude/skills`) y support-lab
  (`.github/skills`).

- S4 (lectura, 4.1–4.6) — `backend/mcpconf` con su lector JSON y su lector
  TOML acotado + binding `GitMCPConfig` + sección en el panel. **4.7
  (escritura) sigue pendiente y a propósito**: el lector de TOML documenta en
  su propio encabezado que no alcanza para escribir, porque escribir exige
  preservar todo lo que no se entiende.
- S9 (consumo de tokens, pedido después de escribir este plan) —
  `backend/agentusage` + binding `GitAgentUsage` + sección en el panel.

- S2.7 — **migración 30**: `git_repos.open_files` (rutas, nunca contenido) y
  `git_repos.default_agent`, con `GitRepoWorkspace`/`GitSetOpenFiles`/
  `GitSetDefaultAgent`. Con esto **S2 queda cerrado**.
- S6-A (parcial) — A.1 (agente por defecto, columna lista), A.2 y A.6:
  "Preguntar" desde la barra del editor arma el prompt con el archivo o el
  rango de líneas seleccionado y lo lleva a la sesión del agente elegido.
  **El prompt se escribe, no se envía** — misma decisión que el historial de
  comandos SSH. A una sesión recién creada no se le escribe de inmediato (el
  CLI tarda en arrancar y el texto se lo come la shell): queda en una barra
  con botón *Insertar*.
- Antigravity agregado al catálogo de `backend/agents` (binario `agy`, sin
  campo de API key porque no documenta modo por variable de entorno).

- S6-A **completo** — A.1 (selector de agente por defecto en el panel), A.2
  (Preguntar desde el editor y desde el diff), A.3 (sesiones nombradas por la
  tarea: `Claude Code · GitRepoTab.tsx:120-140`), A.4 (cada skill con su botón,
  invocándolo **por nombre** y no pegando el `SKILL.md`), A.5/A.6 (archivo,
  rango de líneas y diff como contexto).
- S5 (parcial) — 5.3: `codemirror/frontmatterLint.ts` marca en el editor los
  `SKILL.md`/subagentes/comandos a los que les falta el bloque, `name` o
  `description`, que es el fallo silencioso más caro de este ecosistema (el
  CLI no los carga y no avisa). 5.4: `backend/claudemd` emite además
  `AGENTS.md` y `GEMINI.md`, **punteros al mismo documento y no copias**.
- S5.1 quedó cubierto de hecho por el panel de agentes, que abre cualquier
  skill o archivo de instrucciones en el editor.

- **S6-B implementado** (B.1 a B.5), y esto **enmienda formalmente** la
  decisión fundacional de `backend/agents`: sigue siendo cierto que un agente
  se ejecuta como el programa de terminal que es, y ese camino no se tocó;
  `backend/agentchat` es un SEGUNDO camino en paralelo para lo que el PTY no
  puede dar. B.1 se resolvió capturando corridas reales de `claude -p
  --output-format stream-json --verbose` y `agy --print --output-format
  stream-json`, que quedaron como fixtures en `backend/agentchat/testdata/` y
  son contra lo que corren los tests. Codex no se pudo capturar (no está
  instalado) y por eso no tiene adaptador ni aparece como opción.
  - **B.5 completo**: modo, esfuerzo y modelo por turno, mapeados a banderas
    verificadas contra `claude --help` y `agy --help` (no supuestas). Los
    modos que se ofrecen son **por agente**: `auto` hoy solo lo tiene Claude
    Code y para Antigravity NO se traduce a `accept-edits`, porque sería dar
    más permiso del pedido. El modelo es campo libre a propósito: una lista
    fija de ids quedaría vieja rechazando modelos que existen.
  - **La aprobación del modo permisivo es un diálogo, y vale para la sesión.**
    Elegir `auto` o `edit` en el desplegable NO los activa: abre una
    confirmación que dice qué va a poder hacer el agente, y recién ahí queda
    activo. Se aprueba **una vez y sigue** — la razón de ser de esos modos es
    que el agente trabaje solo, y preguntar por mensaje los volvería inútiles.
    Mientras está puesto se avisa en todos los turnos.
  - **Después de un turno autónomo se informa qué quedó tocado** y se ofrece
    ir a Cambios. Aprobar el modo antes sirve de poco si revisar depende de
    acordarse; como los cambios caen en un repositorio git, la vuelta atrás ya
    existía y esto solo la pone a la vista.
  - **La salida de trabajo se muestra**: cada llamada a herramienta es una
    línea plegada con nombre, objetivo y tamaño (`Edit · src/app.go · 18
    líneas`). La descripción sale del CONTENIDO del argumento (`file_path`,
    `command`, `pattern`) y no del nombre de la herramienta: los tres CLIs
    llaman distinto a lo mismo y esa lista cambia con cada versión suya.
  - **B.6 resuelto como consentimiento explícito, no como diálogo de
    aprobación por acción.** El modo por defecto no fija permisos, así que una edición
    que necesita confirmación no se puede aprobar desde el chat y el agente la
    salta; "Aplicar ediciones" lo elige el usuario a mano, con la advertencia
    a la vista. Lo que lo hace defendible es que el resultado cae en el árbol
    de trabajo de un repositorio git: se ve en Cambios y se descarta ahí.
    **La bandera que saltea TODOS los permisos no se pasa nunca**, ni siquiera
    en ese modo — cubre también ejecutar comandos arbitrarios, que es otra
    decisión y no una que un desplegable pueda representar. Hay un test que
    falla si alguien agrega `--dangerously-skip-permissions`/`bypassPermissions`.
    Un diálogo de aprobación **por acción** (aprobar cada edición desde la UI)
    sigue pendiente. **Se investigó su viabilidad y el resultado importa:**
    exigiría `--permission-prompt-tool` apuntando a un servidor MCP propio, y
    ese servidor corre como OTRO proceso —lo lanza el CLI— así que necesita
    **IPC bidireccional** con la ventana para poder preguntar y esperar la
    respuesta. El repo ya re-ejecuta su binario dos veces (askpass, sequence
    editor), pero las dos son unidireccionales: reciben lo suyo por variable
    de entorno y contestan por stdout. Acá haría falta un socket Unix o un TCP
    en localhost con token —lo primero con soporte irregular en Windows, lo
    segundo abriendo un puerto—, más un servidor JSON-RPC a mano. Es una capa
    nueva y cae de lleno en lo que la regla 12 pide discutir antes, así que
    **no se implementó**: queda como decisión abierta, no como olvido.
  - Efecto lateral bueno: con chat nativo desaparece el baile de "insertar
    cuando el agente arranque" que necesitaba el camino PTY, porque no hay un
    CLI levantando al que no se le pueda escribir.

- **S7 (parcial)**: 7.1 (mensaje de commit desde el diff preparado), 7.2
  (revisar antes de pushear) y 7.3 (explicar un commit). El habilitador es
  `agentchat.Manager.Ask` + el binding `AskAgentOnce`: un turno de una sola
  vez que **devuelve el texto** en vez de streamearlo, que es lo que hace
  falta cuando la respuesta va a un campo del formulario y no a una
  conversación. `Ask` **rechaza los modos que editan**, así que una acción
  disparada por un botón no puede tocar archivos — la garantía está en el
  backend, no en que la UI no mande el parámetro.

- **S7 completo**: 7.4 (Consultar en el resolutor de conflictos), 7.5
  (Describir, al lado de "Crear pull request") y 7.6 (botón por línea fallida
  en el log de comandos, solo en las fallidas). En 7.4 se decidió **no** pedir
  el archivo resuelto para volcarlo en el editor: exigiría que el agente
  devuelva el contenido entero y exacto, y un merge mal reconstruido se ve
  idéntico a uno bien hecho hasta que alguien corre el código.

- **S5 completo** con 5.2: `components/git/MarkdownPreview.tsx`, a mano y sin
  librería (regla 12). Se renderiza a elementos de React y **nunca** con
  `dangerouslySetInnerHTML`: el contenido viene de archivos que pudo escribir
  cualquiera, y un renderer que arma HTML e inyecta es una vía de XSS con
  pasos extra. El frontmatter se muestra tal cual en vez de esconderse — de
  esos campos depende que el CLI cargue el archivo. Es lo
único del segmento que no aporta corrección sino comodidad, y escribir un
renderer propio —la alternativa es sumar una librería, contra la regla 12— es
más trabajo que valor frente a lo que queda por delante.

## Segmento 9 — Consumo de tokens (implementado)

Pedido durante la implementación: ver tokens consumidos y porcentajes de
Claude, Codex y Antigravity. Lo que la investigación previa determinó, y que
cambia la forma de la feature:

1. **El porcentaje de un límite de plan no existe en el disco.** Lo sabe el
   servidor; el CLI lo muestra preguntándoselo. Todo porcentaje que muestre
   esta app es una PROPORCIÓN de lo consumido (por modelo, por repositorio,
   caché sobre entrada), y eso está dicho en pantalla en vez de dejarse
   interpretar.
2. **Cada agente da lo que de verdad tiene.**
   - **Claude Code**: contadores completos en sus transcripts. Único con
     números de tokens.
   - **Antigravity** (instalado después, binario `agy`, estado en
     `~/.gemini/antigravity-cli/`): **no guarda consumo de tokens**. Se
     revisaron `conversations/`, `history.jsonl`, `log/`, `settings.json` y
     `conversation_summaries.db` — esa tabla tiene título, pasos, workspace,
     agente y fechas, ningún contador. El panel de límite semanal/cinco horas
     de su `/usage` lo contesta el servidor por gRPC a través de su language
     server y no queda escrito en disco; traerlo exigiría reimplementar esa
     llamada privada o manejar su TUI, y las dos se rompen en cuanto Google
     cambie algo. Se reporta **actividad** (conversaciones, pasos, cuántos de
     este repo, último uso), leída de su SQLite en modo `ro` porque es la base
     viva de otro programa.
   - **Codex**: no instalado, formato sin verificar, lector **no escrito**. Un
     parser a ciegas sobre transcripts ajenos produce totales que parecen
     razonables y están mal —el error clásico es sumar contadores acumulativos
     como si fueran incrementales, que infla por diez— y ese error no se
     detecta mirando la pantalla.
3. **El slug de `~/.claude/projects` es la ruta con `/`, `_` y `.` → `-`**,
   verificado contra los directorios reales. Es lo que permite decir cuánto
   del consumo total corresponde al repositorio abierto.
4. Los transcripts **repiten mensajes**; hay que deduplicar por
   `message.id` o el total se infla en silencio.

**Para completar Codex y Antigravity** hace falta tener los CLIs instalados y
usados, y verificar contra un archivo real dos cosas antes de escribir nada:
dónde están los contadores y si son acumulativos o incrementales.

**Ajuste de S0 que trajo S3:** el panel ofrece crear los archivos de
instrucciones que faltan, así que `WriteWorkFile` ahora **crea el directorio
padre** si no existe, y `editablePath` resuelve symlinks subiendo hasta el
ancestro más cercano que sí existe en vez de exigir que el padre esté. Sin las
dos cosas, "creá el `.github/copilot-instructions.md` que te falta" fallaba con
un error del sistema de archivos que no explicaba nada. La guarda de seguridad
no se debilitó: lo que se comprueba sigue siendo que el ancestro **real**
(resuelto) caiga dentro del repositorio.

**Hallazgo lateral, ya corregido en la documentación:** `go-react-contract.md`
afirmaba que `safeWorkingPath` "valida sobre la ruta resuelta, no sobre el
string" para no dejar pasar un symlink que apunte afuera. El código no hacía
eso — la validación era puramente textual. Alcanza para su caso real (rutas que
produce git), pero la afirmación era falsa; ahora el doc describe lo que cada
función hace de verdad, y quien implementa esa garantía es `editablePath`.

## Investigado y NO implementado (con lo que se aprendió)

Dos cosas quedaron fuera después de investigarlas. Lo que sigue existe para que
nadie las vuelva a encarar desde cero.

### Re-dibujar los mensajes anteriores al retomar un chat — **IMPLEMENTADO**

Se hizo con el alcance disparejo que la investigación anticipó, que es
exactamente el punto: la feature existe donde se puede leer y no finge donde
no. Lo que se encontró y por qué quedó así:

- **Claude Code**: `~/.claude/projects/<slug>/<sesión>.jsonl`, JSONL con el
  contenido de cada mensaje. **Factible.**
- **Codex**: `~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl`, con
  `response_item` → `payload` (mensajes por rol, `custom_tool_call`,
  `reasoning`). Factible, **pero con una trampa**: además del mensaje del
  usuario hay mensajes inyectados con rol `user` y `developer` (el prompt de
  sistema, la lista de plugins recomendados). Separarlos del mensaje real exige
  heurísticas sobre el texto, que es justo lo que envejece mal.
- **Antigravity**: `~/.gemini/antigravity-cli/conversations/<id>.db`, un SQLite
  cuya tabla `steps` guarda **blobs binarios** (protobuf, coherente con el
  `jetski_state.pbtxt` del mismo directorio). Sin el esquema, no se puede leer
  honestamente. **No factible.**

O sea: la feature saldría completa para uno, frágil para otro e imposible para
el tercero. Eso no la descarta —mostrar el historial de dos de tres ya sirve—
pero hay que decidirlo sabiendo que va a quedar disparejo, no descubrirlo a
mitad de camino.

### Aprobación por acción en Codex y Antigravity

- **Antigravity: no se puede hoy.** Su único control es
  `--dangerously-skip-permissions` (todo o nada). No expone hooks ni un
  mecanismo para delegar la decisión.
- **Codex: el mecanismo EXISTE y está más cerca de lo esperado, pero no se
  logró activarlo.** Tiene un sistema de hooks completo —eventos
  `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`…— y su
  contrato de SALIDA es prácticamente el mismo que el de Claude Code
  (`hookSpecificOutput.permissionDecision`), con estas diferencias que sus
  propios mensajes de error revelan:
  - En `PreToolUse` **solo acepta `deny`**: `allow` y `ask` los rechaza
    explícitamente. El evento que sí puede aprobar es `PermissionRequest`.
  - Una denegación **exige** un `permissionDecisionReason` no vacío.
  - Se configura en un `hooks.json` (no en `config.toml`) y requiere
    "confianza" en el hook, que se saltea con `--dangerously-bypass-hook-trust`.

  **Se probó de verdad y el hook no se ejecutó**: Codex leyó la config (avisó
  por la bandera de confianza) pero corrió el comando igual, así que la forma
  del `hooks.json` que se usó —copiada de la de Claude Code— no es la suya. Las
  claves que aparecen en el binario (`event_name`, `handler_type`,
  `execution_mode`, `matcher`, `commandWindows`, `timeout`, `async`) sugieren
  otro esquema. **Falta su schema documentado**; seguir adivinando cuesta una
  llamada real al modelo por intento y es exactamente la forma de equivocarse
  que esta rama evitó tres veces.

## Lo que este plan deja fuera a propósito

- Editar archivos **fuera** del repo abierto desde la pestaña Git — el módulo
  se apoya en `repoID` justamente para que el frontend nunca maneje rutas
  arbitrarias del sistema.
- Escribir credenciales de MCP en el vault. Los configs de MCP son del usuario
  y de sus CLIs; la app los edita donde viven.
- Un cuarto agente. El catálogo admite uno nuevo con una entrada en
  `registry.go`, pero cada agente agregado multiplica el trabajo de S4 y S6-B.
