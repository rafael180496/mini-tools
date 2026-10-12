# IA: servidores de modelos, agente local, historial, chat en Utilidades y cerebro

**Estado: aprobado, en desarrollo.** Siete fases que se pueden mergear por separado.

| Fase | Backend (Dev A) | Frontend (Dev B) |
| --- | --- | --- |
| 1. Servidores de modelos | hecho | hecho |
| 2. Historial genérico | hecho | — |
| 3. Chat en Utilidades | — | hecho |
| 4. Herramientas MCP | hecho | hecho |
| 5. Agente de código local | hecho | hecho |
| 6. Cerebro | **hecho** (herramientas de notas, setting, bandera por chat, instrucciones, `git push` en la lista de riesgo, migración 59) | pendiente (control en el chat, setting en Acceso de IA, ayuda, `CHANGELOG.md`) |
| 7. Proveedores de IA (estilo Hermes) | **hecho** (cliente Anthropic con el SDK oficial, migración 63, `SetModelServerEnabled` / `ReorderModelServers`, consumo con caché) | pendiente (gestor de proveedores en Utilidades, presets por URL, interruptor y orden) |

## Qué se pide

1. **Servidores de modelos** como proveedores, locales o remotos: **Ollama** y cualquier servidor **compatible con la API de OpenAI** (LM Studio, vLLM, llama.cpp server, etc.).
2. Que funcionen en **todo lo de IA que ya existe**: el chat unificado y los botones de un solo turno (generar/corregir SQL, analizar plan, HTTP, commit, error SSH).
3. Un **chat en Utilidades** con historial, sobre los agentes ya integrados y los servidores nuevos, con UX mejorada siguiendo la skill `ui-ux-pro-max`.
4. **Herramientas**: las del servidor MCP de la app.
5. **Agente de código local**: que el modelo pueda leer y editar archivos y ejecutar comandos, **con los permisos que el usuario le dé**. Vale igual con un servidor local o remoto.
6. **Cerebro estilo Obsidian**: si el usuario lo permite, el agente escribe notas solo, por tema y por proyecto. Para eso se **mejoran las herramientas de notas del MCP**.

## Decisiones tomadas con el usuario

- **Historial genérico para todos los proveedores**: la app guarda los mensajes de cada conversación en el vault, sea un CLI o un servidor de modelos. Los CLIs siguen retomando con su `--resume`.
- **Herramientas MCP con las mismas reglas que hoy**: mismo catálogo (`a.mcpTools()`), mismo AI Access Firewall y auditoría (`runMCPTool`, `recordMCPAccess`), y la escritura de notas depende del switch `mcpNotesWrite`. Sin aprobación por llamada.
- **Archivos y comandos con permisos elegidos por el usuario**, con los mismos modos que ya tiene el chat (abajo).
- **Entrega por fases.**

## Restricciones que aplican (`.claude/rules/technical.md`)

- **Sin dependencias nuevas para Ollama y OpenAI.** Esos dos clientes son `net/http` + `encoding/json`: Ollama habla NDJSON y la API de OpenAI habla SSE, y ninguno necesita SDK. **Excepción aprobada (fase 7): el cliente de Anthropic usa el SDK oficial** `github.com/anthropics/anthropic-sdk-go`; el porqué está en «Proveedores de IA (estilo Hermes)» y en la regla 12 de `.claude/rules/technical.md`.
- **Toda tabla nueva va por migración** (`backend/vault/migrations.go`; la última es la 56). El token de un servidor y el contenido de los mensajes van cifrados por columna, como el título de `agent_chats`.
- **Todo binding nuevo pasa por `requireUnlocked`.** El token nunca cruza al frontend: solo viaja `hasToken`.
- **Textos en inglés y español**, tema de ayuda en `index.html` y entrada en `CHANGELOG.md`.

## Diseño

### Servidores de modelos como agentes

Tabla `model_servers` (migración 57):

| Columna | Nota |
| --- | --- |
| `id`, `name` | nombre visible, único |
| `kind` | `ollama` · `openai` · `anthropic` (fase 7) |
| `base_url` | `http://localhost:11434`, `http://localhost:1234/v1`, `https://gpu.empresa/…` |
| `encrypted_token`, `token_nonce` | opcional: Bearer para servidores detrás de un proxy o con API key |
| `encrypted_headers`, `headers_nonce` | opcional (migración 60): JSON `{nombre: valor}` de cabeceras propias, cifrado |
| `insecure_tls` | migración 60: no verificar el certificado de este servidor (default 0) |
| `context_tokens` | migración 62: ventana que se le pide a Ollama |
| `enabled`, `default_model`, `sort_order` | migración 63: ver «Proveedores de IA (estilo Hermes)» |
| `created_at`, `updated_at` | |

Cada servidor aparece en el catálogo de agentes con id **`llm:<serverId>`** y vendor `Ollama` u `OpenAI-compatible`. Así entra en todos los selectores y en `AgentAsk`/`AgentAskWith` sin cambiar ninguna firma.

- **Modelos**: `AgentModelCatalog("llm:<id>")` consulta `GET /api/tags` (Ollama) o `GET /v1/models` (OpenAI). Si el turno no trae modelo, se usa el primero que devuelva el servidor.
- **Disponibilidad**: `Available` = configurado. Probar la conexión es un botón, no algo que corra en cada listado: un remoto caído no puede trabar la lista de agentes.
- **Idioma**: el `replyLanguage` va como mensaje `system` inicial.
- Al abrir la configuración, si `http://localhost:11434` responde, se ofrece agregar el Ollama local con un clic.

### Servidores remotos: chequeo previo, cabeceras y TLS

Un servidor en otra máquina se apaga, cambia de IP o queda tras una VPN caída, pide cabeceras de su gateway y a veces tiene un certificado propio. Cuatro piezas, todas del lado de Go.

**Chequeo previo (`app_modelserver_health.go`).** Antes de cada turno contra un `llm:<id>` —`SendAgentChat`, `AgentAsk*`, `AskAgentOnce`; los tres pasan por `llmClientForTurn`— se pregunta al servidor: Ollama `GET /api/version`, compatibles con OpenAI `GET {base}/models`, con **4 s** de plazo.

- Si falla, el turno **no empieza**: ni evento `start`, ni fila de chat, ni mensaje en el historial. El error nombra el servidor, el host y la causa: `No se pudo usar el servidor «GPU» (10.0.0.5:11434): … Revisá que esté encendido y accesible desde esta máquina.` Las causas salen clasificadas (`llm.ConnError`): conexión rechazada, tiempo agotado, nombre no encontrado, conexión perdida, TLS. Un 401/403 sugiere revisar token y cabeceras.
- Un chequeo **exitoso** se cachea por id de servidor y vale **30 s**; una respuesta real del chat lo renueva; una caída de conexión en pleno turno lo invalida. Los fallos **no** se cachean (el que enciende el servidor y reintenta tiene que volver a preguntar). `SaveModelServer` y `DeleteModelServer` invalidan; un chequeo que arrancó antes de invalidar no puede guardar su resultado (generación por servidor).
- `ModelServerHealth(id)` usa ese mismo caché y devuelve `ok`, `version`, `models`, `error`, `latencyMs` y `checkedAt` (unix ms). Pasados 30 s hace un chequeo nuevo, completo (en Ollama suma `GET /api/tags`). Un servidor caído o un id inexistente no son error de la llamada: viajan en `error`.
- El selector de modelos (`AgentModelCatalog`) **no** hace el chequeo previo: ya degrada solo a «Por defecto» si el servidor no contesta.

**Reintento (runner).** Si `Chat` falla con un error de conexión transitorio (`llm.IsRetryable`: rechazada, reset, EOF, pipe rota, error al conectar, timeout de red) **antes de recibir un solo trozo**, el runner reintenta **una vez** tras ~1 s. No reintenta un 4xx/5xx, un error de certificado, un corte con el stream ya abierto (repetiría texto que la persona ya leyó) ni un turno cancelado (la espera también se corta con el contexto). Aplica a los tres `Chat` del runner (turno, reintento sin herramientas y `Ask`).

