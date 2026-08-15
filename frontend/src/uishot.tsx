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

const repoFiles = [
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    'app/javascript/dashboard/App.vue',
    'app/javascript/dashboard/routes/index.js',
    'app/models/conversation.rb',
    'app/controllers/api/v1/accounts_controller.rb',
    'backend/git/files.go',
    'backend/agentchat/session.go',
    'config/routes.rb',
    'spec/models/conversation_spec.rb',
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
            {path: 'backend/git/files.go', origPath: '', indexStatus: 'M', workStatus: '', staged: true, untracked: false},
            {path: 'app/models/conversation.rb', origPath: '', indexStatus: '', workStatus: 'M', staged: false, untracked: false},
            {path: 'CLAUDE.md', origPath: '', indexStatus: '', workStatus: '?', staged: false, untracked: true},
        ],
    },
    GitReadWorkFile: {
        path: 'CLAUDE.md',
        content: '# Chatwoot Clone — Claude Instructions\n\n## CodeGraph Sync\n\n`.codegraph/` indexa este repo.\n\n## Estilo\n\n- **Español** para specs y commits.\n- Identificadores en inglés.\n\n| Nivel | Qué cambia |\n|---|---|\n| lite | Sin relleno |\n| ultra | Abreviado |\n',
        size: 240,
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
    AgentChatHistory: [
        {role: 'user', text: '¿Por qué falla el login de SGCPRO?', tools: []},
        {
            role: 'agent',
            text: '## Qué encontré\n\nEl problema está en la **validación del token**: expira antes de que se renueve la sesión.\n\n- `accounts_controller.rb` valida contra `Time.now` sin margen\n- El refresh corre en un job que puede demorar hasta 30s\n\n> Con la carga de producción esa ventana se abre en casi todos los logins.\n\n```ruby\nreturn if token.expires_at > Time.now + GRACE\n```\n\nSi te parece, lo cambio y agrego el test.',
            tools: [{name: 'Read', input: '{"file_path":"app/controllers/api/v1/accounts_controller.rb"}', summary: 'app/controllers/api/v1/accounts_controller.rb', detail: ''}],
        },
    ],
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
        {id: 'chat-1', repoId: 'r1', agentId: 'claude', title: 'Login SGCPRO', conversationId: 'conv-1', createdAt: 1786700000, updatedAt: 1786741440, model: 'opus', effort: 'high', mode: ''},
    ],
    GitRepoWorkspace: {openFiles: ['CLAUDE.md'], defaultAgent: ''},
    GitProbe: {available: true, version: '2.45.0', path: '/usr/bin/git', error: ''},
    GitBranches: [
        {name: 'develop', current: true, remote: false, upstream: 'origin/develop', ahead: 2, behind: 0, hash: 'a1b2c3d', subject: 'feat: panel de agentes'},
        {name: 'feature/login-fix', current: false, remote: false, upstream: '', ahead: 0, behind: 0, hash: 'e4f5a6b', subject: 'fix: token'},
        {name: 'origin/develop', current: false, remote: true, upstream: '', ahead: 0, behind: 0, hash: 'a1b2c3d', subject: ''},
        {name: 'origin/main', current: false, remote: true, upstream: '', ahead: 0, behind: 0, hash: 'c7d8e9f', subject: ''},
    ],
    GitTags: [
        {name: 'v1.2.0', hash: 'a1b2c3d', message: '', date: '2026-08-01'},
        {name: 'v1.1.0', hash: 'c7d8e9f', message: '', date: '2026-07-10'},
    ],
    GitRemotes: [{name: 'origin', fetchUrl: 'git@github.com:ejemplo/chatwoot-clone.git', pushUrl: ''}],
    GitStashes: [],
    GitLog: [
        {hash: 'a1b2c3d4e5f6', shortHash: 'a1b2c3d', subject: 'feat: panel de agentes con consumo y MCP', author: 'Dev', email: '', date: '2026-08-14', parents: ['c7d8e9f'], refs: ['develop']},
        {hash: 'c7d8e9f0a1b2', shortHash: 'c7d8e9f', subject: 'fix: validación del token de sesión', author: 'Dev', email: '', date: '2026-08-13', parents: [], refs: []},
    ],
    GitInProgress: '',
    GitForgeInfo: {provider: 'github', webUrl: 'https://github.com/ejemplo/chatwoot-clone', compareUrl: 'https://github.com/ejemplo/chatwoot-clone/compare/develop'},
    GitCommandLog: [],
    GitWorktrees: [],
    GetSettings: {gitSideWidth: 260, gitDiffWidth: 420, gitPanelDock: 'right', gitPanelSize: 460, // La vista `panelagents` prueba el botón "Agentes" de la barra de arriba,
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
const {default: AgentChat} = await import('./components/git/AgentChat')
const {default: GitRepoTab} = await import('./components/git/GitRepoTab')
const {default: Workspace} = await import('./components/Workspace')
const {default: RedisBrowserTab} = await import('./components/redis/RedisBrowserTab')

// --- Vistas ---------------------------------------------------------------

// La pestaña Git se reusa en dos vistas (`repo` y `agentmode`), así que se
// declara una vez.
const views_repo = (
    <GitRepoTab
        repoId="r1"
        repoName="chatwoot-clone"
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
    <AgentChat sessionId="chat-1" repoId="r1" agentId="claude" agentLabel="Claude Code" resumeConversationId="conv-1" />
)

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
            initialFiles={['CLAUDE.md']}
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
    redis: <RedisBrowserTab connId="c3" initialKey="cart:u:1042" initialKeyToken={1} />,
    agents: <GitAgentPanel repoId="r1" onOpenFile={() => {}} onAskAgent={() => {}} defaultAgent="" onSetDefaultAgent={() => {}} />,
    chat: views_chat,
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
if (view === 'redis') {
    // La key se elige con un clic y no por prop: `initialKey` sirve para
    // llegar desde otra pestaña, pero lo que hay que fotografiar es el panel
    // de detalle con un valor cargado.
    autoClick(() => [...document.querySelectorAll('button, div[role="button"], span')].find((e) => e.textContent?.trim() === 'cart:u:1042') as HTMLElement | undefined)
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
