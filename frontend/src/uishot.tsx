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

import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import './styles/globals.css'

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
    ],
    AgentChatSupported: true,
    AgentChatModes: ['', 'plan', 'approve', 'auto', 'edit'],
    AgentModelCatalog: {
        models: [
            {id: '', label: 'Por defecto', description: 'El que tenga configurado el CLI', efforts: []},
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
        agents: [
            {agent: 'claude', available: true, note: '', source: '', all: {input: 37210, output: 8646915, cacheWrite: 60985113, cacheRead: 3604530546, total: 3674199784, messages: 9309}, repo: {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 323200000, messages: 800}, firstDay: '2026-07-15', lastDay: '2026-08-14', byModel: [{key: 'claude-opus-5', total: 2055073573, percent: 60.1, messages: 5119}, {key: 'claude-opus-4-8', total: 834401643, percent: 21.5, messages: 1789}], byDay: [], cacheHitPercent: 98.4, activity: null},
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
    GitProbe: {available: true, version: '2.45.0', path: '/usr/bin/git', error: ''},
    GitBranches: [
        {name: 'develop', current: true, remote: false, upstream: 'origin/develop', ahead: 8, behind: 0, hash: '76d8575', subject: 'Add macOS and Windows binaries for mini-tools v1.3.1 release'},
        {name: 'main', current: false, remote: false, upstream: 'origin/main', ahead: 0, behind: 0, hash: '76d8575', subject: ''},
        {name: 'origin/develop', current: false, remote: true, upstream: '', ahead: 0, behind: 0, hash: '76d8575', subject: ''},
        {name: 'origin/main', current: false, remote: true, upstream: '', ahead: 0, behind: 0, hash: '76d8575', subject: ''},
    ],
    GitTags: [
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
    GitRemotes: [{name: 'origin', fetchUrl: 'git@github.com:rafael180496/mini-tools.git', pushUrl: ''}],
    GitStashes: [],
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
    GitForgeInfo: {provider: 'github', webUrl: 'https://github.com/rafael180496/mini-tools', compareUrl: 'https://github.com/rafael180496/mini-tools/compare/develop'},
    GitCommandLog: [],
    GitWorktrees: [],
    GetSettings: {gitSideWidth: 260, gitDiffWidth: 420, gitTermDock: 'bottom', gitTermSize: 520, // La vista `panelagents` prueba el botón "Agentes" de la barra de arriba,
    // que solo existe con el panel CERRADO — de ahí que la fixture dependa de
    // la vista.
    gitPanelTab: new URLSearchParams(location.search).get('view') === 'panelagents' ? '' : 'agents', gitSideHidden: false, gitDiffHidden: false, gitPanelSessions: [{id: 'chat-1', kind: 'chat', agentId: 'claude', title: 'Chat · Claude Code'}], gitDiffContext: 3, gitDiffIgnoreWs: false, gitDiffWrap: false},
    GitChangedFiles: [],
    GitDiff: {path: '', origPath: '', patch: '', isBinary: false, stat: {added: 0, removed: 0}},
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
    // --- Módulo de base de datos ---
    ListConnections: [
        {id: 'c1', name: 'Producción Oracle', dbType: 'oracle', host: 'db.ejemplo.local', port: 1521, database: 'SGCPRO', username: 'app', folderId: '', sortOrder: 0, environment: 'production', metadataSchemas: []},
        {id: 'c2', name: 'Postgres local', dbType: 'postgres', host: 'localhost', port: 5432, database: 'chatwoot', username: 'dev', folderId: '', sortOrder: 1, environment: 'development', metadataSchemas: []},
        {id: 'c3', name: 'Redis caché', dbType: 'redis', host: 'localhost', port: 6379, database: '0', username: '', folderId: '', sortOrder: 2, environment: 'development', metadataSchemas: []},
        {id: 'c4', name: 'Mongo eventos', dbType: 'mongodb', host: 'localhost', port: 27017, database: 'events', username: '', folderId: '', sortOrder: 3, environment: 'development', metadataSchemas: []},
        {id: 's1', name: 'app-prod', dbType: 'ssh', host: 'app.ejemplo.local', port: 22, database: '', username: 'deploy', folderId: '', sortOrder: 4, environment: 'production', metadataSchemas: []},
    ],
    ListFolders: [],
    GitListRepos: [
        {id: 'r1', name: 'chatwoot-clone', path: '/repos/chatwoot-clone', folderId: '', sortOrder: 0, createdAt: 0, pinnedBranches: []},
        {id: 'r2', name: 'mini-tools', path: '/repos/mini-tools', folderId: '', sortOrder: 1, createdAt: 0, pinnedBranches: []},
    ],
    ListRecentFiles: [],
    ListSchemas: ['SGCPRO', 'PUBLIC'],
    GetSchemaMetadata: {tables: [], views: [], routines: []},
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
    SearchNotesSmart: [],

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

    // --- Servidor MCP ------------------------------------------------------
    MCPServerStatus: {
        enabled: true,
        socketPath: '/Users/tu-usuario/Library/Application Support/mini-tools/mcp.sock',
        tools: 7,
        executable: '/Applications/mini-tools.app/Contents/MacOS/mini-tools',
        audit: [
            {tool: 'vault_search_notes', resource: 'pool de conexiones', denied: false, at: 1786741380},
            {tool: 'db_get_schema', resource: 'SGCPRO.FACTURAS', denied: false, at: 1786741260},
            {tool: 'vault_read_note', resource: 'Credenciales de laboratorio', denied: true, at: 1786741100},
            {tool: 'ssh_get_recent_logs', resource: 'sgc-app-01', denied: false, at: 1786740980},
        ],
    },

    QueryHistory: [],
}

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
anyWindow.runtime = {
    EventsOnMultiple: () => () => {},
    EventsOn: () => () => {},
    EventsOnce: () => () => {},
    EventsOff: () => {},
    EventsOffAll: () => {},
    EventsEmit: () => {},
    BrowserOpenURL: () => {},
    LogPrint: () => {},
    LogError: () => {},
    WindowGetSize: () => ({w: 1280, h: 860}),
    ClipboardSetText: () => Promise.resolve(true),
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
const {default: NoteEditorTab} = await import('./components/notes/NoteEditorTab')
const {default: NotesGraphView} = await import('./components/notes/NotesGraphView')
const {default: ResultGrid} = await import('./components/results/ResultGrid')
const {default: AgentUsagePanel} = await import('./components/agent/AgentUsagePanel')
const {default: AiAccessPanel} = await import('./components/AiAccessPanel')

// --- Vistas ---------------------------------------------------------------

// La pestaña Git se reusa en dos vistas (`repo` y `agentmode`), así que se
// declara una vez.
const views_repo = (
    <GitRepoTab
        repoId="r1"
        repoName="mini-tools"
        editorThemeId="auto"
        appTheme="dark"
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

const views: Record<string, React.ReactNode> = {
    // El módulo de base de datos entero: sidebar de conexiones, editor SQL y
    // resultados. Es el otro producto que vive en esta app.
    workspace: <Workspace theme="dark" onToggleTheme={() => {}} onLocked={() => {}} updateInfo={null} />,
    // La pestaña Git entera: es la única forma de ver el modo agente, la tira
    // de solapas y los acordeones, que dependen del layout completo.
    repo: views_repo,
    files: (
        <GitFileEditor
            repoId="r1"
            editorThemeId="auto"
            appTheme="dark"
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
    chatmode: views_repo,
    panelagents: views_repo,
    newmenu: views_repo,
    history: views_repo,
    redis: <RedisBrowserTab connId="c3" initialKey="cart:u:1042" initialKeyToken={1} />,
    agents: <GitAgentPanel repoId="r1" onOpenFile={() => {}} onAskAgent={() => {}} defaultAgent="" onSetDefaultAgent={() => {}} />,
    chat: views_chat,
    chatdb: views_chatdb,
    // La base de conocimiento: el editor con el Markdown ya formateado, la
    // barra de formato, los enlaces entre notas y el panel lateral.
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
    usage: (
        <div className="w-[420px]">
            <AgentUsagePanel
                agentLabel={(id) => ({claude: 'Claude Code', codex: 'Codex CLI', antigravity: 'Antigravity CLI'})[id] ?? id}
                session={{total: 15900, output: 974, cost: 0.0412}}
                onClose={() => {}}
            />
        </div>
    ),
    mcp: (
        <div className="w-[420px] p-3">
            <AiAccessPanel />
        </div>
    ),
    // Mismo componente: lo que cambia es que el harness le manda un mensaje,
    // que es la única forma de que exista un turno en curso que fotografiar.
    thinking: views_chat,
}

const view = new URLSearchParams(location.search).get('view') ?? 'files'

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

if (view === 'agentmode') {
    // Por title y no por texto: el Icon renderiza su ligadura como texto, así
    // que textContent es "smart_toyAgente" y nunca matchea "Agente".
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Modo agente')))
}
if (view === 'panelagents') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Asistentes de código')))
}
if (view === 'newmenu') {
    // El menú "Nueva" del panel de agentes: es donde aparecen las
    // conversaciones que el CLI ya tenía, y solo se ve abierto.
    // Primero el modo agente (para que exista la tira de la solapa Agentes) y
    // después el `+` de esa tira, que es donde vive el historial.
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Modo agente')))
    setTimeout(() => {
        autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Empezar una conversación nueva')))
    }, 400)
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
        return [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Manda el mensaje'))
    })
}
if (view === 'history') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Modo agente')))
    setTimeout(() => {
        autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Todas las conversaciones de este repositorio, por agente')))
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
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Ver la nota renderizada')))
}
if (view === 'mcp') {
    // El tutorial viene plegado: se abre, que es justamente lo que hay que
    // fotografiar.
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.title.startsWith('Los pasos exactos')))
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
if (view === 'chatmode') {
    autoClick(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Chat · Claude Code')))
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <div className="h-screen w-screen bg-surface text-on-surface">
            {views[view] ?? <p className="p-4">Vista desconocida: {view}. Hay: {Object.keys(views).join(', ')}</p>}
        </div>
    </StrictMode>,
)