**Cabeceras propias (migración 60).** `model_servers` gana `encrypted_headers` + `headers_nonce`: un JSON `{nombre: valor}` cifrado por columna con el mismo esquema que el token (NULL = sin cabeceras). Los **nombres** no son secretos y vuelven al frontend (`ModelServer.headerNames`); los **valores** nunca. Viajan en **todo** request del servidor (versión, modelos, chat, chequeo). Validación en `vault.ValidateModelServerHeaders`:

- nombre = token HTTP válido (RFC 7230), sin repetidos sin importar mayúsculas, máx. 20 cabeceras, 100 caracteres de nombre y 2000 de valor; valor no vacío y sin CR/LF ni otros caracteres de control (inyección de cabeceras);
- reservadas: `Host`, `Content-Length`, `Content-Type`, `Accept`, `Accept-Encoding`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `Keep-Alive` — las maneja el cliente o el protocolo (el stream SSE/NDJSON depende de ellas);
- `Authorization` **solo** se admite si el servidor no tiene token: con token el cliente manda `Authorization: Bearer …` y una cabecera con ese nombre pisaría una de las dos en silencio. Se valida contra el token que va a *quedar* (token nuevo, token guardado no borrado, cabeceras guardadas si no se reemplazan).

**Certificado propio (`insecure_tls`, misma migración).** Columna en claro `INTEGER NOT NULL DEFAULT 0` y `ModelServer.insecureTls`. Con `true` el transporte **de ese servidor** usa `InsecureSkipVerify` (cada cliente tiene su propio `http.Transport`, no afloja nada más). Riesgo, documentado en `llm/conn.go`: sin verificar el certificado, quien se interponga en la red puede hacerse pasar por el servidor y leer el token y los prompts; por eso es explícita por servidor y arranca apagada. Con la opción apagada, un fallo de certificado dice: `certificado no confiable en … — si es un servidor interno con certificado propio, activá 'Aceptar certificado autofirmado'`.

### Runner HTTP dentro de `agentchat`

Paquete `backend/llm` con un cliente por tipo de servidor, detrás de una interfaz común (`Models`, `Version`, `Chat` con streaming y herramientas).

`agentchat.Manager.Send`/`Ask` ramifican por el prefijo `llm:` hacia un runner que emite **los mismos `Event`** que los adaptadores de CLI (`start`, `text`, `thinking`, `tool`, `done` con `Usage`, `error`). El frontend no distingue proveedores para dibujar. El runner no conoce el vault: recibe por el `Turn` el cliente, los mensajes previos, las herramientas y cómo ejecutarlas. Todo eso lo arma `App`.

### Historial genérico

Tabla `agent_chat_messages` (migración 58):

| Columna | Nota |
| --- | --- |
| `id`, `chat_id` | FK a `agent_chats(id)` con `ON DELETE CASCADE` |
| `seq` | orden dentro del chat |
| `role` | `user` · `assistant` · `tool` |
| `content`, `nonce` | cifrado AES-256-GCM |
| `tool_name` | para las filas `tool` |
| `usage` | JSON de tokens, opcional |
| `created_at` | |

Índice `(chat_id, seq)`.

- **Quién escribe**: `App`, envolviendo el `emit` del chat. Al enviar guarda el mensaje del usuario; en `done`, el texto del asistente y las llamadas a herramientas. Vale para todos los proveedores.
- **Quién lee**: `AgentChatHistory` lee primero el vault y, si un chat viejo no tiene mensajes guardados, cae a la transcripción del CLI como hoy.
- **Contexto de un servidor de modelos**: los últimos mensajes guardados, recortados para que entren en el contexto.
- **Búsqueda**: `SearchAgentChats(query)` descifra y filtra en Go, porque el contenido cifrado no admite `LIKE`.

### Consumo de los servidores de modelos (panel de consumo)

Un servidor no deja transcripts en disco como un CLI, así que `AgentUsageAll` (que lee `backend/agentusage`) no lo cubre. Su consumo sale de `agent_chat_messages.usage`, **sin migración y sin descifrar contenido**:

- **Qué se guarda**: el JSON de `agentchat.Usage` de la fila que cierra cada turno gana `model` (el del evento `start`, que el recorder `TurnRecorder` retiene y entrega en `RecordedMessage.Model`; `App.usageJSON(u, model)` lo mezcla) y `durationMs` (solo el runner `llm:`: suma del tiempo de las llamadas `Chat`, **sin** la espera de aprobaciones ni la ejecución de herramientas, para que tokens/s sea del modelo). Un CLI guarda el modelo pero no la duración. Las filas anteriores no traen ninguna de las dos claves: cuentan en los totales con modelo `""` y sin velocidad.
- **Proveedor por turno**: el usage de cada fila gana también `agentId` (`llm:<id>` que atendió el turno; `recordedTurn.agentID` → `usageJSON(u, model, agentID)`), porque un chat puede cambiar de proveedor (ver «Cambiar de proveedor a mitad de un chat»). `ModelServerUsageRows` atribuye por `COALESCE(NULLIF($.agentId,''), agent_chats.agent_id)`: las filas anteriores a la clave caen al agente del chat.
- **Lectura**: `Store.ModelServerUsageRows(since)` — un `SELECT` sobre `agent_chats` (`agent_id LIKE 'llm:%'`) unido a los mensajes por `idx_agent_chat_messages_chat`, con `usage <> ''` y `json_valid(usage)` y `json_extract` de las claves; no selecciona `content`/`nonce`.
- **Binding**: `App.ModelServerUsage(days int) (ModelServerUsageReport, error)`; `days <= 0` = `agentusage.DefaultDays` (30), igual que `AgentUsageAll`. La ventana son `days` días locales contando hoy. Arma el informe `buildModelServerUsage` (pura, probada). Un servidor existente sin turnos aparece con ceros; uno **eliminado** solo si dejó turnos en la ventana, agrupado por su id (`deleted: true`).
- **Sin costo**: un servidor propio u OpenAI-compatible no informa precio; el panel lo dice y no inventa un monto.
- **UI**: `components/agent/AgentModelServersUsage.tsx`, dentro de `AgentUsagePanel` (los CLIs no cambian).

### Cambiar de proveedor a mitad de un chat (estilo Hermes)

Un chat `llm:` se puede continuar con **otro** servidor de modelos sin perder la conversación. `SendAgentChat` ya aceptaba otro `llm:` agentId sobre un chat existente (la memoria está atada a la sesión); lo que faltaba era persistir el proveedor nuevo en la fila.

- **Binding**: `App.SetAgentChatAgent(chatID, agentID string) error` (`app_localterm.go`). `requireUnlocked`; el chat tiene que existir; el agente actual de la fila **y** el destino deben ser `llm:` (un chat con CLI conserva su propio historial: error i18n claro); el destino tiene que ser un servidor existente (`vault.GetModelServer`) y **activado** (`errProviderDisabled`). Mismo proveedor = éxito sin cambios. El frontend lo llama antes del siguiente `SendAgentChat` con el id nuevo.
- **Fila**: `Store.SetAgentChatAgent(id, from, to)` en una transacción: `UPDATE agent_chats SET agent_id=to, model='', updated_at=now WHERE id AND agent_id=from` (`SetAgentChatSettings` guarda `model` en la misma columna; el modelo del proveedor anterior no existe en el nuevo, así que se vacía y rige el predeterminado del nuevo hasta que el frontend fije otro con `SetAgentChatSettings`). `effort` y `mode` se conservan. `Store.AgentChatAgent(id)` lee el agente actual.
- **Consumo por turno**: antes del `UPDATE`, la misma transacción escribe `agentId = from` en el usage de las filas del chat que no traen la clave (`json_set` donde `$.agentId IS NULL`), así el pasado queda con el proveedor que lo produjo y no migra con `agent_chats.agent_id`. Los turnos nuevos ya graban su `agentId`.
- **Runner**: la memoria (`Manager.llmHistory`) sigue por sesión. `Manager.llmHistoryAgent` recuerda qué proveedor la produjo; si el turno viene de otro, `withoutRaw` descarta `Message.Raw` (bloques `thinking`/`tool_use` firmados de Anthropic) de lo ya guardado. Ya hoy Ollama/OpenAI ignoran `Raw` y el cliente de Anthropic solo lo reenvía dentro del turno abierto; esto lo hace explícito. El contenido, las llamadas a herramientas y sus resultados sí viajan (ids `call_*` son válidos para Anthropic). `Reset` también olvida el dueño.
- **Tests**: `app_chatswitch_test.go` (validaciones y fila), `TestModelServerUsageFollowsProviderSwitch`, `vault` (`TestSetAgentChatAgent`, `TestModelServerUsageRowsPrefersRowProvider`), `agentchat/llmswitch_test.go` (descarte de `Raw` y un chat que empieza en un servidor OpenAI falso con herramienta y sigue en uno Anthropic falso).

