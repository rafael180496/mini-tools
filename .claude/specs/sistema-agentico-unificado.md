# Plan — Sistema agéntico unificado, Vault Notes y servidor MCP nativo (1.4.0 → 2.0.0)

> **Estado: FASES 1 a 7 implementadas y verificadas.** La paridad de Windows
> se probó en Windows 10 y 11. Lo único que queda del plan es el empaquetado de
> la 2.0.0, que es un trigger del usuario. Ver "Estado de implementación".
>
> Segmentación completa de la
> especificación maestra pedida: IA omnipresente sobre los tres CLIs (Claude
> Code, Codex, Antigravity), asistencia agéntica dentro de los módulos de base
> de datos y SSH/SFTP, un **módulo nuevo** de base de conocimiento cifrada
> (grafo tipo Obsidian + bloques tipo Notion), un **servidor MCP nativo
> embebido**, y el cortafuegos de privacidad que separa "lo que veo yo" de "lo
> que puede leer un agente".
>
> Cada fase es una versión publicable por sí sola. Ninguna fase depende de que
> la siguiente exista.

## Hallazgos previos (estado real del código, verificado)

Estos siete determinan la segmentación. Sin ellos el plan sería otro —
concretamente, sería mucho más largo, porque **más de la mitad de lo que pide
la especificación maestra ya está construido**.

1. **La capa de sesión agéntica ya existe y es más completa que lo que
   describe la especificación.** `backend/agents` (catálogo + detección en
   PATH), `backend/agentchat` (modo headless traducido a eventos tipados, con
   adaptadores verificados contra corridas reales de los tres CLIs, historial,
   adjuntos, cinco modos de permiso), `backend/agentapprove` (aprobación acción
   por acción vía hook `PreToolUse`), `backend/agentplan`, `backend/agentmodels`
   y `backend/agentusage` ya están implementados y publicados en 1.3.x. El
   "Session Harness" por agente que pide la especificación **no es
   construcción nueva**: es cableado de lo que ya existe hacia módulos que hoy
   no lo tienen.

2. **`agentchat.Manager.Ask(ctx, Turn) (string, error)`
   (`backend/agentchat/session.go:209`) ya es el one-shot síncrono que
   necesitan NL2SQL, el analizador de `EXPLAIN` y el debugger de terminal.**
   Es el mismo método que hoy usa "Redactar mensaje de commit". Ninguna de esas
   features necesita un cliente de IA nuevo, ni una API key, ni una dependencia
   nueva: necesitan un prompt, un contexto y un botón.

3. **El chat agéntico está cableado *solo* dentro de la pestaña Git.**
   `GitAgentPanel.tsx`/`AgentChat.tsx` viven bajo `components/git/`, y el
   agente por defecto se persiste por repositorio (`GitSetDefaultAgent`,
   `git_repos.default_agent`). Para que la IA sea omnipresente hay que sacar la
   sesión de la pestaña Git a un servicio de nivel app — ese es el trabajo real
   de la Fase 1, y es la dependencia de las fases 2, 5 y 6.

4. **No hay ningún servidor MCP en el repo.**
   `.claude/specs/architecture.md` describe `backend/agentapprove/mcpserver.go`
   ("servidor MCP de stdio, conservado por si otro CLI lo usa") — **ese archivo
   no existe**: el paquete tiene `channel.go`, `hook.go`, `settings.go` y su
   test. Es deriva de documentación, y hay que corregirla. Lo que sí existe es
   `backend/mcpconf`, que **lee y edita la configuración MCP de los CLIs** —
   otra cosa. El servidor MCP nativo es construcción nueva completa.

5. **La aprobación acción por acción no funciona en Windows, y no hay ni un
   solo archivo con build tag de Windows en `backend/`.**
   `agentapprove/channel.go:106` hace `net.Listen("unix", path)` y
   `channel.go:207` el `Dial` correspondiente. Hoy el modo simplemente **no se
   ofrece** en una máquina sin `AF_UNIX` — decisión correcta (nunca comportarse
   como permisivo sin avisar), pero deja al usuario de Windows sin el modo de
   más control. Es exactamente lo que resuelve `winio`.

6. **ConPTY ya está resuelto y no hace falta trabajo nuevo ahí.** La
   especificación lo lista como pendiente de paridad multiplataforma, pero
   `backend/localterm` usa `github.com/aymanbagabas/go-pty`, que hace `openpty`
   por syscalls en Unix y **ConPTY en Windows**, en Go puro y sin romper el
   cross-compile. Esa parte del punto 9 de la especificación ya está hecha.

7. **`environment` (`prod`/`staging`/`dev`) ya existe en las conexiones de base
   de datos** (`backend/vault/connections_repo.go:36`), con
   `ProductionGuardDialog.tsx` interceptando sentencias destructivas. **Las
   conexiones SSH no lo tienen** — ahí el Production Guard es construcción
   nueva, pero copiando un patrón ya probado en vez de inventarlo.

**Migración actual del vault: 32.** La primera migración nueva de este plan es
la **33** (que es, casualmente, el número que ya suponía la especificación).

## Lo que ya existe y NO se re-implementa

Tabla de correspondencia entre la especificación maestra y el código actual,
para no pagar dos veces lo mismo:

| Pide la especificación | Estado real |
|---|---|
| Claude Code / Codex / Antigravity Session Harness | ✅ `backend/agents` + `backend/agentchat` (1.2.0–1.3.1) |
| Control de permisos paso a paso (5 modos) | ✅ `agentchat.ModesFor` + `backend/agentapprove` |
| Lectura de `CLAUDE.md` / `AGENTS.md` / skills / subagentes | ✅ `backend/agentctx` |
| Rastreo de modelo / esfuerzo / plan / consumo de tokens | ✅ `agentmodels`, `agentplan`, `agentusage` |
| Historial de conversaciones por repositorio | ✅ `agentchat/history.go` + `agent_chats` (migraciones 31–32) |
| 7 motores de base de datos | ✅ Oracle, Postgres, SQLite, SQL Server, MySQL/MariaDB*, Redis, Mongo |
| Autocompletado de tablas/alias/FKs reales | ✅ `backend/sqlintel` (no es IA: es índice de esquema + fuzzy) |
| `EXPLAIN` → árbol de costo **y su diagnóstico** | ✅ `backend/explain` — `analysis.go` (severidad, cuello de botella, estimaciones erradas) y `suggest.go` (`CREATE INDEX`). Verificado en la fase 2: NO había que construirlo |
| Inspector Redis (tipos, `MEMORY USAGE`, TTL, Pub/Sub, Streams) | ✅ `backend/redisquery` + `rediskeys.go` |
| Explorador SFTP doble panel + cola de transferencias | ✅ `backend/sftpx` + `components/sftp/` |
| Edición remota con `Ctrl+S` (Remote Edit & Sync) | ✅ `ReadSftpFileForEdit`/`WriteSftpFileFromEdit` |
| Badges de entorno + intercepción de destructivos | ✅ **solo en bases de datos**; falta en SSH |
| ConPTY en Windows | ✅ `go-pty` en `backend/localterm` |
| Renombre Gemini CLI → Antigravity | ✅ una entrada con `altBins`, no dos |

\* Verificar si MySQL/MariaDB está realmente registrado antes de anunciarlo:
`architecture.md` lista seis motores + Mongo, y no menciona MySQL. Si no está,
es una tarea aparte que **no** entra en este plan (motor relacional nuevo =
regla 2 sin excepción, camino `database/sql` normal).

## Restricciones que atraviesan todos los segmentos

De [.claude/rules/technical.md](../rules/technical.md), aplican sin excepción:

- **Punto 1 (sin cgo)** — el grafo de conocimiento no puede traer nada nativo.
  Cualquier render 3D se resuelve con WebGL en el frontend, jamás con una
  dependencia Go con cgo.
- **Punto 3 (cifrado por columna, no de archivo)** — las notas van cifradas
  columna por columna con AES-256-GCM y la clave maestra del `vaultgate`,
  igual que `encrypted_dsn`. Nada de SQLCipher.
- **Punto 5 (gate server-side)** — todo binding nuevo de `App` pasa por
  `requireUnlocked()`. El servidor MCP **no es una excepción**: si el vault
  está bloqueado, responde error, no datos.
- **Punto 8 (<80MB)** — la Fase 4 (grafo + bloques) es la única que suma peso
  de frontend serio. Medir con `wails build` y anotar el delta antes de
  mergear, igual que se hizo con los lenguajes de CodeMirror.
- **Punto 9/10 (el frontend nunca ve un DSN; nunca loguear)** — se extiende:
  **el agente tampoco**. Ver la matriz de permisos en el Segmento 6.3.
- **Punto 12 (dependencias mínimas)** — el servidor MCP se escribe a mano
  sobre JSON-RPC 2.0 por stdio (~200 líneas), no se suma un SDK de MCP.
- **Punto 13 (migraciones aditivas)** — 33 en adelante, `CREATE TABLE IF NOT
  EXISTS` / `ADD COLUMN ... DEFAULT`, nunca tocar `vault_meta`, verificadas con
  el patrón de script efímero en `HOME=$(mktemp -d)`.

De [.claude/rules/conventions.md](../rules/conventions.md): sin tests nuevos,
`title=""` en **todo** control interactivo nuevo, tokens Material Design 3 y
`<Icon name>` (nunca emoji), `ConfirmDialog` en vez de `window.confirm`, y
entrada en `CHANGELOG.md` bajo `[Unreleased]` **en la misma tarea**.

## Mapa de versiones

