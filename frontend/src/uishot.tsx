// Banco de capturas de la interfaz — SOLO desarrollo.
//
// # Para qué existe
//
// La app es de escritorio (Wails), así que revisar un cambio de interfaz
// implicaba compilarla, abrirla, desbloquear el vault y mirar. Peor: sacarle
// una captura desde fuera requiere el permiso de grabación de pantalla de
// macOS, que un proceso automatizado no tiene — de hecho `screencapture`
// falla con "could not create image from display".
//
// Esto lo resuelve por el otro lado: los componentes son React normales, así
// que se los monta en un navegador headless con los bindings de Wails
// simulados. El navegador se saca la foto a sí mismo, sin permisos del sistema
// y sin vault de por medio.
//
// # Qué NO prueba
//
// Nada del backend. Los datos son fijos, así que esto sirve para mirar
// **disposición, jerarquía y textos** — que es justamente donde se venía
// trabajando a ciegas. Que un binding devuelva lo correcto se prueba con los
// tests de Go, no acá.
//
// # Cómo se usa
//
//     ./scripts/uishot.sh <vista> [ancho] [alto]
//
// No entra en el build de producción: Vite solo empaqueta `index.html`, y
// este entra por `uishot.html`, que no es su entrada.

import {cloneElement, StrictMode, type ReactElement} from 'react'
import {createRoot} from 'react-dom/client'
import './styles/globals.css'
import {normalizeLang, setLanguage, t} from './i18n'
import GitOutputNotice from './components/git/GitOutputNotice'
import {requestOpenAiChat} from './lib/appBus'
import {useEffect, useState} from 'react'

// --- Bindings simulados ---------------------------------------------------
//
// Los métodos generados (`wailsjs/go/main/App.js`) llaman a
// `window.go.main.App.<Nombre>`. Se define ese objeto ANTES de importar
// cualquier componente, porque el módulo generado lo resuelve al invocarse.
//
// Todo lo que no esté acá devuelve `null`: un componente que pide algo que el
// banco no simula se dibuja vacío en vez de romper la captura entera, y ese
// vacío es en sí mismo una señal de que falta un dato.

// El árbol del propio repositorio: las capturas se comparan contra la app
// real, y un árbol inventado hace que cualquier diferencia de disposición
// parezca un cambio de la app en vez de del banco de datos.
const repoFiles = [
    '.claude/rules/technical.md',
    '.claude/specs/architecture.md',
    '.codegraph/config.toml',
    'backend/agentchat/session.go',
    'backend/agentchat/conversations.go',
    'backend/agents/registry.go',
    'backend/git/files.go',
    'build/darwin/Info.plist',
    'docs/screenshots/ui-history.png',
    'frontend/src/components/git/GitRepoTab.tsx',
    'frontend/src/components/git/AgentChat.tsx',
    'frontend/src/uishot.tsx',
    'releases/macos/README.md',
    'scripts/package-all.sh',
    '.gitignore',
    'app_git.go',
    'app_localterm.go',
    'app.go',
    'CHANGELOG.md',
    'CLAUDE.md',
    'go.mod',
    'go.sum',
    'LICENSE',
    'main.go',
    'README.md',
    'VERSION',
    'wails.json',
]

// Turnos de ejemplo del chat. Se declaran aparte porque la fixture del
// historial es una función del id de conversación: el chat de código y el de
// una base muestran cosas distintas, y fotografiar las dos con el mismo texto
// no probaría nada.
const chatCodeTurns = [
    {role: 'user', text: '¿Por qué falla el login de SGCPRO?', tools: []},
    {
        role: 'agent',
        text: '## Qué encontré\n\nEl problema está en la **validación del token**: expira antes de que se renueve la sesión.\n\n- `accounts_controller.rb` valida contra `Time.now` sin margen\n- El refresh corre en un job que puede demorar hasta 30s\n\n> Con la carga de producción esa ventana se abre en casi todos los logins.\n\n```ruby\nreturn if token.expires_at > Time.now + GRACE\n```\n\nSi te parece, lo cambio y agrego el test.',
        tools: [{name: 'Read', input: '{"file_path":"app/controllers/api/v1/accounts_controller.rb"}', summary: 'app/controllers/api/v1/accounts_controller.rb', detail: ''}],
    },
]

const chatDbTurns = [
    {role: 'user', text: 'mejorá esta query', tools: []},
    {
        role: 'agent',
        text: [
            'Traer la tabla entera con `SELECT *` consume ancho de banda que no vas a usar, impide que el motor resuelva por índice cubriente y rompe la aplicación si mañana cambia el orden de las columnas.',
            '',
            '### 1. Pedí solo lo que mostrás',
            '',
            '```sql',
            'SELECT id,',
            '       name,',
            '       email,',
            '       phone_number,',
            '       created_at',
            'FROM contacts',
            'ORDER BY id',
            'LIMIT 50;',
            '```',
            '',
            '### 2. Filtrá por estado',
            '',
            'Rara vez necesitás los dados de baja. Si la tabla maneja borrado lógico:',
            '',
            '```sql',
            'SELECT id, name, email',
            'FROM contacts',
            'WHERE deleted_at IS NULL',
            'ORDER BY name',
            'LIMIT 100;',
            '```',
            '',
            'El `ORDER BY` no es un adorno: sin él, dos ejecuciones con `LIMIT` pueden devolver filas distintas.',
        ].join('\n'),
        tools: [],
    },
]