### Gestor de modelos (Utilidades → Modelos)

Pestaña de Utilidades para ver y administrar los modelos de un servidor guardado (`frontend/src/components/utilities/ModelManagerTab.tsx` y `utilities/models/`; backend en `app_modelserver_admin.go` y `backend/llm/ollama_admin.go`). Usa el mismo cliente que el chat (`llmServer`): token, cabeceras propias y preferencia de TLS salen del vault y no cruzan hacia el frontend. Todo pasa por `requireUnlocked`.

- **Solo Ollama administra.** La API de Ollama expone `/api/tags` (lista), `/api/ps` (cargados en memoria), `/api/show` (detalle), `/api/pull`, `/api/delete` y la descarga de memoria con `keep_alive: 0`. Un servidor **compatible con OpenAI es solo lectura**: lista `/models` y nada más; LM Studio, vLLM y llama.cpp cargan sus modelos con su propia herramienta. Las demás operaciones contestan un `*llm.UnsupportedError` con el motivo y la interfaz esconde esas acciones en vez de dejar que se prueben y fallen.
- **Detalle.** `ModelServerShowModel` trae familia, tamaño de parámetros, cuantización, plantilla, parámetros del Modelfile, el comienzo de la licencia y **`contextLength`: la ventana con la que se entrenó el modelo** (0 si no la informa). Es el tope útil al configurar la ventana de contexto del servidor (ver abajo).
- **Descargas.** `ModelServerPull(serverId, model)` devuelve un `pullId` y sigue por su cuenta en un registro del backend (no se corta al cerrar la pestaña). El progreso viaja por el evento de Wails **`model-pull:<pullId>`** con un `ModelPullEvent` (`pullId, serverId, model, status, completed, total, percent, done, error, cancelled, startedAt`), emitido como mucho cada 100 ms; el porcentaje no retrocede aunque cambie la capa. `ModelServerPulls()` devuelve el último estado de las descargas en curso y de las terminadas hace menos de 10 minutos, para quien abre la pestaña después. `ModelServerCancelPull(pullId)` corta (lo ya descargado queda en el servidor) y `ModelServerDismissPull(pullId)` olvida una terminada.
- **Aviso de cambios.** Tras bajar o borrar un modelo la pestaña publica en `window` el evento `mini-tools:models-changed` (`{serverId}`, `frontend/src/lib/modelsChanged.ts`). Los selectores de modelo del chat (cabecera de `AiChatTab` y `AgentChat`) lo escuchan y releen `AgentModelCatalog` si el `serverId` es el del agente `llm:<serverId>` elegido: el modelo recién bajado aparece sin cambiar de proveedor.
- Borrar y descargar de memoria invalidan el caché de salud del servidor; borrar pide confirmación con `ConfirmDialog`.

### Ventana de contexto (`contextTokens`, migración 62)

Ollama arranca cada modelo con una ventana chica (2k a 4k tokens según la versión) y **recorta el prompt en silencio por el principio**. Con un proyecto con instrucciones y skills (hasta ~32 000 caracteres en el mensaje de sistema) más el historial, lo primero que se pierde es justamente lo que se vino a decir. No hay error: el modelo contesta otra cosa.

- **Columna** `model_servers.context_tokens INTEGER NOT NULL DEFAULT 0` (migración 62, aditiva). `0` = no pedir nada y dejar la ventana del servidor, que es lo que hacían todos los servidores existentes: ningún comportamiento cambia al migrar.
- **Campo** `contextTokens` (int) en `vault.ModelServer` y en `main.ModelServer`; `SaveModelServer` lo persiste (la firma no cambia: es un campo de `s`). Solo vale para `kind = ollama`: en uno OpenAI se descarta a 0 al guardar. Un negativo queda en 0 y un valor sobre `vault.MaxContextTokens` (4 194 304) se acota.
- **Envío.** `llm.Options.ContextTokens` llega al `ollamaClient`, que manda `options: {"num_ctx": N}` en `POST /api/chat` **solo si N > 0**. Con 0 el cuerpo no lleva `options`. El cliente OpenAI lo ignora: ese protocolo no admite pedir la ventana por petición y los servidores la fijan al cargar el modelo. Como es del cliente, vale para el chat, `AgentAsk*` y los botones de un solo turno.
- **Aviso en el chat.** `agentchat.Turn.ContextTokens` lleva la ventana configurada; antes de cada pedido el runner estima el prompt (mensajes + llamadas + definiciones de herramientas, **caracteres / 4**) y, si supera la ventana, emite **una línea `text`** en cursiva (`_⚠ …_`) — el mismo mecanismo que el aviso «sin herramientas» — **una vez por sesión**, sugiriendo subirla en el servidor. **No bloquea ni recorta.** Sin ventana conocida (0) no dice nada: no hay contra qué comparar.
- **Formulario** (`ModelServerForm`): para Ollama, campo numérico con atajos 4k/8k/16k/32k/64k y «Del servidor» (0), con la explicación del recorte silencioso y del costo (más contexto = más RAM/VRAM y más lento al cargar). Un Ollama **nuevo** arranca con **16384**, y los atajos de Ollama lo fijan; los de OpenAI lo dejan en 0 y el formulario **oculta el campo** con una nota (el servidor decide al cargar el modelo). Ofrecer «usar el máximo del modelo» desde `contextLength` queda como mejora opcional: pide elegir un modelo en el formulario.

### Herramientas MCP

Si el servidor MCP está habilitado, el runner recibe `a.mcpTools()` convertidas al formato de herramientas del servidor (es el mismo `{type: "function", function: {…}}` en Ollama y en OpenAI). El bucle es este:

```text
chat con tools → tool_calls → ejecutar → mensaje role:"tool" → chat … (tope de vueltas configurable, 25 por defecto)
```

Cada llamada se emite como evento `tool` y queda en el historial. Si el modelo no soporta herramientas, se reintenta sin ellas y se avisa una vez.

### Agente de código local: archivos y comandos con permisos

El modelo puede estar en otra máquina, pero **las herramientas corren siempre en la del usuario**, dentro del directorio de trabajo del chat (`agentCwd`: el repositorio git o la carpeta de trabajo elegida, ver «Proyectos y carpetas»). Sin proyecto no hay herramientas de archivos ni de comandos.

| Herramienta | Qué hace | Tipo |
| --- | --- | --- |
| `read_file` | lee un archivo (con rango de líneas) | lectura |
| `list_dir` | lista un directorio | lectura |
| `search` | busca texto o regex en el árbol (respeta `.gitignore`) | lectura |
| `glob` | busca archivos por nombre con un patrón (`**/*.go`, `*.{ts,tsx}`); respeta `.gitignore` | lectura |
| `skill` | carga un skill: su `SKILL.md` y la lista de archivos de su carpeta (solo si hay skills) | lectura |
| `read_skill_file` | lee un archivo dentro de la carpeta de un skill, aunque esté fuera del proyecto (solo si hay skills) | lectura |
| `write_file` | crea o reemplaza un archivo | escritura |
| `edit_file` | reemplaza un fragmento exacto y único | escritura |
| `run_command` | ejecuta un comando en el directorio de trabajo, con timeout y salida acotada | comando |

