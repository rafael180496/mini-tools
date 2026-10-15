# Mejoras del harness agéntico (cerebro, paridad, multi-agente)

Plan por fases para sacar más de lo que mini-tools ya integra (Claude Code,
Codex, OpenCode, Antigravity y servidores de modelos) sin construir un
orquestador nuevo. Cada fase cierra verificada (`go test ./...`, `pnpm build`,
`scripts/i18n-check.sh`, captura con `scripts/uishot.sh` si toca UI), con su
entrada en `CHANGELOG.md` y su tema en `index.html` / `es/index.html`.

Estado: ✅ hecha · 🔄 en curso · ⏳ pendiente.

## Fase 1 — Conectar el MCP de mini-tools sin copiar a mano ✅

Sin el servidor MCP conectado al CLI no hay cerebro ni datos de mini-tools para
el agente: es la puerta de entrada de las demás fases.

- **T1.1** `MCPConnections()`: por agente, si mini-tools ya figura en su
  configuración (lectura con `mcpconf.Scan`), dónde y si la app puede conectarlo
  sola.
- **T1.2** `ConnectMCP(agentID)`:
  - Claude Code: corre `claude mcp add --scope user mini-tools -- <exe> --mcp`
    (no se toca `~/.claude.json` a mano: es su archivo de estado).
  - Antigravity: escribe la entrada en `~/.gemini/config/mcp_config.json` con
    `mcpconf.UpsertServer` (ya es escribible, con backup).
  - Codex y OpenCode: no se escriben (TOML y JSONC perderían contenido); se
    sigue ofreciendo copiar.
- **T1.3** *Acceso de la IA*: estado por agente (conectado / sin conectar) y
  botón **Conectar** donde la app puede hacerlo.
- **T1.4** Tests, i18n, ayuda y CHANGELOG.

Pendiente conocido: una instalación vieja de Antigravity configurada en
`~/.gemini/settings.json` queda con dos entradas tras **Conectar** (la nueva
va a `config/mcp_config.json`); la vieja puede seguir figurando desactualizada.

## Fase 2 — Recuerdo automático del cerebro ✅

Hoy el cerebro escribe pero no recuerda solo.

- **T2.1** `brainRecall`: con el cerebro encendido, busca en la carpeta del
  proyecto (o del tema) las notas relevantes al mensaje — palabras clave del
  mensaje buscadas una por una (el buscador exige todas las palabras) y
  puntaje sumado — más el `_Índice` de la carpeta. Solo notas compartidas (el
  cortafuegos de `SearchSharedNotes` / `NoteForAI`).
- **T2.2** Presupuesto: tope de notas (5) y de caracteres; cada nota recortada.
  Una nota ya enviada en la misma sesión no se repite en los turnos siguientes.
- **T2.3** Entrega con `brainDelivery` (system prompt en Claude Code y
  servidores de modelos; delante del mensaje en el resto). El historial guarda
  lo que escribió el usuario, no el recuerdo.
- **T2.4** La conversación muestra qué notas se recordaron (evento visible, no
  contexto a escondidas).
- **T2.5** Tests, ayuda y CHANGELOG.

**Contrato (arquitecto):**

- `app_brain_recall.go`: `func (a *App) brainRecall(sessionID, module, contextID, prompt string) (text string, titles []string)`.
  Vacío si `chatBrainOn` es falso. Carpeta: `<raíz>/Proyectos/<proyecto>` o, sin
  proyecto, todo `<raíz>/Temas` (`brainProject`, `resolveFolderFilter`).
- Palabras clave: el mensaje plegado (sin tildes, minúsculas), partido en
  palabras, sin vacías (lista corta es/en) ni de menos de 4 letras, sin
  repetir, máximo 8. Cada una se busca por separado con
  `vault.SearchSharedNotes{Query: palabra, FolderIDs, Limit: 20}` y la nota suma
  `20 - posición` por cada palabra en la que aparece: gana la que coincide en
  más palabras. Función pura testeable para el ranking.
- El `_Índice <nombre>` de la carpeta va siempre primero si existe (no cuenta en
  el tope). Contenido por `vault.NoteForAI` (cortafuegos de privadas). Tope: 5
  notas, 1500 caracteres cada una, 6000 en total.