// Historial del Chat de IA: conversaciones de varios proveedores y módulos, con
// fechas repartidas para que se vean los cuatro grupos (Hoy / Ayer / Últimos 7
// días / Anteriores). Los instantes salen de `Date.now()` y no de una fecha
// fija: la captura tiene que mostrar «Hoy» el día que se saque.
const aiNow = Math.floor(Date.now() / 1000)
const aiChats = [
    {id: 'ac-1', repoId: '', agentId: 'claude', title: 'Cómo paginar por cursor en Postgres', conversationId: 'conv-ac-1', createdAt: aiNow - 5400, updatedAt: aiNow - 1500, model: 'sonnet', effort: '', mode: '', module: 'utilities', contextId: 'r4', brain: false},
    {id: 'ac-2', repoId: '', agentId: 'llm:ms1', title: 'Resumí este log de arranque', conversationId: '', createdAt: aiNow - 14000, updatedAt: aiNow - 9000, model: 'qwen2.5:3b', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
    {id: 'ac-3', repoId: '', agentId: 'codex', title: 'Script para rotar los backups de Docker', conversationId: 'conv-ac-3', createdAt: aiNow - 100000, updatedAt: aiNow - 86400 - 3000, model: '', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
    {id: 'ac-4', repoId: '', agentId: 'claude', title: 'Explicá esta consulta', conversationId: 'conv-ac-4', createdAt: aiNow - 4 * 86400, updatedAt: aiNow - 3 * 86400, model: 'opus', effort: '', mode: '', module: 'db', contextId: 'c1', brain: false},
    {id: 'ac-5', repoId: '', agentId: 'llm:ms2', title: 'Diferencias entre SSE y WebSocket', conversationId: '', createdAt: aiNow - 6 * 86400, updatedAt: aiNow - 5 * 86400, model: 'llama3.2:3b', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
    {id: 'ac-6', repoId: '', agentId: 'antigravity', title: 'Plan de migración de índices en Oracle', conversationId: 'conv-ac-6', createdAt: aiNow - 20 * 86400, updatedAt: aiNow - 18 * 86400, model: '', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
    {id: 'ac-7', repoId: '', agentId: 'claude', title: 'Revisá el runbook de guardia', conversationId: 'conv-ac-7', createdAt: aiNow - 40 * 86400, updatedAt: aiNow - 38 * 86400, model: '', effort: '', mode: '', module: 'note', contextId: 'n1', brain: false},
    // Servidor local con herramientas de archivos y comandos sobre un repositorio,
    // y con «Guardar en mi cerebro» encendido: la conversación de las capturas de
    // eventos de herramientas.
    {id: 'ac-8', repoId: '', agentId: 'llm:ms1', title: 'El test de paginación falla en CI', conversationId: '', createdAt: aiNow - 2400, updatedAt: aiNow - 600, model: 'qwen2.5:3b', effort: '', mode: 'approve', module: 'utilities', contextId: 'r4', brain: true},
    // Servidor REMOTO con un repositorio de trabajo: la captura del aviso.
    {id: 'ac-9', repoId: '', agentId: 'llm:ms2', title: 'Preparar el release 1.4', conversationId: '', createdAt: aiNow - 7200, updatedAt: aiNow - 3000, model: 'llama3.2:3b', effort: '', mode: '', module: 'utilities', contextId: 'r4', brain: false},
    // Respuesta larga con prosa, tabla y una línea de código muy ancha: la que se usa
    // para mirar cómo aprovecha el ancho el chat de ancho completo.
    {id: 'ac-10', repoId: '', agentId: 'claude', title: 'B-tree o BRIN para una tabla de eventos', conversationId: 'conv-ac-10', createdAt: aiNow - 900, updatedAt: aiNow - 300, model: 'sonnet', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
    // Servidor de modelos trabajando sobre una CARPETA (no un repo git) en modo
    // automático, con skills: la conversación de las capturas de proyecto.
    {id: 'ac-11', repoId: '', agentId: 'llm:ms1', title: 'Armá el informe semanal de soporte', conversationId: '', createdAt: aiNow - 2 * 86400, updatedAt: aiNow - 86400 - 7000, model: '', effort: '', mode: 'auto', module: 'utilities', contextId: 'ws:w1', brain: false},
]
// Mensajes guardados de la primera conversación (AgentChatMessages): lo que se
// dibuja al retomarla, con el consumo de cada turno.
const aiChatMessages: Record<string, unknown[]> = {
    // Adjuntos (fase 8): `attachments` trae nombre, tipo y tamaño de cada
    // archivo —nunca contenido ni rutas— y se dibuja como fichas sobre el
    // mensaje del usuario. Un mensaje puede ser solo archivos (sin texto).
    'chat-att': [
        {seq: 1, role: 'user', content: 'No me deja entrar y sale este error. ¿Qué pasó? Te paso también el informe del trimestre por si ayuda.', toolName: '', attachments: [{name: 'captura-login.png', kind: 'image', size: 184320}, {name: 'informe-q3.pdf', kind: 'pdf', size: 1843200}], createdAt: aiNow - 900},
        {
            seq: 2,
            role: 'assistant',
            content: 'En la captura se ve un **401** justo después de renovar la sesión: el token expira antes de que el refresh termine. El informe confirma que los picos de login coinciden con los reinicios de las 02:00.',
            toolName: '',
            usage: {input: 2410, output: 96, cacheRead: 0, thinking: 0, total: 2506, costUsd: 0.0071},
            createdAt: aiNow - 880,
        },
        {seq: 3, role: 'user', content: '', toolName: '', attachments: [{name: 'accounts_controller.go', kind: 'text', size: 2481}], createdAt: aiNow - 600},
        {
            seq: 4,
            role: 'assistant',
            content: 'Con el archivo a la vista: `Validate` compara contra `time.Now()` sin margen. Le agregaría un colchón de 30 s.',
            toolName: '',
            usage: {input: 3120, output: 54, cacheRead: 0, thinking: 0, total: 3174, costUsd: 0.0049},
            createdAt: aiNow - 590,
        },
    ],
    'ac-10': [
        {seq: 1, role: 'user', content: '¿Conviene un índice B-tree o BRIN para la tabla de eventos, que crece unos 40 millones de filas por mes y se consulta casi siempre por rango de fecha?', toolName: '', createdAt: aiNow - 880},
        {
            seq: 2,
            role: 'assistant',
            content: [
                'Para una tabla de eventos que solo crece al final y se consulta por rango de fecha, un índice **BRIN** suele ganar por mucho en tamaño y en costo de escritura, a cambio de ser menos preciso: no te dice qué fila cumple, te dice en qué bloques de páginas vale la pena mirar. Mientras la columna esté correlacionada con el orden físico de la tabla —y en una tabla append-only con una marca de tiempo lo está—, esa imprecisión casi no se paga.',
                '',
                '| Criterio | B-tree | BRIN |',
                '| --- | --- | --- |',
                '| Tamaño con 400 millones de filas | 8 a 12 GB | 20 a 60 MB |',
                '| Costo de insertar | Alto: actualiza el árbol en cada fila | Casi nulo: resume por bloques |',
                '| Rango de fecha reciente | Muy rápido | Rápido si hay correlación física |',
                '| Búsqueda de una fila puntual | Ideal | Mala: recorre muchos bloques |',
                '| Mantenimiento | REINDEX ocasional | Se resume solo con autosummarize |',
                '',
                'Si además necesitás buscar eventos puntuales por id, no los mezcles: dejá el BRIN para el rango de fechas y un B-tree chico y parcial para lo que busca de a una fila.',
                '',
                '```sql',
                'CREATE INDEX CONCURRENTLY eventos_fecha_brin ON eventos USING brin (creado_en) WITH (pages_per_range = 32, autosummarize = on);',
                '```',
                '',
                'Antes de decidir, comprobá la correlación física con `SELECT correlation FROM pg_stats WHERE tablename = \'eventos\' AND attname = \'creado_en\'`: por encima de 0,9 el BRIN rinde; por debajo, no.',
            ].join('\n'),
            toolName: '',
            usage: {input: 612, output: 538, cacheRead: 0, thinking: 0, total: 1150, costUsd: 0.0092},
            createdAt: aiNow - 860,
        },
    ],
    // Carpeta con skills: `skill`, `read_skill_file` y `glob` junto a las de siempre.
    'ac-11': [
        {seq: 1, role: 'user', content: 'Armá el informe semanal de soporte con lo que haya en la carpeta, siguiendo nuestra plantilla.', toolName: '', createdAt: aiNow - 2 * 86400 + 100},
        {seq: 2, role: 'tool', content: 'informe-semanal', toolName: 'skill', createdAt: aiNow - 2 * 86400 + 110},
        {seq: 3, role: 'tool', content: 'informe-semanal/plantilla.md', toolName: 'read_skill_file', createdAt: aiNow - 2 * 86400 + 115},
        {seq: 4, role: 'tool', content: 'tickets/**/*.md\n14 archivos', toolName: 'glob', createdAt: aiNow - 2 * 86400 + 120},
        {seq: 5, role: 'tool', content: 'tickets/2026-W41/resumen.md', toolName: 'read_file', createdAt: aiNow - 2 * 86400 + 125},
        {seq: 6, role: 'tool', content: 'informes/2026-W41.md\n42 líneas', toolName: 'write_file', createdAt: aiNow - 2 * 86400 + 140},
        {
            seq: 7,
            role: 'assistant',
            content: [
                'Listo. Seguí la skill `informe-semanal`: leí la plantilla, recorrí los 14 archivos de `tickets/` y escribí el informe en `informes/2026-W41.md` (42 líneas).',
                '',
                'Quedó con las tres secciones de la plantilla —resumen, incidentes y pendientes—. Los incidentes salen ordenados por severidad.',
            ].join('\n'),
            toolName: '',
            usage: {input: 1840, output: 212, cacheRead: 0, thinking: 0, total: 2052, costUsd: 0},
            createdAt: aiNow - 2 * 86400 + 150,
        },
    ],
    // Una fila `tool` guarda «resumen\ndetalle» (backend/agentchat/record.go).
    'ac-8': [
        {seq: 1, role: 'user', content: 'El test TestCursorPage falla en CI pero no en mi máquina. Fijate qué pasa y arreglalo.', toolName: '', createdAt: aiNow - 2300},
        {seq: 2, role: 'tool', content: 'backend/pagination', toolName: 'list_dir', createdAt: aiNow - 2290},
        {seq: 3, role: 'tool', content: 'backend/pagination/cursor.go', toolName: 'read_file', createdAt: aiNow - 2285},
        {seq: 4, role: 'tool', content: 'ORDER BY created_at', toolName: 'search', createdAt: aiNow - 2280},
        {seq: 5, role: 'tool', content: 'go test ./backend/pagination/ -run TestCursorPage', toolName: 'run_command', createdAt: aiNow - 2270},
        {seq: 6, role: 'tool', content: 'backend/pagination/cursor.go\n2 líneas', toolName: 'edit_file', createdAt: aiNow - 2250},
        {seq: 7, role: 'tool', content: 'docs/paginacion.md\n18 líneas', toolName: 'write_file', createdAt: aiNow - 2240},
        {seq: 8, role: 'tool', content: 'Paginación por cursor · desempate en created_at', toolName: 'vault_create_note', createdAt: aiNow - 2230},
        {seq: 9, role: 'tool', content: '_Índice · mini-tools', toolName: 'vault_append_to_note', createdAt: aiNow - 2220},
        {
            seq: 10,
            role: 'assistant',
            content: [
                'El test fallaba porque el orden por `created_at` no era estable: dos filas con el mismo instante salían en distinto orden según el plan que eligiera Postgres.',
                '',
                'Lo arreglé agregando `id` como desempate en `cursor.go` (2 líneas) y documenté la regla en `docs/paginacion.md`.',
                '',
                'Dejé el diagnóstico en tu cerebro: **Paginación por cursor · desempate en created_at**, enlazado desde el índice del proyecto.',
            ].join('\n'),
            toolName: '',
            usage: {input: 5120, output: 410, total: 5530},
            createdAt: aiNow - 2200,
        },
    ],
    'ac-9': [
        {seq: 1, role: 'user', content: '¿Qué falta para sacar el release 1.4?', toolName: '', createdAt: aiNow - 3100},
        {
            seq: 2,
            role: 'assistant',
            content:
                '_⚠ Este modelo no admite herramientas: sigo sin ellas._\n\nSin ver el repositorio solo puedo darte una lista general: congelar la rama, actualizar el CHANGELOG, generar los artefactos y verificar los checksums.',
            toolName: '',
            usage: {input: 180, output: 62, total: 242},
            createdAt: aiNow - 3000,
        },
    ],
    'ac-1': [
        {seq: 1, role: 'user', content: 'Cómo paginar por cursor en Postgres sin que se vuelva lento con millones de filas', toolName: '', createdAt: aiNow - 1800},
        {
            seq: 2,
            role: 'assistant',
            content: [
                'La paginación por **cursor** (o *keyset*) evita el `OFFSET`, que obliga a Postgres a recorrer y descartar todas las filas anteriores.',
                '',
                '### La idea',
                '',
                '- Ordenás por una columna **única y estable** (`id`, o `(created_at, id)`).',
                '- La página siguiente pide «lo que viene después del último que viste».',
                '- Un índice sobre esas columnas hace que cada página cueste lo mismo, sea la 1 o la 10.000.',
                '',
                '```sql',
                'SELECT id, subject, created_at',
                'FROM tickets',
                'WHERE (created_at, id) < ($1, $2)',
                'ORDER BY created_at DESC, id DESC',
                'LIMIT 50;',
                '```',
                '',
                'Para que use el índice, creálo con el mismo orden:',
                '',
                '```sql',
                'CREATE INDEX CONCURRENTLY tickets_cursor_idx',
                '    ON tickets (created_at DESC, id DESC);',
                '```',
                '',
                'El cliente guarda el `(created_at, id)` de la última fila y lo manda como cursor en la petición siguiente.',
            ].join('\n'),
            toolName: '',
            usage: {input: 812, output: 436, cacheRead: 0, thinking: 0, total: 1248, costUsd: 0.0071},
            createdAt: aiNow - 1790,
        },
        {seq: 3, role: 'user', content: '¿Y si el usuario necesita saltar a una página en particular?', toolName: '', createdAt: aiNow - 1600},
        {
            seq: 4,
            role: 'assistant',
            content:
                'Con cursores **no se puede saltar** a la página N: solo avanzar o retroceder. Si hace falta, las opciones son:\n\n1. Mantener `OFFSET` pero solo para las primeras páginas (donde es barato) y pasar a cursor después.\n2. Ofrecer búsqueda o filtros en lugar de números de página: en tablas grandes nadie navega hasta la página 4.000.',
            toolName: '',
            usage: {input: 1320, output: 188, cacheRead: 640, thinking: 0, total: 1508, costUsd: 0.0034},
            createdAt: aiNow - 1500,
        },
    ],
}

// Las vistas `gitsidebar*` fotografían el módulo Git de la barra lateral con un
// repositorio de verdad: ramas con carpetas (`feature/`, `claude/`), una ancla,
// remotos, tags por versión y un stash. Los demás cuadros siguen con el
// repositorio chico de siempre.
const gitSidebarShot = (new URLSearchParams(location.search).get('view') ?? '').startsWith('gitsidebar')
// Las vistas `gitwork*` fotografían la pestaña de un repositorio con su columna
// de trabajo (Historial / Cambios / Stash / Archivos). Llevan stashes de
// ejemplo para que la solapa Stash tenga qué mostrar.
const gitWorkShot = (new URLSearchParams(location.search).get('view') ?? '').startsWith('gitwork')
const gitWorkStashes = [
    {ref: 'stash@{0}', index: 0, branch: 'develop', message: 'WIP: barra única y columna de trabajo', date: '2026-10-11'},
    {ref: 'stash@{1}', index: 1, branch: 'feat/diff-compacto', message: 'prueba del diff con medianiles', date: '2026-10-08'},
    {ref: 'stash@{2}', index: 2, branch: 'main', message: 'On main: ajustes de la ayuda', date: '2026-09-30'},
]
const gitWorkStashPatch = [
    'diff --git a/frontend/src/components/git/GitToolbar.tsx b/frontend/src/components/git/GitToolbar.tsx',
    'index 3f2a1c4..9b7d0e2 100644',
    '--- a/frontend/src/components/git/GitToolbar.tsx',
    '+++ b/frontend/src/components/git/GitToolbar.tsx',
    '@@ -18,6 +18,10 @@ export default function GitToolbar(p: Props) {',
    '     const ref = useRef<HTMLDivElement>(null)',
    '     const [width, setWidth] = useState(1200)',
    ' ',
    '+    const labels = width >= WIDE',
    '+    const repoActionsInline = width >= MEDIUM',
    '+    const rightExtrasInline = width >= NARROW',
    '+',
    '     useLayoutEffect(() => {',
    '         const el = ref.current',
    '         if (!el) return',
    'diff --git a/CHANGELOG.md b/CHANGELOG.md',
    'index 1a2b3c4..5d6e7f8 100644',
    '--- a/CHANGELOG.md',
    '+++ b/CHANGELOG.md',
    '@@ -3,4 +3,5 @@',
    ' ## [Unreleased]',
    ' ',
    '-### Agregado',
    '+### Mejorado',
    '+- La pestaña Git tiene una barra única.',
    ' ',
].join('\n')
const gitSidebarBranch = (name: string, extra: Partial<Record<string, unknown>> = {}) => ({
    name, current: false, remote: false, isCurrent: false, isRemote: name.startsWith('origin/') || name.startsWith('upstream/'),
    upstream: '', ahead: 0, behind: 0, hash: '76d8575', subject: '', ...extra,
})
const gitSidebarBranches = [
    gitSidebarBranch('develop', {isCurrent: true, current: true, upstream: 'origin/develop', ahead: 8}),
    gitSidebarBranch('main', {upstream: 'origin/main'}),
    gitSidebarBranch('feature/TIGOCHAT-11607', {upstream: 'origin/feature/TIGOCHAT-11607', ahead: 2, behind: 1}),
    gitSidebarBranch('feature/vault-notes', {upstream: 'origin/feature/vault-notes'}),
    gitSidebarBranch('feature/git-sidebar'),
    gitSidebarBranch('claude/fix-tree-filter'),
    gitSidebarBranch('claude/agent-chat-attachments'),
    gitSidebarBranch('claude/oracle-explain'),
    gitSidebarBranch('fix/123/null-pointer'),
    gitSidebarBranch('release/2026-07'),
    gitSidebarBranch('origin/develop'),
    gitSidebarBranch('origin/main'),
    gitSidebarBranch('origin/feature/TIGOCHAT-11607'),
    gitSidebarBranch('origin/feature/vault-notes'),
    gitSidebarBranch('origin/release/2026-07'),
    gitSidebarBranch('upstream/main'),
]
const gitSidebarTag = (name: string, hash: string, taggerDate: string, annotated = false) => ({name, hash, annotated, message: annotated ? `Versión ${name}` : '', taggerDate})
const gitSidebarTags = [
    gitSidebarTag('v1.3.1', '76d8575', '2026-08-15T10:00:00Z', true),
    gitSidebarTag('v1.3.0', '7334bc1', '2026-08-14T10:00:00Z', true),
    gitSidebarTag('v1.2.0', '3b24744', '2026-08-11T10:00:00Z'),
    gitSidebarTag('v1.1.0', '3ffd8cf', '2026-08-03T10:00:00Z'),
    gitSidebarTag('v0.5.2', '847a366', '2026-07-23T10:00:00Z'),
    gitSidebarTag('v0.5.1', 'fe25341', '2026-07-22T10:00:00Z'),
    gitSidebarTag('produccion-final', '83d5c41', '2026-07-22T09:00:00Z'),
]

const fixtures: Record<string, unknown> = {
    GitListWorkTree: {files: repoFiles, truncated: false},
    GitStatus: {
        branch: 'develop',
        upstream: 'origin/develop',
        ahead: 2,
        behind: 0,
        detached: false,
        hasChanges: true,
        files: [
            {path: 'backend/agentchat/conversations.go', origPath: '', indexStatus: 'A', workStatus: '', staged: true, untracked: false},
            {path: 'frontend/src/components/git/GitRepoTab.tsx', origPath: '', indexStatus: '', workStatus: 'M', staged: false, untracked: false},
            {path: 'CHANGELOG.md', origPath: '', indexStatus: '', workStatus: 'M', staged: false, untracked: false},
            {path: 'README.md', origPath: '', indexStatus: '', workStatus: 'M', staged: false, untracked: false},
        ],
    },
    GitReadWorkFile: {
        path: 'app_git.go',
        content: 'package main\n\nimport (\n\t"fmt"\n\t"strings"\n\n\t"github.com/wailsapp/wails/v2/pkg/runtime"\n\n\t"mini-tools/backend/git"\n\t"mini-tools/backend/vault"\n)\n\n// Git module bindings.\n//\n// These live in their own file rather than inside app.go\'s ~2500 lines purely\n// for readability — Wails binds every exported method on *App regardless of\n// which file declares it.\n//\n// gitRepo resolves an opaque repository ID to its on-disk path, after the gate\n// check. Every operation below funnels through it.\nfunc (a *App) gitRepo(repoID string) (string, error) {\n\tif err := a.requireUnlocked(); err != nil {\n\t\treturn "", err\n\t}\n\trepo, err := a.vault.GetGitRepo(repoID)\n\tif err != nil {\n\t\treturn "", err\n\t}\n\treturn repo.Path, nil\n}\n',
        size: 640,
        modTimeUnix: 1786741440,
        binary: false,
        tooLarge: false,
    },
    ListAgents: [
        {id: 'claude', label: 'Claude Code', vendor: 'Anthropic', command: 'claude', defaultCommand: 'claude', path: '/usr/local/bin/claude', available: true, keyEnv: 'ANTHROPIC_API_KEY', hasKey: false, loginHint: '', note: '', docsUrl: ''},
        {id: 'codex', label: 'Codex CLI', vendor: 'OpenAI', command: 'codex', defaultCommand: 'codex', path: '/usr/local/bin/codex', available: true, keyEnv: 'OPENAI_API_KEY', hasKey: false, loginHint: '', note: '', docsUrl: ''},
        {id: 'antigravity', label: 'Antigravity CLI', vendor: 'Google', command: 'agy', defaultCommand: 'agy', path: '/usr/local/bin/agy', available: true, keyEnv: '', hasKey: false, loginHint: '', note: '', docsUrl: ''},
        // Servidores de modelos: id `llm:<id>`, sin comando, key ni login.
        {id: 'llm:ms1', label: 'Ollama local', vendor: 'Ollama', command: '', defaultCommand: '', path: '', available: true, keyEnv: '', hasKey: false, loginHint: '', note: '', docsUrl: ''},
        {id: 'llm:ms2', label: 'vLLM en el servidor GPU', vendor: 'OpenAI-compatible', command: '', defaultCommand: '', path: '', available: true, keyEnv: '', hasKey: false, loginHint: '', note: '', docsUrl: ''},
        {id: 'llm:ms3', label: 'LM Studio del laboratorio', vendor: 'OpenAI-compatible', command: '', defaultCommand: '', path: '', available: true, keyEnv: '', hasKey: false, loginHint: '', note: '', docsUrl: ''},
    ],
    ListModelServers: [
        {id: 'ms1', name: 'Ollama local', kind: 'ollama', baseUrl: 'http://localhost:11434', hasToken: false, isLocal: true, insecureTls: false, contextTokens: 16384, enabled: true, defaultModel: '', sortOrder: 0, headerNames: [], createdAt: 1786741440, updatedAt: 1786741440},
        // Detrás de Cloudflare Access: token más dos cabeceras (solo los nombres viajan).
        {id: 'ms2', name: 'vLLM en el servidor GPU', kind: 'openai', baseUrl: 'https://gpu.example.com/v1', hasToken: true, isLocal: false, insecureTls: false, contextTokens: 0, enabled: true, defaultModel: '', sortOrder: 0, headerNames: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'], createdAt: 1786741440, updatedAt: 1786741440},
        // Servidor propio con certificado autofirmado.
        {id: 'ms3', name: 'LM Studio del laboratorio', kind: 'openai', baseUrl: 'https://192.168.1.50:1234/v1', hasToken: false, isLocal: false, insecureTls: true, contextTokens: 0, enabled: true, defaultModel: '', sortOrder: 0, headerNames: [], createdAt: 1786741440, updatedAt: 1786741440},
    ],
    // Salud por servidor (cacheada 30 s en el backend). `checkedAt` sale del
    // reloj de la captura para que el «comprobado hace Xs» sea creíble.
    ModelServerHealth: (id: string) => ({
        ok: true,
        version: id === 'ms1' ? '0.5.7' : '',
        models: ['qwen2.5:3b', 'llama3.2:3b'],
        error: '',
        latencyMs: id === 'ms1' ? 38 : id === 'ms2' ? 142 : 64,
        checkedAt: Date.now() - 12000,
    }),
    // Con un Ollama ya guardado en localhost la sugerencia no se muestra; la
    // captura de la sugerencia usa `?view=modelserverdetected`.
    DetectLocalOllama: true,
    TestModelServer: {ok: true, version: '0.5.7', models: ['qwen2.5:3b', 'llama3.2:3b', 'nomic-embed-text:latest'], error: '', latencyMs: 61, checkedAt: Date.now()},
    AgentDraftCommit: {
        message: 'feat(git): redactar el mensaje del commit con el agente por defecto',
        files: ['A   backend/agentchat/conversations.go'],
        insertions: 128,
        deletions: 12,
        diffTruncated: false,
        agentLabel: 'Claude Code',
    },
    AgentUsageLimits: [
        {
            agent: 'claude',
            known: true,
            note: '',
            source: '~/.claude.json',
            plan: '',
            queryable: false,
            measuredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
            windows: [
                {kind: 'session', label: 'Sesión · 5 h', percent: 3, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(), severity: 'normal', active: false},
                {kind: 'weekly', label: 'Semana · todos los modelos', percent: 17, resetsAt: new Date(Date.now() + 40 * 3600_000).toISOString(), severity: 'normal', active: true},
                {kind: 'weekly', label: 'Semana · Fable', percent: 0, resetsAt: '', severity: 'normal', active: false},
            ],
        },
        {
            agent: 'codex',
            known: true,
            note: '',
            source: '~/.codex/sessions/…/rollout-….jsonl',
            plan: 'plus',
            queryable: false,
            measuredAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
            windows: [{kind: 'session', label: 'Ventana · 5 h', percent: 74, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), severity: '', active: true}],
        },
        {
            agent: 'antigravity',
            known: false,
            note: 'Antigravity no guarda su cuota en el disco. Se le puede preguntar a él mismo: tarda unos segundos y no consume cuota.',
            source: '~/.gemini/antigravity-cli',
            plan: '',
            queryable: true,
            measuredAt: '',
            windows: [],
        },
    ],
    // Lo que contesta el CLI de Antigravity cuando se le pregunta la cuota
    // (`agy --print "/usage"`): grupos de modelos con su ventana semanal y la
    // de cinco horas.
    AgentQueryLimits: {
        agent: 'antigravity',
        known: true,
        note: '',
        source: 'agy --print /usage',
        plan: '',
        queryable: true,
        measuredAt: new Date().toISOString(),
        windows: [
            {kind: 'weekly', label: 'Gemini Models · semana', percent: 12, resetsAt: new Date(Date.now() + 60 * 3600_000).toISOString(), severity: '', active: true},
            {kind: 'session', label: 'Gemini Models · 5 h', percent: 0.4, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString(), severity: '', active: false},
            {kind: 'weekly', label: 'Claude and GPT models · semana', percent: 0, resetsAt: new Date(Date.now() + 150 * 3600_000).toISOString(), severity: '', active: false},
            {kind: 'session', label: 'Claude and GPT models · 5 h', percent: 0, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString(), severity: '', active: false},
        ],
    },
    // Chat de IA (pestaña de Utilidades): historial de todas las conversaciones,
    // búsqueda en su contenido y los mensajes guardados de una de ellas.
    AgentActive: {id: 'claude', label: 'Claude Code', available: true, model: '', effort: '', chatSupported: true},
    ListAllAgentChats: aiChats,
    SearchAgentChats: (query: string) => {
        const q = String(query).trim().toLowerCase()
        // Encuentra también por el TEXTO de los mensajes, no solo por el título:
        // es lo que distingue esta búsqueda de un filtro de la lista.
        const inBody: Record<string, string> = {
            'ac-1': 'cursor keyset offset postgres índice',
            'ac-4': 'select join índice plan de ejecución',
            'ac-6': 'índice oracle partición',
        }
        return aiChats.filter((c) => c.title.toLowerCase().includes(q) || (inBody[c.id] ?? '').includes(q))
    },
    AgentChatMessages: (chatID: string) => aiChatMessages[chatID] ?? [],
    AgentChatSupported: true,
    // Proyectos del Chat de IA: carpetas concedidas (una con la ruta perdida) y
    // el contexto que la app lee de cada proyecto.
    ListAgentWorkspaces: [
        {id: 'w1', name: 'soporte-semanal', path: '/Users/ana/trabajo/soporte-semanal', isGit: false, exists: true},
        {id: 'w2', name: 'infra-scripts', path: '/Users/ana/trabajo/infra-scripts', isGit: true, exists: true},
        {id: 'w3', name: 'prototipo-2024', path: '/Volumes/Respaldo/prototipo-2024', isGit: false, exists: false},
    ],
    PickAgentWorkspaceFolder: '/Users/ana/trabajo/soporte-semanal',
    AddAgentWorkspace: (path: string, name: string) => ({id: 'w1', name, path, isGit: false, exists: true}),
    RemoveAgentWorkspace: null,
    AgentWorkspaceContext: (_module: string, contextId: string) =>
        contextId === 'ws:w1'
            ? {
                  root: '/Users/ana/trabajo/soporte-semanal',
                  isGit: false,
                  branch: '',
                  instructions: [
                      {path: 'AGENTS.md', scope: 'project', chars: 1980, truncated: false},
                      {path: '~/.claude/CLAUDE.md', scope: 'global', chars: 640, truncated: false},
                  ],
                  skills: [
                      {name: 'informe-semanal', description: 'Arma el informe semanal de soporte a partir de la carpeta de tickets, con la plantilla del equipo.', scope: 'project', path: '.claude/skills/informe-semanal/SKILL.md'},
                      {name: 'triaje-tickets', description: 'Clasifica tickets nuevos por severidad y producto.', scope: 'project', path: '.claude/skills/triaje-tickets/SKILL.md'},
                  ],
                  totalChars: 2620,
              }
            : {
                  root: '/repos/mini-tools',
                  isGit: true,
                  branch: 'develop',
                  instructions: [
                      {path: 'AGENTS.md', scope: 'project', chars: 3412, truncated: false},
                      {path: 'CLAUDE.md', scope: 'project', chars: 9120, truncated: false},
                      {path: '~/.claude/CLAUDE.md', scope: 'global', chars: 640, truncated: false},
                      {path: 'claude/03-backend.md', scope: 'project', chars: 7428, truncated: true},
                  ],
                  skills: [
                      {name: 'mini-tools-patterns', description: 'Patrones de conectores de base de datos y de ejecución de queries.', scope: 'project', path: '.claude/skills/mini-tools-patterns/SKILL.md'},
                      {name: 'migrar-batch', description: 'Migrar un batch legacy a PL/SQL Oracle 19c siguiendo el flujo SDD del repo.', scope: 'project', path: '.claude/skills/migrar-batch/SKILL.md'},
                      {name: 'consultar-legacy', description: 'Resolver dudas del comportamiento del iSGL leyendo los fuentes originales.', scope: 'project', path: '.claude/skills/consultar-legacy/SKILL.md'},
                      {name: 'golang-performance', description: 'Optimización de rendimiento en Go: perfilado, asignaciones y concurrencia.', scope: 'global', path: '~/.claude/skills/golang-performance/SKILL.md'},
                      {name: 'frontend-design', description: 'Diseño visual intencional al construir o rehacer interfaces.', scope: 'global', path: '~/.claude/skills/frontend-design/SKILL.md'},
                      {name: 'write-swift', description: 'Cómo escribir Swift moderno: valores, concurrencia y protocolos.', scope: 'global', path: '~/.claude/skills/write-swift/SKILL.md'},
                  ],
                  totalChars: 32000,
              },
    AgentChatModes: ['', 'plan', 'approve', 'auto', 'edit'],
    // Cerebro: servidor MCP y escritura de notas encendidos (la vista
    // `braindisabled` los apaga), con la carpeta por defecto.
    BrainStatus: {mcpEnabled: true, notesWrite: true, root: 'Cerebro'},
    GetBrainRoot: 'Cerebro',
    SetBrainRoot: null,
    SetAgentChatBrain: null,
    AgentModelCatalog: {
        models: [
            {id: '', label: 'Default', description: 'The one the CLI has configured', efforts: []},
            {id: 'opus', label: 'Opus', description: 'El más capaz para tareas complejas y largas', efforts: []},
            {id: 'sonnet', label: 'Sonnet', description: 'Equilibrio entre capacidad y velocidad', efforts: []},
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    // Dos historiales: el de código (pestaña Git) y el de una BASE, que es
    // donde se ve lo nuevo — la consulta adjunta y la barra de cada bloque de
    // SQL con "Al editor".
    AgentChatHistory: (_agentID: string, conversationID: string) =>
        conversationID === 'conv-db' ? chatDbTurns : chatCodeTurns,
    GitAgentContext: {
        skills: [{name: 'chatwoot-dev', description: 'Chatwoot full-stack development workflow. Use when: creating a new feature, adding an API endpoint.', path: '.claude/skills/chatwoot-dev/SKILL.md', scope: 'repo'}],
        agents: [],
        commands: [
            {name: 'adapt', description: '', path: '.claude/commands/adapt.md', scope: 'repo'},
            {name: 'audit', description: '', path: '.claude/commands/audit.md', scope: 'repo'},
        ],
        instructions: [
            {file: 'CLAUDE.md', path: 'CLAUDE.md', present: true, size: 2756, agents: ['claude']},
            {file: 'AGENTS.md', path: 'AGENTS.md', present: false, size: 0, agents: ['codex']},
            {file: 'GEMINI.md', path: 'GEMINI.md', present: false, size: 0, agents: ['antigravity']},
        ],
    },
    GitMCPConfig: {
        servers: [
            {name: 'codegraph', agent: 'claude', scope: 'project', transport: 'stdio', command: 'codegraph', args: ['mcp'], url: '', envKeys: [], source: '/repo/.mcp.json'},
            {name: 'github', agent: 'claude', scope: 'user', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], url: '', envKeys: ['GITHUB_TOKEN'], source: '/home/u/.claude.json'},
        ],
        files: [{path: '/repo/.mcp.json', agent: 'claude', scope: 'project', present: true, error: '', servers: 1, writable: true}],
    },
    GitAgentUsage: {
        days: 30,
        // Los tres agentes, como los devuelve el backend: uno con tokens
        // medidos, uno con menos, y uno que no deja tokens en disco y solo
        // tiene actividad — es el que estrena el botón de consultar la cuota.
        agents: [
            {agent: 'claude', available: true, note: '', source: '', all: {input: 37210, output: 8646915, cacheWrite: 60985113, cacheRead: 3604530546, total: 3674199784, messages: 9309}, repo: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 323200000, messages: 800}, firstDay: '2026-07-15', lastDay: '2026-08-14', byModel: [{key: 'claude-opus-5', total: 2055073573, percent: 60.1, messages: 5119}, {key: 'claude-opus-4-8', total: 834401643, percent: 21.5, messages: 1789}], byDay: [], cacheHitPercent: 98.4, activity: null},
            {agent: 'antigravity', available: false, note: 'El CLI no deja los tokens en disco: se muestra la actividad registrada.', source: '~/.gemini', all: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0}, repo: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0}, firstDay: '', lastDay: '', byModel: [], byDay: [], cacheHitPercent: 0, activity: {conversations: 1, steps: 4, repoConversations: 0, repoSteps: 0, lastUsed: '2026-08-14'}},
        ],
    },
    AgentPlans: [
        {agent: 'claude', known: true, label: 'Claude Max 5x', detail: 'claude_max', note: ''},
        {agent: 'codex', known: true, label: 'Free', detail: 'chatgpt', note: ''},
    ],
    ListAgentChats: [
        {id: 'chat-1', repoId: 'r1', agentId: 'claude', title: 'Potenciar el editor Git con CodeMirror y agentes', conversationId: 'conv-1', createdAt: 1786700000, updatedAt: 1786741440, model: 'opus', effort: 'high', mode: ''},
        {id: 'chat-2', repoId: 'r1', agentId: 'claude', title: 'Investigar la anomalía AT355 en facturación', conversationId: 'conv-2', createdAt: 1786600000, updatedAt: 1786665000, model: 'opus', effort: 'high', mode: ''},
        {id: 'chat-3', repoId: 'r1', agentId: 'codex', title: 'Corregir el autocompletado SQL de esquemas y tablas', conversationId: 'conv-3', createdAt: 1786500000, updatedAt: 1786579000, model: '', effort: '', mode: ''},
        {id: 'chat-4', repoId: 'r1', agentId: 'claude', title: 'Procedimiento de limpieza de facturas duplicadas', conversationId: 'conv-4', createdAt: 1786400000, updatedAt: 1786492000, model: '', effort: '', mode: ''},
        {id: 'chat-5', repoId: 'r1', agentId: 'antigravity', title: 'Diseñar el autocompletado SQL con contexto', conversationId: 'conv-5', createdAt: 1785500000, updatedAt: 1785542000, model: '', effort: '', mode: ''},
        {id: 'chat-6', repoId: 'r1', agentId: 'codex', title: 'Configurar git push upstream en la rama de feature', conversationId: 'conv-6', createdAt: 1785200000, updatedAt: 1785282000, model: '', effort: '', mode: ''},
    ],
    GitRepoWorkspace: {openFiles: ['app_git.go'], defaultAgent: ''},
    // Devuelve un archivo para cualquier ruta: las pestañas guardadas se
    // restauran abriendo su archivo, así que sin esto la tira de pestañas
    // salía siempre con una sola.
    OpenSQLFilePath: (path: string) => ({
        path,
        content: path.includes('facturacion')
            ? "SELECT f.num_factura, f.fecha_emision, c.nombre, f.total\nFROM SGCPRO.facturas f\nJOIN SGCPRO.clientes c ON c.id_cliente = f.id_cliente\nWHERE f.estado = :estado\n  AND f.fecha_emision BETWEEN :desde AND :hasta\nORDER BY f.fecha_emision DESC;"
            : "SELECT lower(email) AS email, count(*) AS veces\nFROM contacts\nGROUP BY lower(email)\nHAVING count(*) > 1\nORDER BY veces DESC;",
    }),
    // --- Configuración -----------------------------------------------------
    AppVersion: '2.0.0',
    ListShells: [
        {id: 'zsh', label: 'zsh', path: '/bin/zsh', available: true},
        {id: 'bash', label: 'bash', path: '/bin/bash', available: true},
        {id: 'pwsh', label: 'PowerShell', path: '', available: false},
    ],
    DefaultShellID: 'zsh',
    // Activity Monitor: una lectura inventada; cambia un poco en cada llamada
    // para que los gráficos tengan algo que dibujar.
    ProcessSnapshot: () => {
        const j = (v: number, d: number) => Math.max(0, v + (Math.random() - 0.5) * d)
        const mk = (pid: number, name: string, user: string, cpu: number, mb: number, prot = false) => ({
            pid, ppid: 1, name, user, cpu: j(cpu, cpu * 0.3), memory: mb * 1024 * 1024, protected: prot,
        })
        return {
            processes: [
                mk(602, 'WindowServer', '_windowserver', 15.5, 88),
                mk(22518, 'Code Helper (Renderer)', 'rafael', 9, 341),
                mk(23559, 'cpptools', 'rafael', 9, 81),
                mk(48211, 'node', 'rafael', 41.2, 412),
                mk(51022, 'java', 'rafael', 88.4, 1240),
                mk(607, 'runningboardd', 'root', 5.2, 16),
                mk(7271, 'Code Helper', 'rafael', 5.2, 86),
                mk(912, 'postgres', 'rafael', 1.8, 58),
                mk(1204, 'redis-server', 'rafael', 0.4, 12),
                mk(1066, 'ControlCenter', 'rafael', 0.2, 64),
                mk(968, 'rapportd', 'rafael', 0, 9),
                mk(1, 'launchd', 'root', 0, 24, true),
                mk(0, 'kernel_task', 'root', 2.1, 310, true),
            ],
            cores: 10, cpuTotal: j(14, 8), memUsed: 12244 * 1048576, memTotal: 16384 * 1048576,
            netRx: j(420000, 300000), netTx: j(85000, 60000), hasUser: true, me: 'rafael', takenAt: Date.now(),
        }
    },
    StopProcessMonitor: null,
    // Docker: los contenedores de un stack inventado, con uno que falló, uno
    // detenido bien y imágenes/volúmenes/redes de ejemplo.
    DockerStatus: () =>
        ['dockerdown', 'sidebardown'].includes(new URLSearchParams(location.search).get('view') ?? '')
            ? {installed: true, path: '/usr/local/bin/docker', version: '29.4.0', serverVersion: '', running: false, context: 'desktop-linux', error: 'Cannot connect to the Docker daemon at unix:///Users/rafael/.docker/run/docker.sock. Is the docker daemon running?', launcher: 'Docker Desktop'}
            : {installed: true, path: '/usr/local/bin/docker', version: '29.4.0', serverVersion: '29.4.0', running: true, context: 'desktop-linux', error: '', launcher: 'Docker Desktop'},
    DockerContainers: [
        {id: 'a1f3c9d0e2b4a1f3c9d0e2b4', name: 'ambdbpost_dbpost', image: 'postgres:17', state: 'running', status: 'Up 2 hours (healthy)', ports: '0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp', created: '', project: 'ambdbpost', service: 'dbpost', mounts: ['ambdbpost_postdbtest']},
        {id: 'b2e4d1c0f3a5b2e4d1c0f3a5', name: 'ambdbpost_redis', image: 'redis:alpine', state: 'running', status: 'Up 2 hours', ports: '0.0.0.0:6379->6379/tcp', created: '', project: 'ambdbpost', service: 'redis', mounts: []},
        {id: 'c3d5e2f1a4b6c3d5e2f1a4b6', name: 'mandadosgo_api', image: 'mandadosgo/api:aeead0d-dirty', state: 'running', status: 'Up 5 minutes (healthy)', ports: '0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp', created: '', project: 'mandadosgo', service: 'api', mounts: []},
        {id: 'd4e6f3a2b5c7d4e6f3a2b5c7', name: 'mandadosgo_minio', image: 'pgsty/minio:RELEASE.2026-08-04', state: 'running', status: 'Up 5 minutes (healthy)', ports: '127.0.0.1:9000-9001->9000-9001/tcp', created: '', project: 'mandadosgo', service: 'minio', mounts: ['mandadosgo_minio']},
        {id: 'e5f7a4b3c6d8e5f7a4b3c6d8', name: 'mandadosgo_minio_init', image: 'pgsty/mc:RELEASE.2026-09-16', state: 'exited', status: 'Exited (0) 19 hours ago', ports: '', created: '', project: 'mandadosgo', service: 'minio-init', mounts: []},
        {id: 'f6a8b5c4d7e9f6a8b5c4d7e9', name: 'mandadosgo_worker', image: 'mandadosgo/worker:aeead0d', state: 'exited', status: 'Exited (137) 3 minutes ago', ports: '', created: '', project: 'mandadosgo', service: 'worker', mounts: []},
        {id: '07b9c6d5e8f0a7b9c6d5e8f0', name: 'scratch_nginx', image: 'nginx:1.27', state: 'running', status: 'Up 20 minutes', ports: '0.0.0.0:8081->80/tcp', created: '', project: '', service: '', mounts: []},
    ],
    DockerStats: [
        {id: 'a1f3c9d0e2b4', cpu: 0.17, memUsage: '31.2MiB / 7.8GiB', memPercent: 0.39},
        {id: 'b2e4d1c0f3a5', cpu: 0.4, memUsage: '8.1MiB / 7.8GiB', memPercent: 0.1},
        {id: 'c3d5e2f1a4b6', cpu: 12.6, memUsage: '186MiB / 7.8GiB', memPercent: 2.3},
        {id: 'd4e6f3a2b5c7', cpu: 0.8, memUsage: '190MiB / 7.8GiB', memPercent: 2.4},
        {id: '07b9c6d5e8f0', cpu: 0, memUsage: '4.4MiB / 7.8GiB', memPercent: 0.06},
    ],
    DockerImages: [
        {id: 'sha256:1fe5b8a465cb', repository: 'mandadosgo/api', tag: 'aeead0d-dirty', size: '90.9MB', created: '19 hours ago', inUse: 1},
        {id: 'sha256:b1581d2fff72', repository: 'mandadosgo/api', tag: 'ed3cb45-dirty', size: '90.9MB', created: '19 hours ago', inUse: 0},
        {id: 'sha256:2293c15365b2', repository: 'postgres', tag: '17', size: '438MB', created: '2 weeks ago', inUse: 1},
        {id: 'sha256:9a8b7c6d5e4f', repository: '<none>', tag: '<none>', size: '212MB', created: '3 weeks ago', inUse: 0},
    ],
    DockerVolumes: [
        {name: 'ambdbpost_postdbtest', driver: 'local', mountpoint: '/var/lib/docker/volumes/ambdbpost_postdbtest/_data', usedBy: 1},
        {name: 'mandadosgo_minio', driver: 'local', mountpoint: '/var/lib/docker/volumes/mandadosgo_minio/_data', usedBy: 1},
        {name: 'old_backup_data', driver: 'local', mountpoint: '/var/lib/docker/volumes/old_backup_data/_data', usedBy: 0},
    ],
    DockerNetworks: [
        {id: 'b3019108a3aa', name: 'ambdbpost_default', driver: 'bridge', scope: 'local'},
        {id: '12a8741c11ab', name: 'bridge', driver: 'bridge', scope: 'local'},
        {id: '7f1c2d3e4a5b', name: 'host', driver: 'host', scope: 'local'},
    ],
    DockerInspect: '[\n  {\n    "Id": "c3d5e2f1a4b6…",\n    "Name": "/mandadosgo_api",\n    "State": {"Status": "running", "Running": true},\n    "Config": {"Image": "mandadosgo/api:aeead0d-dirty"}\n  }\n]',
    DockerCounts: {containers: 7, images: 10, volumes: 3, networks: 5, builds: 14},
    DockerLogsStart: null,
    DockerLogsStop: null,
    DockerBuilds: [
        {ref: 'hyrk5x1eb7v8gjadqybq235ai', name: 'https://github.com/totolab-ni/mandados-go-backend.git', status: 'Completed', createdAt: '2026-09-30T22:07:36.8Z', completedAt: '2026-09-30T22:07:50.9Z', durationMs: 14100, totalSteps: 18, completedSteps: 18, cachedSteps: 3},
        {ref: 'zuku4xrum4ieqe2qe4np5nbot', name: 'deploy/postgres', status: 'Completed', createdAt: '2026-09-30T22:07:36.8Z', completedAt: '2026-09-30T22:07:37.0Z', durationMs: 189, totalSteps: 8, completedSteps: 8, cachedSteps: 2},
        {ref: 'q8w7e6r5t4y3u2i1o0p9a8s7d', name: 'deploy/worker', status: 'Error', createdAt: '2026-09-30T21:10:02.0Z', completedAt: '2026-09-30T21:10:09.4Z', durationMs: 7400, totalSteps: 12, completedSteps: 9, cachedSteps: 6},
        {ref: 'm1n2b3v4c5x6z7l8k9j0h1g2f', name: 'deploy/api', status: 'Canceled', createdAt: '2026-09-29T18:00:00.0Z', completedAt: '2026-09-29T18:01:05.0Z', durationMs: 65000, totalSteps: 10, completedSteps: 4, cachedSteps: 0},
    ],
    DockerBuildLogs: {text: '#1 [internal] load build definition from Dockerfile\n#1 transferring dockerfile: 498B done\n#1 DONE 0.0s\n\n#2 [internal] load metadata for docker.io/library/postgres:17\n#2 DONE 0.0s\n\n#5 [3/4] RUN apk add --no-cache curl\n#5 ERROR: process "/bin/sh -c apk add --no-cache curl" did not complete successfully: exit code: 1', truncated: false},
    DockerExportContainerLogs: {path: '/Users/rafael/Downloads/api-logs-20261001-165500.log', bytes: 482113, lines: 10000},
    DockerExportBuildLogs: {path: '/Users/rafael/Downloads/deploy_postgres-build-20261001-165500.log', bytes: 1402, lines: 33},
    DockerSaveText: {path: '/Users/rafael/Downloads/api-view-20261001-165500.log', bytes: 2210, lines: 20},
    DockerCompose: '',
    DockerPickComposeFile: '',
    DockerComposeUpFile: '',
    // Port Killer: datos inventados, con un puerto abierto a la red, un proceso
    // sin identificar (protegido) y varios locales.
    ListListeningPorts: [
        {port: 3000, address: '127.0.0.1', pid: 48211, process: 'node', protected: false},
        {port: 5000, address: '*', pid: 1066, process: 'ControlCenter', protected: false},
        {port: 5173, address: '::1', pid: 48390, process: 'vite', protected: false},
        {port: 5432, address: '127.0.0.1', pid: 912, process: 'postgres', protected: false},
        {port: 6379, address: '127.0.0.1', pid: 1204, process: 'redis-server', protected: false},
        {port: 8080, address: '*', pid: 51022, process: 'java', protected: false},
        {port: 9229, address: '127.0.0.1', pid: 0, process: '', protected: true},
    ],
    LocalShellLabel: 'zsh',
    // Historial de la terminal LOCAL: por intérprete, no por servidor.
    ListLocalHistory: [
        {id: 3, command: 'kubectl -n produccion logs -f deploy/api', ranAt: 1786741000},
        {id: 2, command: 'scp rafael@prodmain:/var/log/api.log ~/Descargas/', ranAt: 1786740000},
        {id: 1, command: 'tar -xzf backup-2026-08-14.tar.gz', ranAt: 1786700000},
    ],
    GitProbe: {available: true, version: '2.45.0', path: '/usr/bin/git', error: ''},
    GitBranches: gitSidebarShot ? gitSidebarBranches : [
        {name: 'develop', current: true, remote: false, isCurrent: true, isRemote: false, upstream: 'origin/develop', ahead: 8, behind: 0, hash: '76d8575', subject: 'Add macOS and Windows binaries for mini-tools v1.3.1 release'},
        {name: 'main', current: false, remote: false, isCurrent: false, isRemote: false, upstream: 'origin/main', ahead: 0, behind: 0, hash: '76d8575', subject: ''},
        {name: 'origin/develop', current: false, remote: true, isCurrent: false, isRemote: true, upstream: '', ahead: 0, behind: 0, hash: '76d8575', subject: ''},
        {name: 'origin/main', current: false, remote: true, isCurrent: false, isRemote: true, upstream: '', ahead: 0, behind: 0, hash: '76d8575', subject: ''},
    ],
    GitTags: gitSidebarShot ? gitSidebarTags : [
        {name: 'v1.3.1', hash: '76d8575', message: '', date: '2026-08-15'},
        {name: 'v1.3.0', hash: '7334bc1', message: '', date: '2026-08-14'},
        {name: 'v1.2.0', hash: '3b24744', message: '', date: '2026-08-11'},
        {name: 'v1.1.0', hash: '3ffd8cf', message: '', date: '2026-08-03'},
        {name: 'v1.0.0', hash: '8e0d0e1', message: '', date: '2026-07-30'},
        {name: 'v0.5.2', hash: '847a366', message: '', date: '2026-07-23'},
        {name: 'v0.5.1', hash: 'fe25341', message: '', date: '2026-07-22'},
        {name: 'v0.4.0', hash: '83d5c41', message: '', date: '2026-07-22'},
        {name: 'v0.3.0', hash: '65da206', message: '', date: '2026-07-20'},
    ],
    // La URL llega tal cual está configurada, con el token adentro: es lo que
    // muestra la app. El token es inventado y no sirve para autenticarse.
    GitRemotes: [
        {
            name: 'origin',
            fetchUrl: 'https://ghp_EjEmPl0N0Us4bl3T0k3nDeMuestra@github.com/rafael180496/mini-tools.git',
            pushUrl: 'https://ghp_EjEmPl0N0Us4bl3T0k3nDeMuestra@github.com/rafael180496/mini-tools.git',
        },
        ...(gitSidebarShot ? [{name: 'upstream', fetchUrl: 'https://github.com/otro-equipo/mini-tools.git', pushUrl: 'https://github.com/otro-equipo/mini-tools.git'}] : []),
    ],
    // Lo mismo, pero con la URL de push vacía: así se ve un remoto sin
    // override, que es el caso normal.
    GitRemoteURLsForEdit: {
        name: 'origin',
        fetchUrl: 'https://ghp_EjEmPl0N0Us4bl3T0k3nDeMuestra@github.com/rafael180496/mini-tools.git',
        pushUrl: '',
    },
    GitIdentity: {
        localName: '',
        localEmail: '',
        globalName: 'rafael',
        globalEmail: 'rafael@ejemplo.dev',
        effectiveName: 'rafael',
        effectiveEmail: 'rafael@ejemplo.dev',
        usingGlobal: true,
    },
    GitCredentialHelper: {
        helper: 'osxkeychain',
        global: true,
        available: [
            {value: 'osxkeychain', label: 'Llavero de macOS', secure: true},
            {value: 'cache --timeout=3600', label: 'Recordar 1 hora (en memoria)', secure: true},
            {value: 'store', label: 'Archivo en texto plano (~/.git-credentials)', secure: false},
        ],
    },
    GitListCredentials: [{id: 'gc1', host: 'github.com', username: 'rafael180496', createdAt: 1786400000}],
    GitStashes: gitWorkShot ? gitWorkStashes : gitSidebarShot ? [{ref: 'stash@{0}', index: 0, branch: 'develop', message: 'WIP: filtro de ramas en la barra', date: '2026-10-11'}] : [],
    GitLog: [
        {hash: '76d8575000000000000000000000000000000000', shortHash: '76d8575', subject: 'Add macOS and Windows binaries for mini-tools v1.3.1 release', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-15', body: '', parents: ['7334bc1000000000000000000000000000000000'], branches: ['develop', 'main', 'origin/develop', 'origin/main', 'origin/HEAD'], tags: ['v1.3.1'], isHead: true, stats: {added: 0, removed: 0, files: 0}},
        {hash: '7334bc1000000000000000000000000000000000', shortHash: '7334bc1', subject: 'feat: Add agent chat functionalities and models', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-14', body: '', parents: ['74e1525000000000000000000000000000000000'], branches: [], tags: ['v1.3.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '74e1525000000000000000000000000000000000', shortHash: '74e1525', subject: 'feat: agregar confirmación antes de ejecutar sentencias destructivas en bases de datos marcadas como Producción', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-13', body: '', parents: ['3230ced000000000000000000000000000000000'], branches: [], tags: [], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '3230ced000000000000000000000000000000000', shortHash: '3230ced', subject: 'feat: agregar funcionalidad para revelar contraseñas guardadas en conexiones, incluyendo controles para ver, copiar y editar', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-13', body: '', parents: ['3b24744000000000000000000000000000000000'], branches: [], tags: [], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '3b24744000000000000000000000000000000000', shortHash: '3b24744', subject: 'feat: add SQL script parsing for CREATE TABLE/VIEW and CTEs', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-11', body: '', parents: ['e2b214c000000000000000000000000000000000'], branches: [], tags: ['v1.2.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: 'e2b214c000000000000000000000000000000000', shortHash: 'e2b214c', subject: 'feat: eliminar versiones antiguas de archivos binarios para macOS y Windows', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-03', body: '', parents: ['3ffd8cf000000000000000000000000000000000'], branches: [], tags: [], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '3ffd8cf000000000000000000000000000000000', shortHash: '3ffd8cf', subject: 'feat: add terminal font size limits and default values', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-08-03', body: '', parents: ['8e0d0e1000000000000000000000000000000000'], branches: [], tags: ['v1.1.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '8e0d0e1000000000000000000000000000000000', shortHash: '8e0d0e1', subject: 'feat: Add new data models for MongoDB and Redis, including field info and server stats', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-30', body: '', parents: ['847a366000000000000000000000000000000000'], branches: [], tags: ['v1.0.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '847a366000000000000000000000000000000000', shortHash: '847a366', subject: 'feat: enhance commit graph and repository management features', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-23', body: '', parents: ['fe25341000000000000000000000000000000000'], branches: [], tags: ['v0.5.2'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: 'fe25341000000000000000000000000000000000', shortHash: 'fe25341', subject: 'feat: add SQLCipher support for SQLite connections', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-22', body: '', parents: ['0549112000000000000000000000000000000000'], branches: [], tags: ['v0.5.1'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '0549112000000000000000000000000000000000', shortHash: '0549112', subject: 'Refactor code structure for improved readability and maintainability', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-22', body: '', parents: ['39f3b92000000000000000000000000000000000'], branches: [], tags: [], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '39f3b92000000000000000000000000000000000', shortHash: '39f3b92', subject: 'feat: actualizar a la versión 0.5.0 con nuevas funcionalidades y correcciones', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-22', body: '', parents: ['16fa5c0000000000000000000000000000000000'], branches: [], tags: ['v0.5.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '16fa5c0000000000000000000000000000000000', shortHash: '16fa5c0', subject: 'feat(git): add prompt dialog and split diff functionality', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-22', body: '', parents: ['9cb3da9000000000000000000000000000000000'], branches: [], tags: [], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '9cb3da9000000000000000000000000000000000', shortHash: '9cb3da9', subject: 'feat: actualizar el tamaño objetivo del binario a <80MB y ajustar documentación relacionada', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-22', body: '', parents: ['83d5c41000000000000000000000000000000000'], branches: [], tags: [], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '83d5c41000000000000000000000000000000000', shortHash: '83d5c41', subject: 'Update macOS and Windows releases to version 0.4.0', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-22', body: '', parents: ['65da206000000000000000000000000000000000'], branches: [], tags: ['v0.4.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
        {hash: '65da206000000000000000000000000000000000', shortHash: '65da206', subject: 'feat: implement automatic backup feature with scheduler', author: 'rafael', email: 'rafael@ejemplo.dev', date: '2026-07-20', body: '', parents: [], branches: [], tags: ['v0.3.0'], isHead: false, stats: {added: 0, removed: 0, files: 0}},
    ],
    GitInProgress: '',
    GitStashDiff: gitWorkStashPatch,
    GitForgeInfo: {provider: 'github', webUrl: 'https://github.com/rafael180496/mini-tools', compareUrl: 'https://github.com/rafael180496/mini-tools/compare/develop'},
    GitCommandLog: [],
    GitWorktrees: [],
    GetSettings: {sidebarWidth: 276,
    // Apariencia del editor, manejable por query string para poder
    // fotografiar variantes: `&size=18&gutter=0&toolbar=compact` es la forma
    // de comprobar que el ajuste llega de verdad al editor y no solo al
    // formulario que lo configura.
    editorAppearance: {
        fontFamily: new URLSearchParams(location.search).get('font') || 'jetbrains',
        fontSize: Number(new URLSearchParams(location.search).get('size')) || 13,
        lineWrap: new URLSearchParams(location.search).get('wrap') === '1',
        lineNumbers: new URLSearchParams(location.search).get('gutter') !== '0',
        tabSize: 4,
        toolbar: new URLSearchParams(location.search).get('toolbar') || 'normal',
    }, sidebarCollapsed: new URLSearchParams(location.search).get('view') === 'sidebarmin',
    // Una tanda de pestañas como queda una sesión de verdad: dos consultas
    // contra bases distintas, una terminal y un repositorio. Es lo que hace
    // fotografiable el rótulo de tipo de cada pestaña — con una sola pestaña
    // abierta no hay nada que distinguir.
    openTabs: [
        {path: '/consultas/facturacion-pendiente.sql', connId: 'c1', language: 'sql', kind: 'editor'},
        {path: '/consultas/contactos-duplicados.sql', connId: 'c5', language: 'sql', kind: 'editor'},
        {path: '', connId: 'c3', language: 'redis-cli', kind: 'redis-browser'},
    ], sidebarModule: new URLSearchParams(location.search).get('module') || (gitSidebarShot ? 'git' : (new URLSearchParams(location.search).get('view') ?? '') === 'aisessreveal' ? 'connections' : (new URLSearchParams(location.search).get('view') ?? '').startsWith('aisess') ? 'utilities' : 'connections'), gitSideWidth: 260, gitDiffWidth: 420, gitTermDock: 'bottom', gitTermSize: 520, // La vista `panelagents` prueba el botón "Agentes" de la barra de arriba,
    // que solo existe con el panel CERRADO — de ahí que la fixture dependa de
    // la vista.
    gitPanelTab: new URLSearchParams(location.search).get('view') === 'panelagents' || gitWorkShot ? '' : 'agents', gitSideHidden: new URLSearchParams(location.search).get('view') === 'gitworkcollapsed', gitDiffHidden: false, gitPanelSessions: [{id: 'chat-1', kind: 'chat', agentId: 'claude', title: 'Chat · Claude Code'}], gitDiffContext: 3, gitDiffIgnoreWs: false, gitDiffWrap: false},
    // Los archivos de un commit, con su churn: es lo que dibuja el resumen del
    // commit (metadatos + archivos desplegables). Vacío se fotografiaba como un
    // commit que no tocó nada.
    GitChangedFiles: [
        {path: 'backend/agentchat/conversations.go', origPath: '', patch: '', isBinary: false, stat: {filesChanged: 1, insertions: 42, deletions: 6}},
        {path: 'backend/agentchat/session.go', origPath: '', patch: '', isBinary: false, stat: {filesChanged: 1, insertions: 18, deletions: 3}},
        {path: 'frontend/src/components/agent/AgentChat.tsx', origPath: '', patch: '', isBinary: false, stat: {filesChanged: 1, insertions: 96, deletions: 21}},
        {path: 'frontend/src/assets/agent-chat.png', origPath: '', patch: '', isBinary: true, stat: {filesChanged: 1, insertions: 0, deletions: 0}},
    ],
    // Un parche de verdad: es lo que dibujan el panel de diff y el diff
    // desplegable de la lista de cambios, y con `patch: ''` las dos vistas se
    // fotografiaban vacías.
    GitDiff: {
        path: '',
        origPath: '',
        patch: [
            'diff --git a/backend/agentchat/conversations.go b/backend/agentchat/conversations.go',
            'index 3f2a1c4..9b7d0e2 100644',
            '--- a/backend/agentchat/conversations.go',
            '+++ b/backend/agentchat/conversations.go',
            '@@ -12,7 +12,11 @@ func Conversations(agentID string) ([]Conversation, error) {',
            ' \tif agentID == "" {',
            ' \t\treturn nil, fmt.Errorf("agentchat: falta el agente")',
            ' \t}',
            '-\tlist, err := readAll(agentID)',
            '+\tlist, err := readAll(agentID)',
            '+\tif err != nil {',
            '+\t\treturn nil, fmt.Errorf("agentchat: leyendo conversaciones de %s: %w", agentID, err)',
            '+\t}',
            '+',
            ' \tsort.Slice(list, func(i, j int) bool { return list[i].UpdatedAt > list[j].UpdatedAt })',
            ' \treturn list, nil',
            ' }',
            '@@ -48,6 +52,9 @@ func readAll(agentID string) ([]Conversation, error) {',
            ' \tentries, err := os.ReadDir(dir)',
            ' \tif err != nil {',
            '-\t\treturn nil, err',
            '+\t\tif errors.Is(err, fs.ErrNotExist) {',
            '+\t\t\treturn nil, nil',
            '+\t\t}',
            '+\t\treturn nil, fmt.Errorf("agentchat: leyendo %s: %w", dir, err)',
            ' \t}',
            ' \tout := make([]Conversation, 0, len(entries))',
        ].join('\n'),
        isBinary: false,
        stat: {added: 9, removed: 2},
    },
    // Conversaciones que el propio CLI ya tiene del repositorio: la respuesta
    // depende del agente que se pregunte.
    AgentCLIConversations: (agentID: string) =>
        agentID === 'claude'
            ? [
                  {id: 'c-9f21', agent: 'claude', title: 'migrar el panel de conexiones a carpetas', updatedAt: 1786650000},
                  {id: 'c-7a03', agent: 'claude', title: 'por qué el SFTP no conecta contra el servidor de staging', updatedAt: 1786480000},
              ]
            : agentID === 'codex'
              ? [{id: 'x-0142', agent: 'codex', title: 'revisar el splitter de PL/SQL con subprogramas anidados', updatedAt: 1786390000}]
              : [],
    // --- Redis Browser ---
    // Claves de un e-commerce de juguete: nada que se parezca a un dato de
    // nadie, que es lo que permite publicar la captura sin borronear nada.
    ListRedisKeys: {
        keys: [
            {key: 'session:u:1042', type: 'string'},
            {key: 'session:u:1043', type: 'string'},
            {key: 'cart:u:1042', type: 'hash'},
            {key: 'cart:u:1043', type: 'hash'},
            {key: 'catalog:product:SKU-8841', type: 'json'},
            {key: 'catalog:product:SKU-8842', type: 'json'},
            {key: 'queue:orders:pending', type: 'list'},
            {key: 'queue:orders:failed', type: 'list'},
            {key: 'leaderboard:ventas:2026-08', type: 'zset'},
            {key: 'flags:checkout-v2', type: 'string'},
            {key: 'tags:producto:destacado', type: 'set'},
            {key: 'stream:pagos', type: 'stream'},
        ],
        cursor: '',
    },
    GetRedisStats: {totalKeys: 1011, usedMemoryBytes: 4089446},
    GetRedisKeyInfo: {key: 'cart:u:1042', type: 'hash', ttlSeconds: 51548, sizeBytes: 256},
    GetRedisKeyValue: {
        type: 'hash',
        hashPairs: [
            {field: 'SKU-8841', value: '2'},
            {field: 'SKU-8842', value: '1'},
            {field: 'moneda', value: 'GTQ'},
            {field: 'total', value: '1249.00'},
            {field: 'actualizado', value: '2026-08-14T10:22:05Z'},
        ],
    },
    // --- MongoDB Browser ---
    // Pedidos de la misma tienda de juguete que el Redis de arriba.
    ListMongoDatabases: [{name: 'events', sizeOnDisk: 81920, empty: false}],
    ListMongoCollections: [
        {name: 'orders', type: 'collection', estimatedCount: 1842},
        {name: 'payments', type: 'collection', estimatedCount: 977},
    ],
    GetMongoIndexes: [],
    ListMongoDocuments: [
        '{"_id":{"$oid":"66bc1f0a9d3e2a0012ab3401"},"cliente":"u:1042","estado":"pagado","total":1249,"items":2}',
        '{"_id":{"$oid":"66bc1f0a9d3e2a0012ab3402"},"cliente":"u:1043","estado":"pendiente","total":310.5,"items":1}',
    ],
    CountMongoDocuments: 1842,
    SampleMongoFields: [
        {path: '_id', types: ['objectId'], count: 100, frequency: 1},
        {path: 'cliente', types: ['string'], count: 100, frequency: 1},
        {path: 'estado', types: ['string'], count: 100, frequency: 1},
        {path: 'total', types: ['double', 'int'], count: 100, frequency: 1},
    ],
    // --- Módulo de base de datos ---
    // Conexiones repartidas en carpetas, como queda un equipo real después de
    // unos meses: un entorno productivo aparte, uno de pruebas, y lo local
    // suelto en la raíz. Plano no probaba nada de lo que hay que mirar —el
    // árbol de carpetas es la mitad del diseño de la barra— y con todo en la
    // raíz la captura mentía sobre cómo se ve la app en uso.
    ListConnections: [
        {id: 'c1', name: 'SGCPRO · producción', dbType: 'oracle', host: 'ora-prod.energuate.local', port: 1521, database: 'SGCPRO', username: 'app_sgc', folderId: 'f-prod', sortOrder: 0, environment: 'prod', color: '#ef5350', metadataSchemas: ['SGCPRO']},
        {id: 'c2', name: 'SGCPRO · réplica lectura', dbType: 'oracle', host: 'ora-ro.energuate.local', port: 1521, database: 'SGCPRO', username: 'lector', folderId: 'f-prod', sortOrder: 1, environment: 'prod', metadataSchemas: ['SGCPRO']},
        {id: 'c3', name: 'Redis · sesiones', dbType: 'redis', host: 'redis-prod.energuate.local', port: 6379, database: '0', username: '', folderId: 'f-prod', sortOrder: 2, environment: 'prod', metadataSchemas: []},
        {id: 'c4', name: 'SGCTEST', dbType: 'oracle', host: 'ora-qa.energuate.local', port: 1521, database: 'SGCTEST', username: 'app_sgc', folderId: 'f-qa', sortOrder: 0, environment: 'staging', metadataSchemas: ['SGCPRO']},
        {id: 'c5', name: 'chatwoot · staging', dbType: 'postgres', host: 'pg-qa.energuate.local', port: 5432, database: 'chatwoot', username: 'chatwoot', folderId: 'f-qa', sortOrder: 1, environment: 'staging', metadataSchemas: ['public']},
        {id: 'c6', name: 'eventos', dbType: 'mongodb', host: 'mongo-qa.energuate.local', port: 27017, database: 'events', username: 'app', folderId: 'f-qa', sortOrder: 2, environment: 'staging', metadataSchemas: []},
        {id: 'c7', name: 'chatwoot local', dbType: 'postgres', host: 'localhost', port: 5432, database: 'chatwoot_dev', username: 'dev', folderId: '', sortOrder: 3, environment: 'dev', metadataSchemas: ['public']},
        {id: 'c8', name: 'vault.db', dbType: 'sqlite', host: '', port: 0, database: '~/Library/Application Support/mini-tools/vault.db', username: '', folderId: '', sortOrder: 4, environment: 'dev', metadataSchemas: []},
        {id: 's1', name: 'app-01 · producción', dbType: 'ssh', host: 'app01.energuate.local', port: 22, database: '', username: 'deploy', folderId: 'f-ssh-prod', sortOrder: 0, environment: 'prod', metadataSchemas: []},
        {id: 's2', name: 'app-02 · producción', dbType: 'ssh', host: 'app02.energuate.local', port: 22, database: '', username: 'deploy', folderId: 'f-ssh-prod', sortOrder: 1, environment: 'prod', metadataSchemas: []},
        {id: 's3', name: 'batch-nocturno', dbType: 'ssh', host: 'batch.energuate.local', port: 22, database: '', username: 'sgc', folderId: 'f-ssh-prod', sortOrder: 2, environment: 'prod', metadataSchemas: []},
        {id: 's4', name: 'qa-app', dbType: 'ssh', host: 'qa.energuate.local', port: 22, database: '', username: 'deploy', folderId: '', sortOrder: 3, environment: 'staging', metadataSchemas: []},
    ],
    // Un árbol por scope: los cuatro módulos comparten la tabla `folders` pero
    // nunca las mismas carpetas (backend/vault/folders_repo.go).
    // Snippets: la misma lista para las terminales SSH y para las locales — es
    // global, lo único atado a la pestaña es a qué sesión se le mandan.
    // Con qué entorno está marcada la conexión de la terminal. La fila de la
    // terminal lo dibuja como un punto de color (ver SshTerminalTab): sin este
    // mock la promesa falla y la captura sale sin la marca, que es justo lo que
    // hay que poder revisar.
    ConnectionEnvironment: 'staging',
    ListSshSnippets: [
        {id: 's1', name: 'Ver logs del día', script: 'tail -f /var/log/app/$(date +%F).log', folderId: '', sortOrder: 0},
        {id: 's2', name: 'Espacio en disco', script: 'df -h | sort -k5 -r | head', folderId: '', sortOrder: 1},
        {id: 's3', name: 'Puertos escuchando', script: 'ss -ltnp', folderId: '', sortOrder: 2},
    ],
    ListFolders: [
        {id: 'f-prod', name: 'Producción', parentId: '', sortOrder: 0, createdAt: 0, scope: 'db'},
        {id: 'f-qa', name: 'Pruebas', parentId: '', sortOrder: 1, createdAt: 0, scope: 'db'},
        {id: 'f-ssh-prod', name: 'Producción', parentId: '', sortOrder: 0, createdAt: 0, scope: 'ssh'},
        {id: 'f-git-trabajo', name: 'Trabajo', parentId: '', sortOrder: 0, createdAt: 0, scope: 'git'},
        {id: 'f-notes-runbooks', name: 'Runbooks', parentId: '', sortOrder: 0, createdAt: 0, scope: 'note'},
        {id: 'f-notes-guardia', name: 'Guardia', parentId: '', sortOrder: 1, createdAt: 0, scope: 'note'},
    ],
    GitListRepos: [
        {id: 'r1', name: 'chatwoot-clone', path: '/repos/chatwoot-clone', folderId: 'f-git-trabajo', sortOrder: 0, createdAt: 0, pinnedBranches: gitSidebarShot ? ['develop', 'feature/vault-notes'] : []},
        {id: 'r2', name: 'ISGL_WEB', path: '/repos/ISGL_WEB', folderId: 'f-git-trabajo', sortOrder: 1, createdAt: 0, pinnedBranches: []},
        {id: 'r3', name: 'ISGL_BATCH', path: '/repos/ISGL_BATCH', folderId: 'f-git-trabajo', sortOrder: 2, createdAt: 0, pinnedBranches: []},
        {id: 'r4', name: 'mini-tools', path: '/repos/mini-tools', folderId: '', sortOrder: 3, createdAt: 0, pinnedBranches: []},
        {id: 'r5', name: 'support-lab', path: '/repos/support-lab', folderId: '', sortOrder: 4, createdAt: 0, pinnedBranches: []},
    ],
    ListRecentFiles: [],
    ListSchemas: ['SGCPRO', 'PUBLIC'],
    // Catálogo del esquema, para poder fotografiar el ÁRBOL con contenido.
    //
    // Estuvo vacío mientras ninguna vista lo desplegaba, y la captura del árbol
    // de esquema de la documentación seguía siendo una foto vieja de la app
    // real —con la barra lateral de antes del menú master—. Con esto la vista
    // `schematree` la genera como el resto.
    //
    // Los nombres son de un sistema de facturación inventado: hace falta que
    // se parezcan a un catálogo real (nombres largos, prefijos, mezcla de
    // tablas y PL/SQL) para que la captura muestre cómo se ve de verdad, y que
    // no sean de nadie.
    GetSchemaMetadata: {
        tables: [
            {schema: 'SGCPRO', name: 'FACTURAS', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'FACTURA_DETALLE', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'CLIENTES', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'CLIENTE_DIRECCION', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'LECTURAS', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'MEDIDORES', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'PAGOS', columns: [], foreignKeys: []},
            {schema: 'SGCPRO', name: 'TARIFAS', columns: [], foreignKeys: []},
        ],
        procedures: [
            {schema: 'SGCPRO', name: 'PR_FACT_ACTUALIZAR', oid: 1},
            {schema: 'SGCPRO', name: 'PR_FACT_ANULAR', oid: 2},
            {schema: 'SGCPRO', name: 'PR_LECTURA_CARGAR', oid: 3},
        ],
        functions: [
            {schema: 'SGCPRO', name: 'F_DUPLICADO_FACTURA', oid: 4},
            {schema: 'SGCPRO', name: 'F_SALDO_CLIENTE', oid: 5},
        ],
        triggers: [
            {schema: 'SGCPRO', name: 'TRG_FACTURAS_AUDIT', oid: 6},
            {schema: 'SGCPRO', name: 'TRG_PAGOS_SALDO', oid: 7},
        ],
        packages: [{schema: 'SGCPRO', name: 'PKG_FACTURACION', oid: 8}],
    },
    // --- Notas (base de conocimiento cifrada) -----------------------------
    //
    // El texto es un runbook creíble y sin datos de nadie: lo que hay que
    // fotografiar es cómo se ve el Markdown formateado mientras se escribe,
    // los enlaces entre notas y el panel lateral.
    GetNote: {
        id: 'n1',
        title: 'Runbook · caída del pool de conexiones',
        content: [
            '# Síntoma',
            '',
            'La API responde 502 y el log del servicio repite `ORA-12519` cada pocos',
            'segundos. Ver [[Inventario de entornos]] para saber a qué host mirar.',
            '',
            '> [!WARNING]',
            '> Antes de reiniciar nada, sacá el estado del pool: reiniciar borra la',
            '> evidencia y el problema vuelve a la hora.',
            '',
            '## 1. Confirmar que el pool está lleno',
            '',
            '```sql connection="SGCPRO"',
            'SELECT resource_name, current_utilization, max_utilization, limit_value',
            'FROM v$resource_limit',
            "WHERE resource_name IN ('processes', 'sessions');",
            '```',
            '',
            '## 2. Quién las tiene tomadas',
            '',
            'Si `current_utilization` está pegado al límite, casi siempre es **una sola',
            'aplicación** que no devuelve las conexiones. El detalle en',
            '[[Procedimiento de sesiones colgadas]].',
            '',
            '## 3. Umbrales',
            '',
            '| Recurso | Límite | Alerta |',
            '|---|---:|:---:|',
            '| processes | 1500 | 90% |',
            '| sessions | 1800 | 90% |',
            '| open_cursors | 300 | 85% |',
            '',
            '## 4. Antes de cerrar',
            '',
            '- [x] Guardar el estado del pool',
            '- [ ] Identificar la app que no devuelve conexiones',
            '  - [ ] Revisar el timeout del datasource',
            '- [ ] Reiniciar ~~el server~~ solo el servicio',
            '',
            '1. Confirmar',
            '2. Aislar',
            '3. Reiniciar',
            '',
            '<details>',
            '<summary>Detalle del parámetro `processes`</summary>',
            '',
            'Subirlo obliga a reiniciar la instancia: no es dinámico.',
            '',
            '</details>',
            '',
            '#produccion #oracle',
        ].join('\n'),
        frontmatter: '',
        isPrivate: false,
        corrupt: false,
        folderId: '',
        createdAt: 1786400000,
        updatedAt: 1786741440,
    },
    NoteLinks: [
        {targetHash: 'h1', targetId: 'n2', title: 'Inventario de entornos', isPrivate: false},
        {targetHash: 'h2', targetId: 'n3', title: 'Procedimiento de sesiones colgadas', isPrivate: false},
    ],
    NoteBacklinks: [{targetHash: 'h9', targetId: 'n4', title: 'Guardia · qué mirar primero', isPrivate: false}],
    NoteStatsFor: {backlinks: 1, words: 128, chars: 812},
    NoteTitles: [
        {id: 'n2', title: 'Inventario de entornos', isPrivate: false},
        {id: 'n3', title: 'Procedimiento de sesiones colgadas', isPrivate: false},
        {id: 'n4', title: 'Guardia · qué mirar primero', isPrivate: false},
        {id: 'n5', title: 'Credenciales de laboratorio', isPrivate: true},
    ],
    NoteTags: [
        {tag: '#produccion', count: 6},
        {tag: '#oracle', count: 4},
    ],
    NotesGraph: {
        nodes: [
            {id: 'n1', title: 'Runbook · caída del pool de conexiones', isPrivate: false, degree: 3},
            {id: 'n2', title: 'Inventario de entornos', isPrivate: false, degree: 2},
            {id: 'n3', title: 'Procedimiento de sesiones colgadas', isPrivate: false, degree: 2},
            {id: 'n4', title: 'Guardia · qué mirar primero', isPrivate: false, degree: 2},
            {id: 'n5', title: 'Credenciales de laboratorio', isPrivate: true, degree: 1},
            {id: 'n6', title: 'Postmortem 2026-07-30', isPrivate: false, degree: 1},
        ],
        edges: [
            {source: 'n4', target: 'n1'},
            {source: 'n1', target: 'n2'},
            {source: 'n1', target: 'n3'},
            {source: 'n3', target: 'n2'},
            {source: 'n6', target: 'n1'},
            {source: 'n4', target: 'n5'},
        ],
        brokenLinks: 2,
        selfLinks: 0,
    },
    SearchNotesSmart: [
        {id: 'n1', title: 'Runbook · caída del pool de conexiones', isPrivate: false, updatedAt: 1786650000, score: 1, snippet: '', matchedTitle: true, folderId: 'f-notes-runbooks', pinned: true},
        {id: 'n3', title: 'Procedimiento de sesiones colgadas', isPrivate: false, updatedAt: 1786480000, score: 1, snippet: '', matchedTitle: true, folderId: 'f-notes-runbooks'},
        {id: 'n6', title: 'Postmortem 2026-07-30', isPrivate: false, updatedAt: 1786390000, score: 1, snippet: '', matchedTitle: true, folderId: 'f-notes-runbooks'},
        {id: 'n4', title: 'Guardia · qué mirar primero', isPrivate: false, updatedAt: 1786300000, score: 1, snippet: '', matchedTitle: true, folderId: 'f-notes-guardia'},
        {id: 'n5', title: 'Credenciales de laboratorio', isPrivate: true, updatedAt: 1786200000, score: 1, snippet: '', matchedTitle: true, folderId: 'f-notes-guardia'},
        {id: 'n2', title: 'Inventario de entornos', isPrivate: false, updatedAt: 1786100000, score: 1, snippet: '', matchedTitle: true, folderId: ''},
    ],

    // --- Grilla editable ---------------------------------------------------
    ResultEditTarget: {
        editable: true,
        table: '"public"."contacts"',
        keyCols: ['id'],
        reason: '',
        columns: [
            {name: 'id', dataType: 'int4', nullable: false, isKey: true, kind: 'number', editable: false},
            {name: 'name', dataType: 'varchar', nullable: true, isKey: false, kind: 'text', editable: true},
            {name: 'email', dataType: 'varchar', nullable: true, isKey: false, kind: 'text', editable: true},
            {name: 'phone_number', dataType: 'varchar', nullable: true, isKey: false, kind: 'text', editable: true},
            {name: 'account_id', dataType: 'int8', nullable: true, isKey: false, kind: 'number', editable: true},
            {name: 'created_at', dataType: 'timestamp', nullable: true, isKey: false, kind: 'datetime', editable: true},
        ],
    },
    PreviewRowEdits: [`UPDATE "public"."contacts" SET "name" = 'white-sound-2467' WHERE "id" = 4`],

    // --- Consumo global (el botón del chat) --------------------------------
    AgentUsageAll: {
        days: 30,
        agents: [
            {agent: 'claude', available: true, note: '', source: '', all: {input: 37210, output: 8646915, cacheWrite: 60985113, cacheRead: 3604530546, total: 3674199784, messages: 9309}, repo: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0}, firstDay: '2026-07-15', lastDay: '2026-08-14', byModel: [{key: 'claude-opus-5', total: 2055073573, percent: 60.1, messages: 5119}, {key: 'claude-opus-4-8', total: 834401643, percent: 21.5, messages: 1789}, {key: 'claude-haiku-4-5', total: 384744568, percent: 18.4, messages: 2401}], byDay: [], cacheHitPercent: 98.4, activity: null},
            {agent: 'codex', available: true, note: '', source: '', all: {input: 412300, output: 1204880, cacheWrite: 0, cacheRead: 8221400, total: 9838580, messages: 412}, repo: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0}, firstDay: '2026-07-28', lastDay: '2026-08-15', byModel: [{key: 'gpt-5-codex', total: 9838580, percent: 100, messages: 412}], byDay: [], cacheHitPercent: 83.5, activity: null},
            {agent: 'antigravity', available: false, note: 'El CLI no deja los tokens en disco: se muestra la actividad registrada.', source: '~/.gemini', all: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0}, repo: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0}, firstDay: '', lastDay: '', byModel: [], byDay: [], cacheHitPercent: 0, activity: {conversations: 34, steps: 291, repoConversations: 0, repoSteps: 0, lastUsed: 'hace 2 h'}},
        ],
    },

    // --- Consumo de los servidores de modelos (panel de consumo) -----------
    // La serie trae TODOS los días de la ventana, con ceros, como el backend.
    ModelServerUsage: (() => {
        const days = 30
        const series = (totals: number[]) =>
            totals.map((total, i) => {
                const d = new Date(Date.UTC(2026, 7, 15 - (days - 1 - i)))
                return {day: d.toISOString().slice(0, 10), total, turns: total > 0 ? Math.max(1, Math.round(total / 5200)) : 0}
            })
        const local = [0, 0, 0, 0, 12400, 38200, 21000, 0, 0, 0, 45100, 80400, 61000, 22300, 0, 0, 0, 0, 30800, 52100, 91700, 120300, 64000, 0, 0, 38900, 70200, 85100, 143000, 96500]
        const remote = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14200, 9800, 0, 31000]
        return {
            days,
            firstDay: '2026-07-17',
            lastDay: '2026-08-15',
            servers: [
                {
                    agentId: 'llm:ms1', name: 'Ollama local', kind: 'ollama', isLocal: true, deleted: false,
                    totals: {input: 812340, output: 163920, total: 976260, turns: 214, conversations: 31},
                    byModel: [
                        {model: 'qwen2.5-coder:14b', totals: {input: 602100, output: 118200, total: 720300, turns: 150, conversations: 22}, percent: 73.8, tokensPerSec: 38.4},
                        {model: 'llama3.1:8b', totals: {input: 190240, output: 40120, total: 230360, turns: 58, conversations: 11}, percent: 23.6, tokensPerSec: 61.2},
                        {model: '', totals: {input: 20000, output: 5600, total: 25600, turns: 6, conversations: 3}, percent: 2.6, tokensPerSec: 0},
                    ],
                    byDay: series(local), tokensPerSec: 43.7, lastUsedAt: 1786798800,
                },
                {
                    agentId: 'llm:ms2', name: 'vLLM en el servidor GPU', kind: 'openai', isLocal: false, deleted: false,
                    totals: {input: 41200, output: 13800, total: 55000, turns: 9, conversations: 3},
                    byModel: [{model: 'Qwen/Qwen2.5-72B-Instruct', totals: {input: 41200, output: 13800, total: 55000, turns: 9, conversations: 3}, percent: 100, tokensPerSec: 22.1}],
                    byDay: series(remote), tokensPerSec: 22.1, lastUsedAt: 1786780800,
                },
                {
                    agentId: 'llm:mc2', name: 'Anthropic', kind: 'anthropic', isLocal: false, deleted: false,
                    totals: {input: 318400, output: 96200, total: 414600, turns: 87, conversations: 14},
                    byModel: [
                        {model: 'claude-opus-5-5', totals: {input: 201300, output: 71400, total: 272700, turns: 49, conversations: 9}, percent: 65.8, tokensPerSec: 54.2},
                        {model: 'claude-haiku-4-5', totals: {input: 117100, output: 24800, total: 141900, turns: 38, conversations: 8}, percent: 34.2, tokensPerSec: 142.6},
                    ],
                    byDay: series(remote.map((n, i) => (i % 3 === 0 ? n * 4 + 9000 : i % 5 === 0 ? 21000 : 0))), tokensPerSec: 71.3, lastUsedAt: 1786798800,
                },
                {
                    agentId: 'llm:mc1', name: 'OpenRouter', kind: 'openai', isLocal: false, deleted: false,
                    totals: {input: 22100, output: 6900, total: 29000, turns: 6, conversations: 2},
                    byModel: [{model: 'anthropic/claude-sonnet-4.5', totals: {input: 22100, output: 6900, total: 29000, turns: 6, conversations: 2}, percent: 100, tokensPerSec: 0}],
                    byDay: series(remote.map((n) => (n > 0 ? 5800 : 0))), tokensPerSec: 0, lastUsedAt: 1786780800,
                },
                {
                    agentId: 'llm:viejo', name: 'Servidor eliminado (viejo)', kind: '', isLocal: false, deleted: true,
                    totals: {input: 3100, output: 900, total: 4000, turns: 2, conversations: 1},
                    byModel: [{model: 'mistral', totals: {input: 3100, output: 900, total: 4000, turns: 2, conversations: 1}, percent: 100, tokensPerSec: 0}],
                    byDay: series(Array.from({length: days}, (_, i) => (i === 3 ? 4000 : 0))), tokensPerSec: 0, lastUsedAt: 1785000000,
                },
                {
                    agentId: 'llm:ms3', name: 'LM Studio del laboratorio', kind: 'openai', isLocal: false, deleted: false,
                    totals: {input: 0, output: 0, total: 0, turns: 0, conversations: 0},
                    byModel: [], byDay: series(Array.from({length: days}, () => 0)), tokensPerSec: 0, lastUsedAt: 0,
                },
            ],
        }
    })(),

    // --- Servidor MCP ------------------------------------------------------
    MCPServerStatus: {
        enabled: true,
        socketPath: '/Users/tu-usuario/Library/Application Support/mini-tools/mcp.sock',
        tools: 9,
        notesWrite: true,
        executable: '/Applications/mini-tools.app/Contents/MacOS/mini-tools',
        audit: [
            {tool: 'vault_update_note', resource: 'Diagnóstico · pool lleno el 18/08', denied: false, at: 1786741450},
            {tool: 'vault_create_note', resource: 'Diagnóstico · pool lleno el 18/08', denied: false, at: 1786741420},
            {tool: 'vault_search_notes', resource: 'pool de conexiones', denied: false, at: 1786741380},
            {tool: 'db_get_schema', resource: 'SGCPRO.FACTURAS', denied: false, at: 1786741260},
            {tool: 'vault_read_note', resource: 'Credenciales de laboratorio', denied: true, at: 1786741100},
            {tool: 'ssh_get_recent_logs', resource: 'sgc-app-01', denied: false, at: 1786740980},
        ],
    },

    // --- Explorador SFTP -------------------------------------------------------
    //
    // Un directorio real de un servidor de aplicaciones: carpetas de compilación
    // y algún archivo suelto, que es lo que hace reconocible la captura. Las dos
    // sesiones ('local' y la del panel derecho) devuelven listados distintos —
    // un explorador de doble panel con lo mismo a los dos lados no muestra nada.
    OpenSftpBrowse: '/export/env/sgc/DCORA19/exec/funcn/lib',
    SftpHomeDir: (sessionID: string) => (sessionID === 'local' ? '/Users/rafael' : '/export/env/sgc/DCORA19/exec/funcn/lib'),
    CloseSftpBrowse: null,
    SSHCwd: '',
    CheckSftpConflicts: [],
    ListSftpDir: (sessionID: string) =>
        sessionID === 'local'
            ? [
                  {name: 'Descargas', path: '/Users/rafael/Descargas', size: 0, isDir: true, mode: 'drwxr-xr-x', modTime: 1786741000},
                  {name: 'Documentos', path: '/Users/rafael/Documentos', size: 0, isDir: true, mode: 'drwxr-xr-x', modTime: 1786700000},
                  {name: 'Escritorio', path: '/Users/rafael/Escritorio', size: 0, isDir: true, mode: 'drwxr-xr-x', modTime: 1786600000},
                  {name: 'proyectos', path: '/Users/rafael/proyectos', size: 0, isDir: true, mode: 'drwxr-xr-x', modTime: 1786500000},
                  {name: 'parche-tarifas.sql', path: '/Users/rafael/parche-tarifas.sql', size: 8452, isDir: false, mode: '-rw-r--r--', modTime: 1786740000},
                  {name: 'notas-guardia.md', path: '/Users/rafael/notas-guardia.md', size: 2210, isDir: false, mode: '-rw-r--r--', modTime: 1786730000},
              ]
            : [
                  {name: 'bin', path: '/export/env/sgc/DCORA19/exec/funcn/lib/bin', size: 0, isDir: true, mode: 'drwxrwxrwx', modTime: 1786741000},
                  {name: 'lib', path: '/export/env/sgc/DCORA19/exec/funcn/lib/lib', size: 0, isDir: true, mode: 'drwxrwxrwx', modTime: 1786741000},
                  {name: 'obj64', path: '/export/env/sgc/DCORA19/exec/funcn/lib/obj64', size: 0, isDir: true, mode: 'drwxrwxrw-', modTime: 1786740000},
                  {name: 'obj32', path: '/export/env/sgc/DCORA19/exec/funcn/lib/obj32', size: 0, isDir: true, mode: 'drwxrwxrw-', modTime: 1610000000},
                  {name: 'scripts', path: '/export/env/sgc/DCORA19/exec/funcn/lib/scripts', size: 0, isDir: true, mode: 'drwxrwxrwx', modTime: 1550000000},
                  {name: 'rutinas.c', path: '/export/env/sgc/DCORA19/exec/funcn/lib/rutinas.c', size: 412880, isDir: false, mode: '-rw-r--r--', modTime: 1786600000},
                  {name: 'rutinas.h', path: '/export/env/sgc/DCORA19/exec/funcn/lib/rutinas.h', size: 18340, isDir: false, mode: '-rw-r--r--', modTime: 1786600000},
                  {name: 'ref400.pc', path: '/export/env/sgc/DCORA19/exec/funcn/lib/ref400.pc', size: 268112, isDir: false, mode: '-rw-r--r--', modTime: 1786500000},
                  {name: 'compilar.sh', path: '/export/env/sgc/DCORA19/exec/funcn/lib/compilar.sh', size: 1904, isDir: false, mode: '-rwxr-xr-x', modTime: 1786400000},
              ],

    // --- Módulo HTTP (colecciones estilo Postman) -----------------------------
    //
    // Una colección con la forma que tiene una de verdad: una carpeta de
    // autenticación, peticiones con método variado, y una respuesta ya recibida
    // para que se vea el panel entero y no un editor vacío.
    HttpListCollections: [
        {id: 'c1', name: 'Reserve v3', description: 'API de reservas del portal', sortOrder: 0, createdAt: 1786600000, updatedAt: 1786741000},
        {id: 'c2', name: 'Facturación', description: '', sortOrder: 1, createdAt: 1786500000, updatedAt: 1786700000},
    ],
    HttpListItems: (collectionID: string) =>
        collectionID !== 'c1'
            ? []
            : [
                  {id: 'f1', collectionId: 'c1', kind: 'folder', name: 'Autenticación', sortOrder: 0, createdAt: 0, updatedAt: 0},
                  {id: 'i1', collectionId: 'c1', parentId: 'f1', kind: 'request', name: 'login', method: 'POST', url: '{{baseUrl}}/auth/login', sortOrder: 0, createdAt: 0, updatedAt: 0},
                  {id: 'i2', collectionId: 'c1', parentId: 'f1', kind: 'request', name: 'refresh', method: 'POST', url: '{{baseUrl}}/auth/refresh', sortOrder: 1, createdAt: 0, updatedAt: 0},
                  {id: 'i3', collectionId: 'c1', kind: 'request', name: 'listar reservas', method: 'GET', url: '{{baseUrl}}/reservas', sortOrder: 1, createdAt: 0, updatedAt: 0},
                  {id: 'i4', collectionId: 'c1', kind: 'request', name: 'crear reserva', method: 'POST', url: '{{baseUrl}}/reservas', sortOrder: 2, createdAt: 0, updatedAt: 0},
                  {id: 'i5', collectionId: 'c1', kind: 'request', name: 'anular reserva', method: 'DELETE', url: '{{baseUrl}}/reservas/:id', sortOrder: 3, createdAt: 0, updatedAt: 0},
              ],
    HttpGetItem: {
        id: 'i4',
        collectionId: 'c1',
        kind: 'request',
        name: 'crear reserva',
        method: 'POST',
        url: '{{baseUrl}}/reservas',
        headers: JSON.stringify([
            {key: 'Content-Type', value: 'application/json', enabled: true},
            {key: 'X-Tenant', value: '{{tenant}}', enabled: true, description: 'Portal desde el que entra la reserva'},
        ]),
        params: JSON.stringify([{key: 'notificar', value: 'true', enabled: true, description: 'Manda el correo de confirmación'}]),
        body: JSON.stringify({
            mode: 'raw',
            rawLang: 'json',
            raw: '{\n  "cliente": 4821,\n  "servicio": "SUM-2",\n  "desde": "2026-09-01",\n  "hasta": "2026-09-04",\n  "personas": 2\n}',
        }),
        docs: 'Crea una reserva y devuelve su identificador.\n\nHay que llamar antes a [[login]] para tener sesión.',
        createdAt: 1786600000,
        updatedAt: 1786741000,
    },
    HttpBuildRequest: {
        method: 'POST',
        url: '{{baseUrl}}/reservas',
        settings: {timeoutMs: 60000, verifyTls: true, followRedirects: true, maxRedirects: 10, httpVersion: 'auto', maxBodyBytes: 8388608},
    },
    HttpDefaultSettings: {timeoutMs: 60000, verifyTls: true, followRedirects: true, maxRedirects: 10, httpVersion: 'auto', maxBodyBytes: 8388608},
    HttpListEnvironments: [
        {id: 'e1', name: 'desarrollo', sortOrder: 0, createdAt: 0, updatedAt: 0},
        {id: 'e2', name: 'producción', sortOrder: 1, createdAt: 0, updatedAt: 0},
    ],
    HttpActiveEnvironment: 'e1',
    HttpAuthPreview: {type: 'bearer', executable: true, needsToken: false},
    HttpResolvePreview: {sentUrl: 'https://api.desarrollo.local/reservas?notificar=true', missing: []},
    HttpHistory: [
        {id: 'h1', itemId: 'i4', method: 'POST', url: 'https://api.desarrollo.local/reservas?notificar=true', status: 201, durationMs: 212, sizeBytes: 148, executedAt: 1786741000},
        {id: 'h2', itemId: 'i4', method: 'POST', url: 'https://api.desarrollo.local/reservas?notificar=true', status: 422, durationMs: 189, sizeBytes: 96, executedAt: 1786740800},
    ],
    // La respuesta que deja el panel lleno: sin esto la captura muestra
    // "todavía no enviaste esta petición", que no es lo que hay que enseñar.
    HttpSend: {
        sentUrl: 'https://api.desarrollo.local/reservas?notificar=true',
        missing: [],
        computedErrors: [],
        durationMs: 212,
        response: {
            status: 201,
            statusText: 'Created',
            durationMs: 212,
            sizeBytes: 214,
            lang: 'json',
            contentType: 'application/json',
            isBinary: false,
            truncated: false,
            redirects: 0,
            finalUrl: 'https://api.desarrollo.local/reservas?notificar=true',
            headers: [
                {key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true},
                {key: 'Location', value: '/reservas/90412', enabled: true},
                {key: 'X-Request-Id', value: '7c1f0a9e-52b1-4a0e', enabled: true},
            ],
            body: '{\n  "id": 90412,\n  "estado": "confirmada",\n  "cliente": 4821,\n  "servicio": "SUM-2",\n  "desde": "2026-09-01",\n  "hasta": "2026-09-04",\n  "total": 1840.5,\n  "moneda": "GTQ"\n}',
        },
    },
    HttpCodeLanguages: [
        {id: 'curl', label: 'cURL'},
        {id: 'go', label: 'Go'},
        {id: 'python', label: 'Python'},
    ],

    // --- Reflog de Git --------------------------------------------------------
    //
    // La secuencia que uno viene a mirar cuando algo se perdió: un reset que
    // dejó un commit sin referencia, y arriba el cambio de rama posterior.
    GitReflog: [
        {selector: 'HEAD@{0}', hash: '76d857500000000000000000000000000000000a', short: '76d8575', action: 'checkout', detail: 'moving from main to develop', subject: 'Add macOS and Windows binaries for v1.3.1', author: 'rafael', date: '2026-08-20T16:10:20-06:00'},
        {selector: 'HEAD@{1}', hash: '76d857500000000000000000000000000000000a', short: '76d8575', action: 'reset', detail: 'moving to HEAD~1', subject: 'Add macOS and Windows binaries for v1.3.1', author: 'rafael', date: '2026-08-20T16:04:11-06:00'},
        {selector: 'HEAD@{2}', hash: 'ab8d4d600000000000000000000000000000000b', short: 'ab8d4d6', action: 'commit', detail: '', subject: 'feat: variables calculadas para firmar una petición', author: 'rafael', date: '2026-08-20T15:58:02-06:00'},
        {selector: 'HEAD@{3}', hash: '7334bc100000000000000000000000000000000c', short: '7334bc1', action: 'rebase', detail: '(finish): returning to refs/heads/develop', subject: 'feat: add agent chat functionalities and models', author: 'rafael', date: '2026-08-20T15:31:44-06:00'},
        {selector: 'HEAD@{4}', hash: '74e152500000000000000000000000000000000d', short: '74e1525', action: 'merge', detail: 'main: Fast-forward', subject: 'feat: confirmación antes de sentencias destructivas', author: 'rafael', date: '2026-08-19T20:47:36-06:00'},
        {selector: 'HEAD@{5}', hash: '3230ced00000000000000000000000000000000e', short: '3230ced', action: 'commit', detail: '', subject: 'feat: revelar contraseñas guardadas en conexiones', author: 'rafael', date: '2026-08-19T20:46:58-06:00'},
    ],

    // --- Notas: la tabla de una carpeta --------------------------------------
    ListNotes: [
        {id: 'n1', title: 'Runbook · reinicio del portal', isPrivate: false, updatedAt: 1786741000, createdAt: 1786100000, linkCount: 4, folderId: 'f-notes-runbooks'},
        {id: 'n2', title: 'Diagnóstico · pool lleno el 18/08', isPrivate: false, updatedAt: 1786700000, createdAt: 1786620000, linkCount: 2, folderId: 'f-notes-runbooks'},
        {id: 'n3', title: 'Credenciales de laboratorio', isPrivate: true, updatedAt: 1786400000, createdAt: 1785900000, linkCount: 0, folderId: 'f-notes-runbooks'},
        {id: 'n4', title: 'Migración de tarifas M1G/M2G', isPrivate: false, updatedAt: 1786300000, createdAt: 1785700000, linkCount: 6, folderId: 'f-notes-guardia'},
        {id: 'n5', title: 'Checklist de pase a producción', isPrivate: false, updatedAt: 1786200000, createdAt: 1785600000, linkCount: 3, folderId: 'f-notes-guardia'},
        {id: 'n6', title: 'Notas sueltas', isPrivate: false, updatedAt: 1786000000, createdAt: 1785000000, linkCount: 0, folderId: ''},
    ],

    // --- DDL de una tabla ----------------------------------------------------
    //
    // Largo a propósito: el visor existe para objetos que no entran en una
    // pantalla, y una fixture de diez líneas no muestra si el panel scrollea.
    GetObjectDDL: () =>
        [
            '  CREATE TABLE "DWHPRO"."DXHT_FACTURACION_CONCEPTOS"',
            '   (\t"ID_SERVICIO" NUMBER(7,0) NOT NULL ENABLE,',
            '\t"ID_MES" NUMBER(6,0) NOT NULL ENABLE,',
            '\t"ID_CONTRATO" NUMBER(3,0) NOT NULL ENABLE,',
            '\t"ID_FACTURA" NUMBER(1,0) NOT NULL ENABLE,',
            '\t"TI_OPERACION_FACT" VARCHAR2(1) NOT NULL ENABLE,',
            '\t"CC_OCURRENCIAS" NUMBER(3,0) NOT NULL ENABLE,',
            '\t"FE_FACTURA" DATE NOT NULL ENABLE,',
            '\t"FE_PROCESO" DATE NOT NULL ENABLE,',
            '\t"IN_DEFINIDO" VARCHAR2(1) NOT NULL ENABLE,',
            '\t"SG_FACTURACION" NUMBER(1,0) NOT NULL ENABLE,',
            ...Array.from({length: 10}, (_, i) => `\t"IM_VARIABLE_${String(i + 1).padStart(2, '0')}" NUMBER(13,2) NOT NULL ENABLE,`),
            '\t"FH_CARGA" DATE NOT NULL ENABLE,',
            '\t"ID_RANGO_KWH" NUMBER(4,0),',
            '\t"TEXTO_01" VARCHAR2(20),',
            '\t"TEXTO_02" VARCHAR2(20),',
            '\t"TI_ESTIMACION" VARCHAR2(5),',
            '\t"CS_POTENCIA_LEIDA" NUMBER(9,0),',
            '\t"CS_POTENCIA_LEIDA_PUNTA" NUMBER(9,0),',
            '\t"CS_POTENCIA_LEIDA_VALLE" NUMBER(9,0),',
            '\t"CS_POTENCIA_LEIDA_LLANO" NUMBER(9,0),',
            '\t"CS_PROMEDIO" NUMBER(9,0),',
            '\t"FE_CONTABLE" DATE,',
            '\t"ES_CONTABLE" VARCHAR2(5),',
            '\t"IM_OTROS_CARGOS_EXENTOS" NUMBER(13,2),',
            '\t"FE_CONTROL" DATE,',
            '\t"ES_ANTERIOR" VARCHAR2(5),',
            '\t"IX_FACTURA" VARCHAR2(86) GENERATED ALWAYS AS (LPAD(TO_CHAR("ID_SERVICIO"),7,\'0\')||LPAD(TO_CHAR("ID_CONTRATO"),3,\'0\')||TO_CHAR("FE_FACTURA",\'YYYYMMDD\')||LPAD(TO_CHAR("ID_FACTURA"),1,\'0\')) VIRTUAL ,',
            '\t"CS_REACTIVA" NUMBER(9,0),',
            '\t"FE_FACTURA_ORIGINAL" DATE,',
            '\t CONSTRAINT "PK_DXHT_FACTURACION_CONCEPTOS" PRIMARY KEY ("ID_SERVICIO", "ID_MES", "ID_FACTURA", "TI_OPERACION_FACT")',
            '  USING INDEX PCTFREE 10 INITRANS 2 MAXTRANS 255 COMPUTE STATISTICS',
            '  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645',
            '  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1',
            '  BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)',
            '  TABLESPACE "DATOS4_IND"  ENABLE',
            '   ) SEGMENT CREATION IMMEDIATE',
            '  PCTFREE 10 PCTUSED 40 INITRANS 1 MAXTRANS 255',
            ' NOCOMPRESS LOGGING',
            '  STORAGE(INITIAL 65536 NEXT 1048576 MINEXTENTS 1 MAXEXTENTS 2147483645',
            '  PCTINCREASE 0 FREELISTS 1 FREELIST GROUPS 1',
            '  BUFFER_POOL DEFAULT FLASH_CACHE DEFAULT CELL_FLASH_CACHE DEFAULT)',
            '  TABLESPACE "DATOS1" ',
        ].join('\n'),
}

// Conexiones con un pool abierto: sin esto el árbol de Conexiones nunca
// muestra el punto verde ni el botón de desconectar, que son parte de la fila.
fixtures.ActiveConnectionIds = ['c1', 'c7']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyWindow = window as any
anyWindow.go = {
    main: {
        App: new Proxy(
            {},
            {
                get:
                    (_t, name: string) =>
                    (...args: unknown[]) => {
                        const fx = fixtures[name]
                        // Una fixture puede ser función cuando la respuesta
                        // depende del argumento —el caso de los listados por
                        // agente, donde devolver siempre lo mismo duplicaría
                        // cada fila en la pantalla que se quiere fotografiar.
                        return Promise.resolve(typeof fx === 'function' ? fx(...args) : (fx ?? null))
                    },
            },
        ),
    },
}
// El envoltorio generado (`wailsjs/runtime/runtime.js`) no llama a `EventsOn`
// directo sino a `EventsOnMultiple`: simular solo el primero deja el panel en
// blanco con un TypeError. Se cubren los que ese envoltorio usa de verdad.
// Salida enlatada de una terminal, por nombre de evento.
//
// El widget de terminal (xterm.js) no dibuja nada por su cuenta: escribe lo que
// le llega por el evento de Wails cuyo nombre ES el id de la sesión (ver
// SshTerminalTab y LocalTerminalPanel). Con EventsOn devolviendo un no-op, una
// captura de una terminal salía siempre en negro — que es el motivo por el que
// la de la documentación seguía siendo una foto vieja de la app real, con la
// barra lateral de hace tres versiones.
//
// Se entrega en el siguiente tick y no en el mismo: el componente se suscribe
// ANTES de abrir la sesión, pero xterm todavía no midió el contenedor, y
// escribirle antes de eso deja el texto cortado a la mitad de una columna.
const TERMINAL_OUTPUT: Record<string, string> = {
    'ssh-shot': [
        'Last login: Mon Aug 25 09:12:04 2026 from 192.168.10.24',
        '',
        '\u001b[1;32mdeploy@build19\u001b[0m:\u001b[1;34m~\u001b[0m$ systemctl status facturacion-api --no-pager',
        '\u001b[1;32m●\u001b[0m facturacion-api.service - API de facturación',
        '     Loaded: loaded (/etc/systemd/system/facturacion-api.service; enabled)',
        '     Active: \u001b[1;32mactive (running)\u001b[0m since Mon 2026-08-25 08:41:17 -06; 31min ago',
        '   Main PID: 4812 (facturacion-ap)',
        '      Tasks: 24 (limit: 9451)',
        '     Memory: 186.4M',
        '',
        '\u001b[1;32mdeploy@build19\u001b[0m:\u001b[1;34m~\u001b[0m$ tail -n 4 /var/log/facturacion/api.log',
        '2026-08-25T09:10:58 INFO  pool: 12/40 conexiones en uso',
        '2026-08-25T09:11:12 \u001b[33mWARN\u001b[0m  ORA-12519 reintentando en 2s (intento 1/5)',
        '2026-08-25T09:11:14 INFO  pool: reconectado',
        '2026-08-25T09:11:40 INFO  factura 88213 emitida en 412ms',
        '',
        '\u001b[1;32mdeploy@build19\u001b[0m:\u001b[1;34m~\u001b[0m$ ',
    ].join('\r\n'),
}

// Logs de ejemplo de un contenedor, con el prefijo de hora que pone
// `docker logs --timestamps` y algún color de terminal.
const DOCKER_LOGS = [
    '2026-10-01T16:50:51.201133000Z \u001b[32mINFO\u001b[0m  servidor escuchando en :8080',
    '2026-10-01T16:50:51.214802000Z INFO  conectado a postgis:5432 (17.2)',
    '2026-10-01T16:50:52.009117000Z INFO  GET /health 200 1.2ms',
    '2026-10-01T16:50:55.440021000Z INFO  GET /v1/pedidos?estado=abierto 200 14ms',
    '2026-10-01T16:50:58.118305000Z WARN  cache miss repetido para repartidor:482 (3 veces)',
    '2026-10-01T16:51:02.337640000Z INFO  POST /v1/pedidos 201 38ms',
    '2026-10-01T16:51:07.552918000Z ERROR no se pudo notificar al repartidor 482: firebase: 401 Unauthorized',
    '2026-10-01T16:51:07.553411000Z INFO  reintento 1/3 en 2s',
    '2026-10-01T16:51:09.601220000Z INFO  notificación enviada a repartidor 482',
    '2026-10-01T16:51:12.004470000Z INFO  GET /health 200 0.9ms',
]

// btoa solo acepta latin-1, y el texto de la terminal lleva acentos: se
// codifica a UTF-8 primero, byte por byte, que es exactamente lo que hace el
// backend antes de mandarlo.
function toBase64(text: string): string {
    let binary = ''
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
    return btoa(binary)
}

// Pregunta de aprobación de una herramienta, para la captura del diálogo con un
// comando de riesgo. Llega por un evento GLOBAL (`agent-approval`), no por el de
// la sesión, así que se entrega cuando el chat ya se abrió y se suscribió.
const uiLang = new URLSearchParams(location.search).get('lang')
const APPROVAL_RISKY = {
    id: 'llm-approve-1',
    tool: 'run_command',
    input: '{"command":"git push --force origin main"}',
    summary: 'git push --force origin main',
    detail:
        uiLang === 'es'
            ? '⚠ Comando de riesgo: push forzado (git push --force)'
            : '⚠ Risky command: force push (git push --force)',
}

anyWindow.runtime = {
    EventsOnMultiple: (name: string, cb: (data: unknown) => void) => {
        // Las vistas aisess* empujan una lista nueva de sesiones a mano (el aviso
        // de «terminó una conversación»): se guardan los suscriptores.
        if (name === 'agent-sessions') {
            ;(anyWindow.__sessionCbs ??= []).push(cb)
            return () => {}
        }
        if (name === 'agent-approval' && new URLSearchParams(location.search).get('view') === 'approvalrisky') {
            setTimeout(() => cb(APPROVAL_RISKY), 2600)
            return () => {}
        }
        if (name.startsWith('docker-logs-')) {
            setTimeout(() => cb({lines: DOCKER_LOGS}), 300)
            return () => {}
        }
        const canned = TERMINAL_OUTPUT[name]
        if (canned) {
            // El evento viaja en base64 porque la shell remota puede emitir
            // bytes que no son UTF-8 (ver sshconn.Event); el mock respeta el
            // mismo contrato, si no el componente decodifica basura.
            setTimeout(() => cb({type: 'data', data: toBase64(canned)}), 300)
        }
        return () => {}
    },
    EventsOn: (name: string, cb: (data: unknown) => void) => anyWindow.runtime.EventsOnMultiple(name, cb),
    EventsOnce: () => () => {},
    EventsOff: () => {},
    EventsOffAll: () => {},
    EventsEmit: () => {},
    BrowserOpenURL: () => {},
    LogPrint: () => {},
    LogError: () => {},
    WindowGetSize: () => ({w: 1280, h: 860}),
    ClipboardSetText: () => Promise.resolve(true),
    // El explorador SFTP registra una zona de drop con el runtime de Wails
    // (`OnFileDrop`), que solo existe dentro de la app real. Sin estos dos el
    // panel entero explota al montarse y la captura sale en blanco.
    OnFileDrop: () => {},
    OnFileDropOff: () => {},
    // La barra de título propia (components/TitleBar.tsx) le pregunta al
    // runtime en qué sistema corre para decidir si dibuja los botones de
    // ventana: macOS conserva sus semáforos y solo se le reserva el hueco,
    // Windows y Linux los dibuja la app. `?platform=` permite fotografiar
    // los dos casos desde una sola máquina, que es exactamente lo que no se
    // puede comprobar a ojo acá.
    Environment: () =>
        Promise.resolve({
            buildType: 'dev',
            platform: new URLSearchParams(location.search).get('platform') || 'darwin',
            arch: 'arm64',
        }),
    WindowIsMaximised: () => Promise.resolve(true),
    WindowMinimise: () => {},
    WindowToggleMaximise: () => {},
    Quit: () => {},
}

// Los componentes se importan DESPUÉS de definir los mocks: el módulo generado
// de Wails resuelve `window.go` al invocarse, pero importar antes deja
// cualquier llamada de módulo sin nada a lo que apuntar.
const {default: GitFileEditor} = await import('./components/git/GitFileEditor')
const {default: GitAgentPanel} = await import('./components/git/GitAgentPanel')
const {default: AgentChat} = await import('./components/agent/AgentChat')
const {default: GitRepoTab} = await import('./components/git/GitRepoTab')
const {default: Workspace} = await import('./components/Workspace')
const {default: RedisBrowserTab} = await import('./components/redis/RedisBrowserTab')
const {default: MongoBrowserTab} = await import('./components/mongo/MongoBrowserTab')
const {default: MongoFindWizard} = await import('./components/mongo/MongoFindWizard')
const {default: NoteEditorTab} = await import('./components/notes/NoteEditorTab')
const {default: NotesGraphView} = await import('./components/notes/NotesGraphView')
const {default: SettingsDialog} = await import('./components/SettingsDialog')
const {DEFAULT_EDITOR_APPEARANCE} = await import('./codemirror/editorAppearance')
const {default: TitleBar} = await import('./components/TitleBar')
const {default: ResultGrid} = await import('./components/results/ResultGrid')
const {default: ExecutionConsole} = await import('./components/results/ExecutionConsole')
const {default: AgentUsagePanel} = await import('./components/agent/AgentUsagePanel')
const {default: AiAccessPanel} = await import('./components/AiAccessPanel')
const {default: LocalTerminalTab} = await import('./components/terminal/LocalTerminalTab')
const {default: PortKillerTab} = await import('./components/utilities/PortKillerTab')
const {default: ActivityMonitorTab} = await import('./components/utilities/ActivityMonitorTab')
const {default: DockerTab} = await import('./components/utilities/DockerTab')
const {default: AiChatTab} = await import('./components/utilities/AiChatTab')
const {default: ModelManagerTab} = await import('./components/utilities/ModelManagerTab')
const {default: HttpTree} = await import('./components/http/HttpTree')
const {default: HttpRequestTab} = await import('./components/http/HttpRequestTab')
const {default: GitReflogPanel} = await import('./components/git/GitReflogPanel')
const {default: GitSettingsDialog} = await import('./components/git/GitSettingsDialog')
const {default: FolderNotesDialog} = await import('./components/notes/FolderNotesDialog')
const {default: SftpTab} = await import('./components/sftp/SftpTab')
const {default: SshTerminalTab} = await import('./components/ssh/SshTerminalTab')
const {default: DDLViewerModal} = await import('./components/DDLViewerModal')

// --- Vistas ---------------------------------------------------------------

// La pestaña Git se reusa en dos vistas (`repo` y `agentmode`), así que se
// declara una vez.
// Las tres vistas nuevas de esta versión: el módulo de peticiones HTTP, el
// reflog de Git y la tabla de una carpeta de notas.
const views_http = (
    <div className="flex h-full">
        <div className="w-72 shrink-0 border-r border-outline-variant">
            <HttpTree
                filter=""
                activeItemId="i4"
                onOpenRequest={() => {}}
                refreshToken={0}
                onChanged={() => {}}
                onNewScratch={() => {}}
                onOpenScratchWith={() => {}}
                historyToken={0}
            />
        </div>
        <HttpRequestTab
            itemId="i4"
            editorThemeId="auto"
            appTheme="dark"
            appearance={DEFAULT_EDITOR_APPEARANCE}
            onChanged={() => {}}
            active
        />
    </div>
)

// Solo las conexiones SSH: el selector de host del explorador ofrece «Local»
// más estas, igual que en la app.
const sshConnections = (fixtures.ListConnections as {dbType: string}[]).filter(
    (c) => c.dbType === 'ssh',
) as unknown as Parameters<typeof SftpTab>[0]['connections']

const views_sftp = <SftpTab tabId="sftp-1" initialConnId="s1" connections={sshConnections} />

const views_reflog = (
    <div className="flex h-full flex-col">
        <GitReflogPanel repoId="r1" onChanged={() => {}} />
    </div>
)

const views_notesfolder = (
    <FolderNotesDialog
        folder={{id: 'f-notes-runbooks', name: 'Runbooks', parentId: '', sortOrder: 0, createdAt: 0, scope: 'note'} as never}
        descendantIds={[]}
        activeNoteId="n1"
        onOpenNote={() => {}}
        onChanged={() => {}}
        onClose={() => {}}
    />
)

const views_repo = (
    <GitRepoTab
        repoId="r1"
        repoName="mini-tools"
        editorThemeId="auto"
        appearance={DEFAULT_EDITOR_APPEARANCE}
        appTheme={new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark'}
        terminalThemeId="Dracula"
        onChangeTerminalTheme={() => {}}
        terminalFontSize={13}
        onChangeTerminalFontSize={() => {}}
        localShellId=""
        syncToken={0}
        onChanged={() => {}}
        active
    />
)

const views_chat = (
    <AgentChat
        sessionId="chat-1"
        context={{kind: 'git', id: 'r1', label: 'mini-tools'}}
        agentId="claude"
        agentLabel="Claude Code"
        resumeConversationId="conv-1"
    />
)

// El mismo chat pero abierto sobre una CONEXIÓN, con la consulta del editor
// adjunta y con destino para insertar: es lo que hace aparecer la barra de cada
// bloque de código ("Al editor" / "Copiar"), que es lo nuevo que hay que
// mostrar.
// El panel de buscar/reemplazar de CodeMirror y un tooltip, con el cromo de
// la app (codemirror/editorChrome.ts). UISHOT_THEME=light para el tema claro.
const {EditorView: CMView} = await import('@codemirror/view')
const {EditorState: CMState} = await import('@codemirror/state')
const {basicSetup: cmBasicSetup} = await import('codemirror')
const {search: cmSearch, openSearchPanel, setSearchQuery, SearchQuery} = await import('@codemirror/search')
const {editorAppearanceExtension: cmAppearance, DEFAULT_EDITOR_APPEARANCE: cmDefaultLook} = await import('./codemirror/editorAppearance')
const {resolveEditorTheme: cmTheme} = await import('./codemirror/themes')
const {sqlLanguageExtension: cmSql} = await import('./codemirror/sqlSchema')
const {execTimeField, execTimeTheme, execMarkSpec} = await import('./codemirror/execTimeMarks')
type ExecMark = import('./codemirror/execTimeMarks').ExecMark

function ExecMarksShot() {
    const ref = (el: HTMLDivElement | null) => {
        if (!el || el.childElementCount) return
        const doc = `SELECT * FROM SGCPRO.CARGVAR ORDER BY F_ACTUAL DESC;

UPDATE BATCH_CTRL_MODULO SET IND_ESTADO = 1 WHERE IND_ESTADO = 2;

DELETE FROM SGCPRO.TMP_RECIBO WHERE F_BATCH < DATE '2026-01-01';

SELECT COUNT(*) FROM SGCPRO.ITIFACT;`
        const view = new CMView({
            parent: el,
            state: CMState.create({doc, extensions: [cmBasicSetup, cmSql('oracle', null), cmTheme('auto', 'dark'), ...cmAppearance(cmDefaultLook), execTimeField, execTimeTheme]}),
        })
        const marks: [string, ExecMark][] = [
            ['SELECT * FROM SGCPRO.CARGVAR ORDER BY F_ACTUAL DESC', {status: 'done', label: '412 ms · 500 filas', title: ''}],
            ['UPDATE BATCH_CTRL_MODULO SET IND_ESTADO = 1 WHERE IND_ESTADO = 2', {status: 'done', label: '1m 4s · 37 afectadas', title: ''}],
            ["DELETE FROM SGCPRO.TMP_RECIBO WHERE F_BATCH < DATE '2026-01-01'", {status: 'error', label: 'error', title: ''}],
            ['SELECT COUNT(*) FROM SGCPRO.ITIFACT', {status: 'cancelled', label: 'cancelada', title: ''}],
        ]
        for (const [sql, mark] of marks) {
            const spec = execMarkSpec(view.state, sql, 0, mark)
            if (spec) view.dispatch(spec)
        }
    }
    return <div ref={ref} className="h-full w-full bg-surface" />
}

function EditorSearchShot() {
    const light = new URLSearchParams(location.search).get('theme') === 'light'
    const ref = (el: HTMLDivElement | null) => {
        if (!el || el.childElementCount) return
        const view = new CMView({
            parent: el,
            state: CMState.create({
                doc: `update BATCH_CTRL_MODULO
set IND_ESTADO = 1,
    DESCRIP_ERROR = 'Simulado por problemas de noche'
where IND_ESTADO = 2;

DECLARE
    v_cant NUMBER; v_ret NUMBER;
BEGIN
    SGCPRO.PR_INFORMANTE(
        p_fecha_batch => DATE '2026-09-10',
        p_usuario     => USER,
        p_cant        => v_cant,
        p_retorno     => v_ret);
END;`,
                extensions: [cmBasicSetup, cmSearch({top: true}), cmSql('oracle', null), cmTheme('auto', light ? 'light' : 'dark'), ...cmAppearance(cmDefaultLook)],
            }),
        })
        openSearchPanel(view)
        view.dispatch({effects: setSearchQuery.of(new SearchQuery({search: 'IND_ESTADO', caseSensitive: true, replace: 'ESTADO'}))})
        const input = el.querySelector<HTMLInputElement>('input[name=case]')
        if (input) input.checked = true
    }
    return <div ref={ref} className="h-full w-full bg-surface" />
}

const views_chatdb = (
    <AgentChat
        sessionId="chat-db"
        context={{kind: 'db', id: 'c1', label: 'chatwoot_dev'}}
        agentId="claude"
        agentLabel="Claude Code"
        resumeConversationId="conv-db"
        working={{label: 'Consulta del editor', text: 'SELECT * FROM contacts;', language: 'sql'}}
        insertLabel="Inserta el bloque en el editor, donde está el cursor"
        onInsertText={() => {}}
    />
)

// Las filas de la grilla editable. Son las mismas columnas que declara la
// fixture de ResultEditTarget: si no coincidieran, la captura mostraría una
// grilla que la app real no permitiría editar.
const gridColumns = ['id', 'name', 'email', 'phone_number', 'account_id', 'created_at']
const gridRows: unknown[][] = [
    [1, 'jane', 'jane@example.com', '+2320000', 1, '2026-06-24 22:41:03.893239'],
    [3, 'polished-rain-974', null, null, 2, '2026-06-24 22:48:01.016058'],
    [4, 'white-sound-246', null, null, 2, '2026-06-24 22:48:02.462428'],
    [5, 'prueba', 'prueba9@prueba9.com', null, 2, '2026-07-02 18:10:26.673483'],
    [865, 'rafa', null, '+50588842174', 2, '2026-07-30 13:41:37.617379'],
    [2, 'rafael', 'rafael@prueba.com', null, 1, '2026-08-15 00:00:00.000000'],
]

// Un script con lo que se ve todos los días en la consola: un DDL que salió
// bien, un bloque PL/SQL con su DBMS_OUTPUT y una sentencia que falló. Los tres
// casos que el resaltado tiene que distinguir de un vistazo.
const CONSOLE_ENTRIES = [
    {
        index: 0, total: 3,
        sqlText: "CREATE OR REPLACE PROCEDURE SGCPRO.PR_REFACT_NUM_FACT_NOTA (\n    p_cod_proceso IN  VARCHAR2,\n    p_num_fact    OUT VARCHAR2,\n    p_retorno     OUT NUMBER\n) AS\n    -- Numeración de la autorización vigente\n    v_seq NUMBER := 0;\nBEGIN\n    SELECT SEQ INTO v_seq FROM CARGVAR WHERE COD_PROCESO = p_cod_proceso;\n    p_retorno := 0;\nEND PR_REFACT_NUM_FACT_NOTA;",
        status: 'done' as const, hasColumns: false, rowsAffected: 0, durationMs: 421, error: '',
        dbmsOutput: [], note: '', timestamp: 1788696564000,
    },
    {
        index: 1, total: 3,
        sqlText: "BEGIN\n    SGCPRO.PR_REFACT_NUM_FACT_NOTA('FACB0003', :p_num_fact, :p_retorno);\nEND;",
        status: 'done' as const, hasColumns: false, rowsAffected: 0, durationMs: 167, error: '',
        dbmsOutput: ['NUM_FACT nota: AVISO - se estan agotando los numeros de la autorizacion 4200 (van 981 de 1000)'],
        note: '', timestamp: 1788696564000,
    },
    {
        // Una edición de la grilla: no la escribió nadie en el editor, la
        // generó el backend al guardar dos celdas. Va con su distintivo.
        index: 0, total: 1,
        sqlText: "UPDATE SGCPRO.FUECICLO SET LECT_ACT = :1 WHERE NIS_RAD = :2 AND SEC_NIS = :3\nUPDATE SGCPRO.FUECICLO SET CSMO_ESTM = :1 WHERE NIS_RAD = :2 AND SEC_NIS = :3",
        status: 'done' as const, hasColumns: false, rowsAffected: 2, durationMs: 61, error: '',
        dbmsOutput: [], note: '', timestamp: 1788696564500,
        values: [
            "#1  :1 LECT_ACT = '1543'   :2 NIS_RAD = '88213'   :3 SEC_NIS = '1'   (antes '1200')",
            "#2  :1 CSMO_ESTM = '343'   :2 NIS_RAD = '88213'   :3 SEC_NIS = '1'   (antes '0')",
        ],
        origin: 'Edición de la grilla · 2 sentencias en una transacción',
    },
    {
        index: 2, total: 3,
        sqlText: "SELECT NIS_RAD, F_EMISION\n  FROM SGCPRO.FUECICLO\n WHERE F_EMISION = '2026-08-27'",
        status: 'error' as const, hasColumns: false, rowsAffected: 0, durationMs: 38,
        error: 'ORA-01843: el mes no es valido\nORA-06512: en linea 1',
        dbmsOutput: [], note: '', timestamp: 1788696565000,
    },
]

// Salida de un pull grande, con el ancho de COLUMNS=1000 que usa el backend.
const pullOutput = [
    'Updating dab00220f..0c234c506',
    'Fast-forward',
    ...Array.from({length: 60}, (_, i) => {
        const n = (i * 37) % 320
        return ` app/controllers/api/v1/accounts/${['agents', 'calls', 'conversations', 'forms', 'inboxes', 'labels'][i % 6]}_controller_${i}.rb | ${n} ${'+'.repeat(Math.ceil(n / 8))}${'-'.repeat(i % 4)}`
    }),
    ' app/javascript/{dashboard/old_api.js => shared/api.js} | 12 ++--',
    ' public/logo.png | Bin 0 -> 3456 bytes',
    ' 62 files changed, 9123 insertions(+), 188 deletions(-)',
    ' create mode 100644 app/controllers/api/v1/accounts/calls_controller_1.rb',
    ' delete mode 100644 app/controllers/api/v1/accounts/forms_controller_3.rb',
].join('\n')

const views: Record<string, React.ReactNode> = {
    // pullnoticeopen: la misma, con la lista desplegada.
    pullnoticeopen: null as React.ReactNode,
    pullnotice: (
        <div className="flex h-full flex-col bg-surface">
            <GitOutputNotice text={pullOutput} onClose={() => {}} onOpenFile={() => {}} onRevealCommit={() => {}} />
            <div className="flex-1 p-4 text-ui-11 text-on-surface-variant">(grafo de commits)</div>
        </div>
    ),
    // El visor de DDL, con un objeto largo de verdad: lo que se mira acá es que
    // el panel scrollee adentro del modal (y no desborde) y que la cabecera y
    // la barra de estado queden fijas mientras el DDL corre.
    editorsearch: <EditorSearchShot />,
    ddl: (
        <div className="h-full w-full bg-surface">
            <DDLViewerModal
                connId="c1"
                objectType="table"
                schema="DWHPRO"
                name="DXHT_FACTURACION_CONCEPTOS"
                oid={0}
                dbType="oracle"
                editorThemeId="auto"
                appTheme="dark"
                onClose={() => {}}
            />
        </div>
    ),
    // La consola de ejecución con sus tres desenlaces: SQL resaltado, salida de
    // DBMS_OUTPUT y un error con su código del motor destacado.
    console: (
        <div className="flex h-full w-full flex-col bg-surface">
            <ExecutionConsole entries={CONSOLE_ENTRIES} running={false} onClear={() => {}} />
        </div>
    ),
    // El módulo de base de datos entero: sidebar de conexiones, editor SQL y
    // resultados. Es el otro producto que vive en esta app.
    workspace: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    // Mismo montaje: lo que cambia es qué se está mirando. La barra lateral y
    // la tira de pestañas no son componentes sueltos que se puedan montar
    // aparte —viven del estado del workspace— así que se fotografían dentro
    // de él, con `&module=` para elegir qué módulo abre el menú master:
    //
    //     ./scripts/uishot.sh sidebar          # conexiones
    //     UISHOT_MODULE=git ./scripts/uishot.sh sidebar
    gitsidebar: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    gitsidebarfilter: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    gitsidebartag: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    gitsidebarmenu: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    sidebar: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    tabs: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    // La búsqueda global escrita, que es lo único que hace aparecer los
    // contadores del menú master — el mecanismo por el que, viendo un módulo
    // solo, uno se entera de que lo que busca está en otro.
    // El árbol de esquema con contenido: tablas, procedures, functions,
    // triggers y packages. Es el workspace entero y no el árbol suelto porque
    // el árbol depende del módulo activo de la barra, que lo maneja el marco.
    // El árbol con «Agrupar por prefijo» puesto y un grupo abierto.
    schemaprefix: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    // Marcas de tiempo de ejecución al final de cada sentencia.
    execmarks: <ExecMarksShot />,
    // Una celda editada con una expresión SQL (fx).
    gridexpr: (
        <div className="flex h-full flex-col">
            <ResultGrid columns={gridColumns} rows={gridRows} connId="c1" sqlText="select * from contacts;" />
        </div>
    ),
    schematree: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    sidebarsearch: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    // La barra oculta: queda la columna con el menú master.
    sidebarmin: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    // La ventana entera con su barra de título propia. `?platform=windows`
    // (o linux) dibuja los botones de ventana de la app; el default, darwin,
    // deja el hueco de los semáforos, que en el navegador se ve vacío porque
    // los pone el sistema y acá no hay sistema.
    window: (
        <div className="flex h-full w-full flex-col overflow-hidden">
            <TitleBar />
            <div className="min-h-0 flex-1">
                {/* `&update=1` simula que hay una versión nueva: es la única
                    forma de fotografiar el aviso del pie de la barra, que en
                    una instalación al día no existe. */}
                <Workspace
                    theme="dark"
                    onToggleTheme={() => {}}
                    onLocked={() => {}}
                    updateInfo={
                        new URLSearchParams(location.search).get('update')
                            ? ({
                                  available: true,
                                  latest: '2.1.0',
                                  current: '2.0.0',
                                  releaseUrl: 'https://example.invalid',
                                  downloadUrl: 'https://example.invalid/mini-tools-v2.1.0.dmg',
                                  assetName: 'mini-tools-v2.1.0.dmg',
                              } as never)
                            : null
                    }
                    uiFontScale={100}
                    onChangeUIFontScale={() => {}}
                />
            </div>
        </div>
    ),
    // El grafo con un commit elegido y su diff a la derecha: es el mismo
    // componente que `repo`, pero la foto que la documentación necesita del
    // módulo Git es esta, no la del panel de agentes.
    commitgraph: views_repo,
    // El menú de una pestaña con su selector de conexión desplegado: es la
    // lista más larga que dibuja el Select de la app, así que es la que dice
    // si las filas se leen o no.
    tabmenu: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />,
    // La pestaña Git entera: es la única forma de ver el modo agente, la tira
    // de solapas y los acordeones, que dependen del layout completo.
    repo: views_repo,
    files: (
        <GitFileEditor
            repoId="r1"
            editorThemeId="auto"
            appTheme="dark"
            appearance={DEFAULT_EDITOR_APPEARANCE}
            initialFiles={['app_git.go']}
            // El estado de git es lo que pinta los indicadores de cambio del
            // árbol: sin pasarlo, la vista se veía bien pero no probaba nada.
            status={fixtures.GitStatus as never}
            onSaved={() => {}}
            onClose={() => {}}
            onAskAgent={() => {}}
        />
    ),
    agentmode: views_repo,
    gitworkhistory: views_repo,
    gitworkchanges: views_repo,
    gitworkdiff: views_repo,
    gitworkstash: views_repo,
    gitworkfiles: views_repo,
    gitworkcollapsed: views_repo,
    gitworkswitcher: views_repo,
    gitworknarrow: views_repo,
    chatmode: views_repo,
    panelagents: views_repo,
    newmenu: views_repo,
    history: views_repo,
    redis: <RedisBrowserTab connId="c3" initialKey="cart:u:1042" initialKeyToken={1} />,
    mongo: <MongoBrowserTab connId="c6" initialDatabase="events" initialCollection="orders" initialToken={1} onOpenWizard={() => {}} />,
    mongowizard: <MongoFindWizard connId="c6" database="events" initialCollection="orders" onGenerate={() => {}} onClose={() => {}} />,
    agents: <GitAgentPanel repoId="r1" onOpenFile={() => {}} onAskAgent={() => {}} defaultAgent="" onSetDefaultAgent={() => {}} />,
    chat: views_chat,
    chatdb: views_chatdb,
    // La base de conocimiento: el editor con el Markdown ya formateado, la
    // barra de formato, los enlaces entre notas y el panel lateral.
    http: views_http,
    reflog: views_reflog,
    sftp: views_sftp,
    notesfolder: views_notesfolder,
    notes: (
        <NoteEditorTab
            noteId="n1"
            editorThemeId="auto"
            appTheme="dark"
            onOpenNote={() => {}}
            onCreateNote={() => {}}
            onClosed={() => {}}
            onChanged={() => {}}
        />
    ),
    notespreview: (
        <NoteEditorTab
            noteId="n1"
            editorThemeId="auto"
            appTheme="dark"
            onOpenNote={() => {}}
            onCreateNote={() => {}}
            onClosed={() => {}}
            onChanged={() => {}}
        />
    ),
    notesgraph: <NotesGraphView onOpenNote={() => {}} onClose={() => {}} activeNoteId="n1" />,
    // La grilla con la conexión y la consulta: es lo que la habilita a editar.
    gridedit: (
        <div className="flex h-full flex-col">
            <ResultGrid columns={gridColumns} rows={gridRows} connId="c1" sqlText="select * from contacts;" />
        </div>
    ),
    // La barra de la grilla: filtro rápido puesto y estadísticas abiertas.
    gridtools: (
        <div className="flex h-full flex-col">
            <ResultGrid columns={gridColumns} rows={gridRows} connId="c1" sqlText="select * from contacts;" toolbarStart={<span className="text-ui-11 text-on-surface-variant">Export ▾</span>} />
        </div>
    ),
    // La vista de registro sobre la segunda fila.
    gridrecord: (
        <div className="flex h-full flex-col">
            <ResultGrid columns={gridColumns} rows={gridRows} connId="c1" sqlText="select * from contacts;" />
        </div>
    ),
    usage: (
        // Alto explícito: el panel de consumo pasó a ocupar el cuerpo del chat
        // como una solapa (`h-full`), así que sin un contenedor con alto la
        // captura salía aplastada.
        <div className="h-full w-[420px]">
            <AgentUsagePanel
                agentLabel={(id) => ({claude: 'Claude Code', codex: 'Codex CLI', antigravity: 'Antigravity CLI'})[id] ?? id}
                session={{total: 15900, output: 974, cost: 0.0412}}
                onClose={() => {}}
            />
        </div>
    ),
    // La terminal del sistema operativo abierta desde el módulo SSH: la barra
    // con snippets/historial/tema es lo nuevo, el widget de abajo es el mismo
    // que ya usaba el módulo Git.
    // Terminal SSH con salida real. El `sessionId` ES el nombre del evento por
    // el que llega lo que escribe el servidor: tiene que coincidir con una
    // clave de TERMINAL_OUTPUT o la captura sale en negro. Va aparte del
    // connId porque un servidor puede tener varias terminales abiertas.
    sshterm: (
        <div className="h-full">
            <SshTerminalTab
                connId="ssh-shot"
                connName="build19"
                sessionId="ssh-shot"
                theme="dark"
                terminalThemeId="auto"
                onChangeTerminalTheme={() => {}}
                terminalFontSize={13}
                onConnectedChange={() => {}}
            />
        </div>
    ),
    docker: (
        <div className="h-full">
            <DockerTab visible section="containers" onCounts={() => {}} />
        </div>
    ),
    dockerlogs: (
        <div className="h-full">
            <DockerTab visible section="containers" onCounts={() => {}} />
        </div>
    ),
    dockerbuilds: (
        <div className="h-full">
            <DockerTab visible section="builds" onCounts={() => {}} />
        </div>
    ),
    dockerexport: (
        <div className="h-full">
            <DockerTab visible section="containers" onCounts={() => {}} />
        </div>
    ),
    dockersearch: (
        <div className="h-full">
            <DockerTab visible section="containers" onCounts={() => {}} />
        </div>
    ),
    dockerdown: (
        <div className="h-full">
            <DockerTab visible section="containers" onCounts={() => {}} />
        </div>
    ),
    aichat: (
        <div className="h-full">
            <AiChatTab visible paneId="uishot" />
        </div>
    ),
    aichatchat: (
        <div className="h-full">
            <AiChatTab visible paneId="uishot" />
        </div>
    ),
    aichatsearch: (
        <div className="h-full">
            <AiChatTab visible paneId="uishot" />
        </div>
    ),
    activitymonitor: (
        <div className="h-full">
            <ActivityMonitorTab visible />
        </div>
    ),
    portkiller: (
        <div className="h-full">
            <PortKillerTab visible />
        </div>
    ),
    localterm: (
        <div className="h-full">
            <LocalTerminalTab
                sessionId="local-shot"
                shellId="zsh"
                shellLabel="zsh"
                theme="dark"
                terminalThemeId="Dracula"
                onChangeTerminalTheme={() => {}}
                terminalFontSize={13}
                visible
            />
        </div>
    ),
    mcp: (
        <div className="w-[420px] p-3">
            <AiAccessPanel />
        </div>
    ),
    // El modal de configuración, que dejó de ser un scroll único y pasó a
    // tener sus secciones aparte. `&section=` elige cuál abre, porque el
    // punto de la captura es justamente que cada una se ve sola.
    settings: (
        <SettingsDialog
            rememberMasterKey
            onToggleRememberMasterKey={() => {}}
            editorThemeId="auto"
            onChangeEditorThemeId={() => {}}
            editorAppearance={DEFAULT_EDITOR_APPEARANCE}
            onChangeEditorAppearance={() => {}}
            terminalThemeId="dracula"
            onChangeTerminalThemeId={() => {}}
            terminalFontSize={13}
            onChangeTerminalFontSize={() => {}}
            localShellId=""
            onChangeLocalShellId={() => {}}
            onBackupVault={() => {}}
            // El aviso del último backup vive acá, no en el toolbar de
            // bases: se fotografía con un resultado puesto para que se
            // vea dónde aparece la ruta.
            backupResult={{ok: true, text: 'Backup guardado en /Users/ana/Documents/mini-tools-2026-09-03.mtbackup'}}
            onRestoreVault={() => {}}
            autoBackupEnabled
            onToggleAutoBackup={() => {}}
            autoBackupIntervalHours={6}
            onChangeAutoBackupInterval={() => {}}
            autoBackupPath="~/Backups/mini-tools"
            onPickAutoBackupFolder={() => {}}
            autoSaveEnabled
            onToggleAutoSave={() => {}}
            autoSaveIntervalSeconds={30}
            onChangeAutoSaveInterval={() => {}}
            uiFontScale={100}
            onChangeUIFontScale={() => {}}
            updateInfo={null}
            onOpenRepo={() => {}}
            onClose={() => {}}
        />
    ),
    // Mismo componente: lo que cambia es que el harness le manda un mensaje,
    // que es la única forma de que exista un turno en curso que fotografiar.
    thinking: views_chat,
    // La configuración de git de un repositorio, abierta en la pestaña de
    // remotos. `&edit=1` le pega el clic al lápiz para fotografiar el
    // formulario con la URL real —token incluido— y el aviso que ofrece
    // mudarlo al vault, que es lo que la ayuda explica.
    gitconfig: (
        <div className="h-full w-full bg-surface">
            <GitSettingsDialog repoId="r1" repoName="mini-tools" initialTab="remotes" onClose={() => {}} onChanged={() => {}} />
        </div>
    ),
}

const view = new URLSearchParams(location.search).get('view') ?? 'files'

// --- Sesiones de IA en segundo plano (vistas aisess*) -------------------------
//
// Cinco conversaciones en estados distintos: una trabajando con salida parcial
// (la que se retoma), una pidiendo permiso, una terminada sin leer, una fallida y
// una más trabajando en otro proveedor. Los instantes salen de `Date.now()` para
// que el reloj de «trabajando» muestre un tiempo creíble el día que se saque.
const sessEs = uiLang === 'es'
if (view.startsWith('aisess')) {
    // «Recientes» arranca plegado en la app; las capturas lo muestran abierto
    // (salvo la vista aisesscollapsed, que fotografía el estado de fábrica).
    try {
        localStorage.setItem('mini-tools:ai-groups-open', JSON.stringify({active: true, recent: view !== 'aisesscollapsed'}))
    } catch {
        // sin almacenamiento: queda el valor por defecto
    }
    const nowMs = Date.now()
    const T = {
        mig: sessEs ? 'Migrar el módulo de pagos a PL/SQL' : 'Migrate the payments module to PL/SQL',
        plan: sessEs ? 'Revisar el plan de ejecución de la consulta lenta' : 'Review the execution plan of the slow query',
        tests: sessEs ? 'Generar los tests del parser de logs' : 'Generate tests for the log parser',
        job: sessEs ? 'Diagnosticar el timeout del job nocturno' : 'Diagnose the nightly job timeout',
        logs: sessEs ? 'Resumir los logs de la semana' : 'Summarize this week logs',
    }
    // Las cinco están ABIERTAS (open) —Chat de IA → Abiertas es la lista
    // persistente—, con el estado en el que quedaron guardadas: la que trabaja
    // figura «interrumpida» hasta que termina (ver Store.SetAgentChatLastStatus).
    const mk = (id: string, agentId: string, title: string, ctx: string, ago: number, model: string, lastStatus = 'idle') => ({
        id, repoId: '', agentId, title, conversationId: `conv-${id}`, createdAt: aiNow - ago - 600, updatedAt: aiNow - ago, model, effort: '', mode: '', module: 'utilities', contextId: ctx, brain: false,
        open: true, pinned: false, lastStatus,
    })
    fixtures.ListAllAgentChats = [
        mk('as-1', 'claude', T.mig, 'ws:w1', 40, 'sonnet', 'interrupted'),
        mk('as-2', 'llm:ms1', T.plan, '', 120, 'qwen2.5-coder:14b', 'interrupted'),
        mk('as-3', 'codex', T.tests, 'r4', 700, ''),
        mk('as-4', 'antigravity', T.job, 'ws:w1', 1500, '', 'error'),
        mk('as-5', 'llm:ms2', T.logs, '', 30, 'llama3.1:70b', 'interrupted'),
        ...aiChats.slice(0, 5),
    ]
    // La parte persistente de «Abiertas»: las filas abiertas del vault.
    fixtures.ListOpenAgentChats = () => (fixtures.ListAllAgentChats as {open?: boolean}[]).filter((c) => c.open)
    fixtures.SetAgentChatPinned = null
    fixtures.SetAgentChatOpen = null
    const info = (id: string, agentId: string, agentLabel: string, title: string, model: string, ctx: string, status: string, extra: Record<string, unknown>) => ({
        sessionId: id, chatId: id, agentId, agentLabel, model, mode: '', module: 'utilities', contextId: ctx, title, status,
        startedAt: nowMs - 900_000, lastEventAt: nowMs - 2000, turnStartedAt: nowMs - 312_000, lastText: '', pendingApprovalId: '', unread: false, ...extra,
    })
    const sessionList = (finished: boolean) => [
        info('as-2', 'llm:ms1', 'Ollama local', T.plan, 'qwen2.5-coder:14b', '', 'awaiting_approval', {
            pendingApprovalId: 'apr-1', turnStartedAt: nowMs - 95_000,
            lastText: sessEs ? 'Necesito correr EXPLAIN sobre la consulta para ver si usa el índice.' : 'I need to run EXPLAIN on the query to see whether it uses the index.',
        }),
        info('as-1', 'claude', 'Claude Code', T.mig, 'sonnet', 'ws:w1', 'running', {
            lastText: sessEs ? 'Leyendo backend/payments/settle.pks para mapear los procedimientos que hay que portar…' : 'Reading backend/payments/settle.pks to map the procedures that need porting…',
        }),
        info('as-5', 'llm:ms2', 'vLLM en el servidor GPU', T.logs, 'llama3.1:70b', '', finished ? 'idle' : 'running', {
            turnStartedAt: nowMs - 41_000, unread: finished,
            lastText: sessEs ? 'Resumen: 3 reinicios del job y un pico de latencia el martes a las 02:10.' : 'Summary: 3 job restarts and a latency spike on Tuesday at 02:10.',
            ...(finished ? {usage: {input: 5210, output: 640, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 5850, costUsd: 0}} : {}),
        }),
        info('as-3', 'codex', 'Codex CLI', T.tests, '', 'r4', 'idle', {
            unread: true, turnStartedAt: nowMs - 780_000, lastEventAt: nowMs - 600_000,
            lastText: sessEs ? 'Agregué 14 casos de prueba; todos pasan con go test ./...' : 'Added 14 test cases; all pass with go test ./...',
            usage: {input: 18200, output: 2220, cacheRead: 0, cacheWrite: 0, thinking: 0, total: 20420, costUsd: 0},
        }),
        info('as-4', 'antigravity', 'Antigravity CLI', T.job, '', 'ws:w1', 'error', {
            unread: true, turnStartedAt: nowMs - 1_400_000, lastEventAt: nowMs - 1_300_000,
            lastText: '',
            error: sessEs ? 'el proceso terminó con código 1: no se pudo leer /var/log/batch/nocturno.log (permiso denegado)' : 'process exited with code 1: could not read /var/log/batch/nightly.log (permission denied)',
        }),
    ]
    fixtures.ListAgentSessions = sessionList(false)
    anyWindow.__sessionNext = sessionList(true)
    fixtures.ListPendingApprovals = [
        {
            id: 'apr-1', tool: 'run_command', input: '{"command":"psql -c \"EXPLAIN ANALYZE SELECT * FROM pagos WHERE estado = 3\""}',
            summary: 'psql -c "EXPLAIN ANALYZE SELECT * FROM pagos WHERE estado = 3"', detail: '', sessionId: 'as-2', title: T.plan, agentLabel: 'Ollama local', createdAt: nowMs - 30_000,
        },
    ]
    fixtures.MarkAgentSessionRead = null
    const ev = (seq: number, kind: string, text: string, extra: Record<string, unknown> = {}) => ({seq, kind, text, ...extra})
    fixtures.AgentSessionReplay = (id: string) =>
        id !== 'as-1'
            ? []
            : [
                  ev(1, 'start', '', {model: 'claude-sonnet-4', tools: ['Read', 'Grep', 'Edit'], mcpServers: []}),
                  ev(2, 'text', sessEs ? 'Voy a empezar por entender qué procedimientos tiene el paquete de pagos.\n\n' : 'I will start by understanding which procedures the payments package has.\n\n'),
                  ev(3, 'tool', '', {tool: {name: 'Grep', input: '{"pattern":"PROCEDURE"}', summary: 'PROCEDURE  backend/payments/', detail: ''}}),
                  ev(4, 'tool', '', {tool: {name: 'Read', input: '{"file_path":"backend/payments/settle.pks"}', summary: 'backend/payments/settle.pks', detail: ''}}),
                  ev(5, 'text', sessEs ? '## Lo que encontré\n\nEl paquete expone **7 procedimientos**; tres de ellos escriben en `PAGOS_LIQ` y hay que portarlos con su manejo de `COMMIT` intermedio:\n\n- `settle_batch`\n- `reverse_payment`\n- `close_period`\n\nSigo con `settle.pkb` para ver los cursores…' : '## What I found\n\nThe package exposes **7 procedures**; three of them write to `PAGOS_LIQ` and must be ported with their intermediate `COMMIT`:\n\n- `settle_batch`\n- `reverse_payment`\n- `close_period`\n\nContinuing with `settle.pkb` to look at the cursors…'),
              ]
    aiChatMessages['as-1'] = [{seq: 1, role: 'user', content: sessEs ? 'Migrá el módulo de pagos a PL/SQL y listame qué procedimientos hay que portar.' : 'Migrate the payments module to PL/SQL and list which procedures need porting.', toolName: '', createdAt: aiNow - 330}]
    aiChatMessages['as-3'] = [
        {seq: 1, role: 'user', content: sessEs ? 'Generá los tests del parser de logs.' : 'Generate the tests for the log parser.', toolName: '', createdAt: aiNow - 790},
        {seq: 2, role: 'assistant', content: sessEs ? 'Agregué **14 casos de prueba**; todos pasan con `go test ./...`.' : 'Added **14 test cases**; all pass with `go test ./...`.', toolName: '', usage: {input: 18200, output: 2220, cacheRead: 0, thinking: 0, total: 20420, costUsd: 0}, createdAt: aiNow - 600},
    ]
    aiChatMessages['as-5'] = [
        {seq: 1, role: 'user', content: sessEs ? 'Resumí los logs de la semana.' : 'Summarize this week logs.', toolName: '', createdAt: aiNow - 60},
    ]
}

// La solapa de la columna de trabajo se recuerda por repositorio en el
// almacenamiento del navegador (GitRepoTab): para fotografiar cada una basta
// dejarla escrita antes de montar la pestaña.
if (gitWorkShot) {
    const stored =
        view === 'gitworkchanges' || view === 'gitworkdiff'
            ? 'changes'
            : view === 'gitworkstash'
              ? 'stash'
              : view === 'gitworkfiles'
                ? 'files'
                : 'commits'
    try {
        localStorage.setItem('mt.git.work.r1', JSON.stringify({view: stored}))
    } catch {
        // sin almacenamiento: la vista arranca en Historial
    }
}

// Servidores de modelos: la sección vive en Configuración → IA. Estas vistas
// montan el mismo modal y le pegan los clics que daría una persona.
// La sección se pasa por prop (initialSection) y no con un clic sobre la barra
// lateral: un clic deja la transición de color de la pestaña activa a medias en
// la captura y la barra marca «Apariencia» sobre el contenido de «IA».
const settingsInSection = (id: string) =>
    cloneElement(views.settings as ReactElement<{initialSection?: string}>, {initialSection: id})
if (view === 'settings') {
    const sec = (new URLSearchParams(location.search).get('section') ?? '').toLowerCase()
    const byName: Record<string, string> = {apariencia: 'general', appearance: 'general', ia: 'ai', ai: 'ai', vault: 'vault', terminal: 'terminal', general: 'general'}
    if (byName[sec]) views.settings = settingsInSection(byName[sec])
}
views.modelserverform = settingsInSection('ai')
views.modelserverdetected = settingsInSection('ai')
// Sin servidores guardados y con un Ollama respondiendo en localhost: sale la sugerencia.
if (view === 'modelserverdetected') fixtures.ListModelServers = []
views.modelservertest = settingsInSection('ai')
// Formulario con el editor de cabeceras y la opción de certificado autofirmado
// (servidor nuevo, ya con las filas llenas) y edición de uno que ya guarda
// cabeceras (solo sus nombres, con «Reemplazar cabeceras»).
views.modelserverheaders = settingsInSection('ai')
views.modelserveredit = settingsInSection('ai')
// Atajos del alta: la cuadrícula sola, y «Ollama en otra máquina» ya elegido, con
// la IP y un puerto distinto del habitual (11435) y la guía de exposición abierta.
views.modelserverpresets = settingsInSection('ai')
views.modelserverremote = settingsInSection('ai')
views.modelservercontext = settingsInSection('ai')

// Agente de código local y cerebro (spec ia-ollama-chat-utilidades, fases 4-6).
// Todas montan el Chat de IA y retoman una conversación del historial, que es el
// camino real; la fixture de cada una decide qué se ve.
//   toolevents      eventos de herramientas (archivos, comandos, notas) y el
//                   cerebro encendido en un servidor local
//   remotewarn      servidor remoto con un repositorio: aviso y distintivo
//   approvalrisky   diálogo de aprobación de un comando de riesgo
//   brainon         el interruptor encendido; braindisabled, bloqueado (un chat
//                   nuevo, con el servidor MCP apagado); norepo, un servidor de
//                   modelos sin repositorio de trabajo
//   brainsettings   Configuración → IA, sección «Cerebro»
views.toolevents = views.aichat
views.remotewarn = views.aichat
views.approvalrisky = views.aichat
views.brainon = views.aichat
views.braindisabled = views.aichat
views.norepo = views.aichat
// Abre en «IA» por prop (initialSection) y no con un clic: un clic deja la
// transición de color de la barra lateral a medias en la captura.
views.brainsettings = settingsInSection('ai')
// Chat de IA con el servidor local caído: punto rojo en la cabecera, aviso sobre
// la caja con el error y «Reintentar». Reutiliza la conversación ac-8 (Ollama
// local); solo cambia lo que contesta la comprobación de salud.
views.healthred = views.aichat
// Chat de IA y su disposición (spec: ancho completo, panel angosto, historial
// redimensionable, alta de servidor desde el selector).
//   aichatwide       ventana ancha (usar con 1600 de ancho): el chat ocupa todo
//   aichatnarrow     pestaña angosta (700): el historial se pliega al botón
//   aichatdrawer     lo mismo con el historial abierto como cajón
//   aichatresize     arrastre del borde del historial, a mitad de camino
//   aichatadd        «Agregar servidor» abierto desde el selector de proveedor
//   aichataddfail    la prueba falla contra un Ollama remoto: consejo + «Guardar igual»
//   aichatusage      el panel de consumo ocupando el cuerpo de la pestaña
//   aichatnoserver   sin servidor de modelos: el aviso del estado vacío
views.aichatwide = views.aichat
views.aichatnarrow = views.aichat
views.aichatdrawer = views.aichat
views.aichatresize = views.aichat
views.aichatadd = views.aichat
views.aichataddfail = views.aichat
views.aichatnoserver = views.aichat
views.aichatusage = views.aichat
//   aichatlost       conversación de un proveedor apagado: se abre, la caja queda bloqueada y la franja ofrece seguir con otro
//   aichatlostcontinue  lo mismo después de «Continuar con otro proveedor»: el aviso del cambio
//   aichatswitch     cambio de proveedor de modelos en una conversación abierta, sin perder el hilo
views.aichatlost = views.aichat
views.aichatlostcontinue = views.aichat
views.aichatswitch = views.aichat
// Proyectos del Chat de IA (carpetas, contexto y modo Automático). Todas parten
// de un servidor de modelos, que es con el que la app carga el contexto sola.
//   projectpicker   selector de proyecto abierto: repos, carpetas y acciones
//   projecthint     proyecto elegido en un chat nuevo: la sugerencia de Automático
//   projectauto     una carpeta con el modo Automático recordado de otra vez
//   projectcontext  la franja «Contexto» abierta (archivos y skills)
//   projectchat     conversación sobre una carpeta, con tarjetas de skill y glob
//   projectmanage   «Administrar carpetas…»
//   projectremove   la confirmación al quitar una carpeta (cuenta sus conversaciones)
//   modelservercontext   alta de un Ollama nuevo: ventana de contexto en 16384
views.projectpicker = views.aichat
views.projecthint = views.aichat
views.projectauto = views.aichat
views.projectcontext = views.aichat
views.projectchat = views.aichat
views.projectmanage = views.aichat
views.projectremove = views.aichat
if (['projectpicker', 'projecthint', 'projectauto', 'projectcontext', 'projectchat', 'projectmanage', 'projectremove'].includes(view)) {
    fixtures.AgentActive = {id: 'llm:ms1', label: 'Ollama local', available: true, model: '', effort: '', chatSupported: true}
    // Sin memoria de otras corridas: el mismo navegador puede haber guardado modos.
    try {
        localStorage.clear()
        if (view === 'projectauto') {
            localStorage.setItem('mini-tools:aiChat:project:ws:w1', JSON.stringify({mode: 'auto', acked: ['auto']}))
        }
    } catch {
        // sin almacenamiento: la vista se ve igual, sin el modo recordado
    }
}
if (view === 'aichatnoserver') {
    fixtures.ListAgents = (fixtures.ListAgents as {id: string}[]).filter((a) => !a.id.startsWith('llm:'))
    fixtures.ListModelServers = []
    fixtures.ListAllAgentChats = aiChats.filter((c) => !c.agentId.startsWith('llm:'))
}
if (view === 'aichataddfail') {
    fixtures.TestModelServer = {
        ok: false,
        version: '',
        models: [],
        error:
            uiLang === 'es'
                ? 'no se pudo conectar a http://192.168.1.50:11434: la conexión fue rechazada (¿está el servidor en marcha?)'
                : 'could not connect to http://192.168.1.50:11434: connection refused (is the server running?)',
        latencyMs: 0,
        checkedAt: Date.now(),
    }
}
if (view === 'healthred') {
    fixtures.ModelServerHealth = (id: string) => ({
        ok: id !== 'ms1',
        version: '',
        models: [],
        error: id === 'ms1' ? 'dial tcp 127.0.0.1:11434: connect: connection refused' : '',
        latencyMs: id === 'ms1' ? 0 : 142,
        checkedAt: Date.now() - 3000,
    })
}
if (view === 'braindisabled') fixtures.BrainStatus = {mcpEnabled: false, notesWrite: false, root: 'Cerebro'}

// `&scale=150` fotografía la interfaz con el tamaño de letra agrandado.
//
// Se aplica acá y no por prop porque el ajuste no es de ningún componente: es
// una variable CSS del documento que escribe useUIFontScale (hooks/), y acá no
// se monta App sino cada vista suelta. Sirve para comprobar que una pantalla
// sigue entrando con el cuerpo al 150% antes de que se lo encuentre alguien
// que lo necesita.
// `&theme=light` fotografía el tema claro: la app guarda `dark` como clase de
// <html> (useTheme), y acá se la quita igual que lo haría el selector de tema.
if (new URLSearchParams(location.search).get('theme') === 'light') document.documentElement.classList.remove('dark')

const scale = Number(new URLSearchParams(location.search).get('scale'))
if (Number.isFinite(scale) && scale > 0) {
    document.documentElement.style.setProperty('--ui-font-scale', String(scale / 100))
}

// El modo agente no es una vista aparte sino un estado de la pestaña Git, y no
// se puede pasar por prop a propósito (es del usuario, no del que la monta).
// Para poder fotografiarlo, estas vistas montan la pestaña normal y le pegan el
// clic, igual que lo haría una persona: `agentmode` al botón de la barra,
// `chatmode` a la solapa de un chat — que tiene que dejar la pestaña igual.
const autoClick = (find: () => HTMLElement | undefined) => {
    const click = () => {
        const el = find()
        if (el) el.click()
        else setTimeout(click, 120)
    }
    setTimeout(click, 900)
}

if (view === 'gitconfig' && new URLSearchParams(location.search).get('edit')) {
    autoClick(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.hasAttribute('data-remote-edit')))
}
if (view === 'agentmode') {
    // Por title y no por texto: el Icon renderiza su ligadura como texto, así
    // que textContent es "smart_toyAgente" y nunca matchea "Agente".
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.hasAttribute('data-agent-mode-toggle')))
}
if (view === 'gitworkchanges' || view === 'gitworkdiff') {
    // Elegir un archivo de la lista de Cambios: el diff pasa al área principal.
    autoClick(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('GitRepoTab.tsx') && !b.hasAttribute('aria-label')))
}
if (view === 'gitworkswitcher') {
    autoClick(() => document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]') ?? undefined)
}
if (view === 'panelagents') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.hasAttribute('data-open-agents')))
}
if (view === 'newmenu') {
    // El menú "Nueva" del panel de agentes: es donde aparecen las
    // conversaciones que el CLI ya tenía, y solo se ve abierto.
    // Primero el modo agente (para que exista la tira de la solapa Agentes) y
    // después el `+` de esa tira, que es donde vive el historial.
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.hasAttribute('data-agent-mode-toggle')))
    setTimeout(() => {
        autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title === t().git.tab.panel.newChatTitle))
    }, 400)
}
// Escribir en un campo controlado de React: setter nativo + evento `input`.
const typeInto = (el: HTMLInputElement | null | undefined, value: string) => {
    if (!el) return
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', {bubbles: true}))
}
const clickChat = (id: string) => document.querySelector<HTMLButtonElement>(`[data-chat-id="${id}"]`)?.click()
if (view === 'aichatlost' || view === 'aichatlostcontinue' || view === 'aichatswitch') {
    if (view !== 'aichatswitch') {
        // El laboratorio se apagó (sigue guardado) y otro proveedor se eliminó: sus
        // conversaciones siguen en el historial.
        fixtures.ListAgents = (fixtures.ListAgents as {id: string}[]).filter((a) => a.id !== 'llm:ms3')
        fixtures.ListModelServers = (fixtures.ListModelServers as {id: string}[]).map((x) => (x.id === 'ms3' ? {...x, enabled: false} : x))
        fixtures.ListAllAgentChats = [
            {id: 'ac-12', repoId: '', agentId: 'llm:ms3', title: 'Revisá el plan de despliegue del jueves', conversationId: '', createdAt: aiNow - 5400, updatedAt: aiNow - 3600, model: '', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
            {id: 'ac-13', repoId: '', agentId: 'llm:viejo', title: 'Resumen de la reunión de soporte', conversationId: '', createdAt: aiNow - 86400, updatedAt: aiNow - 80000, model: '', effort: '', mode: '', module: 'utilities', contextId: '', brain: false},
            ...aiChats,
        ]
        const msgs = {
            'ac-12': [
                {seq: 1, role: 'user', content: 'Revisá el plan de despliegue del jueves y decime qué riesgos ves.', toolName: '', createdAt: aiNow - 5300},
                {seq: 2, role: 'assistant', content: 'Dos riesgos principales: la migración de la tabla de eventos corre en la misma ventana que el cambio de índices, y no hay un paso de vuelta atrás para el segundo. Separaría las dos ventanas o agregaría un `DROP INDEX CONCURRENTLY` preparado.', toolName: '', usage: {input: 410, output: 96, cacheRead: 0, thinking: 0, total: 506, costUsd: 0}, createdAt: aiNow - 5200},
            ],
        }
        const prev = fixtures.AgentChatMessages as (id: string) => unknown[]
        fixtures.AgentChatMessages = (id: string) => (msgs as Record<string, unknown[]>)[id] ?? prev(id)
        autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-12"]') ?? undefined)
        if (view === 'aichatlostcontinue') setTimeout(() => document.querySelector<HTMLButtonElement>('[data-continue-with-another]')?.click(), 1500)
    } else {
        // Un chat de Ollama local que sigue con el vLLM del servidor GPU.
        autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-11"]') ?? undefined)
        setTimeout(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${t().utilities.aiChat.header.providerLabel}"]`)?.click(), 1500)
        setTimeout(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('vLLM en el servidor GPU'))?.click(), 1800)
    }
}
if (view === 'aichatusage') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-10"]') ?? undefined)
    setTimeout(() => document.querySelector<HTMLButtonElement>('[data-usage-toggle]')?.click(), 1400)
}
if (view === 'aichatwide') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-10"]') ?? undefined)
}
if (view === 'aichatnarrow' || view === 'aichatdrawer') {
    // Pestaña angosta: el historial no es una columna, así que se abre el cajón,
    // se elige la conversación (que lo cierra) y, para el cajón, se reabre.
    const toggle = () => document.querySelector<HTMLButtonElement>('[data-history-toggle]')?.click()
    setTimeout(toggle, 1000)
    setTimeout(() => clickChat('ac-10'), 1400)
    if (view === 'aichatdrawer') setTimeout(toggle, 1900)
}
if (view === 'aichatresize') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-10"]') ?? undefined)
    // Arrastre sin soltar: agarra el borde y lo corre 170 px a la derecha.
    setTimeout(() => {
        const handle = document.querySelector<HTMLElement>('[data-resize-handle]')
        if (!handle) return
        const r = handle.getBoundingClientRect()
        const x = r.left + r.width / 2
        handle.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, clientX: x, clientY: r.top + 200}))
        window.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: x + 170, clientY: r.top + 200}))
    }, 1600)
}
// Selector de proyecto del Chat de IA, manejado como lo haría una persona: se
// abre el menú y se elige una opción por su texto.
const openProjectMenu = () => {
    const label = t().utilities.aiChat.header.repoLabel
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click()
}
const pickProjectOption = (text: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(text))?.click()
if (view === 'projectpicker') setTimeout(openProjectMenu, 1100)
if (view === 'projecthint') {
    setTimeout(openProjectMenu, 1100)
    setTimeout(() => pickProjectOption('mini-tools'), 1400)
}
if (view === 'projectauto') {
    setTimeout(openProjectMenu, 1100)
    setTimeout(() => pickProjectOption('soporte-semanal'), 1400)
}
if (view === 'projectmanage' || view === 'projectremove') {
    setTimeout(openProjectMenu, 1100)
    setTimeout(() => pickProjectOption(t().utilities.aiChat.project.manage), 1400)
}
if (view === 'projectremove') {
    // Quitar la primera carpeta (soporte-semanal, con una conversación): la
    // confirmación tiene que decir que esa conversación se va con ella.
    setTimeout(() => document.querySelector<HTMLButtonElement>('[data-folder-remove]')?.click(), 1900)
}
if (view === 'projectcontext') {
    setTimeout(openProjectMenu, 1100)
    setTimeout(() => pickProjectOption('mini-tools'), 1400)
    setTimeout(() => document.querySelector<HTMLButtonElement>('[data-context-chip]')?.click(), 2000)
}
if (view === 'projectchat') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-11"]') ?? undefined)
}
if (view === 'aichatadd' || view === 'aichataddfail') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-10"]') ?? undefined)
    // Como lo haría una persona: abre el selector de proveedor y elige la
    // última opción.
    setTimeout(() => {
        const providerLabel = t().utilities.aiChat.header.providerLabel
        document.querySelector<HTMLButtonElement>(`button[aria-label="${providerLabel}"]`)?.click()
    }, 1300)
    setTimeout(() => {
        const add = t().settings.modelServers.addFromPicker
        ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes(add))?.click()
    }, 1600)
    setTimeout(() => {
        const m = t().settings.modelServers
        typeInto(document.querySelector<HTMLInputElement>(`[data-model-server-dialog] input[placeholder="${m.namePlaceholder}"]`), 'Ollama del servidor GPU')
        typeInto(document.querySelector<HTMLInputElement>('[data-model-server-dialog] input[placeholder="http://localhost:11434"]'), 'http://192.168.1.50:11434')
    }, 1900)
    if (view === 'aichataddfail') {
        setTimeout(() => {
            const m = t().settings.modelServers
            ;[...document.querySelectorAll<HTMLButtonElement>('[data-model-server-dialog] button')].find((b) => b.title === m.formTestTitle)?.click()
        }, 2300)
        // El resultado y el aviso quedan bajo el pliegue del diálogo: se baja hasta ellos.
        setTimeout(() => {
            const dlg = document.querySelector<HTMLElement>('[data-model-server-dialog]')
            if (dlg) dlg.scrollTop = dlg.scrollHeight
        }, 2900)
    }
}
if (view === 'aichatchat') {
    // Abre desde el historial la conversación con mensajes guardados, como lo
    // haría una persona: es el camino real de «retomar».
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-1"]') ?? undefined)
}
if (view === 'toolevents' || view === 'brainon' || view === 'approvalrisky' || view === 'healthred') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-8"]') ?? undefined)
}
if (view === 'norepo') {
    // Un servidor de modelos sin repositorio de trabajo: aviso de que solo tiene MCP.
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-5"]') ?? undefined)
}
if (view === 'remotewarn') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-9"]') ?? undefined)
}
if (view === 'brainsettings') {
    setTimeout(() => document.querySelector('[data-brain-settings]')?.scrollIntoView({block: 'start'}), 700)
}
// Filtros del historial del Chat de IA (vistas aichatfilters*) y renombrar desde
// la cabecera (aichatrename):
//   aichatfilters       filtros puestos, panel cerrado: las fichas en una línea
//   aichatfiltersopen   el panel abierto sobre la lista
//   aichatfilterscol    la columna del historial en su ancho mínimo, con el panel abierto
//   aichatfiltersmany   más fichas de las que entran: la línea se desplaza
//   aichatrename        el nombre de la conversación en la cabecera, editándose
views.aichatfilters = views.aichat
views.aichatfiltersopen = views.aichat
views.aichatfilterscol = views.aichat
views.aichatfiltersmany = views.aichat
views.aichatrename = views.aichat
if (view.startsWith('aichatfilters')) {
    const extra = (id: string, agentId: string, title: string, module: string, ctx: string, ago: number) => ({
        id, repoId: '', agentId, title, conversationId: `conv-${id}`, createdAt: aiNow - ago - 600, updatedAt: aiNow - ago, model: '', effort: '', mode: '', module, contextId: ctx, brain: false,
    })
    fixtures.ListAllAgentChats = [
        ...aiChats,
        extra('ac-12', 'claude', sessEs ? 'Por qué el rebase pide resolver el mismo conflicto' : 'Why the rebase keeps asking to resolve the same conflict', 'git', 'r1', 2000),
        extra('ac-13', 'codex', sessEs ? 'Limpiar las ramas viejas del release' : 'Clean up the old release branches', 'git', 'r3', 90000),
        extra('ac-14', 'claude', sessEs ? 'Índice faltante en PAGOS.ESTADO' : 'Missing index on PAGOS.ESTADO', 'db', 'c4', 4000),
        extra('ac-15', 'antigravity', sessEs ? 'Logs del batch de las 02:00' : 'Logs from the 02:00 batch', 'ssh', 's3', 8 * 86400),
        extra('ac-16', 'claude', sessEs ? 'Prueba del endpoint de pagos' : 'Payments endpoint test', 'http', 'h1', 700),
        extra('ac-17', 'claude', sessEs ? 'Chat con Claude Code' : 'Chat with Claude Code', 'utilities', '', 40 * 86400),
    ]
    try {
        localStorage.clear()
        const base = {providers: [] as string[], origins: [] as string[], date: 'all', state: 'any', order: 'recent'}
        const seeded =
            view === 'aichatfiltersmany'
                ? {...base, providers: ['claude', 'llm:ms1', 'codex'], origins: ['utilities|r4'], date: 'd30', order: 'name'}
                : {...base, providers: ['claude', 'llm:ms1'], origins: ['utilities|r4'], date: 'd30'}
        localStorage.setItem('mini-tools:aiChat:historyFilters', JSON.stringify({last: seeded, panes: {}, order: []}))
        if (view === 'aichatfilterscol') localStorage.setItem('mini-tools:aiChat:historyWidth', '240')
    } catch {
        // sin almacenamiento: la vista se ve sin los filtros sembrados
    }
    if (view !== 'aichatfilters' && view !== 'aichatfiltersmany') {
        autoClick(() => document.querySelector<HTMLButtonElement>('[data-filters-toggle]') ?? undefined)
    }
}
if (view === 'aichatrename') {
    autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-1"]') ?? undefined)
    setTimeout(() => document.querySelector<HTMLButtonElement>('[data-chat-title]')?.click(), 1700)
}
if (view === 'aichatsearch') {
    // Escribe en el buscador del historial (con el setter nativo, para que
    // React vea el cambio) y abre el primer resultado.
    autoClick(() => {
        const input = document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')
        if (!input) return undefined
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        set?.call(input, 'índice')
        input.dispatchEvent(new Event('input', {bubbles: true}))
        return document.body
    })
    // Y abre el primer resultado, que es lo que se hace después de buscar.
    setTimeout(() => autoClick(() => document.querySelector<HTMLButtonElement>('[data-chat-id="ac-1"]') ?? undefined), 1600)
}
if (view === 'thinking') {
    // El indicador de trabajo solo existe con un turno en curso, y un turno
    // en curso es el CLI corriendo. Se simula mandando un mensaje: el envío
    // pone la vista en "ocupado" y ahí se queda, porque la fixture nunca
    // emite el evento de fin.
    autoClick(() => {
        const ta = document.querySelector('textarea')
        if (!ta) return undefined
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        set?.call(ta, 'de qué trata el proyecto')
        ta.dispatchEvent(new Event('input', {bubbles: true}))
        return document.querySelector<HTMLButtonElement>('button[data-chat-send]') ?? undefined
    })
}
if (view === 'sidebarmenu' || view === 'sidebaropen' || view === 'sidebardown' || view === 'sidebardocker') {
    const expand = () =>
        [...document.querySelectorAll<HTMLButtonElement>('button[data-tree-toggle="closed"]')].forEach((b) => b.click())
    setTimeout(expand, 1200)
    setTimeout(expand, 1600)
    setTimeout(() => {
        // Solo las visibles: los módulos ocultos siguen montados y sus filas
        // cuentan igual en el DOM.
        const rows = [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].filter((r) => r.getClientRects().length > 0)
        if (view === 'sidebaropen') return
        const row = rows[Math.min(2, rows.length - 1)]
        const r = row?.getBoundingClientRect()
        row?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: (r?.left ?? 0) + 60, clientY: (r?.top ?? 0) + 14}))
    }, 2100)
}
if (view === 'workspace' || view === 'sidebar' || view === 'sidebarmenu' || view === 'sidebaropen' || view === 'sidebardown' || view === 'sidebardocker') {
    // Se abre una carpeta del árbol: la barra rediseñada se trata justamente
    // de la jerarquía, y con todas las carpetas plegadas la captura muestra
    // una lista plana que no prueba nada.
    // El que abre la carpeta es el chevron, no la fila: buscarlo por su
    // title es lo mismo que hacen las demás vistas — el Icon renderiza su
    // ligadura como texto, así que textContent no sirve para encontrarlo.
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title === 'Expandir carpeta'))
}
if (view === 'dockerlogs') {
    // El clic en el nombre del servicio abre el panel de logs del contenedor.
    autoClick(() => [...document.querySelectorAll('button')].find((b) => /^(Opens the live logs|Abre los logs)/.test(b.title) && b.textContent === 'api'))
}
if (view === 'sidebardocker') {
    // Abre Docker desde la barra para que la pestaña informe los contadores, y
    // pasa a «Imágenes» para ver el resaltado de la sección activa. El clic va al
    // botón de la fila (el último: el primero es el chevron), no a la fila.
    const rowButton = (re: RegExp) => {
        const row = [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].find((r) => re.test(r.textContent ?? ''))
        return [...(row?.querySelectorAll('button') ?? [])].pop() as HTMLElement | undefined
    }
    setTimeout(() => rowButton(/Docker/)?.click(), 1200)
    setTimeout(() => rowButton(/(Images|Imágenes)/)?.click(), 2600)
}
if (view === 'dockerexport') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => /^(Opens the live logs|Abre los logs)/.test(b.title) && b.textContent === 'api'))
    setTimeout(() => {
        ;[...document.querySelectorAll('button')].find((b) => /^(Saves the logs|Guarda los logs)/.test(b.title))?.click()
    }, 1500)
}
if (view === 'dockersearch') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => /^(Opens the live logs|Abre los logs)/.test(b.title) && b.textContent === 'api'))
    // Escribir en un campo controlado de React: hay que usar el setter nativo y
    // avisar con un evento `input`, o React no se entera.
    setTimeout(() => {
        const input = [...document.querySelectorAll('input')].find((i) => /^(Search the logs|Buscar en los logs)/.test(i.placeholder))
        if (!input) return
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'repartidor')
        input.dispatchEvent(new Event('input', {bubbles: true}))
    }, 1200)
}
if (view === 'tabmenu') {
    // Dos clics encadenados, como los daría una persona: el rótulo de la
    // pestaña abre su menú, y adentro está el selector de conexión.
    // Por atributo data-*, no por el tooltip ni el aria-label: cambian con el idioma.
    autoClick(() => document.querySelector<HTMLButtonElement>('button[data-tab-binding="bound"]') ?? undefined)
    setTimeout(() => {
        autoClick(() => document.querySelector<HTMLButtonElement>('[data-tab-connection-select] button') ?? undefined)
    }, 400)
}
if (view === 'settings') {
    const section = new URLSearchParams(location.search).get('section')
    // Por id de sección (data-section), no por el rótulo, que cambia con el
    // idioma. Se aceptan también los nombres de antes (Vault, Terminal, IA).
    const legacy: Record<string, string> = {apariencia: 'general', appearance: 'general', ia: 'ai'}
    const id = section ? (legacy[section.toLowerCase()] ?? section.toLowerCase()) : ''
    if (id) autoClick(() => document.querySelector<HTMLButtonElement>(`button[role="tab"][data-section="${id}"]`) ?? undefined)
}
if (view === 'modelserverform' || view === 'modelservertest' || view === 'modelserverdetected') {
    autoClick(() => document.querySelector<HTMLButtonElement>('button[role="tab"][data-section="ai"]') ?? undefined)
    setTimeout(
        () =>
            autoClick(() => {
                const btn = document.querySelector<HTMLButtonElement>(
                    view === 'modelserverform'
                        ? '[data-model-server-add]'
                        : view === 'modelserverdetected'
                          ? '[data-model-servers]'
                          : '[data-manage-in-utilities]',
                )
                // La sección queda debajo del panel de acceso: se trae a la vista
                // DESPUÉS del clic, porque el formulario o el resultado la alargan.
                if (btn) setTimeout(() => document.querySelector('[data-model-servers]')?.scrollIntoView({block: 'start'}), 300)
                return btn ?? undefined
            }),
        1200,
    )
}
// Cambia el valor de un input controlado por React (setter nativo + evento).
const fillInput = (el: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', {bubbles: true}))
}
if (view.startsWith('gitsidebar')) {
    // Se recorre el árbol como lo haría una persona: carpeta «Trabajo», el
    // repositorio, las carpetas de ramas y el grupo de remotos. Por texto de la
    // fila y no por tooltip, que cambia con el idioma.
    const row = (re: RegExp) => [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].find((r) => r.getClientRects().length > 0 && re.test(r.textContent ?? ''))
    const open = (re: RegExp) => row(re)?.querySelector<HTMLButtonElement>('[data-tree-toggle="closed"]')?.click()
    setTimeout(() => open(/Trabajo/), 1100)
    setTimeout(() => open(/chatwoot-clone/), 1400)
    setTimeout(() => open(/feature\d/), 2200)
    setTimeout(() => open(/claude\d/), 2400)
    setTimeout(() => open(/(Remotos|Remotes)\d/), 2600)
    setTimeout(() => open(/Tags\d/), 2800)
    setTimeout(() => open(/1\.3\d/), 3000)
    if (view === 'gitsidebarfilter') {
        setTimeout(() => {
            // La lupa de la fila del repositorio: es el primer botón de acción.
            const btns = [...(row(/chatwoot-clone/)?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
            btns[2]?.click()
        }, 3200)
        setTimeout(() => {
            const input = document.querySelector<HTMLInputElement>('input[placeholder^="Filtrar ramas"], input[placeholder^="Filter branches"]')
            if (input) fillInput(input, 'vault')
        }, 3600)
    }
    if (view === 'gitsidebartag') {
        setTimeout(() => {
            const r = row(/v1\.3\.1/)
            const box = r?.getBoundingClientRect()
            r?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: (box?.left ?? 0) + 90, clientY: (box?.top ?? 0) + 14}))
        }, 3400)
    }
    if (view === 'gitsidebarmenu') {
        setTimeout(() => {
            const r = row(/TIGOCHAT-11607/)
            const box = r?.getBoundingClientRect()
            r?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: (box?.left ?? 0) + 90, clientY: (box?.top ?? 0) + 14}))
        }, 3400)
    }
}
if (view === 'modelserverheaders' || view === 'modelserveredit') {
    autoClick(() => document.querySelector<HTMLButtonElement>('button[role="tab"][data-section="ai"]') ?? undefined)
    setTimeout(
        () =>
            autoClick(() =>
                document.querySelector<HTMLButtonElement>(view === 'modelserveredit' ? '[data-model-server-edit="ms2"]' : '[data-model-server-add]') ?? undefined,
            ),
        1200,
    )
    if (view === 'modelserverheaders') {
        // Un servidor nuevo detrás de Cloudflare Access con certificado propio:
        // se llenan los campos como lo haría una persona.
        // Cada paso en su propio tick: los manejadores del formulario leen el
        // estado del render anterior, y dos cambios en el mismo tick se pisan.
        const steps: (() => void)[] = [
            // El atajo de LM Studio fija el tipo «Compatible con OpenAI»; la dirección
            // se reescribe después, y con eso el atajo se suelta.
            () => document.querySelector<HTMLButtonElement>('[data-model-preset="lmstudio"]')?.click(),
            () => {
                const [name] = [...document.querySelectorAll<HTMLInputElement>('[data-model-servers] input')]
                if (name) fillInput(name, 'LM Studio del laboratorio')
            },
            () => {
                const url = document.querySelector<HTMLInputElement>('[data-model-servers] input[placeholder^="http"]')
                if (url) fillInput(url, 'https://192.168.1.50:1234/v1')
            },
            () => document.querySelector<HTMLButtonElement>('[data-model-servers] [data-header-add]')?.click(),
            () => document.querySelector<HTMLButtonElement>('[data-model-servers] [data-header-add]')?.click(),
            () => {
                const rows = [...document.querySelectorAll<HTMLElement>('[data-model-servers] [data-header-row]')]
                const first = rows[0]?.querySelectorAll<HTMLInputElement>('input')
                if (first) fillInput(first[0], 'CF-Access-Client-Id')
            },
            () => {
                const first = document.querySelectorAll<HTMLElement>('[data-model-servers] [data-header-row]')[0]?.querySelectorAll<HTMLInputElement>('input')
                if (first) fillInput(first[1], 'a1b2c3d4.access')
            },
            () => {
                const second = document.querySelectorAll<HTMLElement>('[data-model-servers] [data-header-row]')[1]?.querySelectorAll<HTMLInputElement>('input')
                if (second) fillInput(second[0], 'CF-Access-Client-Secret')
            },
            () => {
                const second = document.querySelectorAll<HTMLElement>('[data-model-servers] [data-header-row]')[1]?.querySelectorAll<HTMLInputElement>('input')
                if (second) fillInput(second[1], 'f3e9d2a8c7b6')
            },
            // La opción de certificado autofirmado, encendida.
            () => document.querySelector<HTMLButtonElement>('[data-insecure-tls] button[role="switch"]')?.click(),
            () => document.querySelector('[data-headers-editor]')?.scrollIntoView({block: 'center'}),
        ]
        steps.forEach((fn, i) => setTimeout(fn, 2400 + i * 90))
    } else {
        setTimeout(() => document.querySelector('[data-headers-editor]')?.scrollIntoView({block: 'center'}), 2500)
    }
}
if (view === 'modelservercontext') {
    // Un Ollama NUEVO con el atajo «en esta máquina»: la ventana de contexto
    // arranca en 16384 y el campo se trae a la vista.
    autoClick(() => document.querySelector<HTMLButtonElement>('button[role="tab"][data-section="ai"]') ?? undefined)
    setTimeout(() => autoClick(() => document.querySelector<HTMLButtonElement>('[data-model-server-add]') ?? undefined), 1200)
    setTimeout(() => document.querySelector<HTMLButtonElement>('[data-model-preset="ollamaLocal"]')?.click(), 2400)
    setTimeout(() => document.querySelector('[data-context-tokens]')?.scrollIntoView({block: 'center'}), 2700)
}
if (view === 'modelserverpresets' || view === 'modelserverremote') {
    autoClick(() => document.querySelector<HTMLButtonElement>('button[role="tab"][data-section="ai"]') ?? undefined)
    setTimeout(() => autoClick(() => document.querySelector<HTMLButtonElement>('[data-model-server-add]') ?? undefined), 1200)
    if (view === 'modelserverremote') {
        const steps: (() => void)[] = [
            () => document.querySelector<HTMLButtonElement>('[data-model-preset="ollamaRemote"]')?.click(),
            () => {
                const host = document.querySelector<HTMLInputElement>('[data-preset-host]')
                if (host) fillInput(host, '192.168.1.50')
            },
            () => {
                const port = document.querySelector<HTMLInputElement>('[data-preset-port]')
                if (port) fillInput(port, '11435')
            },
            () => document.querySelector('[data-model-presets]')?.scrollIntoView({block: 'start'}),
        ]
        steps.forEach((fn, i) => setTimeout(fn, 2400 + i * 120))
    } else {
        setTimeout(() => document.querySelector('[data-model-presets]')?.scrollIntoView({block: 'start'}), 2400)
    }
}
if (view === 'sidebarsearch') {
    // Se escribe en el buscador como lo haría una persona: el contador de
    // cada módulo del menú master solo existe con una búsqueda activa, así
    // que sin tipear no hay nada que fotografiar.
    autoClick(() => {
        const input = [...document.querySelectorAll('input')].find((i) => i.placeholder.startsWith('Buscar en todo'))
        if (!input) return undefined
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        set?.call(input, 'prod')
        input.dispatchEvent(new Event('input', {bubbles: true}))
        return undefined
    })
}
if (view === 'history') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.hasAttribute('data-agent-mode-toggle')))
    setTimeout(() => {
        autoClick(() => [...document.querySelectorAll('button')].find((b) => b.hasAttribute('data-agents-history')))
    }, 1200)
}
if (view === 'redis') {
    // La key se elige con un clic y no por prop: `initialKey` sirve para
    // llegar desde otra pestaña, pero lo que hay que fotografiar es el panel
    // de detalle con un valor cargado.
    autoClick(() => [...document.querySelectorAll('button, div[role="button"], span')].find((e) => e.textContent?.trim() === 'cart:u:1042') as HTMLElement | undefined)
}
if (view === 'notes') {
    // El cursor arranca en la línea 1, y en la línea del cursor la vista en
    // vivo muestra las marcas —es lo correcto para editar, pero para la foto
    // conviene ver el documento formateado de punta a punta. Se mueve el
    // cursor al final haciendo clic abajo de todo, como haría una persona.
    setTimeout(() => {
        const lines = [...document.querySelectorAll('.cm-line')]
        ;(lines[lines.length - 1] as HTMLElement | undefined)?.click()
    }, 1200)
}
if (view === 'notespreview') {
    autoClick(() => document.querySelector<HTMLElement>('button[data-note-preview-toggle]') ?? undefined)
}
if (view === 'mcp') {
    // El tutorial viene plegado: se abre, que es justamente lo que hay que
    // fotografiar.
    autoClick(() => document.querySelector<HTMLButtonElement>('button[data-mcp-howto]') ?? undefined)
}
if (view === 'gridtools' || view === 'gridrecord') {
    const setInput = (input: HTMLInputElement, value: string) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
        input.dispatchEvent(new Event('input', {bubbles: true}))
    }
    setTimeout(() => {
        const buttons = [...document.querySelectorAll('button')]
        if (view === 'gridtools') {
            const filter = document.querySelector<HTMLInputElement>('input[placeholder]')
            if (filter) setInput(filter, 'pr')
            buttons.find((b) => /Estad|Statist/.test(b.textContent ?? ''))?.click()
        } else {
            const cell = [...document.querySelectorAll('td')].find((td) => td.textContent?.trim() === 'polished-rain-974')
            cell?.parentElement?.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}))
            setTimeout(() => buttons.find((b) => /Registro|Record/.test(b.textContent ?? ''))?.click(), 200)
        }
    }, 900)
}
if (view === 'gridedit') {
    // Se edita una celda de verdad, como lo haría una persona: doble clic,
    // escribir, y confirmar. Así la captura muestra el estado que importa —la
    // barra de cambios pendientes— y no una grilla cualquiera.
    setTimeout(() => {
        const cell = [...document.querySelectorAll('td')].find((td) => td.textContent?.trim() === 'white-sound-246')
        cell?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))
        setTimeout(() => {
            const input = document.querySelector('td input') as HTMLInputElement | null
            if (!input) return
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            set?.call(input, 'white-sound-2467')
            input.dispatchEvent(new Event('input', {bubbles: true}))
            input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
        }, 250)
    }, 900)
}
if (view === 'http') {
    // Se arma la foto como la armaría una persona: se despliega la colección,
    // se abre el cuerpo de la petición y se manda. Una captura del módulo con
    // el árbol plegado y sin respuesta no muestra nada de lo que hace.
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Reserve v3')))
    setTimeout(() => {
        document.querySelector<HTMLButtonElement>('button[data-http-section="body"]')?.click()
    }, 1400)
    setTimeout(() => {
        document.querySelector<HTMLButtonElement>('button[data-http-send]')?.click()
    }, 1800)
}
if (view === 'commitgraph') {
    // Elegir el commit alcanza: la pestaña selecciona sola su primer archivo y
    // pide el diff (ver el efecto de GitChangedFiles en GitRepoTab).
    autoClick(() =>
        [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) =>
            b.textContent?.includes('feat: Add agent chat functionalities'),
        ),
    )
}
if (view === 'schemaprefix') {
    try {
        localStorage.setItem('mini-tools.schemaTree.groupByPrefix', '1')
    } catch {
        // sin almacenamiento la vista sale sin agrupar
    }
    const meta = fixtures.GetSchemaMetadata as {tables: {schema: string; name: string; columns: never[]; foreignKeys: never[]}[]}
    for (const name of ['FACTURA_ANULADA', 'FACTURA_HIST', 'TMP_RECIBO', 'TMP_LECTURA', 'TMP_TRANSAC', 'AUD_FACTURACION', 'AUD_FACTURACION_CFG']) {
        meta.tables.push({schema: 'SGCPRO', name, columns: [], foreignKeys: []})
    }
    // Clic en la fila del árbol (columna izquierda) cuyo texto es exactamente
    // `text`: carpeta → conexión → esquema → grupo, cada uno cuando el
    // anterior ya se desplegó.
    const clickRow = (text: string) => {
        const leaf = [...document.querySelectorAll<HTMLElement>('span, div, button')].find(
            (el) => el.childElementCount === 0 && el.textContent?.trim() === text && el.getBoundingClientRect().left < 280,
        )
        leaf?.dispatchEvent(new MouseEvent('click', {bubbles: true}))
    }
    setTimeout(() => clickRow('Producción'), 900)
    setTimeout(() => clickRow('SGCPRO · producción'), 1400)
    setTimeout(() => clickRow('SGCPRO'), 2200)
    setTimeout(() => clickRow('TMP_*'), 2800)
}
if (view === 'gridexpr') {
    setTimeout(() => {
        const cell = [...document.querySelectorAll('td')].find((td) => td.textContent?.trim() === '2026-06-24 22:48:01.016058')
        cell?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}))
        setTimeout(() => {
            ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'fx')?.click()
            setTimeout(() => {
                const input = document.querySelector('td input') as HTMLInputElement | null
                if (!input) return
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'NOW()')
                input.dispatchEvent(new Event('input', {bubbles: true}))
                setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})), 150)
            }, 200)
        }, 300)
    }, 900)
}
if (view === 'schematree') {
    // Dos pasos: primero se despliega la conexión (que dispara la lectura del
    // catálogo), y recién después el esquema que aparece adentro. Encadenados
    // por título porque el ícono renderiza su ligadura como texto y
    // textContent no sirve para encontrar el botón.
    autoClick(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.title === 'Expandir'))
    setTimeout(() => {
        const schema = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
            b.textContent?.includes('SGCPRO'),
        )
        schema?.click()
    }, 1600)
    // Y se pliega "Tablas", que se abre sola: con las ocho tablas desplegadas
    // las otras cuatro categorías quedan fuera de la foto, y lo que la foto
    // tiene que mostrar es justamente que el árbol no es solo tablas.
    setTimeout(() => {
        const tablas = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
            b.title === 'Ocultar tablas',
        )
        tablas?.click()
    }, 2100)
}
if (view === 'pullnoticeopen') {
    autoClick(() => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.hasAttribute('data-pull-notice-toggle')))
}
if (view === 'chatmode') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Chat · Claude Code')))
}

