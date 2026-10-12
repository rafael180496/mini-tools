# IA: servidores de modelos, agente local, historial, chat en Utilidades y cerebro

**Estado: aprobado, en desarrollo.** Seis fases que se pueden mergear por separado.

| Fase | Backend (Dev A) | Frontend (Dev B) |
| --- | --- | --- |
| 1. Servidores de modelos | hecho | hecho |
| 2. Historial genérico | hecho | — |
| 3. Chat en Utilidades | — | hecho |
| 4. Herramientas MCP | hecho | hecho |
| 5. Agente de código local | hecho | hecho |
| 6. Cerebro | **hecho** (herramientas de notas, setting, bandera por chat, instrucciones, `git push` en la lista de riesgo, migración 59) | pendiente (control en el chat, setting en Acceso de IA, ayuda, `CHANGELOG.md`) |

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

- **Sin dependencias nuevas.** Los dos clientes son `net/http` + `encoding/json`: Ollama habla NDJSON y la API de OpenAI habla SSE, y ninguno necesita SDK.
- **Toda tabla nueva va por migración** (`backend/vault/migrations.go`; la última es la 56). El token de un servidor y el contenido de los mensajes van cifrados por columna, como el título de `agent_chats`.
- **Todo binding nuevo pasa por `requireUnlocked`.** El token nunca cruza al frontend: solo viaja `hasToken`.
- **Textos en inglés y español**, tema de ayuda en `index.html` y entrada en `CHANGELOG.md`.

## Diseño

### Servidores de modelos como agentes

Tabla `model_servers` (migración 57):

| Columna | Nota |
| --- | --- |
| `id`, `name` | nombre visible, único |
| `kind` | `ollama` · `openai` |
| `base_url` | `http://localhost:11434`, `http://localhost:1234/v1`, `https://gpu.empresa/…` |
| `encrypted_token`, `token_nonce` | opcional: Bearer para servidores detrás de un proxy o con API key |
| `encrypted_headers`, `headers_nonce` | opcional (migración 60): JSON `{nombre: valor}` de cabeceras propias, cifrado |
| `insecure_tls` | migración 60: no verificar el certificado de este servidor (default 0) |
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

### Herramientas MCP

Si el servidor MCP está habilitado, el runner recibe `a.mcpTools()` convertidas al formato de herramientas del servidor (es el mismo `{type: "function", function: {…}}` en Ollama y en OpenAI). El bucle es este:

```text
chat con tools → tool_calls → ejecutar → mensaje role:"tool" → chat … (tope de vueltas configurable, 25 por defecto)
```

Cada llamada se emite como evento `tool` y queda en el historial. Si el modelo no soporta herramientas, se reintenta sin ellas y se avisa una vez.

### Agente de código local: archivos y comandos con permisos

El modelo puede estar en otra máquina, pero **las herramientas corren siempre en la del usuario**, dentro del directorio de trabajo del chat (`agentCwd`: el repositorio abierto). Sin repositorio no hay herramientas de archivos ni de comandos.

| Herramienta | Qué hace | Tipo |
| --- | --- | --- |
| `read_file` | lee un archivo (con rango de líneas) | lectura |
| `list_dir` | lista un directorio | lectura |
| `search` | busca texto o regex en el árbol (respeta `.gitignore`) | lectura |
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

### Chat en Utilidades

Herramienta nueva `aiChat` (ícono `forum`) en `utilities.ts`, con su pestaña en `Workspace.tsx`:

- **Izquierda**: el historial de todas las conversaciones, con buscador, agrupado por fecha y filtrable por proveedor.
- **Centro**: el `AgentChat` existente con `module = "utilities"`. Las mejoras de UX van en ese componente y valen para el chat de todos los módulos.
- **Cabecera**: selector de proveedor + modelo (CLIs y servidores), y selector de repositorio de trabajo para el agente de código local.

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

## Contrato de bindings (Go ↔ TS)

```go
type ModelServer struct {
    ID        string `json:"id"`
    Name      string `json:"name"`
    Kind      string `json:"kind"`    // "ollama" | "openai"
    BaseURL   string `json:"baseUrl"`
    HasToken  bool   `json:"hasToken"`
    IsLocal   bool   `json:"isLocal"`
    InsecureTLS bool     `json:"insecureTls"`  // migración 60
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

// Fase 2
type AgentChatMessage struct { Seq int; Role, Content, ToolName string; Usage *agentchat.Usage; CreatedAt int64 }
func (a *App) AgentChatMessages(chatID string) ([]AgentChatMessage, error)
func (a *App) SearchAgentChats(query string) ([]vault.AgentChat, error)

// Fase 6 (detalle en go-react-contract.md → «Cerebro»)
type BrainStatus struct { MCPEnabled, NotesWrite bool; Root string } // json: mcpEnabled, notesWrite, root
func (a *App) BrainStatus() (BrainStatus, error)
func (a *App) GetBrainRoot() (string, error)
func (a *App) SetBrainRoot(root string) error
func (a *App) SetAgentChatBrain(chatID string, enabled bool) error // vault.AgentChat gana `brain bool`
```

`ListAgents`, `AgentModelCatalog`, `AgentChatModes`, `AgentChatSupported`, `SendAgentChat`, `AgentAsk*` y `RespondAgentApproval` no cambian de firma.

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

Cada fase cierra con `go build ./...`, `go vet ./...`, `go test ./...`, `cd frontend && pnpm build`, `./scripts/i18n-check.sh` y `codegraph sync`, y se prueba contra un Ollama local real (un modelo chico con soporte de herramientas, como `qwen2.5:3b`).