| Fase | Versión | Qué entrega | Depende de |
|---|---|---|---|
| 1 | **1.4.0** ✅ | **Chat integral único para todos los módulos** + sesión agéntica de nivel app + sistema `@` de contexto | — |
| 2 | **1.5.0** ✅ | IA en bases de datos: NL2SQL, auto-fix, análisis de plan | Fase 1 |
| 3 | **1.6.0** ✅ | Vault Notes: núcleo cifrado, WikiLinks, backlinks, **buscador** | — |
| 4 | **1.7.0** ✅ | Vault Notes: bloques `/slash`, runbooks vivos, grafo, chat por nota | Fase 3 |
| 5 | **1.8.0** ✅ | SSH agéntico: debugger de terminal, `@ssh`, sincronización terminal↔SFTP (el Production Guard **ya existía**) | Fase 1 |
| 6 | **1.9.0** ✅ | Servidor MCP nativo embebido + AI Access Firewall | Fases 1, 3 |
| 7 | **2.0.0** ✅ | Paridad Windows (`winio`), verificada en Windows 10 y 11 | Todas |

Las fases 3 y 4 (Vault Notes) son **independientes** de las fases 1, 2 y 5: se
pueden hacer en paralelo o adelantar si el módulo de notas es lo más urgente.
La única dependencia dura es que la Fase 6 necesita 1 y 3 terminadas.

---

# FASE 1 — Núcleo agéntico de nivel app (1.4.0)

Hoy la IA vive dentro de la pestaña Git. Esta fase la saca de ahí. Es la fase
más importante del plan: sin ella, cada módulo que quiera IA duplica el
cableado del chat.

Su entregable central es **un solo componente de chat integral**, compartido
por todos los módulos de la aplicación (bases de datos, Redis, Mongo, SSH,
SFTP, Git, Notas). No un chat por módulo con aire de familia: **el mismo
componente montado en distintos lugares**, con la misma conversación, el mismo
historial y el mismo selector de agente/modelo/modo. Cambiar de pestaña no
cambia de chat.

## Segmento 1.1 — Servicio de sesión agéntica de nivel app

| # | Tarea | Archivos |
|---|---|---|
| 1.1.1 | Mover la noción de "sesión agéntica activa" de la pestaña Git a un servicio de `App`: agente, modelo, esfuerzo y modo actuales, con un único punto de consulta | `backend/agentchat/active.go` (nuevo), `app.go` |
| 1.1.2 | `AgentAsk(ctx, prompt, contextRefs)` bindeado: envuelve `Manager.Ask` con modo **no-edición forzado en el backend** y timeout, igual que hace hoy "Redactar" | `app_agent.go` (nuevo) |
| 1.1.3 | `AgentSendToChat(prompt, contextRefs)`: en vez de responder en línea, inyecta el turno en la conversación abierta del panel de agentes | `app_agent.go` |
| 1.1.4 | Selector de agente activo en el toolbar principal (`Workspace.tsx`), no solo en la pestaña Git; muestra agente + modelo + esfuerzo, y su ausencia cuando no hay ninguno instalado | `components/AgentBar.tsx` (nuevo), `Workspace.tsx` |
| 1.1.5 | Migración **33**: `settings.active_agent` / `active_model` / `active_effort` (`DEFAULT ''` = preguntar) | `backend/vault/migrations.go`, `settings_repo.go` |

`AgentAsk` y `AgentSendToChat` son dos verbos distintos a propósito: el primero
es "contestame acá y ahora" (NL2SQL, analizar un error), el segundo es "llevate
esto a la conversación" (mandar un plan de ejecución para discutirlo). Todo
módulo que sume IA de acá en adelante usa uno de los dos, nunca arma su propio
subproceso.

**Verificación:** `go build ./...`; abrir una pestaña SQL sin ningún repo Git
abierto y confirmar que el selector de agente funciona igual.

## Segmento 1.2 — Componente de chat integral, uno solo para toda la app

Hoy el chat es `components/git/AgentChat.tsx`: vive bajo el dominio Git, recibe
props de repositorio y se monta dentro de `GitRepoTab`. Este segmento lo
promueve a componente de nivel app y lo deja como **el único chat que existe**.

| # | Tarea | Archivos |
|---|---|---|
| 1.2.1 | Mover `AgentChat.tsx` / `AgentChatHistory.tsx` de `components/git/` a `components/agent/`, sin cambios de comportamiento (commit separado y verificable) | `components/agent/` (nuevo) |
| 1.2.2 | Romper el acoplamiento con Git: `repoID`/`repoPath` dejan de ser props obligatorias y pasan a ser un **contexto de trabajo** opcional (`{ kind: 'git' \| 'db' \| 'ssh' \| 'note' \| 'none', id, label }`) | `components/agent/AgentChat.tsx` |
| 1.2.3 | `AgentChatHost`: contenedor único que sostiene la conversación viva, montado **una sola vez** en `Workspace.tsx` — no uno por pestaña | `components/agent/AgentChatHost.tsx` (nuevo) |
| 1.2.4 | Presentación conmutable sobre el mismo host: **panel lateral acoplable** (izquierda/derecha/abajo, reusando el mecanismo `gitTermDock`/`gitTermSize` que ya existe) y **modo ventana flotante** | `AgentChatHost.tsx` |
| 1.2.5 | Atajo global (`Cmd/Ctrl + L`) que abre/cierra el chat desde cualquier módulo, con el contexto de trabajo del módulo activo ya cargado | `Workspace.tsx` |
| 1.2.6 | Encabezado del chat: muestra **sobre qué está trabajando** (`Postgres · Prod_Analytics`, `SSH · SUN24D01`, `Git · mini-tools`, `Nota · Runbook SGC`) y cambia solo cuando cambia el módulo activo | `AgentChat.tsx` |
| 1.2.7 | La conversación **no se reinicia al cambiar de módulo**: es una sola sesión con contexto que se desplaza. Cambiar de pestaña inserta una marca de contexto en el hilo, no un chat nuevo | `backend/agentchat/active.go`, `AgentChat.tsx` |
| 1.2.8 | `GitRepoTab.tsx` **conserva su panel**, montando el MISMO componente. Lo que se unifica es el componente y sus capacidades, no la cantidad de paneles — ver "Un componente, dos propósitos" abajo | `components/git/GitRepoTab.tsx`, `GitAgentPanel.tsx` |
| 1.2.9 | Puntos de entrada por módulo, todos hacia el mismo componente: editor SQL, panel de resultados, visor de `EXPLAIN`, terminal SSH, panel SFTP, editor de notas | módulos respectivos |
| 1.2.10 | El historial es uno solo (`agent_chats`), con el **módulo de origen** como columna nueva para poder filtrar por él — migración incluida en la **33** | `backend/vault/migrations.go`, `agent_chats_repo.go` |
| 1.2.11 | Estado vacío honesto: sin ningún CLI instalado, el chat explica cuál falta y cómo instalarlo, en vez de un cuadro de texto que no responde | `AgentChat.tsx` |

### Un componente, dos propósitos

Unificar el **componente** no es unificar el **propósito**. Lo que hace el
agente en el módulo Git y lo que hace en una base de datos son dos trabajos
distintos, y el mismo componente los cubre porque lo que cambia entre uno y
otro es el contexto, no el chat:

| | Módulo Git | Bases de datos, SSH, notas |
|---|---|---|
| Qué es | Un **proyecto de código** que el agente puede leer y escribir | Un recurso que se **consulta** |
| Modos permisivos (editar, automático) | **Sí** — el resultado cae en el árbol de trabajo, se ve en el diff y se descarta con un clic | **No se ofrecen**: fuera de un repositorio esa vuelta atrás no existe |
| Directorio de trabajo del agente | El repositorio | Un directorio propio y **vacío** (ver `agentCwd`) |
| Selector de `@` | Archivos y carpetas del árbol de trabajo | Conexiones, tablas, planes de ejecución |
| Qué se le pide | "Arreglá esto", "escribí el commit", "revisá el diff" | "Escribime esta consulta", "explicá este error", "por qué este plan es lento" |

Por eso el panel de la pestaña Git **se queda donde está**: es el banco de
trabajo agéntico sobre código, con sus permisos, su aprobación acción por
acción, sus conversaciones en paralelo ("validar con otro") y su aviso de
archivos tocados. Lo que se unificó es que ahora todo eso es **el mismo
componente** que se abre desde el editor SQL o desde una terminal SSH, en vez
de una implementación por módulo que se desincroniza.

**Por qué un solo componente y no uno por módulo.** El trabajo real cruza módulos:
se mira un `EXPLAIN`, se corrige la consulta, se revisa un log por SSH y se
anota la conclusión en una nota. Con un chat por módulo, ese hilo único queda
partido en cuatro conversaciones que no se conocen entre sí, y el agente
pierde justo lo que lo hace útil — lo que ya se habló. Además evita cuatro
implementaciones que se desincronizan: hoy el chat tiene modos de permiso,
adjuntos, historial, consumo de tokens, renderizado Markdown y cancelación;
duplicar eso por módulo es garantizar que tres de las cuatro copias queden
atrás.

**Riesgo a vigilar:** 1.2.1 y 1.2.2 tocan código publicado y funcionando. La
pestaña Git es hoy el único consumidor del chat, así que es el único lugar
donde se puede romper algo que ya andaba. Van como tareas separadas y con
verificación propia, no mezcladas con las features nuevas.

**Verificación:** `pnpm build`; abrir el chat desde el editor SQL, cambiar a la
pestaña Git y confirmar que **es la misma conversación** con el encabezado
actualizado; confirmar que el panel de Git se ve y se comporta igual que en
1.3.1.

## Segmento 1.3 — Sistema `@` de referenciación unificado

El resolvedor vive **entero en Go**. El frontend manda la cadena `@...` tal
cual la escribió el usuario; nunca resuelve nada por su cuenta (si resolviera,
el contenido sensible ya habría cruzado el binding). Es el otro lado del chat
único: un solo compositor de mensajes que sabe referenciar **cualquier**
recurso de la app.

