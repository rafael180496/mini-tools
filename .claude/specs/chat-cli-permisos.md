# Chat con CLIs: permisos reales por modo y mensajes de rechazo

Revisión de los arreglos que ScadLab hizo a su chat con CLIs (portado de
mini-tools) contra el código de mini-tools. ScadLab
(`javascript/ScadLab`: `backend/clichat`, `app_chat_cli.go`, `claude/26`)
solo se leyó.

Estado: ✅ hecha · 🔄 en curso · ⏳ pendiente.

## Decisión: el modo por defecto sigue siendo «Solo consulta»

En ScadLab el chat arrancaba en «Solo consulta» y el CLI no podía crear nada;
se cambió el default a «Agente». En mini-tools **no** se cambia, y es a
propósito:

- mini-tools es una herramienta de bases de datos, SSH y repositorios. Los
  modos que escriben (`edit`, `auto`) solo se ofrecen sobre un repositorio git,
  donde lo hecho se ve en Cambios y se descarta con un clic. En el resto de los
  módulos (BD, SSH, HTTP, notas) no existen, así que un default «Agente» no
  tendría a qué aplicarse.
- Ningún modo ejecuta SQL contra una base: el servidor MCP de mini-tools no
  tiene una herramienta que escriba en una base (`db_explain_query` corre
  EXPLAIN y rechaza lo que no sea lectura) y las acciones de IA sobre BD
  proponen y el usuario ejecuta. Lo que sí cambia de un modo a otro son los
  archivos del repositorio y los comandos.
- El síntoma de ScadLab («en el modo por defecto el CLI no puede hacer nada»)
  en mini-tools tenía **otra causa**: los CLIs en headless rechazaban las
  herramientas MCP de mini-tools en todos los modos (ver abajo). Eso sí se
  arregla.

Lo que se ajusta del modo por conversación: una conversación retomada que estaba
en un modo permisivo **vuelve con ese modo si el proyecto ya lo había aceptado**
(la confirmación de «Editar»/«Auto» es por proyecto). Antes bajaba a «Solo
consulta» mientras un chat nuevo del mismo proyecto heredaba el modo permisivo
sin preguntar: la conversación existente era la única que lo perdía. Sin la
aceptación del proyecto, sigue bajando a consulta.

El prompt que reciben los CLIs no prohíbe actuar: solo lleva el idioma y, con
el cerebro encendido, las instrucciones de notas. La regla por modo
(`CodeTools.ModeRule`) es solo de los servidores de modelos y dice lo correcto
en cada modo.

## T1 — Permisos reales por CLI ✅

Herramientas MCP de mini-tools = el catálogo de `App.mcpTools()` (lectura
siempre; `vault_create_note`/`update`/`append` solo con «escritura de notas»
encendida). La escritura de notas **no depende del modo del chat** (igual que
con los servidores de modelos y el cerebro): la gobiernan el interruptor global
de escritura de notas y el cerebro de cada conversación, y la aplica la app del
lado del servidor.

- **Claude Code** (`-p`): sin regla de permiso, una herramienta MCP pide permiso
  y en headless se deniega sola: el cerebro y `db_get_schema` no funcionaban
  desde el chat. Ahora `--allowedTools mcp__<servidor>__<herramienta>` por cada
  herramienta del catálogo, en todos los modos salvo «Aprobar cada acción»
  (ahí decide el hook). En «Solo consulta» y «Planificar» además
  `--disallowedTools Edit,Write,MultiEdit,NotebookEdit,Bash,PowerShell`: una
  regla `allow` global del usuario ya no convierte la consulta en edición. Un
  turno de Ask (acción de un botón, `Turn.oneShot`) solo pierde las de edición:
  su prompt le pide leer con `git diff --staged`. En
  `edit`/`auto` la shell queda como estaba (la gobierna el modo del CLI).
- **Codex** (`exec`): «Solo consulta» pasa `--sandbox read-only` explícito (un
  `config.toml` con otro sandbox lo pisaba). «Editar» sigue en
  `workspace-write`. El MCP de mini-tools lo configura el usuario en su
  `config.toml`; `exec` no pide aprobación por herramienta y el sandbox es su
  límite.
- **OpenCode**: `OPENCODE_CONFIG_CONTENT` por modo: `bash` denegado siempre y
  las herramientas de mini-tools (`<servidor>_<herramienta>`) permitidas por
  nombre: un `ask` global del usuario las dejaba esperando una respuesta que en
  headless nadie da.
- **Nunca**: `--dangerously-skip-permissions`, `bypassPermissions`, `--auto`,
  `command(*)` ni `mcp(*)`.

### Antigravity ✅

Medido en ScadLab con `agy` 1.4.x: en `agy -p` toda herramienta MCP no
preaprobada se auto-deniega (`Print mode: soft-denying tool confirmation
"CallMcpTool"`) y el turno termina sin respuesta. Los hooks del proyecto,
`.agents/settings.json` y `~/.gemini/config/projects` no sirven. Lo que funciona
es `"permissions": {"allow": ["mcp(<servidor>/<herramienta>)"]}` en
`~/.gemini/antigravity-cli/settings.json` (global). Antigravity además solo lee
el MCP global, que mini-tools ya escribe con **Conectar**.