// Utilidad «Proveedores de IA» (antes «Modelos»): servidores propios y APIs en la nube.
//   models         Ollama local: tabla con un modelo cargado en memoria
//   modelspull     descargas en curso: una con avance, una arrancando y una que falló
//   modelsdetail   el panel de detalle abierto sobre un modelo
//   modelsopenai   servidor compatible con OpenAI: solo lectura
//   modelsdelete   Ollama remoto, con la confirmación de borrado abierta
//   modelsnarrow   la misma tabla en un panel angosto
// Y la columna de servidores (cuatro: dos locales, dos remotos, uno caído):
//   modelsservers          columna con varios servidores y la prueba de conexión en línea
//   modelsserverdown       el servidor caído elegido: error en la tabla y punto rojo
//   modelsserveredit       diálogo de edición abierto desde la pestaña
//   modelsserverduplicate  diálogo de duplicado (nombre «… (copia)», sin token)
//   modelsserverdelete     confirmación de eliminar un servidor
//   modelsserversmenu      el menú ⋯ de una fila abierto
//   modelsserversempty     sin servidores: la explicación y los atajos
//   modelsserversnarrow    pestaña angosta con el cajón de servidores abierto
//   modelsserversmany      nueve servidores: aparece el buscador
// Y la versión de proveedores (tres grupos: locales, remotos y nube; uno apagado):
//   (modelservertest usa la misma lista en el resumen de Configuración → IA)
//   modelsproviders          la lista con Anthropic elegido (modelos, solo lectura)
//   modelsprovidersoff       el proveedor apagado elegido: fila atenuada y aviso
//   modelsprovidersusage     la pestaña Consumo del proveedor elegido
//   modelsprovidersconfig    la pestaña Configuración
//   modelsprovidersform      alta con el atajo de OpenRouter: API key obligatoria
//   modelsprovidersformkey   lo mismo con la API key escrita y el modelo por defecto
const modelsNow = Date.now()
const modelsAgo = (days: number) => new Date(modelsNow - days * 86400000).toISOString()
const OLLAMA_MODELS = [
    {name: 'llama3.2:3b', size: 2019393189, modifiedAt: modelsAgo(3), digest: 'sha256:a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72', family: 'llama', parameterSize: '3.2B', quantizationLevel: 'Q4_K_M', format: 'gguf'},
    {name: 'qwen2.5-coder:7b', size: 4683087332, modifiedAt: modelsAgo(1), digest: 'sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364', family: 'qwen2', parameterSize: '7.6B', quantizationLevel: 'Q4_K_M', format: 'gguf'},
    {name: 'gemma3:4b', size: 3338801804, modifiedAt: modelsAgo(12), digest: 'sha256:a2af6cc3eb7fa8be8504abaf9b04e88f17a119ec3f04a3addf55f92841195f25', family: 'gemma3', parameterSize: '4.3B', quantizationLevel: 'Q4_K_M', format: 'gguf'},
    {name: 'nomic-embed-text:latest', size: 274302450, modifiedAt: modelsAgo(40), digest: 'sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f', family: 'nomic-bert', parameterSize: '137M', quantizationLevel: 'F16', format: 'gguf'},
    {name: 'deepseek-r1:14b', size: 8988124069, modifiedAt: modelsAgo(21), digest: 'sha256:6e9f90f02bb3b39b59e81916e8cfce9deb45aeaeb9a54a5be4414486b907dc1e', family: 'qwen2', parameterSize: '14.8B', quantizationLevel: 'Q4_K_M', format: 'gguf'},
    {name: 'mistral:7b-instruct', size: 4113301824, modifiedAt: modelsAgo(95), digest: 'sha256:f974a74358d62a017b37c6f424fcdf2951643b5c3d8a1f5ab9abd84ea5f3b1d1', family: 'llama', parameterSize: '7.2B', quantizationLevel: 'Q4_0', format: 'gguf'},
]
const OPENAI_MODELS = [
    {name: 'Qwen/Qwen2.5-Coder-32B-Instruct-AWQ', size: 0, modifiedAt: '', digest: '', family: '', parameterSize: '', quantizationLevel: '', format: ''},
    {name: 'meta-llama/Llama-3.1-8B-Instruct', size: 0, modifiedAt: '', digest: '', family: '', parameterSize: '', quantizationLevel: '', format: ''},
    {name: 'text-embedding-nomic-embed-text-v1.5', size: 0, modifiedAt: '', digest: '', family: '', parameterSize: '', quantizationLevel: '', format: ''},
]
const modelsView = new URLSearchParams(location.search).get('view') ?? ''
if (modelsView.startsWith('models')) {
    const remoteOllama = {id: 'ms4', name: 'Ollama del servidor GPU', kind: 'ollama', baseUrl: 'http://10.0.4.20:11434', hasToken: true, isLocal: false, insecureTls: false, contextTokens: 8192, enabled: true, defaultModel: '', sortOrder: 0, headerNames: ['X-Api-Key'], createdAt: 1786741440, updatedAt: 1786741440}
    // Cuatro servidores: dos locales (un Ollama y un LM Studio) y dos remotos (un
    // vLLM detrás de Cloudflare Access y un LM Studio del laboratorio, apagado).
    const serversBase = [
        {id: 'ms1', name: 'Ollama local', kind: 'ollama', baseUrl: 'http://localhost:11434', hasToken: false, isLocal: true, insecureTls: false, contextTokens: 16384, enabled: true, defaultModel: '', sortOrder: 0, headerNames: [], createdAt: 1786741440, updatedAt: 1786741440},
        {id: 'ms5', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', hasToken: false, isLocal: true, insecureTls: false, contextTokens: 0, enabled: true, defaultModel: '', sortOrder: 0, headerNames: [], createdAt: 1786741440, updatedAt: 1786741440},
        {id: 'ms2', name: 'vLLM en el servidor GPU', kind: 'openai', baseUrl: 'https://gpu.example.com/v1', hasToken: true, isLocal: false, insecureTls: false, contextTokens: 0, enabled: true, defaultModel: '', sortOrder: 0, headerNames: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'], createdAt: 1786741440, updatedAt: 1786741440},
        {id: 'ms3', name: 'LM Studio del laboratorio', kind: 'openai', baseUrl: 'https://192.168.1.50:1234/v1', hasToken: false, isLocal: false, insecureTls: true, contextTokens: 0, enabled: true, defaultModel: '', sortOrder: 0, headerNames: [], createdAt: 1786741440, updatedAt: 1786741440},
    ]
    // Proveedores mezclados: dos locales, dos remotos (uno apagado) y tres de la nube.
    const mk = (o: Record<string, unknown>) => ({createdAt: 1786741440, updatedAt: 1786741440, headerNames: [] as string[], contextTokens: 0, insecureTls: false, defaultModel: '', enabled: true, sortOrder: 0, ...o})
    const providers = [
        mk({id: 'ms1', name: 'Ollama local', kind: 'ollama', baseUrl: 'http://localhost:11434', hasToken: false, isLocal: true, contextTokens: 16384, sortOrder: 0}),
        mk({id: 'ms5', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', hasToken: false, isLocal: true, sortOrder: 1}),
        mk({id: 'ms2', name: 'vLLM en el servidor GPU', kind: 'openai', baseUrl: 'https://gpu.example.com/v1', hasToken: true, isLocal: false, headerNames: ['CF-Access-Client-Id', 'CF-Access-Client-Secret'], sortOrder: 2}),
        mk({id: 'ms3', name: 'LM Studio del laboratorio', kind: 'openai', baseUrl: 'https://192.168.1.50:1234/v1', hasToken: false, isLocal: false, insecureTls: true, enabled: false, sortOrder: 3}),
        mk({id: 'mc1', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', hasToken: true, isLocal: false, defaultModel: 'anthropic/claude-sonnet-4.5', sortOrder: 4}),
        mk({id: 'mc2', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', hasToken: true, isLocal: false, defaultModel: 'claude-opus-5-5', sortOrder: 5}),
        mk({id: 'mc3', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', hasToken: true, isLocal: false, sortOrder: 6}),
    ]
    const extraServers = Array.from({length: 5}, (_, i) => ({
        id: `mx${i}`,
        name: ['Ollama del portátil de Ana', 'Ollama del NAS', 'llama.cpp del rack', 'vLLM de pruebas', 'Ollama de la nube'][i],
        kind: i === 2 || i === 3 ? 'openai' : 'ollama',
        baseUrl: i === 4 ? 'https://models.example.com' : `http://10.0.4.${30 + i}:11434`,
        hasToken: i === 4,
        isLocal: false,
        insecureTls: false,
        contextTokens: 0,
        enabled: true, defaultModel: '', sortOrder: 0, headerNames: [],
        createdAt: 1786741440,
        updatedAt: 1786741440,
    }))
    fixtures.ListModelServers =
        modelsView === 'modelsserversempty'
            ? []
            : modelsView.startsWith('modelsproviders') || modelsView === 'modelservertest'
              ? providers
              : modelsView === 'modelsdelete'
              ? [remoteOllama, ...serversBase]
              : modelsView === 'modelsserversmany'
                ? [...serversBase, ...extraServers]
                : serversBase
    const CLOUD_MODELS = (names: string[]) => names.map((name) => ({name, size: 0, modifiedAt: '', digest: '', family: '', parameterSize: '', quantizationLevel: '', format: ''}))
    const ANTHROPIC_MODELS = CLOUD_MODELS(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-4-8'])
    const OPENROUTER_MODELS = CLOUD_MODELS(['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-r1'])
    const OPENAI_CLOUD_MODELS = CLOUD_MODELS(['gpt-5', 'gpt-5-mini', 'gpt-4o', 'o4-mini'])
    const cloudModels = (id: string) => (id === 'mc2' ? ANTHROPIC_MODELS : id === 'mc1' ? OPENROUTER_MODELS : id === 'mc3' ? OPENAI_CLOUD_MODELS : null)
    if (modelsView.startsWith('modelsproviders')) {
        // El backend simulado guarda el orden y el estado, como el real: sin eso, el
        // «releer la lista» que sigue a cada cambio devolvería siempre la de fábrica.
        let state = providers as unknown as {id: string; sortOrder: number; enabled: boolean}[]
        fixtures.ListModelServers = () => state
        fixtures.ReorderModelServers = (ids: string[]) => {
            state = ids.map((id, i) => ({...state.find((x) => x.id === id)!, sortOrder: i}))
        }
        fixtures.SetModelServerEnabled = (id: string, enabled: boolean) => {
            state = state.map((x) => (x.id === id ? {...x, enabled} : x))
        }
        fixtures.TestModelServer = {ok: true, version: '', models: OPENROUTER_MODELS.map((m) => m.name), error: '', latencyMs: 241, checkedAt: Date.now()}
    }
    fixtures.ModelServerHealth = (id: string) => ({
        ok: id !== 'ms3',
        version: id === 'ms1' || id === 'ms4' ? '0.5.7' : '',
        models: cloudModels(id)?.map((m) => m.name) ?? (id === 'ms1' || id === 'ms4' ? OLLAMA_MODELS.map((m) => m.name) : id === 'ms3' ? [] : OPENAI_MODELS.map((m) => m.name)),
        error: id === 'ms3' ? 'dial tcp 192.168.1.50:1234: connect: connection refused' : '',
        latencyMs: id === 'ms1' ? 38 : id === 'ms5' ? 22 : id === 'ms2' ? 142 : id === 'ms3' ? 0 : id === 'mc2' ? 187 : id === 'mc1' ? 241 : id === 'mc3' ? 203 : 64,
        checkedAt: Date.now() - 12000,
    })
    try {
        localStorage.setItem(
            'mini-tools:modelManager:server',
            modelsView === 'modelsopenai' || modelsView.startsWith('modelsserveredit') || modelsView === 'modelsserverduplicate' || modelsView === 'modelsserverdelete' || modelsView === 'modelsserversmenu'
                ? 'ms2'
                : modelsView === 'modelsdelete'
                  ? 'ms4'
                  : modelsView === 'modelsserverdown' || modelsView === 'modelsprovidersoff'
                    ? 'ms3'
                    : modelsView.startsWith('modelsproviders')
                      ? 'mc2'
                      : 'ms1',
        )
        localStorage.removeItem('mini-tools:modelManager:serversWidth')
        localStorage.removeItem('mini-tools:modelManager:serversOpen')
    } catch {
        // sin almacenamiento: arranca con el primer servidor
    }
    Object.assign(fixtures, {
        ModelServerModels: (id: string) => {
            if (id === 'ms3') throw new Error(uiLang === 'es' ? 'no se pudo conectar a https://192.168.1.50:1234: la conexión fue rechazada (¿está el servidor en marcha?)' : 'could not connect to https://192.168.1.50:1234: connection refused (is the server running?)')
            return cloudModels(id) ?? (id === 'ms2' || id === 'ms5' || id === 'mx2' || id === 'mx3' ? OPENAI_MODELS : OLLAMA_MODELS)
        },
        ModelServerRunning: (id: string) =>
            id === 'ms1' || id === 'ms4'
                ? [{name: 'qwen2.5-coder:7b', size: 6234578944, sizeVram: 6234578944, expiresAt: new Date(modelsNow + 4.6 * 60000).toISOString(), contextLength: 4096}]
                : [],
        ModelServerShowModel: (_id: string, name: string) => ({
            name,
            family: 'qwen2',
            parameterSize: '7.6B',
            quantizationLevel: 'Q4_K_M',
            format: 'gguf',
            parameters: 'repeat_penalty 1.05\nstop "<|im_start|>"\nstop "<|im_end|>"\ntemperature 0.7\ntop_k 20\ntop_p 0.8',
            template:
                '{{- if .Suffix }}<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>\n{{- else if .Messages }}\n{{- range $i, $_ := .Messages }}\n<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n{{ end }}',
            license: 'Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION…',
            contextLength: 32768,
            capabilities: ['completion', 'tools', 'insert'],
        }),
        ModelServerPulls:
            modelsView === 'modelspull'
                ? [
                      {pullId: 'p1', serverId: 'ms1', model: 'qwen3:8b', status: 'pulling a3de86cd1c13', completed: 2214592512, total: 5225376768, percent: 42.4, done: false, error: '', cancelled: false, startedAt: modelsNow - 40000},
                      {pullId: 'p2', serverId: 'ms1', model: 'gemma3:12b', status: 'pulling manifest', completed: 0, total: 0, percent: 0, done: false, error: '', cancelled: false, startedAt: modelsNow - 3000},
                      {
                          pullId: 'p3',
                          serverId: 'ms1',
                          model: 'qwen9:70b',
                          status: 'pulling manifest',
                          completed: 0,
                          total: 0,
                          percent: 0,
                          done: true,
                          error: uiLang === 'es' ? 'el servidor http://localhost:11434 no pudo descargar el modelo: pull model manifest: file does not exist' : 'the server http://localhost:11434 could not pull the model: pull model manifest: file does not exist',
                          cancelled: false,
                          startedAt: modelsNow - 60000,
                      },
                  ]
                : [],
        ModelServerPull: 'p1',
        ModelServerCancelPull: null,
        ModelServerDismissPull: null,
        ModelServerDeleteModel: null,
        ModelServerUnload: null,
    })
    if (modelsView === 'modelsdetail') {
        autoClick(() => document.querySelector<HTMLElement>('tr[data-model="qwen2.5-coder:7b"] button[aria-pressed]') ?? undefined)
    }
    if (modelsView === 'modelsdelete') {
        autoClick(() => {
            const row = document.querySelector('tr[data-model="gemma3:4b"]')
            return row ? [...row.querySelectorAll<HTMLElement>('button')].pop() : undefined
        })
    }
    // La columna de servidores: cada vista aprieta el botón que una persona
    // apretaría.
    const serverAction = (key: string) => () => document.querySelector<HTMLElement>(`[data-server-action="${key}"]`) ?? undefined
    // Editar, duplicar y eliminar viven en la pestaña «Configuración»: se va
    // ahí y se aprieta el botón, como lo haría una persona.
    const configAction = (key: string) => {
        autoClick(() => document.querySelector<HTMLElement>('[data-provider-tab="config"]') ?? undefined)
        setTimeout(() => autoClick(() => document.querySelector<HTMLElement>(`[data-config-action="${key}"]`) ?? undefined), 1300)
    }
    if (modelsView === 'modelsservers') autoClick(serverAction('test'))
    if (modelsView === 'modelsserveredit') configAction('edit')
    if (modelsView === 'modelsserverduplicate') configAction('duplicate')
    if (modelsView === 'modelsserverdelete') configAction('delete')
    if (modelsView === 'modelsserversmenu') autoClick(() => document.querySelector<HTMLElement>('[data-server-menu="ms2"]') ?? undefined)
    if (modelsView === 'modelsserversnarrow') autoClick(() => document.querySelector<HTMLElement>('[data-servers-toggle]') ?? undefined)
    if (modelsView === 'modelsprovidersreorder') {
        // Alt+↓ sobre «Ollama local» lo pasa detrás de «LM Studio» (dentro de Locales) y el
        // interruptor de «OpenAI» lo apaga: el orden y el estado se pintan al instante.
        setTimeout(() => {
            const row = document.querySelector<HTMLElement>('[data-server-row="ms1"]')
            row?.focus()
            row?.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', altKey: true, bubbles: true}))
        }, 1400)
        setTimeout(() => document.querySelector<HTMLElement>('[data-server-id="mc3"] button[role="switch"]')?.click(), 1800)
    }
    if (modelsView === 'modelsprovidersusage') autoClick(() => document.querySelector<HTMLElement>('[data-provider-tab="usage"]') ?? undefined)
    if (modelsView === 'modelsprovidersconfig') autoClick(() => document.querySelector<HTMLElement>('[data-provider-tab="config"]') ?? undefined)
    if (modelsView === 'modelsprovidersform' || modelsView === 'modelsprovidersformkey') {
        autoClick(() => document.querySelector<HTMLElement>('[data-model-server-add]') ?? undefined)
        const fill = (el: HTMLInputElement | null | undefined, value: string) => {
            if (!el) return
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
            el.dispatchEvent(new Event('input', {bubbles: true}))
        }
        setTimeout(() => document.querySelector<HTMLElement>('[data-model-preset="openrouter"]')?.click(), 1500)
        if (modelsView === 'modelsprovidersformkey') {
            setTimeout(() => fill(document.querySelector<HTMLInputElement>('[data-token-input]'), 'sk-or-v1-0a1b2c3d4e5f6a7b8c9d'), 1800)
            setTimeout(() => {
                const m = t().settings.modelServers
                ;[...document.querySelectorAll<HTMLButtonElement>('[data-model-server-dialog] button')].find((b) => b.title === m.formTestTitle)?.click()
            }, 2100)
        }
        setTimeout(() => {
            const dlg = document.querySelector<HTMLElement>('[data-model-server-dialog]')
            if (dlg) dlg.scrollTop = modelsView === 'modelsprovidersformkey' ? dlg.scrollHeight : 280
        }, 2600)
    }
}
views.models = (
    <div className="h-full">
        <ModelManagerTab visible />
    </div>
)
views.modelspull = views.models
views.modelsdetail = views.models
views.modelsopenai = views.models
views.modelsdelete = views.models
views.modelsnarrow = views.models
views.modelsservers = views.models
views.modelsserverdown = views.models
views.modelsserveredit = views.models
views.modelsserverduplicate = views.models
views.modelsserverdelete = views.models
views.modelsserversmenu = views.models
views.modelsserversempty = views.models
views.modelsserversnarrow = views.models
views.modelsserversmany = views.models
views.modelsproviders = views.models
views.modelsprovidersoff = views.models
views.modelsprovidersusage = views.models
views.modelsprovidersreorder = views.models
views.modelsprovidersconfig = views.models
views.modelsprovidersform = views.models
views.modelsprovidersformkey = views.models
views.pullnoticeopen = views.pullnotice
// sidebarmenu: la barra (con UISHOT_MODULE) con todo desplegado y el menú
// contextual abierto sobre una fila — sirve para cualquier árbol hecho con
// TreeRow.
views.sidebarmenu = views.sidebar
views.sidebardown = views.sidebar
views.sidebardocker = views.sidebar
// sidebaropen: lo mismo, desplegado y sin menú (para ver las guías).
views.sidebaropen = views.sidebar
// unlock / unlockcreate: la pantalla de la clave maestra (vault ya creado /
// primera vez).
const {default: UnlockScreen} = await import('./components/lock/UnlockScreen')
views.unlock = <UnlockScreen isInitialized theme="dark" onToggleTheme={() => {}} onInitialize={async () => {}} onUnlock={async () => {}} onRestore={async () => {}} />
views.unlockcreate = <UnlockScreen isInitialized={false} theme="dark" onToggleTheme={() => {}} onInitialize={async () => {}} onUnlock={async () => {}} onRestore={async () => {}} />
// --- Adjuntos del chat (fase 8) --------------------------------------------
//
// Vistas del compositor con archivos adjuntos. No hay forma de elegir un
// archivo del sistema en un navegador sin intervención, así que estas vistas
// hacen lo que haría una persona arrastrando: disparan los eventos de arrastre
// con archivos de verdad (un PNG dibujado en un canvas, un PDF, código) sobre
// el chat, y pasan por el mismo código que la app real.
//
//   attachchips      Claude: imagen con miniatura, PDF y código, listos
//   attachescape     arrastre y Escape: el velo desaparece y soltar después no adjunta
//   attachpaste      lo mismo, pero pegando (⌘V) una captura con el nombre genérico `image.png`
//   attachwarn       Ollama sin visión: la imagen no se puede leer (Enviar apagado)
//   attachwarnpdf    servidor OpenAI-compatible: imagen dudosa y PDF no soportado
//   attachdrop       el velo de «soltá los archivos» durante un arrastre
//   attacherror      imagen demasiado grande y binario rechazado por Go
//   attachsent       el mensaje enviado con sus fichas (con miniatura)
//   attachresumed    una conversación retomada: fichas con ícono, sin miniatura
const attachViews = ['attachescape', 'attachpaste', 'attachchips', 'attachwarn', 'attachwarnpdf', 'attachdrop', 'attacherror', 'attachsent', 'attachresumed']
if (attachViews.includes(view)) {
    const es = uiLang === 'es'
    const mb = 1024 * 1024
    fixtures.AgentAttachmentCapabilities = (agentId: string) => {
        const base = {text: true, maxImageBytes: 5 * mb, maxPdfBytes: 24 * mb, maxTextBytes: 512 * 1024, maxCount: 10}
        if (agentId === 'llm:ms1') {
            return {
                ...base,
                images: false,
                pdf: false,
                known: true,
                note: es
                    ? 'El modelo qwen2.5-coder:7b de Ollama no tiene visión (no informa la capacidad «vision») y Ollama no lee PDF.'
                    : 'Ollama model qwen2.5-coder:7b has no vision (it does not report the "vision" capability) and Ollama does not read PDFs.',
            }
        }
        if (agentId === 'llm:ms2') {
            return {
                ...base,
                images: true,
                pdf: false,
                known: false,
                note: es
                    ? 'No se pudo comprobar qué admite este servidor: se supone que lee imágenes. Un servidor compatible con OpenAI no lee PDF.'
                    : 'Could not check what this server supports: images are assumed to work. An OpenAI-compatible server does not read PDFs.',
            }
        }
        return {...base, images: true, pdf: true, known: true, note: ''}
    }
    const sizeByName: Record<string, number> = {'captura-login.png': 184320}
    fixtures.SaveChatFile = (name: string, data: string) => {
        const ext = (name.split('.').pop() ?? '').toLowerCase()
        if (ext === 'exe') {
            throw new Error(
                es
                    ? `«${name}»: es un binario y no se puede adjuntar (solo imágenes, PDF y texto en UTF-8).`
                    : `«${name}»: it is a binary and can't be attached (only images, PDFs and UTF-8 text).`,
            )
        }
        const decoded = Math.floor(((data.length - data.indexOf(',') - 1) * 3) / 4)
        return {
            path: `/Users/demo/Library/Application Support/mini-tools/adjuntos/adjunto-3f9a1c_${name}`,
            name,
            kind: ext === 'png' ? 'image' : ext === 'pdf' ? 'pdf' : 'text',
            mime: ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : 'text/plain',
            size: sizeByName[name] ?? decoded,
        }
    }
    const pngFile = () =>
        new Promise<File>((resolve) => {
            const c = document.createElement('canvas')
            c.width = 360
            c.height = 220
            const g = c.getContext('2d')!
            const grad = g.createLinearGradient(0, 0, 360, 220)
            grad.addColorStop(0, '#1e3a5f')
            grad.addColorStop(1, '#0f172a')
            g.fillStyle = grad
            g.fillRect(0, 0, 360, 220)
            g.fillStyle = '#e2e8f0'
            g.fillRect(100, 50, 160, 120)
            g.fillStyle = '#cbd5e1'
            g.fillRect(116, 70, 128, 16)
            g.fillRect(116, 98, 128, 16)
            g.fillStyle = '#ef4444'
            g.fillRect(116, 130, 128, 24)
            g.fillStyle = '#ffffff'
            g.font = 'bold 14px sans-serif'
            g.fillText('401', 168, 147)
            c.toBlob((b) => resolve(new File([b!], 'captura-login.png', {type: 'image/png'})), 'image/png')
        })
    const pdfFile = () => new File([new Uint8Array(1_843_200).fill(37)], 'informe-q3.pdf', {type: 'application/pdf'})
    const goFile = () =>
        new File([('func Validate(tok Token) bool {\n\treturn tok.ExpiresAt.After(time.Now())\n}\n').repeat(40)], 'accounts_controller.go', {type: 'text/x-go'})
    const dt = (files: File[]) => {
        const d = new DataTransfer()
        for (const f of files) d.items.add(f)
        return d
    }
    const chatEl = () => document.querySelector('textarea')
    const fire = (type: string, files: File[]) =>
        chatEl()?.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt(files)}))
    const whenChat = (fn: () => void) => {
        const go = () => (chatEl() ? fn() : setTimeout(go, 120))
        setTimeout(go, 900)
    }
    const dropFiles = (files: File[]) => {
        fire('dragenter', files)
        fire('drop', files)
    }
    const agent = view === 'attachwarn' ? 'llm:ms1' : view === 'attachwarnpdf' ? 'llm:ms2' : 'claude'
    const label = view === 'attachwarn' ? 'Ollama local' : view === 'attachwarnpdf' ? 'vLLM en el servidor GPU' : 'Claude Code'
    views[view] = (
        <AgentChat
            sessionId={`chat-${view}`}
            context={{kind: 'db', id: 'c1', label: 'chatwoot_dev'}}
            agentId={agent}
            agentLabel={label}
            resumeChatId={view === 'attachresumed' ? 'chat-att' : 'chat-att-base'}
        />
    )
    aiChatMessages['chat-att-base'] = [
        {seq: 1, role: 'user', content: '¿Por qué falla el login de SGCPRO?', toolName: '', createdAt: aiNow - 900},
        {
            seq: 2,
            role: 'assistant',
            content: 'El problema está en la **validación del token**: expira antes de que se renueve la sesión.\n\nSi me pasás una captura del error o el archivo del controlador, lo confirmo.',
            toolName: '',
            usage: {input: 612, output: 64, cacheRead: 0, thinking: 0, total: 676, costUsd: 0.002},
            createdAt: aiNow - 880,
        },
    ]
    if (view === 'attachchips' || view === 'attachwarn') whenChat(async () => dropFiles([await pngFile(), ...(view === 'attachchips' ? [pdfFile()] : []), goFile()]))
    if (view === 'attachwarnpdf') whenChat(async () => dropFiles([await pngFile(), pdfFile(), goFile()]))
    if (view === 'attachescape') {
        whenChat(async () => {
            const png = await pngFile()
            fire('dragenter', [png])
            setTimeout(() => {
                window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
                setTimeout(() => fire('drop', [png]), 200)
            }, 300)
        })
    }
    if (view === 'attachpaste') {
        whenChat(async () => {
            const png = await pngFile()
            const shot = new File([png], 'image.png', {type: 'image/png'})
            chatEl()?.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: dt([shot])}))
        })
    }
    if (view === 'attachdrop') whenChat(async () => fire('dragenter', [await pngFile()]))
    if (view === 'attacherror') {
        whenChat(() =>
            dropFiles([
                new File([new Uint8Array(6 * mb)], 'pantalla-4k.png', {type: 'image/png'}),
                new File([new Uint8Array(2048).fill(77)], 'setup.exe', {type: 'application/x-msdownload'}),
                new File(['# Notas\n\n- revisar el refresh del token\n'], 'notas.md', {type: 'text/markdown'}),
            ]),
        )
    }
    if (view === 'attachsent') {
        whenChat(async () => {
            dropFiles([await pngFile(), pdfFile()])
            setTimeout(() => {
                const ta = chatEl()
                if (!ta) return
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
                    ta,
                    es ? 'No me deja entrar y sale este error. Te paso también el informe del trimestre.' : "I can't log in and this error shows up. Here's the quarterly report too.",
                )
                ta.dispatchEvent(new Event('input', {bubbles: true}))
                setTimeout(() => document.querySelector<HTMLElement>('[data-chat-send]')?.click(), 250)
            }, 700)
        })
    }
}
// Sesiones de IA: el workspace entero con unos pasos escritos a mano (abrir una
// conversación, dividir, tocar «Revisar»), que es la forma de fotografiar estados
// que sólo existen tras una interacción.
function AiSessHarness({steps, noToast = false}: {steps: (() => void)[]; noToast?: boolean}) {
    useEffect(() => {
        const ids = steps.map((fn, i) => window.setTimeout(fn, 1800 + i * 1400))
        // Las capturas de la cabecera del chat no deben quedar tapadas por el
        // aviso de aprobación que traen los datos de ejemplo.
        const iv = noToast
            ? window.setInterval(() => {
                  const el = document.querySelector<HTMLElement>(`[aria-label="${t().aiSessions.toast.region}"]`)
                  if (el) el.style.display = 'none'
              }, 100)
            : 0
        return () => {
            ids.forEach((id) => window.clearTimeout(id))
            if (iv) window.clearInterval(iv)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />
}
const clickEl = (sel: string, nth = 0) => () => document.querySelectorAll<HTMLElement>(sel)[nth]?.click()
// Pliega Docker (que arranca desplegado): deja el alto de la barra para las
// sesiones, que es lo que estas capturas muestran.
const collapseDocker = () =>
    [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].find((r) => r.querySelector('.truncate')?.textContent === 'Docker')?.querySelector<HTMLElement>('[data-tree-toggle]')?.click()
views.aisesssidebar = <AiSessHarness steps={[collapseDocker]} />
views.aisessreattach = <AiSessHarness steps={[() => requestOpenAiChat({chatId: 'as-1'})]} />
views.aisesstabs = <AiSessHarness steps={[() => requestOpenAiChat({chatId: 'as-1'}), () => requestOpenAiChat({chatId: 'as-3', newWindow: true})]} />
views.aisesssplit = (
    <AiSessHarness
        steps={[
            () => requestOpenAiChat({chatId: 'as-1'}),
            clickEl('[data-split-toggle]'),
            () => document.querySelectorAll('[data-aichat-root]')[1]?.querySelector<HTMLElement>('[data-chat-id="as-3"]')?.click(),
        ]}
    />
)
// Verificación del flujo de varias pestañas de Chat de IA con CLICS REALES (no
// con `requestOpenAiChat`): cada paso toca el botón o el atajo que tocaría una
// persona y deja en #trace cuántas pestañas de Chat de IA hay y cuál está activa.
// `./scripts/uishot.sh` no lo imprime: se lee con `--dump-dom`.
function AiNavProbe({steps, showTrace = false}: {steps: {label: string; run: () => void}[]; showTrace?: boolean}) {
    const [trace, setTrace] = useState<string[]>([])
    useEffect(() => {
        const snap = (label: string) => {
            const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab-kind="utility"]')]
            const active = document.querySelector<HTMLElement>('[data-tab-active]')?.dataset.tabId
            const roots = document.querySelectorAll('[data-aichat-root]').length
            setTrace((prev) => [...prev, `${label} => utilTabs=${tabs.length} aichatRoots=${roots} active=${tabs.findIndex((x) => x.dataset.tabId === active)}`])
        }
        const ids: number[] = []
        steps.forEach((st, i) => {
            ids.push(window.setTimeout(st.run, 1800 + i * 1500))
            ids.push(window.setTimeout(() => snap(st.label), 1800 + i * 1500 + 700))
        })
        return () => ids.forEach((id) => window.clearTimeout(id))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return (
        <>
            <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} uiFontScale={100} onChangeUIFontScale={() => {}} />
            <pre id="trace" className={showTrace ? 'fixed bottom-0 right-0 z-[100] bg-black/80 p-2 text-ui-10 text-white' : 'hidden'}>{trace.join('\n')}</pre>
        </>
    )
}
const shiftN = () => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'N', metaKey: true, shiftKey: true, bubbles: true}))
const pickMenu = (label: () => string) => () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(label()))?.click()
const tr = () => t().aiSessions.tabs
views.aisessnavprobe = (
    <AiNavProbe
        steps={[
            {label: 'open conversation as-1 (sidebar/recent)', run: () => requestOpenAiChat({chatId: 'as-1'})},
            {label: 'click [data-new-window] (icon next to split)', run: clickEl('[data-new-window]')},
            {label: 'Cmd+Shift+N', run: shiftN},
            {label: 'history "open in new tab" row button', run: () => document.querySelector<HTMLElement>(`button[aria-label="${tr().openInNewTab}"]`)?.click()},
            {label: 'Utilities > AI Chat row "+" [data-ai-new-tab]', run: clickEl('[data-ai-new-tab]')},
            {label: 'Utilities > AI Chat row menu -> split tab', run: () => { treeRowMenu(); setTimeout(pickMenu(() => t().utilities.sidebar.aiChat.newSplit), 300) }},
            {label: 'header split-button main (same tab: no new tab)', run: clickEl('[data-new-chat]')},
            {label: 'header menu -> new chat in a new tab', run: () => { clickEl('[data-new-chat-menu]')(); setTimeout(pickMenu(() => tr().newInNewTab), 300) }},
            {label: '+ Nueva menu -> Chat de IA', run: () => { clickEl('[data-new-menu]')(); setTimeout(pickMenu(() => t().editor.tabs.newAiChat), 300) }},
        ]}
    />
)
function treeRowMenu() {
    const name = t().utilities.tools.aiChat.name
    const row = [...document.querySelectorAll<HTMLElement>('[data-tree-row]')].find((r) => r.textContent?.includes(name))
    row?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 140, clientY: 190}))
}
views.aisessutilprobe = (
    <AiNavProbe
        steps={[
            {label: 'open conversation as-1', run: () => requestOpenAiChat({chatId: 'as-1'})},
            {label: 'utilities tree "+" [data-ai-new-tab]', run: clickEl('[data-ai-new-tab]')},
            {label: 'tree right-click menu -> new split tab', run: () => { treeRowMenu(); setTimeout(pickMenu(() => t().utilities.sidebar.aiChat.newSplit), 300) }},
            {label: 'tree child row click focuses first tab (active=0)', run: () => document.querySelectorAll<HTMLElement>('[data-tree-row] button[title^="' + (t().utilities.sidebar.aiChat.tabTitle({title: ''}).slice(0, 8)) + '"]')[0]?.click()},
        ]}
    />
)
views.aisessnewmenu = <AiSessHarness noToast steps={[() => requestOpenAiChat({chatId: 'as-1'}), clickEl('[data-new-chat-menu]')]} />
views.aisesssidemenu = <AiSessHarness noToast steps={[treeRowMenu]} />
views.aisessplusmenu = <AiSessHarness noToast steps={[() => requestOpenAiChat({chatId: 'as-1'}), clickEl('[data-new-menu]')]} />
views.aisessempty = <AiSessHarness noToast steps={[() => requestOpenAiChat({newWindow: true})]} />
views.aisessutiltabs = <AiSessHarness noToast steps={[() => requestOpenAiChat({chatId: 'as-1'}), () => requestOpenAiChat({newWindow: true}), () => requestOpenAiChat({chatId: 'as-3', newWindow: true})]} />
views.aisessutilmenu = (
    <AiSessHarness noToast steps={[() => requestOpenAiChat({chatId: 'as-1'}), () => requestOpenAiChat({chatId: 'as-3', newWindow: true}), treeRowMenu]} />
)
views.aisessapproval = <AiSessHarness steps={[clickEl('[data-approval-card] button')]} />
views.aisesstoast = (
    <AiSessHarness
        steps={[
            () => {
                const cbs = (anyWindow.__sessionCbs ?? []) as ((d: unknown) => void)[]
                for (const cb of cbs) cb(anyWindow.__sessionNext)
            },
        ]}
    />
)
// Cerrar una pestaña NO cierra el chat (vistas aisessbg*):
//   aisessbgtabmenu    clic derecho en una pestaña de Chat de IA
//   aisessbgclosetoast se cierra con la × la pestaña de un chat que trabaja
//   aisessbglist       Utilidades → Chat de IA → Activas con chats abiertos en segundo plano
//   aisessbgmenu       el menú ⋯ de la fila de uno de ellos
if (view.startsWith('aisessbg')) {
    const nowMs = Date.now()
    // Sin la tarjeta de aprobación de los datos de ejemplo: taparía el aviso.
    fixtures.ListPendingApprovals = []
    if (view === 'aisessbglist' || view === 'aisessbgmenu') {
        // Solo las filas que hacen falta: con las cinco de siempre la nueva
        // quedaría fuera de la ventana.
        const all = fixtures.ListAgentSessions as Record<string, unknown>[]
        const list = all.filter((x) => x.sessionId !== 'as-2' && x.sessionId !== 'as-5')
        fixtures.ListAgentSessions = list
        const title6 = sessEs ? 'Refactorizar el parser de logs' : 'Refactor the log parser'
        // La de «Migrar…» trabaja con su pestaña cerrada; la de «Refactorizar…»
        // terminó, ya la leíste y sigue abierta.
        for (const x of list) if (x.sessionId === 'as-1') Object.assign(x, {attached: false, detached: true})
        list.push({
            sessionId: 'as-6', chatId: 'as-6', agentId: 'claude', agentLabel: 'Claude Code', model: 'sonnet', mode: '', module: 'utilities', contextId: 'ws:w1', title: title6, status: 'idle',
            startedAt: nowMs - 2_400_000, lastEventAt: nowMs - 1_200_000, turnStartedAt: nowMs - 1_500_000, lastText: sessEs ? 'Listo: extraje el tokenizador y el parser quedó en 90 líneas.' : 'Done: I extracted the tokenizer and the parser is down to 90 lines.',
            pendingApprovalId: '', unread: false, attached: false, detached: true,
        })
        const chats = fixtures.ListAllAgentChats as Record<string, unknown>[]
        // Solo las abiertas que hacen falta: las otras dos salen del listado.
        for (const c of chats) if (c.id === 'as-2' || c.id === 'as-5') c.open = false
        chats.push({id: 'as-6', repoId: '', agentId: 'claude', title: title6, conversationId: 'conv-as-6', createdAt: aiNow - 2500, updatedAt: aiNow - 1200, model: 'sonnet', effort: '', mode: '', module: 'utilities', contextId: 'ws:w1', brain: false, open: true, pinned: false, lastStatus: 'idle'})
    }
}
const tabContextMenu = () => {
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab-kind="utility"]')]
    const tab = tabs[tabs.length - 1]
    const r = tab?.getBoundingClientRect()
    tab?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: (r?.left ?? 0) + 40, clientY: (r?.bottom ?? 0) - 4}))
}
const closeLastAiTab = () => {
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab-kind="utility"]')]
    tabs[tabs.length - 1]?.querySelector<HTMLElement>(`button[title="${t().aiSessions.tabs.closeTabTitle}"]`)?.click()
}
views.aisessbgtabmenu = <AiSessHarness noToast steps={[() => requestOpenAiChat({chatId: 'as-1'}), tabContextMenu]} />
views.aisessbgclosetoast = <AiSessHarness steps={[() => requestOpenAiChat({chatId: 'as-1'}), closeLastAiTab]} />
views.aisessbglist = <AiSessHarness noToast steps={[collapseDocker]} />
// Arranca en otro módulo (Conexiones): cerrar la pestaña de un chat que trabaja
// deja el aviso, y su «Ver» tiene que llevar a Utilidades → Chat de IA → Activas
// con esa fila a la vista y resaltada. aisesscollapsed: el estado de fábrica
// (Recientes plegado).
views.aisessreveal = (
    <AiSessHarness
        steps={[
            collapseDocker,
            () => requestOpenAiChat({chatId: 'as-1'}),
            closeLastAiTab,
            () => document.querySelector<HTMLElement>('[data-session-toast="background"] button')?.click(),
        ]}
    />
)
views.aisesscollapsed = <AiSessHarness noToast steps={[collapseDocker]} />
views.aisessbgmenu = <AiSessHarness noToast steps={[collapseDocker, () => document.querySelector<HTMLElement>('[data-ai-session="as-6"] [data-ai-row-menu]')?.click()]} />
// Renombrar conversaciones (vistas aisessrename*):
//   aisessrenametab    doble clic sobre la pestaña: el nombre pasa a ser un campo
//   aisessrenamemenu   clic derecho en la pestaña: «Renombrar…» arriba del menú
//   aisessrenametree   doble clic sobre la fila de la pestaña en Utilidades → Chat de IA
//   aisessdrafttab     un chat nuevo sin nombre ni proyecto: la pestaña dice «Nuevo chat»
const dblclickEl = (sel: string, nth = 0) => () =>
    document.querySelectorAll<HTMLElement>(sel)[nth]?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}))