**Los permisos son los modos que ya tiene el chat**, con el mismo orden y la misma UI:

| Modo | Lectura | Escritura | Comandos |
| --- | --- | --- | --- |
| `ask` (por defecto) | sí | no se declara | no se declara |
| `plan` | sí | no se declara | no se declara |
| `approve` | sí | pregunta cada vez | pregunta cada vez |
| `edit` | sí | sin preguntar | pregunta cada vez |
| `auto` | sí | sin preguntar | sin preguntar, salvo los de la lista de riesgo, que preguntan |

- **La pregunta** usa el diálogo que ya existe (`askApproval` → evento `agent-approval` → `RespondAgentApproval`), así que no hay UI nueva de permisos. Si nadie contesta, se deniega.
- **Una herramienta que el modo no permite no se declara**, igual que hace el MCP con la escritura de notas: una herramienta que figura y siempre falla invita a intentarla.
- **Rutas confinadas** al directorio de trabajo. Se resuelven los symlinks, y una ruta que se escapa se rechaza. Nunca se toca `.git/` por escritura.
- **Lista de riesgo** de comandos (`rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `mkfs`, `dd`, redirecciones a dispositivos…): pregunta en todos los modos.
- **Comandos**: con la shell del sistema, timeout de 2 minutos por defecto y salida recortada para el modelo. El entorno no hereda tokens de la app.
- **Servidor remoto**: el contenido de los archivos que se leen viaja a ese servidor. La primera vez que se usa un modo con herramientas contra un servidor remoto, el chat lo advierte una vez.
- Lo que el agente escribe queda en el árbol de trabajo del repositorio y se ve en el diff del módulo Git, igual que con los CLIs.

### Proyectos y carpetas, instrucciones y skills (estilo OpenCode)

Un chat con un servidor de modelos (`llm:<id>`) que tiene un proyecto trabaja como OpenCode: en modo `auto` edita y crea archivos y corre comandos sin preguntar (salvo la lista de riesgo, `git push` incluido), y **lee solo** las instrucciones y los skills del proyecto. Un modelo detrás de Ollama no lee nada que no le pasen, así que se lo pasamos en el mensaje de sistema.

**Carpetas, no solo repositorios.** Migración 61: `agent_workspaces (id TEXT PK, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`. Los repositorios siguen viniendo de `GitListRepos`; esto es para cualquier otra carpeta. El `contextId` del chat nombra el proyecto así:

| `contextId` | Proyecto |
| --- | --- |
| `<id de repo git>` | el repositorio (solo en los módulos `git` y `utilities`, como hasta ahora) |
| `ws:<id>` | una carpeta registrada (en cualquier módulo) |

`workspaceRoot()` y `agentCwd()` aceptan los dos, así que los CLIs (Claude Code, Codex…) también corren en esa carpeta. Una carpeta desconocida o ya inexistente no es una raíz: el chat trabaja en el directorio de consultas y sin herramientas de archivos, igual que un id de repo desconocido. El confinamiento no cambia: la raíz de las herramientas es esa carpeta.

`AddAgentWorkspace` rechaza lo que no es una ruta absoluta y existente, y **lo demasiado amplio**: la raíz del disco, el home del usuario y cualquier carpeta que lo contenga (`/Users`). Se comprueba también con la ruta real, para que un enlace al home no lo esquive. Es idempotente por ruta limpia o real. Quitar una carpeta borra sus chats (como un repo) y **nunca** toca el disco.

**El mensaje de sistema del proyecto** (`agentctx.LoadProject(...).Prompt(...)`, función pura y probada; se arma en cada turno, así que editar un `AGENTS.md` entre dos mensajes se nota). Secciones, en este orden —si un modelo con poco contexto pierde algo, que sea lo último—:

1. **Entorno**: sistema operativo, raíz del proyecto, si es repositorio git y la rama (lee `.git/HEAD`, sin lanzar `git`; entiende worktrees), fecha de hoy, herramientas del modo y la regla del modo («las ediciones se aplican directo, salvo los riesgosos…»).
2. **Cómo trabajar**: pautas con su motivo (explorar antes de editar, cambios chicos con `edit_file`, correr pruebas/build tras cambiar, seguir las instrucciones del proyecto, no inventar, reportar). En los modos de solo lectura reemplaza «editá» por «proponé el archivo, el fragmento y el motivo», y sin comandos aclara que no se prueba nada.
3. **Instrucciones del proyecto**: ver abajo.
4. **Skills disponibles**: índice `- nombre (global): descripción` y cómo cargarlos.

**Archivos de instrucciones**, en orden de prioridad (si el tope no alcanza, quedan afuera los últimos):

| Alcance | Archivos |
| --- | --- |
| proyecto | `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/*.mdc` (solo las `alwaysApply: true`; las condicionales por glob se omiten) |
| global | `~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, `~/.codex/AGENTS.md` |

- **Imports** `@ruta.md` al estilo CLAUDE.md: solo `.md`, relativos al archivo que los importa (o `~/…`), con la ruta REAL dentro de la raíz del proyecto —o de la carpeta del archivo global—, hasta 3 saltos, sin ciclos. Un `@` pegado a una palabra (un correo), dentro de un bloque de código o de código en línea no es un import. Cada import entra como su propia entrada («importado desde X»).
- **Sin duplicados**: el mismo archivo por otro nombre (`CLAUDE.md` → `AGENTS.md` por symlink) o el mismo texto bajo dos nombres entra una sola vez.
- **Tope total de 32000 caracteres** (`agentctx.MaxInstructionChars`). El archivo que cruza el tope se corta y se marca; los que ya no entran se omiten. Una nota explícita al final dice qué se truncó y qué no se incluyó. Cada archivo va entre `--- ruta (proyecto|global) ---` y `--- fin de ruta ---`. Si una global choca con una del proyecto, vale la del proyecto.

**Skills.** Directorios del proyecto: `.claude/skills`, `.github/skills`, `.opencode/skill`, `.opencode/skills`, `.agents/skills`; globales: `~/.claude/skills`, `~/.config/opencode/skill`, `~/.config/opencode/skills`, `~/.agents/skills`. Un skill es una subcarpeta con `SKILL.md` (una subcarpeta que es un **enlace** a un clon también cuenta: es la forma habitual de instalarlos). Nombre y descripción salen del frontmatter (acepta valores en varias líneas y bloques `>` / `|`; sin `name` cae al nombre de la carpeta). Se deduplica por nombre sin distinguir mayúsculas y gana el del proyecto. Tope de 100 skills en el índice y 220 caracteres por descripción. `GitAgentContext` (el panel del módulo Git) usa los mismos directorios.

**Herramientas nuevas, todas de lectura** (valen en `ask` y `plan`; `skill` y `read_skill_file` solo se declaran si hay skills):

- `skill(name)`: el `SKILL.md` completo (tope 64 KB, con aviso) y la lista de archivos de la carpeta del skill (hasta 100, 4 niveles, sin `.git`/`node_modules`, sin seguir enlaces a carpetas).
- `read_skill_file(skill, path, start_line?, end_line?)`: lee un archivo **dentro de la carpeta de ese skill**, con el mismo confinamiento que el workspace (`../`, rutas absolutas y symlinks que salen se rechazan con un mensaje del skill). Es la única forma de leer un skill global, que está fuera de la raíz. Una carpeta devuelve su listado. Que la carpeta del skill sea ella misma un enlace está permitido; un enlace *dentro* del skill que sale, no.
- `glob(pattern, path?)`: archivos que coinciden (`**` cruza carpetas, `{a,b}`, `?`, `[a-z]`); un patrón sin `/` se busca a cualquier profundidad. Usa los mismos candidatos que `search` (`git ls-files` en un repo, así respeta `.gitignore`; sin git, un recorrido que salta `node_modules`, `vendor`, `dist`…), solo archivos regulares, hasta 200 resultados con aviso. Devuelve rutas relativas a la raíz, listas para `read_file`.

**Modos.** `AgentChatModes("llm:<id>")` sigue siendo por agente (`["", "plan", "approve", "edit", "auto"]`), no por contexto: el frontend no necesita saber si el chat tiene proyecto. Sin proyecto, los modos que editan siguen siendo válidos pero el runner solo declara las herramientas del MCP. El modo `auto` hace lo especificado: escritura sin preguntar y comandos sin preguntar, salvo `workspace.Risk` (que incluye `git push`), que pregunta en todos los modos.

**Qué se carga, a la vista.** `AgentWorkspaceContext(module, contextId)` devuelve, sin texto, lo que se le está pasando al modelo (raíz, git, rama, instrucciones con su peso y si se truncaron, skills y el total de caracteres). Vacío —no error— si el chat no tiene proyecto.

**Advertencia de contexto.** 32000 caracteres son unos 8k tokens: un modelo local con la ventana por defecto de Ollama (2k–4k) no los ve enteros. Por eso las instrucciones van después del entorno y la guía, y un `AGENTS.md` corto rinde más que uno de 30 KB.

### Chat en Utilidades

Herramienta nueva `aiChat` (ícono `forum`) en `utilities.ts`, con su pestaña en `Workspace.tsx`:

- **Izquierda**: el historial de todas las conversaciones, con buscador, agrupado por fecha y filtrable por proveedor.
- **Centro**: el `AgentChat` existente con `module = "utilities"`. Las mejoras de UX van en ese componente y valen para el chat de todos los módulos.
- **Cabecera**: selector de proveedor + modelo (CLIs y servidores), y selector de proyecto de trabajo (repositorio git o carpeta) para el agente de código local.

La UX se define corriendo `ui-ux-pro-max` para una app de chat de escritorio. Como mínimo:

- estado vacío con sugerencias;
- Enter / Shift+Enter;
- atajo de chat nuevo;
- botón de detener;
- copiar por mensaje;
- bloques de código con `ChatCodeBlock`;
- indicador de escritura;
- tokens del turno.

Todo con los tokens de `design-system.md`, en claro y oscuro.

### Cerebro: escritura automática de notas

**Qué falta hoy.** Las herramientas de notas del MCP tratan el vault como una lista plana:

- Una nota creada por un agente cae en la raíz, sin carpeta.
- El agente no ve la estructura ni los enlaces de una nota, y no puede filtrar por etiqueta o carpeta.
- Para sumar algo a una nota tiene que reescribirla entera.

**Herramientas mejoradas y nuevas** (`app_mcp.go`; valen también para los CLIs que usan el MCP):

| Herramienta | Cambio |
| --- | --- |
| `vault_search_notes` | filtros opcionales `folder` y `tag` |
| `vault_read_note` | devuelve además carpeta, etiquetas, enlaces salientes y backlinks |
| `vault_list_folders` | **nueva**: árbol de carpetas de notas, con su cantidad de notas |
| `vault_list_notes` | **nueva**: títulos de una carpeta, con etiquetas y fecha |
| `vault_create_note` | `folder` opcional como ruta (`Proyectos/mini-tools`); crea las carpetas que falten |
| `vault_append_to_note` | **nueva**: agrega una sección al final de una nota propia del agente |
| `vault_update_note` | sin cambios de regla |

Las reglas actuales no se tocan:

- nada sobre notas privadas;
- nada que reescriba notas del usuario;
- la escritura solo existe con `mcpNotesWrite` encendido;
- todo queda en el registro de accesos.

**Escritura automática con permiso explícito.** Un control "Guardar en mi cerebro" en el chat, apagado por defecto y recordado por conversación, que solo se puede encender con `mcpNotesWrite` activo. Encendido, se suma un mensaje de sistema que pide registrar lo que valga la pena conservar:

- **Dónde**: dentro de una carpeta raíz configurable (por defecto `Cerebro`), en `Cerebro/Proyectos/<proyecto>` si el chat tiene contexto (repositorio, conexión, servidor SSH) o en `Cerebro/Temas/<tema>` si no.
- **Cómo**: buscando antes para ampliar con `vault_append_to_note` en vez de duplicar, enlazando con `[[…]]` y etiquetando con `#…`.
- **Índices**: una nota `_Índice` por proyecto y por tema (estilo MOC de Obsidian), que el grafo existente muestra como cerebro navegable.

El renglón "Escribir notas desde un agente" de `vault-notes.md` → «Lo que este módulo NO hace» se actualiza en el mismo cambio.

### Proveedores de IA (estilo Hermes)

El usuario quiere un gestor de proveedores de varios tipos a la vez —servidores propios o remotos **y** APIs alojadas— en vez de «un servidor de modelos» suelto. No es una tabla nueva: `model_servers` pasa a ser la lista de **proveedores**, con tres tipos y tres campos de gestión. En el código se sigue llamando `ModelServer`/`llm:<id>` para no renombrar bindings, tablas ni ids de agente ya guardados en chats.

**Tipos (`kind`)**

| `kind` | Qué es | Cliente |
| --- | --- | --- |
| `ollama` | Ollama local o remoto | `net/http` (NDJSON), administra modelos |
| `openai` | Cualquier API compatible con OpenAI: LM Studio, vLLM, llama.cpp, **y las alojadas** (OpenRouter, Groq, DeepSeek, Together, Mistral, Gemini en su endpoint compatible…). Es lo que cubre «casi todas las APIs»: solo cambia la URL base y la clave | `net/http` (SSE), solo lista modelos |
| `anthropic` | La API de Anthropic (Claude), o un proxy/gateway que la hable | SDK oficial `anthropic-sdk-go` v1.80.0, solo lista modelos |

La etiqueta de vendor del catálogo de agentes es «Ollama», «OpenAI-compatible» o «Anthropic». Los nombres bonitos de las APIs alojadas («OpenRouter», «Groq»…) son presets del frontend por URL base; el backend no los distingue.

**Campos nuevos (migración 63, aditiva)**

| Columna / campo JSON | Significado |
| --- | --- |
| `enabled` / `enabled` (default 1) | Un proveedor apagado **sigue guardado y listado** (`ListModelServers`) pero no entra al catálogo de agentes (`ListAgents`), así que desaparece de todos los selectores y de `AgentAsk*`. Un chat que lo usaba falla con «el proveedor «X» está desactivado — activalo en la configuración de proveedores de IA» (`errProviderDisabled`, en `agentByID` y en `llmClientForTurn`, antes de cualquier pedido de red). Se cambia **solo** con `SetModelServerEnabled(id, enabled)` |
| `default_model` / `defaultModel` (default `''`) | Modelo para un turno que no eligió ninguno. Orden de resolución: el del turno → `defaultModel` del proveedor → el propio del cliente (Anthropic: `claude-opus-5-5`) → el primero que liste el servidor. Se guarda con `SaveModelServer`. El selector «Por defecto» del chat muestra cuál es |
| `sort_order` / `sortOrder` (default 0) | Orden en la configuración: `ORDER BY sort_order, name`. Un alta va al final. Se cambia **solo** con `ReorderModelServers(ids)` |

`SaveModelServer` **ignora `enabled` y `sortOrder`** de la estructura que recibe: un formulario que no los conoce no puede apagar ni reordenar nada al guardar (guardar un proveedor apagado lo deja apagado). `ReorderModelServers` pone los ids dados en ese orden y detrás, en el orden que ya tenían, los no mencionados; un id repetido o desconocido se ignora (una lista desactualizada no falla). Prender/apagar no toca `updated_at`, que es la huella de la configuración de conexión.

**URL y credenciales de Anthropic.** `baseUrl` vacío guarda `https://api.anthropic.com`; un `/v1` final se quita (el SDK lo agrega). La clave va en el token cifrado de siempre y se manda como `x-api-key`; las cabeceras propias y «aceptar certificado autofirmado» se respetan (el SDK recibe el mismo `http.Client` que los otros clientes, con `option.WithHTTPClient`). `contextTokens` se ignora (se guarda 0). **Se usa `option.WithoutEnvironmentDefaults()`**: sin eso el SDK leería `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` y los perfiles de `ant auth login` del entorno, y un proveedor guardado terminaría hablando con credenciales que no se le configuraron. Sin token no se manda ninguna clave (un gateway puede autenticar por una cabecera propia).

**Salud y administración.** `Version()` devuelve `""` (no hay endpoint de versión); la prueba de conexión y el chequeo previo usan `Models()` (`GET /v1/models`). Es solo-lectura como OpenAI: `ListModels` funciona y descargar, borrar, descargar de memoria, ver cargados y ver detalle responden `UnsupportedError` («Anthropic»).

**Request de Anthropic** (`backend/llm/anthropic.go`; verificado contra la guía oficial de la API, no de memoria):

| Parte | Decisión |
| --- | --- |
| `model` | El del turno; sin elegir, `claude-opus-5-5` |
| `max_tokens` | 64000 con streaming (se baja al `max_tokens` del modelo si es menor; el pensamiento cuenta contra él) |
| `thinking` | `{type: "adaptive", display: "summarized"}` si el modelo lo admite; **nunca** `budget_tokens` ni `disabled` (400 en los modelos actuales). `display: "summarized"` porque el default es `omitted` y el panel de razonamiento quedaría vacío; los `thinking_delta` salen como `KindThinking` |
| capacidades | Se leen en vivo de `GET /v1/models/{id}` (adaptive, effort, `max_tokens`) y se recuerdan 1 h por URL+modelo. Si el endpoint no contesta (proxy), una familia actual se asume moderna y un modelo desconocido recibe lo mínimo (sin thinking ni effort, 8192 de salida) |
| `output_config.effort` | Explícito e igual al default documentado del modelo: `medium` en Opus 5.5 / Haiku 5.5, `high` en el resto (solo si el modelo lo admite) |
| sampling, prefill, `tool_choice` | Sin `temperature`/`top_p`/`top_k` (400), sin prefill (400), `tool_choice: {type: "auto"}` (el forzado `any`/`tool` da 400 en los modelos actuales) |
| caché de prompt | Los `system` se juntan en un bloque con `cache_control: ephemeral` (las instrucciones del proyecto son un prefijo estable) **más** `cache_control` de nivel superior, que mueve el punto de corte al último bloque cacheable: cada vuelta del bucle de herramientas relee la anterior. Mínimo cacheable del modelo: debajo de él no se cachea, sin error |
| herramientas | `ToolDef` → `input_schema`, **ordenadas por nombre** (el orden es parte del prefijo de la caché), nombres saneados a `^[a-zA-Z0-9_-]{1,64}$` con vuelta al original, y `eager_input_streaming: true` |
| mensajes | Imágenes antes del texto; los `tool_result` de una vuelta en **un solo** mensaje de usuario y primero (hay llamadas en paralelo); `is_error` si el resultado empieza con `error:`; mensajes consecutivos del mismo rol se funden |
| `stop_reason` | `end_turn`/`tool_use`/`stop_sequence`: normal. `pause_turn`: se reenvía lo dicho y se continúa (hasta 5 veces; solo aparece con herramientas del servidor, que no se usan). `max_tokens`/`model_context_window_exceeded`: con una llamada a herramienta a medias es error (`TruncatedError`, no se ejecuta); solo texto, se entrega y se agrega un aviso en cursiva. `refusal`: `RefusalError` con la categoría y la explicación de `stop_details` («Anthropic rechazó este pedido por sus filtros de seguridad (categoría: cyber)…») |
| `fallbacks` (reintento en otro modelo ante un refusal) | **No se usa.** En este SDK solo existe en el namespace beta (`client.Beta.Messages`, con una cabecera beta que un proxy puede rechazar, y exige mantener una lista de modelos de reemplazo); el modelo de reemplazo además corre sin los bloques de pensamiento. El refusal se informa y la persona decide (reformular o cambiar de modelo) |

**Argumentos de herramientas validados.** Con `eager_input_streaming` la API deja de validar el JSON de los argumentos, y el parser tolerante del SDK reemplaza uno inválido o cortado por `{}` **en silencio**: se ejecutaría la herramienta con argumentos vacíos. Por eso el cliente acumula el `partial_json` crudo por bloque y lo valida (`validToolInput`): objeto JSON completo, propiedades `required` presentes y del tipo declarado. Si falla, la llamada viaja con `Arguments: {"_raw": <lo recibido>}` —el runner ya se lo devuelve al modelo como error— y en el historial reenviado el bloque lleva `{}`. Antes se comprueba el `stop_reason`: un `tool_use` de una respuesta cortada por `max_tokens` o por un refusal **nunca** se ejecuta.

**Pensamiento preservado (preserved thinking) e historial.** Los bloques `thinking` de Claude Opus 5.5 llevan una firma que ata el bloque a la conversación que lo produjo (system, tools y todos los mensajes anteriores). Reenviarlo tras editar ese prefijo es un 400 en las cuentas creadas desde el 2026-08-31. Decisiones:

1. `llm.Message` gana `Raw any`: el contenido original del asistente en el formato del proveedor (`[]anthropic.ContentBlockParamUnion` para Anthropic: thinking, text y tool_use **intactos**). El runner lo lleva de ida y vuelta sin mirarlo; Ollama y OpenAI lo ignoran.
2. **Dentro del turno abierto** (del último mensaje del usuario en adelante, que es el bucle de herramientas) el asistente se reenvía con su `Raw`: el pensamiento vuelve idéntico, como exige la guía. system, tools y los mensajes anteriores no cambian entre vueltas, así que la firma sigue valiendo.
3. **Los turnos anteriores se reenvían sin pensamiento** (texto y `tool_use`, reconstruidos de `Content`/`ToolCalls`). La guía admite quitar los bloques de **todos los turnos previos** (un tramo inicial completo) sin invalidar nada, y es lo que hace compatible al runner con cómo trabaja hoy: `trimLLMHistory` **recorta el principio** de la conversación (hasta 60 mensajes / 160 000 caracteres) y `withSystem` **regenera el system y las herramientas en cada turno** según el modo, el proyecto y el cerebro. Ambas cosas editan el prefijo y, si los bloques firmados de turnos anteriores se reenviaran, darían 400. No se cambió `trimLLMHistory` ni se hizo el historial «solo agregar» (rompería los otros proveedores y el recorte que protege el contexto de un modelo chico); en su lugar el cliente de Anthropic nunca depende de ese prefijo. Retomar un chat guardado tras reiniciar la app (que reconstruye el historial sin `Raw`) también queda cubierto.
4. **Costo asumido**: el razonamiento no cruza turnos. La guía dice que quitar el pensamiento en una frontera tiene poco efecto; si algún día importa, la salida es compactación del lado del servidor (`compact-2026-01-12`) o `context_management`, ambos beta, y no un historial inmutable.

**Reintentos y errores.** El SDK reintenta 408/409/429/5xx y fallos de conexión (2 veces, honrando `retry-after`); por encima, `chatRetry` reintenta una vez un `ConnError` transitorio si todavía no salió nada al usuario. Los errores HTTP se traducen a `*llm.StatusError` con un mensaje claro (así `serverUnreachableError` y el resto los tratan como a los otros tipos): 401 «la clave de API no es válida», 402 facturación, 403 permiso/modelo no habilitado, 404 modelo no encontrado (con el mensaje de la API), 413 pedido demasiado grande, 429 «límite de uso (rate limit); reintentá en N s», 529 «sobrecargada», 5xx. Un evento `error` en pleno stream llega con HTTP 200: se mapea por su `type`. Fallos de red: `ConnError` como en los otros clientes.

**Consumo.** El turno guarda `model` y `durationMs` por la vía de siempre (`usageJSON` + `genTime` del runner). `llm.Usage` gana `CacheRead`, `CacheWrite` y `Thinking`; `Input` **incluye** la caché leída y escrita (la API informa `input_tokens` sin ella), así que `Total = Input + Output` sigue siendo lo que el modelo recibió y generó. `agentchat.Usage` gana `cacheWrite`; `ModelUsageTotals` gana `cacheRead` y `cacheWrite`, que salen de `usage` con `json_extract` (turnos anteriores: 0).

### Adjuntos del chat (fase 8)

Archivos, imágenes pegadas o arrastradas, texto/código y PDF en **todos** los chats, respetando lo que cada modelo admite. Código: `backend/agentchat/attachments.go` (clasificación, límites, formato), `backend/llm/attachcaps.go` (capacidades por proveedor), `app_attachments.go` (bindings), migración 64.

**Guardado.** `SaveChatFile(name, base64)` → ficha `{path, name, kind: image|pdf|text|other, mime, size}`. Misma carpeta de adjuntos de la app que las imágenes (`<datos>/adjuntos/`, nunca dentro del repositorio) y misma limpieza (al guardar, se borran los de más de 24 h). El archivo se llama `adjunto-<aleatorio>_<nombre saneado>`: el nombre original se **recupera del propio nombre del archivo**, sin estado aparte. El tipo se decide por **contenido**: `http.DetectContentType` para PNG/JPG/GIF/WebP y PDF; para texto, UTF-8 válido sin bytes nulos más la extensión (un `.log` con colores ANSI le parece binario al sniffer). Se rechaza con un error que nombra el archivo: binarios desconocidos, imágenes BMP/ICO, texto en UTF-16 o Latin-1, vacíos y lo que supere el tope de su tipo. `SaveChatAttachment` sigue existiendo (solo imágenes, ahora con el mismo tope de 5 MB).

**Límites.** Imagen 5 MB (el de la API de Anthropic; sin redimensionar), PDF 24 MB, texto 512 KB por archivo, 10 adjuntos por mensaje. Viajan en `AgentAttachmentCapabilities` para que la UI los muestre. Se comprueban al guardar **y** al enviar (el archivo pudo cambiar). El PDF queda en 24 MB y no en 32 porque viaja en base64 (+33 %): con 32 MB de archivo el *request* pasaría el tope de 32 MB de Anthropic y la API contestaría 413.

**Qué admite cada destino** (`AgentAttachmentCapabilities(agentID, model)`; `model` vacío = el del proveedor):

| Destino | Imágenes | PDF | Texto | `known` | De dónde sale |
|---|---|---|---|---|---|
| Ollama | `capabilities` de `/api/show` contiene `vision` | no | sí | `true` (si `/api/show` falla: imágenes supuestas, `false`) | caché por URL+modelo, 10 min |
| Anthropic API | `image_input` de la ficha del modelo | `pdf_input` | sí | `true` (sin Models API o ficha recortada: ambos supuestos, `false`) | la misma consulta que ya hace `capsFor` |
| OpenAI-compatible, `openrouter.ai` | `architecture.input_modalities` contiene `image` (o la forma vieja `text+image->text`) | no | sí | `true` (modelo ausente del listado: supuesto, `false`) | `GET {base}/models` una vez por servidor, caché 10 min |
| OpenAI-compatible, otro | supuestas | no | sí | `false` + nota | — |
| Claude Code | sí (por ruta) | sí (por ruta) | sí | `true` | fijo |
| Codex | sí (`-i`) | no | sí | `true` | fijo |
| Antigravity | sí (por ruta, no verificado) | no | sí | `false` | fijo |

**Envío.** `SendAgentChat` mantiene su firma; `images []string` lleva **las rutas de todos los adjuntos** (el nombre quedó por compatibilidad). Cada ruta se vuelve a resolver y clasificar en Go, y **tiene que estar dentro de la carpeta de adjuntos** (siguiendo enlaces): el texto de un adjunto viaja al modelo —quizá a un servidor remoto—, y aceptar rutas arbitrarias sería un «leé este archivo y mandalo». Se valida **antes** de tocar el proveedor, con el error nombrando destino y modelo:

- **imagen**: como antes (Ollama `images` en base64, OpenAI `image_url` con data URI, Anthropic bloque `image`; CLIs por ruta o `-i`). Con `known=true` y sin visión → error; con `known=false` se envía igual y contesta el proveedor.
- **texto**: se **pega en el mensaje** para todos los proveedores, CLIs incluidos (un solo camino, y no depende de que el CLI pueda leer ese directorio): `--- archivo: main.go ---` y un bloque con el lenguaje de la extensión; la cerca es más larga que cualquier racha de acentos graves del contenido. Se pega **después** de expandir las `@referencias`, para que un archivo con `@nota:…` adentro sea contenido y no una orden.
- **PDF**: Anthropic → bloque `document` base64 **antes** de las imágenes y del texto; Claude Code → la ruta nombrada en el prompt (él lee PDF); **cualquier otro destino → error** («<proveedor · modelo> no puede leer PDF… usá Claude, o pegá el texto»). No hay extracción de texto ni dependencia nueva.
- Con adjuntos y sin texto, el mensaje es «Revisá los archivos adjuntos.» (el historial guarda vacío).

**Historial.** Migración 64: `agent_chat_messages.meta` y `meta_nonce` (BLOB, nullable). La fila `user` guarda `{"attachments":[{"name","kind","size"}]}` **cifrado** como `content` (un nombre de archivo es contenido) — nunca bytes ni rutas. `AgentChatMessages` devuelve `attachments` (siempre lista) y `PastTurn` (retomar un chat) lo trae en los turnos del usuario. El título de un chat sin texto es el nombre del primer archivo.

**Los adjuntos pasados no se reenvían.** Al terminar un turno, la memoria de la sesión (`forgetAttachments`) suelta las imágenes y PDF de ese mensaje y deja `[Adjuntos de este mensaje, que ya no se reenvían: a.png, b.pdf]`: cuestan tokens en cada turno y a las 24 h el archivo ya no existe. El **texto pegado se conserva** (es parte de lo que se dijo). La siembra desde el vault (`SeedHistory`) usa el mismo texto con los nombres.

**Costo conocido.** Un seguimiento sobre una imagen («¿y el botón de la esquina?») ya no la ve: hay que volver a adjuntarla. Es la contracara de no reenviar megabytes en cada mensaje.

## Contrato de bindings (Go ↔ TS)

```go
type ModelServer struct {
    ID        string `json:"id"`
    Name      string `json:"name"`
    Kind      string `json:"kind"`    // "ollama" | "openai" | "anthropic"
    BaseURL   string `json:"baseUrl"` // Anthropic: vacío al guardar = https://api.anthropic.com
    HasToken  bool   `json:"hasToken"`
    IsLocal   bool   `json:"isLocal"`
    InsecureTLS bool     `json:"insecureTls"`  // migración 60
    ContextTokens int    `json:"contextTokens"` // migración 62; 0 = la ventana del servidor; solo Ollama
    Enabled      bool   `json:"enabled"`      // migración 63; SaveModelServer lo ignora → SetModelServerEnabled
    DefaultModel string `json:"defaultModel"` // migración 63; "" = el predeterminado del cliente o el primero listado
    SortOrder    int    `json:"sortOrder"`    // migración 63; SaveModelServer lo ignora → ReorderModelServers
    HeaderNames []string `json:"headerNames"` // solo nombres; los valores nunca viajan
    CreatedAt int64  `json:"createdAt"`
    UpdatedAt int64  `json:"updatedAt"`
}
type ModelServerProbe struct {
    OK      bool     `json:"ok"`
    Version string   `json:"version"`
    Models  []string `json:"models"`
    Error   string   `json:"error"`
    LatencyMs int64  `json:"latencyMs"`
    CheckedAt int64  `json:"checkedAt"` // unix ms
}

func (a *App) ListModelServers() ([]ModelServer, error)
// token "" conserva el guardado; clearToken lo borra.
// replaceHeaders=false conserva las cabeceras guardadas; true las reemplaza por
// headers (mapa vacío = borrar todas). s.InsecureTLS se guarda.
func (a *App) SaveModelServer(s ModelServer, token string, clearToken bool, headers map[string]string, replaceHeaders bool) (ModelServer, error)
func (a *App) DeleteModelServer(id string) error
// serverID != "" y token == "" → usa el token guardado de ese servidor;
// serverID != "" y headers == nil → usa las cabeceras guardadas.
// insecureTLS es el del formulario (no el guardado).
func (a *App) TestModelServer(kind, baseURL, token, serverID string, insecureTLS bool, headers map[string]string) (ModelServerProbe, error)
// Usa el caché de 30 s del chequeo previo; vencido, hace uno nuevo (4 s de plazo).
func (a *App) ModelServerHealth(id string) (ModelServerProbe, error)
func (a *App) DetectLocalOllama() (bool, error)

// Gestor de modelos (Utilidades → Modelos). Solo Ollama escribe; OpenAI lista y el resto
// devuelve *llm.UnsupportedError. Detalle en «Gestor de modelos».
func (a *App) ModelServerModels(serverID string) ([]llm.ManagedModel, error)
func (a *App) ModelServerRunning(serverID string) ([]llm.RunningModel, error) // vacío si el servidor no lo informa
func (a *App) ModelServerShowModel(serverID, model string) (llm.ModelDetails, error) // incluye contextLength
func (a *App) ModelServerPull(serverID, model string) (string, error)         // pullId; progreso por el evento "model-pull:<pullId>"
func (a *App) ModelServerCancelPull(pullID string) error
func (a *App) ModelServerPulls() ([]ModelPullEvent, error)
func (a *App) ModelServerDismissPull(pullID string) error
func (a *App) ModelServerDeleteModel(serverID, model string) error
func (a *App) ModelServerUnload(serverID, model string) error

// Fase 2
type AgentChatMessage struct { Seq int; Role, Content, ToolName string; Usage *agentchat.Usage; CreatedAt int64 }
func (a *App) AgentChatMessages(chatID string) ([]AgentChatMessage, error)
func (a *App) SearchAgentChats(query string) ([]vault.AgentChat, error)

// Proyectos y carpetas (ver «Proyectos y carpetas, instrucciones y skills»; migración 61)
type AgentWorkspace struct { ID, Name, Path string; IsGit, Exists bool } // json: id, name, path, isGit, exists
type WorkspaceContextInfo struct {
    Root string; IsGit bool; Branch string
    Instructions []agentctx.InstructionInfo // {path, scope: "project"|"global", chars, truncated}
    Skills       []agentctx.SkillInfo       // {name, description, scope, path}
    TotalChars   int
} // json camelCase
func (a *App) ListAgentWorkspaces() ([]AgentWorkspace, error)
func (a *App) PickAgentWorkspaceFolder() (string, error)          // "" si se cancela
func (a *App) AddAgentWorkspace(path, name string) (AgentWorkspace, error)
func (a *App) RemoveAgentWorkspace(id string) error
func (a *App) AgentWorkspaceContext(module, contextID string) (WorkspaceContextInfo, error)

// Fase 6 (detalle en go-react-contract.md → «Cerebro»)
type BrainStatus struct { MCPEnabled, NotesWrite bool; Root string } // json: mcpEnabled, notesWrite, root
func (a *App) BrainStatus() (BrainStatus, error)
func (a *App) GetBrainRoot() (string, error)
func (a *App) SetBrainRoot(root string) error
func (a *App) SetAgentChatBrain(chatID string, enabled bool) error // vault.AgentChat gana `brain bool`
func (a *App) SetAgentChatAgent(chatID, agentID string) error      // cambio de proveedor `llm:`
func (a *App) SetModelServerEnabled(id string, enabled bool) error // fase 7
func (a *App) ReorderModelServers(ids []string) error              // fase 7
```

`ListAgents`, `AgentModelCatalog`, `AgentChatModes`, `AgentChatSupported`, `SendAgentChat`, `AgentAsk*` y `RespondAgentApproval` no cambian de firma. Fase 8 (adjuntos): `SaveChatFile(name, dataBase64) (agentchat.Attachment, error)`, `AgentAttachmentCapabilities(agentID, model) (agentchat.AttachmentCaps, error)`, y `attachments` en `AgentChatMessage` / `PastTurn`.

## Fases y reparto

Dos `fullstack-dev` en paralelo, A y B. Los archivos de choque (`app.go`, `frontend/wailsjs/`, `migrations.go`, diccionarios de i18n) tienen un dueño por fase.

| Fase | Dev A | Dev B |
| --- | --- | --- |
| **1. Servidores de modelos** | `backend/llm/` (Ollama + OpenAI, tests con `httptest`), migración 57 y repo, `app_modelservers.go`, runner `llm:` en `agentchat` (historial en memoria de la sesión), integración en catálogo, modelos y modos. Dueño de `migrations.go` y `wailsjs/` | Sección "Servidores de modelos" en `SettingsDialog`, detección del Ollama local, selectores con `llm:*` sin las opciones propias de un CLI, i18n y ayuda de la fase. Dueño de los diccionarios |
| **2. Historial genérico** | Migración 58, repo de mensajes, grabado desde `App`, `AgentChatMessages`/`SearchAgentChats`, `AgentChatHistory` desde el vault, contexto del runner desde el vault | — (empieza la 3) |
| **3. Chat en Utilidades** | — | `aiChat`, historial con buscador, selector proveedor/modelo/repositorio, UX de `AgentChat` vía `ui-ux-pro-max`, ayuda |
| **4. Herramientas MCP** | Conversión de `mcpTools()`, bucle de tool calls, auditoría, fallback sin herramientas | Eventos `tool` bien rotulados en el chat |
| **5. Agente de código local** | Herramientas de workspace confinadas, modos → herramientas declaradas, aprobación vía `askApproval`, lista de riesgo, tests | Aviso de servidor remoto, rótulos de archivos y comandos en el chat, ayuda |
| **6. Cerebro** | Herramientas de notas mejoradas y nuevas con tests, mensaje "Guardar en mi cerebro", carpeta raíz como setting, `vault-notes.md` | Control en el chat, setting en Acceso de IA, notas escritas con enlace, ayuda y `CHANGELOG.md` de todo el conjunto |
| **7. Proveedores de IA** | `backend/llm/anthropic.go` (+ tests con `httptest` emulando el SSE de la Messages API), `Message.Raw`, migración 63 y repo, `SetModelServerEnabled`/`ReorderModelServers`, catálogo sin proveedores apagados, modelo por defecto, consumo con caché, regla 12 de `technical.md`. Dueño de `migrations.go` y `wailsjs/` | Gestor de proveedores en Utilidades: lista con interruptor y orden, tipo «Anthropic», presets por URL base (OpenRouter, Groq…), modelo por defecto, ayuda y `CHANGELOG.md` |
| **8. Adjuntos** | `backend/agentchat/attachments.go`, `backend/llm/attachcaps.go` (+ bloque `document` de Anthropic), `app_attachments.go`, migración 64, `attachments` en el historial, tests. Dueño de `migrations.go` y `wailsjs/` | Selector/arrastrar/pegar en `AgentChat`, chips (en el compositor y en los mensajes pasados), avisos según `AgentAttachmentCapabilities`, i18n y ayuda |

Cada fase cierra con `go build ./...`, `go vet ./...`, `go test ./...`, `cd frontend && pnpm build`, `./scripts/i18n-check.sh` y `codegraph sync`, y se prueba contra un Ollama local real (un modelo chico con soporte de herramientas, como `qwen2.5:3b`).