| # | Tarea | Archivos |
|---|---|---|
| 1.3.1 | `agentctx/refs.go`: parser de `@tipo:valor` tolerante a fallos (un `@` suelto es texto, no error) | `backend/agentctx/refs.go` (nuevo) |
| 1.3.2 | Registro de resolvedores: `file`, `db`, `explain`, `ssh`, `git`, `note`; cada uno declara su **política de seguridad** además de su función | `backend/agentctx/resolve.go` (nuevo) |
| 1.3.3 | `@file:ruta` → contenido del archivo del working tree, reusando `git.ReadWorkFile` (que ya valida path traversal y detecta binarios) | `resolve.go` |
| 1.3.4 | `@db:conn/tabla` → DDL + PK + FK + índices desde `db.SchemaMetadata`. **Nunca filas, nunca DSN** | `resolve.go` |
| 1.3.5 | `@explain:last` → JSON del último plan del árbol de `backend/explain` | `resolve.go` |
| 1.3.6 | `@ssh:alias/last_error` → últimas N líneas del buffer de la sesión SSH activa (N configurable, tope duro) | `resolve.go`, `backend/sshconn` |
| 1.3.7 | `@git:staged` → `git diff --staged` vía el runner existente | `resolve.go` |
| 1.3.8 | `@note:Título` → **stub que devuelve "módulo no disponible"** hasta la Fase 3; el resolvedor existe desde ya para no rehacer el registro después | `resolve.go` |
| 1.3.9 | Autocompletado de `@` en el compositor del chat único: al escribir `@` se ofrecen los tipos, y al elegir uno se ofrecen sus valores reales (conexiones, alias SSH, archivos abiertos, notas) | `components/agent/AgentRefPicker.tsx` (nuevo) |
| 1.3.10 | Toda referencia resuelta se muestra en la UI como una **ficha desplegable con lo que se envió** antes de mandar el turno | `components/agent/AgentChat.tsx` |

1.3.10 no es cosmético: es la única forma de que el usuario vea qué salió de su
máquina. Una referencia que se expande en silencio es indistinguible de una
fuga.

**Verificación:** `go build ./...`; mandar un turno con `@db:X/tabla` y
confirmar en la ficha que salió DDL y **cero filas**; `@file:` con
`../../../etc/passwd` debe ser rechazado por la validación que ya existe.

## Segmento 1.4 — Cierre de fase

| # | Tarea |
|---|---|
| 1.4.1 | Corregir `architecture.md`: `agentapprove/mcpserver.go` no existe (hallazgo 4), y el chat ya no vive bajo `components/git/` |
| 1.4.2 | Documentar el sistema `@` y el contrato del chat único en `go-react-contract.md` |
| 1.4.3 | `CHANGELOG.md` bajo `[Unreleased]`, `codegraph sync`, `wails build` + medición del binario |

---

# FASE 2 — IA en bases de datos (1.5.0)

Todo se apoya en `AgentAsk` (1.1.2). Cero clientes de IA nuevos.

## Segmento 2.1 — NL2SQL con contexto de esquema

| # | Tarea | Archivos |
|---|---|---|
| 2.1.1 | Barra flotante `Cmd/Ctrl + I` sobre el editor: input de lenguaje natural, estados pidiendo/generando/cancelable | `components/editor/NlPromptBar.tsx` (nuevo) |
| 2.1.2 | Constructor de contexto: DDL de las tablas **relevantes** (no del esquema entero — un esquema Oracle real no entra en una ventana de contexto), elegidas por el índice de `backend/sqlintel` a partir del texto del pedido | `backend/sqlintel/context.go` o `backend/agentctx/dbctx.go` |
| 2.1.3 | Prompt dialecto-aware: el `DBType` de la conexión activa determina la dialéctica pedida (Oracle `FETCH FIRST`/`NVL`/`TO_DATE`, Postgres `ILIKE`/`->>`/`DISTINCT ON`, T-SQL `TOP`/`CROSS APPLY`, pipelines para Mongo) | `backend/agentctx/prompts.go` (nuevo) |
| 2.1.4 | Inserción del resultado como **diff propuesto**, no como reemplazo directo: se ve qué cambia y se acepta o descarta | `NlPromptBar.tsx`, `CodeMirrorTabbedEditor.tsx` |
| 2.1.5 | La consulta generada **nunca se ejecuta sola**, ni siquiera en modo automático | `NlPromptBar.tsx` |

2.1.4 y 2.1.5 son la línea entre "asistente" y "algo que escribe en tu base de
producción". Se aplican en el backend cuando se puede y en la UI siempre.

**Verificación:** generar la misma consulta contra Oracle y contra Postgres y
confirmar que la dialéctica cambia; probar con el vault bloqueado (debe fallar
antes de llegar al agente).

## Segmento 2.2 — Auto-fix de errores SQL

| # | Tarea | Archivos |
|---|---|---|
| 2.2.1 | Captura estructurada del error del motor (`ORA-xxxxx`, `SQLSTATE`, código de SQL Server) en el panel de resultados | `components/results/`, `backend/query/executor.go` |
| 2.2.2 | Botón **Explicar y corregir** junto al error, que manda error + sentencia + DDL de las tablas mencionadas | `components/results/ErrorPanel.tsx` |
| 2.2.3 | Respuesta como diff aplicable sobre la pestaña, reusando 2.1.4 | `NlPromptBar.tsx` |

**Verificación:** provocar un `ORA-00942` y un error de sintaxis de Postgres,
confirmar que el contexto enviado incluye el DDL correcto.

## Segmento 2.3 — Diagnóstico de `EXPLAIN` e Index Advisor

| # | Tarea | Archivos |
|---|---|---|
| 2.3.1 | Detección de cuellos de botella en el árbol ya existente: `Seq Scan` (Postgres), `TABLE ACCESS FULL` (Oracle), `Table Scan` (T-SQL), con umbral de filas configurable | `backend/explain/diagnose.go` (nuevo) |
| 2.3.2 | Resaltado de esos nodos en el visor, **sin IA** — es una regla determinista y debe funcionar con el agente apagado | `components/explain/` |
| 2.3.3 | Botón **Analizar plan con el agente**: manda el JSON del plan + DDL + índices existentes | `components/explain/ExplainPlanPanel.tsx` |
| 2.3.4 | Index Advisor: el DDL de `CREATE INDEX` sugerido se muestra en un bloque **copiable, jamás ejecutable desde ahí** | `ExplainPlanPanel.tsx` |
| 2.3.5 | `@explain:last` (1.3.5) se alimenta de este mismo estado | `backend/explain` |

2.3.2 antes que 2.3.3 a propósito: el 80% del valor de esta pantalla es
determinista, y hacerlo depender de que haya un CLI instalado sería regalar
funcionalidad.

**Verificación:** plan real de Postgres con `Seq Scan` sobre tabla grande →
nodo resaltado sin agente; con agente → sugerencia de índice coherente con las
FK reales.

## Segmento 2.4 — Redis y MongoDB

| # | Tarea | Archivos |
|---|---|---|
| 2.4.1 | `Cmd/Ctrl + I` en pestañas `mongosh`: genera pipelines de agregación con las colecciones e índices reales como contexto | `NlPromptBar.tsx`, `backend/db/mongometa.go` |
| 2.4.2 | `Cmd/Ctrl + I` en pestañas Redis: genera comandos con el mapa de claves y tipos de `rediskeys.go` como contexto | `NlPromptBar.tsx` |
| 2.4.3 | Contexto de Redis limitado a **patrones de clave y tipos, nunca valores** — un valor de Redis es dato de usuario | `backend/agentctx/dbctx.go` |

**Verificación:** pedir "las conversaciones de la última hora agrupadas por
estado" en Mongo y en Redis; confirmar que ningún valor de clave salió en el
prompt.

## Segmento 2.5 — Cierre de fase

`CHANGELOG.md`, `codegraph sync`, `wails build` + medición, y una nota en el
SKILL sobre dónde se construye el contexto de esquema (es el lugar donde va a
volver a tocarse).

---

# FASE 3 — Vault Notes: núcleo cifrado (1.6.0)

**Módulo nuevo.** Base de conocimiento cifrada en el vault, con Markdown puro
como formato y WikiLinks como relación. Esta fase entrega un módulo de notas
**usable y completo** sin bloques ni grafo — esos son la Fase 4.

## Segmento 3.1 — Esquema y cripto

| # | Tarea | Archivos |
|---|---|---|
| 3.1.1 | Migración **34**: `vault_notes` (`id`, `title_encrypted`, `title_nonce`, `content_encrypted`, `content_nonce`, `frontmatter_encrypted`, `frontmatter_nonce`, `title_hash`, `is_private INTEGER NOT NULL DEFAULT 1`, `checksum_hash`, `created_at`, `updated_at`) | `backend/vault/migrations.go` |
| 3.1.2 | Migración **35**: `vault_note_links` (`source_note_id`, `target_title_hash`) + índices por source y por target | `migrations.go` |
| 3.1.3 | Índice `idx_notes_ai_access (id, is_private)` para filtrar sin descifrar | `migrations.go` |
| 3.1.4 | `notes_repo.go`: CRUD con cifrado/descifrado por columna reusando `backend/crypto`, **exactamente el patrón de `encrypted_dsn`** (un nonce propio por columna, nunca reusado) | `backend/vault/notes_repo.go` (nuevo) |
| 3.1.5 | `title_hash`: SHA-256 del título **normalizado** (minúsculas, espacios colapsados) — es lo que permite resolver `[[Nota]]` y dibujar el grafo sin descifrar nada. Mismo criterio que el título cifrado de `agent_chats` (migración 31) | `notes_repo.go` |
| 3.1.6 | `checksum_hash`: SHA-256 del texto plano antes de cifrar, verificado al leer; una nota corrupta se informa como tal en vez de mostrar basura | `notes_repo.go` |
| 3.1.7 | Verificación de las migraciones con el patrón de script efímero (`HOME=$(mktemp -d)`), incluyendo que una fila preexistente reciba `is_private = 1` | script temporal, no commiteado |