const aiTabs = () => [...document.querySelectorAll<HTMLElement>('[data-tab-kind="utility"]')]
const twoChats = [() => requestOpenAiChat({chatId: 'as-1'}), () => requestOpenAiChat({chatId: 'as-3', newWindow: true}), collapseDocker]
views.aisessrenametab = <AiSessHarness noToast steps={[...twoChats, () => aiTabs()[1]?.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}))]} />
views.aisessrenamemenu = (
    <AiSessHarness
        noToast
        steps={[
            ...twoChats,
            () => {
                const tab = aiTabs()[1]
                const r = tab?.getBoundingClientRect()
                tab?.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: (r?.left ?? 0) + 40, clientY: (r?.bottom ?? 0) - 4}))
            },
        ]}
    />
)
views.aisessrenametree = (
    <AiSessHarness
        noToast
        steps={[
            ...twoChats,
            () => dblclickEl('[data-tree-row] button[title^="' + t().utilities.sidebar.aiChat.tabTitle({title: ''}).slice(0, 8) + '"]', 1)(),
        ]}
    />
)
views.aisessdrafttab = <AiSessHarness noToast steps={[() => requestOpenAiChat({chatId: 'as-1'}), () => requestOpenAiChat({newWindow: true}), collapseDocker]} />
// Conversaciones persistentes (vistas aisessopen*): Chat de IA → Abiertas con dos
// fijadas arriba (una trabajando, otra esperando un permiso) y debajo una que
// trabaja, una que falló, una que quedó INTERRUMPIDA al cerrar la app, una que
// terminó y un BORRADOR sin mensajes. Las tres últimas no tienen sesión viva: su
// estado sale de lo guardado en el vault.
//   aisessopen       la lista
//   aisessopenmenu   el menú ⋯ de la interrumpida: Abrir, Fijar, Renombrar…, Cerrar chat, Eliminar
if (view.startsWith('aisessopen')) {
    const chats = fixtures.ListAllAgentChats as Record<string, unknown>[]
    const byId = (id: string) => chats.find((c) => c.id === id) as Record<string, unknown>
    Object.assign(byId('as-1'), {pinned: true})
    Object.assign(byId('as-2'), {pinned: true})
    // «Generar los tests» sale de la lista (cerrada) para que quepan las demás.
    Object.assign(byId('as-3'), {open: false})
    const row = (id: string, agentId: string, title: string, ctx: string, ago: number, model: string, lastStatus: string) => ({
        id, repoId: '', agentId, title, conversationId: title ? `conv-${id}` : '', createdAt: aiNow - ago - 600, updatedAt: aiNow - ago, model, effort: '', mode: '', module: 'utilities', contextId: ctx, brain: false,
        open: true, pinned: false, lastStatus,
    })
    chats.push(
        row('as-7', 'claude', sessEs ? 'Auditar los índices de la tabla PAGOS' : 'Audit the indexes of the PAGOS table', 'ws:w1', 3600, 'sonnet', 'interrupted'),
        row('as-8', 'codex', sessEs ? 'Documentar el esquema de facturación' : 'Document the billing schema', 'r4', 7200, '', 'idle'),
        row('as-9', 'llm:ms1', '', 'ws:w1', 90, 'qwen2.5-coder:14b', ''),
    )
    const sessions = (fixtures.ListAgentSessions as Record<string, unknown>[]).filter((x) => x.sessionId !== 'as-3')
    fixtures.ListAgentSessions = sessions
    anyWindow.__sessionNext = sessions
}
views.aisessopen = <AiSessHarness noToast steps={[collapseDocker]} />
views.aisessopenmenu = <AiSessHarness noToast steps={[collapseDocker, () => document.querySelector<HTMLElement>('[data-ai-session="as-7"] [data-ai-row-menu]')?.click()]} />
// El idioma se fija antes de montar, igual que App.tsx lo carga antes de
// dibujar: UISHOT_LANG=es|en (por defecto, el de la app).
setLanguage(normalizeLang(new URLSearchParams(location.search).get('lang')))
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <div className="h-screen w-screen bg-surface text-on-surface">
            {views[view] ?? <p className="p-4">Vista desconocida: {view}. Hay: {Object.keys(views).join(', ')}</p>}
        </div>
    </StrictMode>,
)