- Memoria por sesión en `App` (mapa sesión → ids ya enviados, con mutex): una
  nota no se repite en la misma sesión; `ResetAgentChat` la olvida. **Solo
  donde el recuerdo viaja dentro del mensaje** (Codex, OpenCode, Antigravity):
  por system prompt (Claude Code, `llm:`) no queda en el historial, así que se
  envía en cada turno sin deduplicar (decisión tomada al integrar).
- Texto: encabezado i18n que explica que son notas del cerebro relevantes y que
  el detalle completo se lee con `vault_read_note`, después `## [[Título]]` +
  contenido por nota. Se suma a las instrucciones del cerebro antes de
  `brainDelivery` / `withBrain`.
- Visibilidad: `agentchat.Turn.Recalled []string` (títulos). El Manager anota
  el PRIMER `KindStart` del turno con `Event.Recalled` (CLIs en `run`, y el
  runner de `llm:`). El frontend lo muestra en el turno del agente como una
  línea chica «Recordó N notas: …» (títulos que abren la nota). No se graba en
  el historial.

## Fase 3 — Paridad de OpenCode en Consumo, Límites y Plan ✅

- **T3.1** `agentusage.readOpencode`: `opencode stats --json` (todo y
  `--project .` para el repositorio), con totales y reparto por modelo.
- **T3.2** `agentplan`: proveedores con sesión iniciada (solo las claves de
  `auth.json`, nunca los valores).
- **T3.3** `agentlimits`: OpenCode no informa cuota; se declara no disponible
  con su motivo en vez de omitirlo.
- **T3.4** Tests con fixtures reales y CHANGELOG.

## Fase 4 — «Validar con otro agente» con el trabajo del primero ✅

- **T4.1** Backend: `GitReviewContext(repoID)` — diff del árbol de trabajo
  (staged + sin preparar) recortado por presupuesto, con la lista de archivos.
- **T4.2** El botón le pasa al revisor, como adjuntos visibles, el último
  mensaje del primer agente (texto + herramientas usadas) y ese diff.
- **T4.3** i18n, ayuda y CHANGELOG.

## Fase 5 — Instrucciones del proyecto con un clic ✅

- **T5.1** `GitCreateInstructionPointer(repoID, file)`: crea el archivo que
  falta (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) como puntero corto al que ya
  existe. Nunca pisa un archivo presente.
- **T5.2** Solapa Agentes: botón **Crear** en cada archivo ausente cuando hay
  otro del que apuntar.
- **T5.3** Tests, i18n, ayuda y CHANGELOG.

**Contrato (arquitecto):**

- `app_instructions.go`: `func (a *App) GitCreateInstructionPointer(repoID, file string) (string, error)`
  — `file` ∈ {`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`} (otro valor: error). Error
  si ya existe. Fuente = el primero presente de esos tres (orden CLAUDE.md,
  AGENTS.md, GEMINI.md) distinto del destino; sin fuente: error. Devuelve la
  fuente usada.
- Contenido (`agentctx.InstructionPointer(target, source)`, puro y testeado):
  - `CLAUDE.md`: Claude Code importa archivos con `@ruta`, así que la línea
    `@<fuente>` trae el contenido real, más una línea que explica por qué existe.
  - `GEMINI.md`: Antigravity/Gemini también importa con `@./<fuente>`.
  - `AGENTS.md`: Codex y OpenCode no importan: puntero textual («las
    instrucciones de este proyecto viven en [fuente](fuente); leelo antes de
    tocar nada»).
- UI: en la solapa Agentes (`GitAgentPanel.tsx`), cada archivo ausente con
  fuente disponible ofrece **Crear** (title que diga a qué apunta); al crear se
  recarga el contexto.

## Fase 6 — Pulidos del chat ✅

- **T6.1** Tarjetas de herramientas de OpenCode: `shell`, `patch`,
  `apply_patch`, `list`, `todowrite`, `webfetch`, `execute` con su ícono y
  resumen.
- **T6.2** Bloques ```` ```diff ````: fondo verde/rojo por línea agregada o
  quitada, no solo el color del texto.
- ~~Cola de mensajes visible~~: ya existe (lista sobre la caja, con quitar).