**El `DEFAULT 1` de `is_private` es la mitad del cortafuegos**, y vive en el
esquema justamente para que no dependa de que alguien se acuerde de setearlo.
La otra mitad es el Segmento 6.3.

**Verificación:** guardar una nota, cerrar la app, reabrir y descifrar;
inspeccionar `vault.db` con `sqlite3` y confirmar que **el título y el cuerpo
son ilegibles** y que `title_hash` no revela el título.

## Segmento 3.2 — Editor y navegación

| # | Tarea | Archivos |
|---|---|---|
| 3.2.1 | Pestaña **Notas** de nivel app, hermana de Conexiones/Git/Sesiones | `Workspace.tsx`, `components/notes/NotesTab.tsx` (nuevo) |
| 3.2.2 | Lista/árbol de notas con búsqueda por título, ordenable por modificación | `components/notes/NoteList.tsx` (nuevo) |
| 3.2.3 | Editor Markdown sobre CodeMirror 6 reusando `@codemirror/lang-markdown` (que ya está en el bundle por el editor de archivos de Git) y `useCodeMirrorTabs` | `components/notes/NoteEditor.tsx` (nuevo) |
| 3.2.4 | Vista previa reusando `MarkdownPreview.tsx` (que ya arma elementos React y **nunca inyecta HTML** — requisito, no detalle) | `components/notes/NoteEditor.tsx` |
| 3.2.5 | Guardado con debounce + indicador de sucio; `Cmd/Ctrl+S` explícito | `NoteEditor.tsx` |
| 3.2.6 | Badge de privacidad en la barra de la nota: **🔒 Privado (oculto para IA)** / **🔓 Acceso IA permitido**, con `title=""` explicando la consecuencia de cada estado | `components/notes/PrivacyToggle.tsx` (nuevo) |
| 3.2.7 | Cambiar de privada a pública pide confirmación con `ConfirmDialog` diciendo **qué** se va a poder leer | `PrivacyToggle.tsx` |
| 3.2.8 | Migración **36**: `settings.notes_last_open` / `notes_panel_layout` | `migrations.go` |

**Verificación:** `pnpm build`; crear una nota, comprobar que nace privada sin
tocar nada, alternar el toggle y ver el badge cambiar.

## Segmento 3.3 — WikiLinks y backlinks

| # | Tarea | Archivos |
|---|---|---|
| 3.3.1 | Extractor de `[[Título]]` del Markdown, tolerante a alias `[[Título\|texto]]` | `backend/vault/notelinks.go` (nuevo) |
| 3.3.2 | Reindexado de `vault_note_links` en cada guardado (borrar los del source + insertar los nuevos, dentro de una transacción) | `notes_repo.go` |
| 3.3.3 | Autocompletado al escribir `[[` en el editor, servido por backend (títulos descifrados en RAM, nunca persistidos en claro) | `frontend/src/codemirror/wikiLinks.ts` (nuevo) |
| 3.3.4 | Enlaces navegables en la vista previa; un enlace a una nota inexistente se dibuja distinto y ofrece **crearla** | `MarkdownPreview.tsx`, `NoteEditor.tsx` |
| 3.3.5 | Panel de **Backlinks** (entrantes) y **Forward links** (salientes) de la nota abierta | `components/notes/LinksPanel.tsx` (nuevo) |
| 3.3.6 | Búsqueda de texto completo **descifrando en RAM** con tope de resultados y cancelación — ver la decisión abierta D2 | `notes_repo.go` |

**Verificación:** crear tres notas enlazadas en cadena, renombrar la del medio
y confirmar el comportamiento elegido en D3 (enlaces rotos visibles, no
silenciosos).

## Segmento 3.4 — Cierre de fase

`CHANGELOG.md`, `codegraph sync`, `wails build` + medición, y **doc nuevo**
`.claude/specs/vault-notes.md` con el diseño de cripto y del cortafuegos, más
su fila en el índice de `CLAUDE.md`.

---

# FASE 4 — Vault Notes: bloques, runbooks y grafo (1.7.0)

## Segmento 4.1 — Motor de bloques `/slash`