Implementado:

- `backend/mcpconf/agyperm.go`: leer, sincronizar (una regla por herramienta
  propia, combinada sin tocar el resto del archivo ni las reglas ajenas, quitando
  las propias que ya no correspondan) y quitar las reglas de mini-tools. Nunca
  comodines, nunca un JSON inválido pisado, copia de respaldo antes de escribir.
- `app_agyperm.go`: la sincronización se llama **al preparar cada turno de
  Antigravity** (`SendAgentChat`, solo con el MCP encendido) y al **Conectar**
  Antigravity (`ConnectMCP`). El nombre del servidor es el que el propio
  Antigravity tiene registrado (`miniToolsServerName`).
- **«Quitar» se respeta**: el marcador `<datos>/antigravity-permissions-off` hace
  que ni los turnos ni Conectar repongan las reglas hasta «Volver a sincronizar»
  o «Reparar permisos» (que lo borran).
- **Aviso**: cuando una sincronización agrega o quita reglas, el turno abre su
  respuesta con una nota («_⚠ mini-tools actualizó los permisos de Antigravity en
  <ruta> (reglas agregadas: N, quitadas: M)…_»), y un fallo de escritura se avisa
  igual sin frenar el turno. Con todo al día no se dice nada. Va por
  `Turn.Notice` → texto del chat, y la ruta mostrada es la real.
- **Bindings** (`requireUnlocked`): `AntigravityPermissionsStatus`,
  `RepairAntigravityPermissions`, `RemoveAntigravityPermissions`
  ([go-react-contract.md](go-react-contract.md)).
- **UI**: bloque «Permisos en Antigravity» en Configuración → Acceso de la IA
  (`AgyPermissionsBlock.tsx`) con el estado, **Quitar** (confirmación del
  sistema de diálogos, nunca `confirm()`) y **Volver a sincronizar**, y el texto
  que explica que **las reglas son globales**.
- **Rechazo (T2)**: si Antigravity igual rechaza una herramienta y el turno
  llevaba el MCP, la nota explica por qué y el evento lleva `action:
  "repair-agy-perms"`; el chat dibuja **Reparar permisos**. Reparar y reintentar
  es decisión del usuario: el mensaje no se reenvía solo.
- La marca de modo por turno en el MCP **no hace falta en mini-tools**: el
  servidor no tiene herramientas que dependan del modo del chat (las de
  escritura son notas, gobernadas por el interruptor global y el cerebro). La
  consecuencia aceptada de la regla global es que la terminal interactiva de
  Antigravity tampoco pregunta antes de usar esas herramientas; se dice en el
  aviso y en la pantalla, y se deshace con **Quitar**.

## T2 — Mensajes cuando el CLI deniega una herramienta ✅

- El adaptador de Antigravity desenvuelve `call_mcp_tool` del servidor
  `mini-tools` en la herramienta real; lee el detalle de un paso en
  `ERROR`/`FAILED` (`tool_info`, `error`, …), `denied_actions` del `result` y
  muestra `result.response` si el CLI no mandó trozos.
- Claude Code: `permission_denials` del `result`.
- Si el turno termina con herramientas denegadas, al final de la respuesta va
  una nota accionable en el idioma de la interfaz (qué herramienta, por qué y
  qué hacer). Un turno que termina sin texto dice que terminó sin responder, en
  lugar de quedar vacío.

## T3 — Chat con servidores de modelos ✅

mini-tools es el origen de `backend/llm` y del bucle de herramientas que portó
ScadLab; casi todo lo que allí se corrigió ya estaba acá (caída a texto sin
herramientas, `RoleSystem`, `Message.Raw` de Anthropic, errores de herramienta
devueltos al modelo, preflight del servidor, texto parcial grabado desde los
deltas, `tools: []` al retomar). Se portó:

- **Gemini por su endpoint compatible**: `openaiModelID` quita `models/` de los
  ids que lista.
- **Herramienta desconocida**: el error enumera las disponibles.
- **Imágenes grandes**: se aceptan hasta 20 MB y al modelo va una copia
  ≤ 2048 px y ≤ 5 MB (`agentchat/imagereduce.go`, solo stdlib, tope de 50 Mpx
  por cabecera, orientación EXIF aplicada; el original no se toca).

## Lo que no aplica

- **`^[[?1;2c` al reenganchar la terminal**: la terminal de mini-tools no
  reproduce una captura al volver (el widget xterm vive mientras la sesión está
  montada), así que xterm nunca vuelve a contestar consultas viejas. Sin cambio.
- **Red de seguridad** (guardar el bloque si el turno no actuó): en mini-tools
  no hay un artefacto equivalente al checkpoint. El paralelo útil ya existe: en
  BD el agente propone la consulta y un clic la lleva al editor. No se agrega.
- Detección de CLIs con el `PATH` del shell de login, latencia y llavero:
  mini-tools ya resuelve el ejecutable a ruta absoluta con el `PATH` ampliado
  (`agents.Launcher`) y no lee el llavero por mensaje.