| # | Tarea | Archivos |
|---|---|---|
| 4.1.1 | Menú `/` en el editor como `CompletionSource` de CodeMirror (el mismo mecanismo que ya usa `sqlIntel.ts`, no un widget flotante nuevo) | `frontend/src/codemirror/slashCommands.ts` (nuevo) |
| 4.1.2 | `/h1` `/h2` `/h3`, `/table`, `/toggle` — puro Markdown/GFM, sin formato propietario | `slashCommands.ts` |
| 4.1.3 | `/callout` como blockquote con marca (`> [!INFO]`, `[!WARNING]`, `[!SECURITY]`, `[!TIP]`), renderizado con tokens MD3 | `MarkdownPreview.tsx` |
| 4.1.4 | `/mermaid`: bloque ` ```mermaid `. **Medir el peso de la dependencia antes de mergear** — ver decisión abierta D4 | `components/notes/MermaidBlock.tsx` (nuevo) |
| 4.1.5 | Todo bloque es Markdown válido: una nota exportada a `.md` se abre en Obsidian sin pérdida | criterio transversal |

4.1.5 es una restricción de diseño, no un extra: guardar un formato de bloques
propietario dentro de una columna cifrada crea datos que solo esta app puede
leer, y el usuario ya tiene una app así (el vault) para credenciales, no para
su documentación.

## Segmento 4.2 — Runbooks vivos (bloques ejecutables)

| # | Tarea | Archivos |
|---|---|---|
| 4.2.1 | ` ```sql connection="Alias" ` — parseo del atributo y resolución del alias contra las conexiones del vault | `backend/vault/runbook.go` (nuevo) |
| 4.2.2 | Botón **Ejecutar** en el bloque, que corre por `backend/query` con el mismo executor de siempre (streaming, cancelación) y muestra el resultado **debajo del bloque, sin guardarlo en la nota** | `components/notes/SqlBlock.tsx` (nuevo) |
| 4.2.3 | ` ```ssh server="Alias" ` — ídem contra `backend/sshconn` | `components/notes/SshBlock.tsx` (nuevo) |
| 4.2.4 | **El Production Guard aplica igual acá**: si la conexión está marcada `prod`, un bloque destructivo pide la confirmación que ya existe | `ProductionGuardDialog.tsx`, `runbook.go` |
| 4.2.5 | Nunca hay "ejecutar todos los bloques": cada uno se dispara a mano | criterio transversal |
| 4.2.6 | Un alias que ya no existe se informa en el bloque ("la conexión *X* ya no está guardada"), no falla en silencio | `SqlBlock.tsx`, `SshBlock.tsx` |

4.2.5 y 4.2.4 juntos: una nota con bloques ejecutables es un script, y un
script que se ejecuta entero de un clic sobre producción es exactamente el
accidente que el Production Guard existe para evitar. Que sea "un runbook" no
lo hace menos peligroso — lo hace **más** probable de correr contra prod.

**Verificación:** runbook con un `SELECT` contra una conexión `dev` y un
`DELETE` contra una `prod`; el segundo debe exigir escribir el nombre del host.

## Segmento 4.3 — Grafo de conocimiento

| # | Tarea | Archivos |
|---|---|---|
| 4.3.1 | `NotesGraph(includePrivate bool)` bindeado: nodos (id, título descifrado, `is_private`) + aristas desde `vault_note_links`, **sin cuerpos de nota** | `app_notes.go` (nuevo) |
| 4.3.2 | Layout dirigido por fuerzas escrito a mano (~150 líneas) sobre `<canvas>` 2D; sin librería de grafos — ver decisión abierta D5 | `components/notes/GraphView.tsx` (nuevo) |
| 4.3.3 | Interacción: zoom, pan, arrastrar nodo, clic para abrir la nota, hover con vecinos resaltados | `GraphView.tsx` |
| 4.3.4 | Nodo de nota privada visible y **marcado con el candado** — el grafo es de la app, no de la IA | `GraphView.tsx` |
| 4.3.5 | Filtros: por etiqueta del frontmatter, por privacidad, por notas huérfanas | `GraphView.tsx` |
| 4.3.6 | Modo 3D (WebGL) **como segmento condicionado**: solo si 4.3.2 queda corto en grafos reales y el delta de binario lo permite. Si no, se documenta como descartado con el número medido | `GraphView.tsx` |

**Verificación:** 200 notas sintéticas (script efímero) → el grafo se mantiene
interactivo; confirmar que ningún cuerpo de nota cruza el binding
(inspeccionar el payload de `NotesGraph`).

## Segmento 4.4 — Cierre de fase

`CHANGELOG.md`, `codegraph sync`, **medición obligatoria del binario** (es la
fase que más peso suma), actualizar `.claude/specs/vault-notes.md` y el punto
8 de `technical.md` con el delta real.

---

# FASE 5 — SSH y SFTP agénticos (1.8.0)

## Segmento 5.1 — Debugger de terminal

| # | Tarea | Archivos |
|---|---|---|
| 5.1.1 | Detección de salida con error: código de retorno distinto de cero, o selección manual de texto en xterm.js | `components/ssh/SshTerminalTab.tsx` |
| 5.1.2 | Botón flotante **Analizar con el agente** sobre la selección | `components/ssh/AnalyzeErrorButton.tsx` (nuevo) |
| 5.1.3 | Contexto de sistema operativo: `uname -a` / release / shell, cacheado por sesión, adjuntado al pedido para que la respuesta traiga comandos del SO real (SunOS ≠ RHEL ≠ Alpine) | `backend/sshconn/osinfo.go` (nuevo) |
| 5.1.4 | El comando propuesto por el agente **no se escribe solo en la terminal**: se ofrece "copiar" e "insertar sin ejecutar" | `AnalyzeErrorButton.tsx` |
| 5.1.5 | `@ssh:alias/last_error` (1.3.6) se alimenta del mismo buffer | `backend/sshconn` |

**Verificación:** provocar un error real en un servidor SunOS y otro en Linux;
confirmar que el contexto de SO enviado difiere y que nada se ejecuta solo.

## Segmento 5.2 — Sincronización terminal ↔ SFTP

| # | Tarea | Archivos |
|---|---|---|
| 5.2.1 | Emisión del directorio de trabajo actual de la sesión SSH (leer `$PWD` del shell, con fallback a "no detectado" — no adivinar parseando el prompt) | `backend/sshconn/sessions.go` |
| 5.2.2 | **Follow terminal** en el panel SFTP remoto, como toggle apagado por default | `components/sftp/SftpPane.tsx` |
| 5.2.3 | Menú contextual del SFTP: **Abrir terminal SSH en esta ruta** | `components/sftp/SftpPane.tsx` |
| 5.2.4 | Ambos lados conviven en `SshHybridTab.tsx`, que ya es el contenedor de terminal + archivos | `components/ssh/SshHybridTab.tsx` |

5.2.1 es la tarea con más riesgo de la fase: detectar el `cwd` de una shell
remota de forma confiable no es trivial (no hay `/proc` en SunOS, el prompt es
del usuario y no un contrato). Por eso el toggle nace apagado y hay un estado
"no detectado" explícito en vez de una heurística que acierte el 80% de las
veces y mienta el 20%.

**Verificación:** `cd` en la terminal → el panel salta; `cd` a un directorio
sin permiso → el panel informa el error, no queda en el anterior fingiendo.

## Segmento 5.3 — Production Guard en SSH

| # | Tarea | Archivos |
|---|---|---|
| 5.3.1 | Migración **37**: `ssh_connections.environment` (`DEFAULT ''`), mismo vocabulario que las conexiones de base de datos | `migrations.go`, `ssh_keys_repo.go` |
| 5.3.2 | Badge de entorno en la pestaña de terminal y en el panel SFTP (rojo/naranja/verde con los tokens MD3, **no** colores Tailwind crudos) | `SshTerminalTab.tsx`, `SftpPane.tsx` |
| 5.3.3 | Intercepción de comandos destructivos (`rm -rf`, `mkfs`, `dd of=`, `systemctl stop`, `truncate`, `shutdown`) antes de mandar el `\n` al PTY | `backend/sshconn/guard.go` (nuevo) |
| 5.3.4 | En `prod`, exige escribir el nombre del host — reusar el flujo de `ProductionGuardDialog.tsx` en vez de un diálogo nuevo | `ProductionGuardDialog.tsx` |
| 5.3.5 | El guard aplica también a los bloques `/ssh` de los runbooks (4.2.4) y a cualquier comando que sugiera un agente | `guard.go` |

5.3.3 tiene un límite honesto que hay que documentar en la UI: es detección
por patrón sobre lo que se escribe, y **no** puede atrapar un
`sh -c "$(echo cm0gLXJm | base64 -d)"`. Es una red contra el error de dedo, no
contra un adversario.

**Verificación:** `rm -rf /tmp/x` en una conexión marcada `prod` → pide el
host; la misma en `dev` → pasa sin fricción.

## Segmento 5.4 — Cierre de fase

`CHANGELOG.md`, `codegraph sync`, `wails build`.

---

# FASE 6 — Servidor MCP nativo embebido (1.9.0)

La pieza que invierte la relación: hasta acá la app le mandaba contexto al
agente; acá el agente puede **pedirlo él**.

## Segmento 6.1 — Transporte y protocolo

| # | Tarea | Archivos |
|---|---|---|
| 6.1.1 | JSON-RPC 2.0 sobre **stdio** escrito a mano (`initialize`, `tools/list`, `tools/call`, `notifications/*`), sin SDK — regla 12 | `backend/mcpserver/rpc.go` (nuevo) |
| 6.1.2 | Modo de arranque `mini-tools --mcp`: el binario se re-ejecuta a sí mismo como servidor MCP, el mismo truco ya usado dos veces (askpass de git, hook de `agentapprove`) | `main.go`, `backend/mcpserver/serve.go` (nuevo) |
| 6.1.3 | **Sin puerto TCP, jamás.** El servidor no escucha en red; habla por los pipes del proceso que lo lanzó | criterio transversal |
| 6.1.4 | Canal hacia la app viva: el proceso MCP consulta a la ventana por el mismo socket/pipe de `agentapprove` (Fase 7 lo hace funcionar en Windows) | `backend/mcpserver/bridge.go` (nuevo) |
| 6.1.5 | Si la app no está abierta o el vault está bloqueado → **error explícito**, nunca datos parciales ni un vault desbloqueado por la puerta de atrás | `bridge.go` |
| 6.1.6 | Registro automático en la config MCP de los tres CLIs reusando `backend/mcpconf/write.go` (que ya preserva byte a byte, deja `.bak` y escribe atómico), con confirmación del usuario | `app_mcp.go` (nuevo), `components/AgentSettings.tsx` |

6.1.5 es la regla que evita la peor falla posible de esta fase: un servidor MCP
que "para que funcione" se saltee el `vaultgate` sería una llave maestra para
todo el vault, disponible para cualquier proceso que sepa invocar el binario.

## Segmento 6.2 — Herramientas expuestas

| # | Herramienta | Devuelve | Restricción |
|---|---|---|---|
| 6.2.1 | `vault_search_notes(query)` | Títulos + fragmentos | **Solo `is_private = 0`** |
| 6.2.2 | `vault_read_note(title)` | Markdown de la nota | **Solo `is_private = 0`**; si es privada, error del firewall |
| 6.2.3 | `db_list_connections()` | Alias + motor + entorno | **Nunca DSN, host, usuario ni password** |
| 6.2.4 | `db_get_schema(alias, tables[])` | DDL, PK, FK, índices | **Cero filas** |
| 6.2.5 | `db_explain_query(alias, query)` | Árbol de plan | Solo `EXPLAIN`; una sentencia que no sea `SELECT`/`WITH` se rechaza |
| 6.2.6 | `ssh_get_recent_logs(alias, lines)` | Últimas N líneas del buffer | Tope duro de N; solo sesiones ya abiertas por el usuario |
| 6.2.7 | `git_status(repo)` | Estado + diff preparado | Solo repos ya abiertos en la app |
| 6.2.8 | `vault_create_note(title, content)` | Confirmación del alta | **Solo con `settings.mcp_notes_write` en 1**; título duplicado se rechaza; tope de 64 KB; la nota nace con `origen: agente-mcp` en su frontmatter |
| 6.2.9 | `vault_update_note(title, content)` | Confirmación del cambio | Además de lo anterior: **solo notas del propio agente que nadie editó después** (`vault.AgentCanEdit`), y pasa por `NoteForAI`, así que una nota privada tampoco se puede escribir |

Cada herramienta declara su política en el mismo lugar donde se implementa, y
todas pasan por el guard del 6.3 antes de responder. Ninguna herramienta abre
una conexión nueva: opera sobre lo que el usuario ya tiene abierto.

**6.2.8 y 6.2.9 son la única escritura de todo el módulo y llegaron después**
(post-2.1.0), con su propio interruptor y apagadas por defecto: hasta entonces
la promesa era "el agente mira y no toca", y cambiarla no podía ser un efecto
colateral de encender el servidor. Las dos herramientas **ni se declaran** en el
catálogo mientras el permiso esté apagado —una herramienta visible que siempre
falla es una invitación a intentarla— y el permiso se vuelve a comprobar al
ejecutar, para que revocarlo valga para la llamada que está por hacerse.

La regla de autoría vive en `backend/vault/notes_provenance.go` y se guarda en
el **frontmatter de la nota**, no en una columna: así la procedencia viaja con
la nota exportada. No es un control de seguridad (el usuario puede editar ese
texto: es su vault) sino la dirección que importa — sin la marca, el agente no
toca la nota.

**Verificación:** conectar el servidor a Claude Code real y pedirle
explícitamente que lea una nota privada; debe recibir el error del firewall.
Repetir con Codex y Antigravity.

## Segmento 6.3 — AI Access Firewall

| # | Tarea | Archivos |
|---|---|---|
| 6.3.1 | `notes.AIAllowed(id) (bool, error)` como **única** puerta: el servidor MCP y el resolvedor `@note` (1.3.8) llaman a esta función, no a la consulta cruda | `backend/vault/notes_repo.go` |
| 6.3.2 | Denegar por defecto: cualquier error, nota inexistente o estado ambiguo devuelve "no permitido" | `notes_repo.go` |
| 6.3.3 | `@note:Privada` se intercepta **antes** de lanzar el subproceso del agente, con el mensaje exacto de la especificación (qué nota, por qué, y cómo desbloquearla) | `backend/agentctx/resolve.go` |
| 6.3.4 | Migración **38**: `settings.mcp_enabled` (`DEFAULT 0` — el servidor nace apagado) y `connections.ai_schema_allowed` (`DEFAULT 1`) | `migrations.go` |
| 6.3.5 | Panel **Acceso de la IA** en `SettingsDialog.tsx`: interruptor maestro del servidor MCP, lista de notas hoy visibles para la IA, y por conexión si su esquema se expone | `components/AiAccessPanel.tsx` (nuevo) |
| 6.3.6 | Registro local de accesos (qué herramienta, qué recurso, cuándo) visible en ese panel — **sin contenido**, solo el hecho | `backend/mcpserver/audit.go` (nuevo) |

6.3.5 responde la pregunta que ningún cortafuegos contesta solo: *"¿qué ve
hoy la IA?"*. Una lista de notas públicas en un panel es la diferencia entre
confiar en la regla y poder verificarla.

**Verificación:** con `mcp_enabled = 0`, el CLI no debe ver ninguna
herramienta; con el vault bloqueado, todas deben fallar igual.

## Segmento 6.4 — Cierre de fase

`CHANGELOG.md`, `codegraph sync`, doc nuevo `.claude/specs/mcp-server.md` +
su fila en `CLAUDE.md`, y corregir la matriz de permisos en
`vault-notes.md`.

---

# FASE 7 — Paridad Windows y cierre 2.0.0

## Segmento 7.1 — IPC en Windows

| # | Tarea | Archivos |
|---|---|---|
| 7.1.1 | Extraer la interfaz de transporte de `agentapprove/channel.go` (hoy Unix a secas) | `backend/agentapprove/channel.go` |
| 7.1.2 | `ipc_unix.go` con build tag: socket Unix, lo actual sin cambios de comportamiento | `backend/agentapprove/ipc_unix.go` (nuevo) |
| 7.1.3 | `ipc_windows.go` con build tag: named pipe vía `github.com/Microsoft/go-winio` — **primera dependencia Go nueva del plan**, medir el delta | `backend/agentapprove/ipc_windows.go` (nuevo) |
| 7.1.4 | ACL del pipe restringida al usuario actual: un named pipe con ACL abierta es peor que no tener el modo | `ipc_windows.go` |
| 7.1.5 | El modo "aprobar cada acción" deja de ocultarse en Windows; `ModesFor` lo refleja | `backend/agentchat/session.go` |
| 7.1.6 | El bridge del servidor MCP (6.1.4) usa el mismo transporte | `backend/mcpserver/bridge.go` |

**Verificación:** en una Windows real (o VM) — aprobar y denegar una acción de
Claude Code de punta a punta, igual que se verificó en macOS en 1.3.0.

## Segmento 7.2 — Cierre de la 2.0.0

| # | Tarea |
|---|---|
| 7.2.1 | Repaso de la matriz de permisos completa contra el código: cada fila verificada, no asumida |
| 7.2.2 | `README.md` raíz: el módulo de notas y el servidor MCP son features de portada |
| 7.2.3 | Actualizar `architecture.md` con los paquetes nuevos (`mcpserver`, notas) y sus desviaciones reales |
| 7.2.4 | Volcado de `[Unreleased]` a `## [2.0.0] - fecha` y proceso completo de [releases.md](releases.md) para macOS y Windows |
| 7.2.5 | Medición final del binario en **ambas** plataformas contra el techo de 80MB (regla 8: aplica al más grande) |

---

## Orden y dependencias

```
Fase 1 (1.4.0) ──┬──► Fase 2 (1.5.0)
                 ├──► Fase 5 (1.8.0)
                 └──┐
Fase 3 (1.6.0) ──┬──┴──► Fase 6 (1.9.0) ──► Fase 7 (2.0.0)
                 └──► Fase 4 (1.7.0) ──────────────┘
```

- **Camino más corto a valor visible:** Fase 1 → Fase 2. Dos versiones y la IA
  deja de estar encerrada en la pestaña Git.
- **Si el módulo de notas es la prioridad:** Fase 3 sola es publicable
  (1.6.0), no depende de nada, y la Fase 4 la completa.
- **La Fase 6 es la última que se puede adelantar**, y no conviene: expone al
  agente lo que las fases 1 y 3 construyeron. Hacerla antes obligaría a
  inventar contratos para datos que todavía no existen.

## Decisiones abiertas — necesitan tu confirmación antes de empezar la fase

| # | Decisión | Bloquea | Recomendación |
|---|---|---|---|
| D1 | ¿MySQL/MariaDB está realmente soportado hoy? La especificación cuenta 7 motores; `architecture.md` documenta 6 | Fase 2 | Verificar antes de anunciarlo; si falta, es un plan aparte |
| D2 | Búsqueda en notas: descifrar en RAM (simple, O(n), correcto) vs. índice de tokens hasheados (rápido, filtra por prefijos, **filtra información**) | Fase 3 | Descifrar en RAM. A escala de notas personales es imperceptible, y un índice de hashes es un canal lateral sobre contenido cifrado |
| D3 | Renombrar una nota: ¿reescribir los `[[enlaces]]` de las demás, o dejarlos rotos y visibles? | Fase 3 | Dejarlos rotos y ofrecer "arreglar los N enlaces": reescribir cuerpos cifrados de otras notas en silencio es la clase de operación que no se puede deshacer |
| D4 | `/mermaid` suma ~1MB al bundle. ¿Entra? | Fase 4 | Medir primero. Si pasa de 1.5MB, cargarlo con `import()` dinámico como los lenguajes de CodeMirror (regla 6) |
| D5 | Grafo: canvas 2D a mano vs. librería vs. WebGL 3D | Fase 4 | 2D a mano primero (regla 12). El 3D queda condicionado a que el 2D quede corto **medido**, no supuesto |
| D6 | ¿El servidor MCP se registra solo en los tres CLIs, o solo cuando el usuario lo pide? | Fase 6 | Solo a pedido. Escribir en la config de un CLI sin que lo pidan es tocar herramientas que el usuario usa fuera de esta app |
| D7 | Chat único: ¿panel acoplado por default, o ventana flotante? | Fase 1 | Acoplado a la derecha, como está hoy en Git — es lo que el usuario ya tiene aprendido. La ventana flotante entra como opción, no como default |
| D8 | Chat único: ¿una sola conversación viva, o una por contexto de trabajo con conmutador? | Fase 1 | Una sola (1.2.7). Si en el uso real se vuelve confuso mezclar temas, agregar el conmutador es aditivo; partirla desde el principio no se puede deshacer sin perder el hilo cruzado, que es el motivo de unificar |

## Estado de implementación

### Fase 1 (1.4.0) — implementada, con una desviación y un pendiente

**Backend.** `app_agent.go` (agente activo de la app, `AgentAsk`, `agentByID`/
`agentEnv`/`agentCwd` extraídos de las tres copias que había), `app_refs.go`
(resolución del sistema `@`) y `backend/agentctx/refs.go` (parser + tabla de
políticas). `SendAgentChat` cambió de firma: `repoID` pasó a ser
`module, contextID`, que es lo que un chat que ya no es solo de Git necesita.

**Migración 33**, verificada con el patrón de script efímero en
`HOME=$(mktemp -d)`: `settings.active_agent`/`active_model`/`active_effort`,
`settings.agent_dock`/`agent_size`, `agent_chats.module`/`context_id` + su
índice. Se comprobó bootstrap, idempotencia, defaults sobre filas
preexistentes, round-trip del título cifrado, que `vault_meta.verifier` sigue
intacto (`Unlock` con la clave original) y que la lectura por repositorio no
cambió de comportamiento.

**Frontend.** `components/agent/` con el host, el chat, el selector de `@` y el
contexto de trabajo. `pnpm build` y `wails build` limpios; **binario macOS
`arm64`: 50MB**, sin cambio respecto de la medición anterior — no hubo
dependencias nuevas ni en Go ni en el frontend.

**Decisiones tomadas durante la implementación, que el plan no preveía:**

1. **Los modos permisivos se ocultan fuera de un repositorio.** El plan no lo
   decía y salió del código: lo que hace aceptable "editar sin preguntar" es
   que el resultado cae en un árbol de trabajo git, donde se ve en el diff y se
   descarta con un clic. Sin repositorio esa vuelta atrás no existe, así que el
   modo no se ofrece — y si el contexto deja de ser un repositorio con un modo
   permisivo activo, se baja solo.
2. **El agente corre en un directorio vacío cuando el contexto no es un
   repositorio** (`agentCwd`). El directorio de trabajo es lo que el agente
   puede leer sin que nadie se lo pase; lanzarlo en el home para contestar
   sobre un esquema de base de datos sería regalarle todo lo que hay ahí.
3. **El selector de agente quedó en la barra del chat y no en el toolbar
   principal** (el plan decía 1.1.4 "en el toolbar"). Lo manda la regla de
   configuración de `conventions.md`: en el toolbar quedó solo el botón que
   abre el chat. El ajuste vive donde se usa.
4. **Un React context, el primero de la app.** Documentado en el encabezado de
   `AgentChatHost.tsx` — es el caso que la convención deja abierto
   ("salvo que el prop-drilling se vuelva un problema real"), y no es una
   librería de estado: el estado sigue siendo `useState` adentro del host.
5. **`@ssh:` no se pudo implementar y se declara como no disponible.**
   `backend/sshconn` streamea la salida de la terminal al frontend y **no la
   retiene**: no hay buffer del que leer. Necesita un ring buffer, que es
   trabajo del segmento 5.1. El tipo existe en el registro desde ya para no
   rehacerlo después, y el selector lo muestra deshabilitado con el motivo.

**Corrección al segmento 1.2.8 — el panel de Git se queda.** La versión
original de este plan decía que `GitRepoTab` tenía que dejar de montar su
propio chat. Estaba mal planteado y se corrigió: el objetivo era **un solo
componente**, no un solo panel.

El módulo Git es un **proyecto de código** — el agente lee, edita con permisos
y trabaja sobre un árbol versionado donde todo lo que hace se revisa en el diff
y se descarta con un clic. Los módulos de base de datos y SSH son otro
objetivo: ahí el agente **consulta**. Retirar el panel de Git para "unificar"
habría borrado la aprobación acción por acción, las conversaciones en paralelo
("validar con otro") y el aviso de archivos tocados — funcionalidad publicada,
y encima la que más justifica que exista el módulo.

Lo que sí se unificó, y es lo que se pidió: **hay un solo componente de chat**
(`components/agent/AgentChat.tsx`), montado tanto por la pestaña Git como por
el anfitrión de nivel app, con un solo historial, un solo selector de `@`, un
solo sistema de modos y un solo lugar donde arreglar un bug. Lo que cambia
entre un módulo y otro es el **contexto de trabajo**, no la implementación —
ver la tabla "Un componente, dos propósitos" en el segmento 1.2.

Con eso, la fase 1 está **completa**.

### Fase 2 (1.5.0) — implementada, con dos segmentos que ya existían

**Hallazgo que cambió el alcance: los segmentos 2.3.1, 2.3.2 y 2.3.4 ya estaban
construidos.** `backend/explain/analysis.go` calcula tiempo propio por nodo,
impacto relativo, severidad graduada y los hallazgos accionables (escaneo
completo con umbrales de filas, estimaciones erradas, cuello de botella, tasa
de aciertos de buffer); `backend/explain/suggest.go` deriva el `CREATE INDEX`
de los predicados del nodo. Y `ExplainPlanPanel.tsx` ya los dibujaba con su
solapa "Diagnóstico". Lo único que faltaba de ese segmento era **2.3.3**, el
botón que le pide una segunda opinión al agente.

**Construido:**

- `backend/agentctx/dbctx.go` — elección de tablas relevantes (menciones del
  pedido + cierre por FK a un salto, en las dos direcciones) y su DDL. Con tope
  de tablas y diciendo cuántas quedaron afuera; cuando el pedido no nombra
  ninguna, van solo los nombres.
- `backend/agentctx/nosqlctx.go` — contexto de Mongo (campos inferidos con su
  tipo BSON, nunca un documento) y de Redis (**patrones** de clave, nunca
  claves: `sesion:usuario:12345` viaja como `sesion:usuario:*`). Regla más
  estricta que la relacional a propósito — ahí el nombre de la clave *es*
  contenido.
- `backend/agentctx/prompts.go` — prompts dialecto-aware por motor, con las
  reglas que un agente acierta solo la mitad de las veces si no se las dicen
  (limitar filas, nulos, fechas), más `ExtractCode` para sacar el bloque.
- `app_dbagent.go` — `AgentGenerateSQL`, `AgentFixSQL`, `AgentAnalyzePlan`.
- `components/editor/NlPromptBar.tsx` + `lineDiff.ts` (LCS por líneas escrito a
  mano, ~40 líneas, regla 12) — la barra de `⌘I`/`Ctrl+I` con el diff de la
  propuesta.
- Botón "Explicar y corregir" pegado al error del motor, y "Analizar con el
  agente" + "Seguir en el chat" en la solapa Diagnóstico del plan.

**Decisiones que el plan no preveía:**

1. **Al agente se le mandan los hallazgos deterministas junto con el plan.** El
   plan decía "mandá el JSON del plan + DDL + índices". Mandarle además lo que
   la app ya dedujo —incluido el `CREATE INDEX` que propuso— hace que lo
   *evalúe* en vez de derivar una propuesta paralela: si coincide lo confirma,
   y si no, explica por qué no. Dos respuestas útiles en vez de dos opiniones
   sueltas.
2. **La propuesta se muestra como diff aun cuando el editor estaba vacío** (ahí
   todas las líneas van como "sin cambio", no como "agregadas"): marcar cada
   línea de una consulta nueva como agregada es ruido que no distingue nada.
3. **Un fallo leyendo el esquema no cancela la consulta al agente.** Se pregunta
   igual con el contexto que haya y el prompt dice que el esquema no se pudo
   leer, en vez de negar una pregunta de sintaxis por un catálogo inaccesible.

**Verificación:** `go build`, `go vet`, `pnpm tsc --noEmit`, `pnpm build` y
`wails build` limpios. **Binario macOS `arm64`: 50MB**, sin cambio — cero
dependencias nuevas en Go y en el frontend.

### Fase 3 (1.6.0) — implementada, más un agregado pedido sobre la marcha

**Construido:** migraciones **34** (`vault_notes`), **35** (`vault_note_links`)
y **36** (settings del módulo); `backend/vault/notes_repo.go`,
`notelinks.go` y `notesearch.go`; `app_notes.go`; el resolvedor `@note`
activado en `app_refs.go`; y en el frontend `components/notes/NotesTree.tsx`
(módulo del sidebar con el buscador) y `NoteEditorTab.tsx` (una pestaña por
nota). Diseño completo en [vault-notes.md](vault-notes.md).

**Agregado que el plan no tenía: el buscador inteligente.** Lo pidió el usuario
durante la implementación, y tenía razón — el segmento 3.3.6 decía "búsqueda de
texto completo descifrando en RAM", que es un `contiene`. Para buscar en
documentación propia eso no alcanza: buscar es justamente el momento en el que
uno no recuerda el título. `SearchNotesSmart` pliega acentos, exige todos los
términos en cualquier orden, entiende frases entre comillas y los filtros
`tag:` / `enlaza:` / `privado:`, ordena por relevancia (título > cuerpo, frase
> término, repetición cuenta) y devuelve el fragmento donde acertó.

**Decisiones cerradas durante la implementación:**

1. **D2 resuelta como se recomendaba**: descifrar en memoria, sin índice
   persistido. Un índice de tokens sobre contenido cifrado es un canal lateral.
2. **D3 resuelta como se recomendaba**: renombrar deja los enlaces rotos y
   visibles. El destino se guarda como hash de título, así que romperse es la
   consecuencia natural del diseño y no una decisión aparte.
3. **Una pestaña por nota**, no una pantalla "Notas". Es el modelo del resto de
   la app y permite tener el runbook abierto al lado de la consulta que se está
   depurando.
4. **`MarkdownPreview` aprendió `[[WikiLinks]]`**, con manejador opcional: en
   una nota son navegables; en la respuesta de un agente o en un `.md` del
   repositorio se muestran marcados pero sin destino, porque ahí no hay ninguno.

**Verificación:** script efímero en `HOME=$(mktemp -d)` que comprueba que una
nota nace privada, que los enlaces de un bloque de código NO cuentan, que
`NoteForAI` bloquea una privada y la deja pasar tras abrirla, que guardar no
cambia la privacidad, que los backlinks resuelven, que el buscador encuentra sin
tildes y exige todos los términos — y, abriendo `vault.db` con `sqlite3`, que
**el título y el cuerpo son ilegibles en disco**. `go build`, `go vet`,
`pnpm tsc --noEmit`, `pnpm build` y `wails build` limpios. **Binario macOS
`arm64`: 50MB**, sin cambio.

### Fase 4 (1.7.0) — implementada, con dos cambios de política pedidos

**Cambio pedido: las notas nacen VISIBLES para los agentes.** El plan las hacía
nacer privadas; el usuario pidió lo contrario y el argumento es correcto — una
base de conocimiento existe para que el agente la consulte, y una nota que nace
invisible no aparece hasta que alguien se acuerda de abrirla, que en la práctica
es nunca. **El cortafuegos no cambió**: `NoteForAI` sigue filtrando en la
consulta SQL y sigue siendo la única puerta; lo que cambió es de qué lado
arranca el interruptor. El intercambio quedó escrito en
[vault-notes.md](vault-notes.md) sin suavizarlo.

**Cambio pedido: cada nota tiene su chat.** Se resolvió sin componentes nuevos
—es el mismo `AgentChat` de la fase 1— agregando `note` al contexto de trabajo
que ya existía y un botón que lo abre con `@note:"Título"` escrito.

**Construido:** `codemirror/slashCommands.ts`; callouts y bloques de código
enchufables en `MarkdownPreview` (`renderCodeBlock`, que es lo que permite que
un ` ```sql connection="X" ` sea ejecutable en una nota y siga siendo un bloque
normal en la respuesta de un agente); `notes/RunbookSqlBlock.tsx`;
`vault.NoteGraph` + `notes/NotesGraphView.tsx`.

**Decisiones:**

1. **El bloque ejecutable reusa `inspectSQL` y el ConfirmDialog del editor**, no
   una guarda propia. Una segunda implementación del Production Guard es una
   que puede quedar atrás de la real.
2. **D4 (mermaid) resuelta por ahora como "no":** `/mermaid` inserta el bloque y
   se muestra como código. Renderizarlo suma ~1MB y esa medición no se hizo;
   prometerlo sin medir sería justamente lo que la regla 8 evita.
3. **El grafo con canvas 2D y fuerzas a mano** (~80 líneas), sin librería —
   regla 12. El 3D queda condicionado a que el 2D se quede corto con números
   medidos.
4. **El grafo no recibe cuerpos de nota**: solo títulos y aristas.

**Verificación:** `go build`, `go vet`, `pnpm tsc --noEmit`, `pnpm build` y
`wails build` limpios. **Binario macOS `arm64`: 50MB**, sin cambio en las cuatro
fases — cero dependencias nuevas.

### Fase 5 (1.8.0) — parcial: 5.1 hecho, 5.3 ya existía, 5.2 pendiente

**Hallazgo que borró un segmento entero: el Production Guard de SSH ya estaba
implementado.** El plan (5.3) daba por sentado que las conexiones SSH vivían en
otra tabla y necesitaban una migración 37 para su `environment`. **No es así**:
están en la misma tabla `connections` con `dbType = 'ssh'`, así que ya tenían la
columna — y `SshTerminalTab.tsx` ya dibuja el badge de entorno y ya intercepta
comandos destructivos con `ProductionGuardDialog`. **No hace falta ninguna
migración nueva y no se escribió ninguna línea de ese segmento.**

**Construido (5.1):**

- `backend/sshconn/scrollback.go` — anillo de 500 líneas por sesión, sin
  escapes ANSI, en memoria y sin persistir. Es lo que faltaba para que el
  backend tuviera algo que mostrarle a un agente: hasta ahora la salida se
  streameaba a xterm.js y se olvidaba.
- `app_sshagent.go` — `AnalyzeSSHError` y `SSHTail`, más la deducción del
  sistema operativo **de lo que la terminal ya imprimió**, nunca ejecutando
  `uname` por nuestra cuenta (escribir en la sesión interactiva del usuario
  aparecería en su pantalla y podría caer dentro de un editor abierto).
- `agentctx.SSHErrorPrompt` — el contexto de SO va primero y, cuando no se
  sabe, el prompt **dice que no se sabe** y pide no suponer Linux.
- `components/ssh/SshErrorAnalysis.tsx` + el botón en la barra de la terminal,
  que cambia de texto según haya selección.
- **`@ssh:` activado**: el tipo estaba declarado como no disponible desde la
  fase 1 justamente esperando este buffer.

**Segmento 5.2 — resuelto con OSC 7.** Era el que el plan marcaba como el de
más riesgo, y las tres formas obvias estaban todas mal: adivinar del prompt es
adivinar (el prompt lo define el usuario, no es un contrato), `/proc/<pid>/cwd`
no existe en SunOS ni AIX —justo los servidores donde esto haría más falta— y
correr `pwd` choca con la misma regla que se respetó para `uname`: **no se
escribe en la sesión interactiva del usuario**.

La cuarta forma no requiere ninguna de esas concesiones: **OSC 7**, la
secuencia que las shells modernas emiten en cada prompt y que usan iTerm2,
WezTerm y VS Code para esto mismo. Se lee al pasar en el mismo lugar donde ya
se limpiaban los escapes ANSI, sin costo. **Y cuando la shell no la emite, el
panel lo dice** en vez de quedarse quieto pareciendo roto — que era el "acierta
el 80% y miente el 20%" que había que evitar.

El toggle está apagado por defecto y solo aparece en la pestaña híbrida, que es
donde hay una terminal viva. La dirección contraria ("Ir acá en la terminal")
escribe el `cd` **sin ejecutarlo**, con la ruta entrecomillada para sh/bash/ksh/zsh.

### Fases 6 y 7 (1.9.0 / 2.0.0) — implementadas

**Servidor MCP.** `backend/mcpserver/` con JSON-RPC 2.0 sobre stdio escrito a
mano (~200 líneas, sin SDK: regla 12), el puente a la ventana, y `app_mcp.go`
con las siete herramientas.

**Cambio pedido por el usuario durante la implementación, y es la decisión de
diseño más importante de esta fase: el servidor solo existe si se lo enciende.**
El plan ya lo tenía apagado por defecto, pero como *flag*. Ahora es más fuerte:
**apagado no hay listener, ni socket, ni goroutine** — `StartBridge` se llama
desde `SetMCPServerEnabled` y de ningún otro lado, y apagar cierra y borra. El
motivo lo dio el usuario y es correcto: mini-tools existe para optimizar
recursos, y un servidor corriendo por si acaso es exactamente lo contrario.

**Arquitectura de dos procesos, y lo que garantiza.** El proceso `--mcp` que
lanza el CLI no tiene la clave maestra: reenvía cada llamada por el socket. Por
lo tanto, **con la app cerrada, el vault bloqueado o el interruptor apagado no
hay forma de leer nada**, ni lanzando el binario a mano. Además `CallTool`
revalida `requireUnlocked` en cada llamada, no solo al encender: entre encender
y llamar, el usuario pudo haber bloqueado el vault.

**Decisiones:**

1. **Un error de herramienta viaja como CONTENIDO con `isError`, no como error
   de JSON-RPC.** La diferencia importa: un error de transporte lo consume el
   CLI y el modelo no lo ve; un `isError` llega al modelo, que puede leer "esa
   nota está marcada como privada" y explicárselo al usuario.
2. **`db_explain_query` valida con lista blanca** (`SELECT`/`WITH`, y rechaza
   dos sentencias). Una lista negra deja pasar todo lo que nadie pensó.
3. **El registro de accesos guarda el hecho, no el contenido**, y vive en
   memoria: escribirlo sería una segunda copia de lo que se quiere proteger.
4. **La ACL del named pipe de Windows** (`D:P(A;;GA;;;OW)`) es la contraparte
   del `chmod 0600`. Un pipe abierto habría sido peor que no tener el modo.

**Paridad Windows.** `winio` entró como **primera dependencia Go nueva de todo
el plan**, y solo compila en Windows (build tag), así que el binario de macOS
no cambió: **50MB, igual que en las seis fases anteriores**. `GOOS=windows go
build ./...` limpio. El transporte se extrajo a `ipc_unix.go`/`ipc_windows.go`
en los dos paquetes que lo usan (`agentapprove` y `mcpserver`), sin cambiar el
comportamiento de Unix.

**Verificado en Windows real.** El usuario lo probó en **Windows 10 y 11**, así
que el named pipe y la aprobación por acción dejaron de ser "compila y la ACL
es la correcta" para ser algo que corrió. Es la primera parte del soporte de
Windows de este proyecto que se ejercita en una máquina de verdad y no solo se
cross-compila.

**Verificación:** script efímero que ejercita el protocolo completo
(`initialize`, `tools/list`, `tools/call`, bloqueo devuelto como contenido
legible, línea rota sin cortar la sesión, método desconocido, `ping`) y otro que
comprueba que la migración 37 nace apagada y que el puente **abre al encender y
deja de aceptar conexiones al apagar**.

### Corrección de diseño posterior: una conversación POR CONTEXTO

El plan (y las fases 1 a 7) sostenían **una sola conversación** que acompañaba
al usuario entre módulos, con el argumento de que el trabajo real cruza módulos
y partir el hilo pierde lo que ya se habló.

**El usuario pidió lo contrario y tiene razón.** Un hilo único hace que el
agente arrastre contexto que no corresponde: lo que se habló sobre una base de
datos no tiene nada que ver con un servidor SSH, y una nota es todavía más
específica —el chat de una nota es sobre *esa* nota—. Ahora hay una conversación
por contexto (`contextKey` = `kind:id`), cada una con su historial, su modelo y
su modo, y el historial arranca filtrado al módulo desde el que se abrió.

Lo que **no** cambió: sigue siendo un solo componente, un solo selector de `@`,
un solo sistema de modos y un solo lugar donde arreglar un bug. La unificación
era de la implementación, no de la cantidad de hilos.

### Auditoría de la matriz de permisos (segmento 7.2.1)

Se verificó fila por fila **contra el código**, no contra el plan:

| Recurso | App | Grafo | Para un agente | Verificado en |
|---|---|---|---|---|
| Nota privada | ✅ | ✅ con candado | ⛔ | `NoteForAI` filtra `is_private = 0` en el SQL; script efímero |
| Nota compartida | ✅ | ✅ | ✅ | ídem |
| DSN / contraseñas | ✅ | N/A | ⛔ **nunca** | `grep` sobre todos los caminos agénticos: ninguno toca `encrypted_dsn` ni descifra un DSN; `ConnectionSummary` no lo tiene |
| Esquema (DDL) | ✅ | ✅ | ✅ **sin filas** | `renderTableDDL` solo emite columnas, tipos, PK y FK |
| Plan de ejecución | ✅ | N/A | ✅ | `db_explain_query` llama `ExplainQuery(..., analyze=false)`: EXPLAIN no ejecuta el plan; lista blanca `SELECT`/`WITH` |
| Logs de terminal | ✅ | N/A | ✅ **redactado** | ver abajo |

**La única fila que no resistió la auditoría fue la de los logs.** La
especificación original la describía como "inyección segura", y no lo es del
todo: `mysql -pSecreta`, `export TOKEN=…` y `curl -H "Authorization: Bearer …"`
quedan impresos en pantalla, así que estaban entrando al prompt junto con el
error. Se corrigió con `backend/sshconn/redact.go`, aplicado **en `Tail`**, que
es el único método que alimenta los tres caminos hacia un agente (análisis,
`@ssh:`, MCP) — ponerlo en cada llamador habría hecho que agregar un camino
nuevo fuera la oportunidad de olvidarse. Verificado con script efímero: los
seis tipos de secreto se ocultan, y un stacktrace, un `ls -l` y un `ORA-00942`
quedan intactos.

## Fuera de alcance a propósito

- **Sincronización de notas entre máquinas.** Cifrado por columna + clave
  derivada con salt por instalación significa que el `vault.db` de una máquina
  no se descifra en otra. Resolverlo es un plan propio, no un renglón de este.
- **Editar notas desde el agente.** El MCP expone **lectura**. Un agente que
  escribe en tu base de conocimiento cifrada necesita su propio diseño de
  confirmación y deshacer.
- **Ejecutar SQL o SSH desde el MCP.** `db_explain_query` corre `EXPLAIN`, que
  no ejecuta el plan. Darle ejecución a un agente por un canal sin UI elimina
  todas las confirmaciones que las fases 2, 4 y 5 construyen.
- **Modelos de IA propios / API directa.** Sigue vigente la decisión
  fundacional de `backend/agents`: los CLIs se ejecutan como los programas que
  son; la autenticación la maneja cada uno. Este plan no la enmienda.
- **Un tercer motor de base de datos no relacional.** Requiere aprobación
  explícita como excepción del punto 2 de `technical.md`, igual que Redis y
  Mongo en su momento.
