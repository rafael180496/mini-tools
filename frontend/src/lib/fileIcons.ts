// Iconos y colores semánticos por tipo de archivo y carpeta para el explorador
// unificado del proyecto, pestañas de editor y paleta de comandos.

export interface FileVisual {
    // Etiqueta corta monoespaciada (ej. "TS", "GO", "RB", "VUE") cuando aporta
    // reconocimiento instantáneo, o undefined para usar el ícono Material.
    badge?: string
    // Nombre de Material Symbols Outlined.
    icon: string
    // Clases Tailwind de color (compatible con modo claro y oscuro).
    color: string
}

const BY_FILENAME: Record<string, FileVisual> = {
    dockerfile: {icon: 'deployed_code', color: 'text-sky-400'},
    'docker-compose.yml': {icon: 'deployed_code', color: 'text-sky-400'},
    'docker-compose.yaml': {icon: 'deployed_code', color: 'text-sky-400'},
    'compose.yml': {icon: 'deployed_code', color: 'text-sky-400'},
    'compose.yaml': {icon: 'deployed_code', color: 'text-sky-400'},
    makefile: {icon: 'build', color: 'text-amber-400'},
    justfile: {icon: 'build', color: 'text-amber-400'},
    procfile: {icon: 'terminal', color: 'text-emerald-400'},
    gemfile: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    'gemfile.lock': {badge: 'RB', icon: 'lock', color: 'text-rose-400/70'},
    rakefile: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    brewfile: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    podfile: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    vagrantfile: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    'go.mod': {badge: 'GO', icon: 'code', color: 'text-cyan-400'},
    'go.sum': {badge: 'GO', icon: 'lock', color: 'text-cyan-400/70'},
    'go.work': {badge: 'GO', icon: 'code', color: 'text-cyan-400'},
    'cargo.toml': {badge: 'RS', icon: 'settings', color: 'text-orange-400'},
    'cargo.lock': {badge: 'RS', icon: 'lock', color: 'text-orange-400/70'},
    'package.json': {badge: '{}', icon: 'data_object', color: 'text-emerald-400'},
    'package-lock.json': {icon: 'lock', color: 'text-on-surface-variant/70'},
    'pnpm-lock.yaml': {icon: 'lock', color: 'text-amber-400/75'},
    'yarn.lock': {icon: 'lock', color: 'text-sky-400/75'},
    'tsconfig.json': {badge: 'TS', icon: 'settings', color: 'text-blue-400'},
    'claude.md': {icon: 'smart_toy', color: 'text-amber-400'},
    'agents.md': {icon: 'smart_toy', color: 'text-primary'},
    'gemini.md': {icon: 'smart_toy', color: 'text-sky-400'},
    'readme.md': {icon: 'menu_book', color: 'text-sky-400'},
    'changelog.md': {icon: 'history', color: 'text-sky-400'},
    license: {icon: 'gavel', color: 'text-amber-400/80'},
    'license.md': {icon: 'gavel', color: 'text-amber-400/80'},
    '.gitignore': {icon: 'visibility_off', color: 'text-orange-400/80'},
    '.gitattributes': {icon: 'tune', color: 'text-orange-400/80'},
    '.gitmodules': {icon: 'account_tree', color: 'text-orange-400/80'},
    '.dockerignore': {icon: 'deployed_code', color: 'text-sky-400/70'},
    '.editorconfig': {icon: 'tune', color: 'text-on-surface-variant'},
    '.env': {icon: 'key', color: 'text-amber-400'},
}

const BY_EXT: Record<string, FileVisual> = {
    // TypeScript / JavaScript
    ts: {badge: 'TS', icon: 'code', color: 'text-blue-400'},
    mts: {badge: 'TS', icon: 'code', color: 'text-blue-400'},
    cts: {badge: 'TS', icon: 'code', color: 'text-blue-400'},
    tsx: {badge: 'TX', icon: 'code', color: 'text-sky-400'},
    js: {badge: 'JS', icon: 'code', color: 'text-amber-400'},
    mjs: {badge: 'JS', icon: 'code', color: 'text-amber-400'},
    cjs: {badge: 'JS', icon: 'code', color: 'text-amber-400'},
    jsx: {badge: 'JX', icon: 'code', color: 'text-amber-300'},
    // Frontend frameworks
    vue: {badge: 'VU', icon: 'code', color: 'text-emerald-400'},
    svelte: {badge: 'SV', icon: 'code', color: 'text-orange-400'},
    astro: {badge: 'AS', icon: 'code', color: 'text-violet-400'},
    // Backend / Systems
    go: {badge: 'GO', icon: 'code', color: 'text-cyan-400'},
    rb: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    erb: {badge: 'EB', icon: 'code', color: 'text-rose-300'},
    rake: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    gemspec: {badge: 'RB', icon: 'diamond', color: 'text-rose-400'},
    jbuilder: {badge: 'RB', icon: 'data_object', color: 'text-rose-300'},
    py: {badge: 'PY', icon: 'code', color: 'text-yellow-400'},
    pyi: {badge: 'PY', icon: 'code', color: 'text-yellow-400'},
    rs: {badge: 'RS', icon: 'code', color: 'text-orange-400'},
    java: {badge: 'JV', icon: 'code', color: 'text-red-400'},
    kt: {badge: 'KT', icon: 'code', color: 'text-purple-400'},
    kts: {badge: 'KT', icon: 'code', color: 'text-purple-400'},
    scala: {badge: 'SC', icon: 'code', color: 'text-red-400'},
    php: {badge: 'PH', icon: 'code', color: 'text-indigo-400'},
    cs: {badge: 'C#', icon: 'code', color: 'text-violet-400'},
    c: {badge: 'C', icon: 'code', color: 'text-blue-300'},
    h: {badge: 'H', icon: 'code', color: 'text-violet-300'},
    cpp: {badge: 'C+', icon: 'code', color: 'text-blue-400'},
    cc: {badge: 'C+', icon: 'code', color: 'text-blue-400'},
    hpp: {badge: 'H+', icon: 'code', color: 'text-violet-400'},
    swift: {badge: 'SW', icon: 'code', color: 'text-orange-400'},
    dart: {badge: 'DT', icon: 'code', color: 'text-sky-400'},
    ex: {badge: 'EX', icon: 'code', color: 'text-purple-400'},
    exs: {badge: 'EX', icon: 'code', color: 'text-purple-400'},
    lua: {badge: 'LU', icon: 'code', color: 'text-blue-400'},
    zig: {badge: 'ZG', icon: 'code', color: 'text-amber-400'},
    // Web / Styles / Markup
    html: {badge: '<>', icon: 'html', color: 'text-orange-400'},
    htm: {badge: '<>', icon: 'html', color: 'text-orange-400'},
    css: {badge: '#', icon: 'css', color: 'text-sky-400'},
    scss: {badge: 'SC', icon: 'css', color: 'text-pink-400'},
    sass: {badge: 'SA', icon: 'css', color: 'text-pink-400'},
    less: {badge: 'LE', icon: 'css', color: 'text-indigo-400'},
    xml: {badge: 'XM', icon: 'code', color: 'text-orange-300'},
    svg: {icon: 'image', color: 'text-amber-400'},
    // Data / Config / Schema
    sql: {badge: 'SQ', icon: 'database', color: 'text-violet-400'},
    ddl: {badge: 'SQ', icon: 'database', color: 'text-violet-400'},
    prisma: {badge: 'PR', icon: 'database', color: 'text-teal-400'},
    graphql: {badge: 'GQ', icon: 'hub', color: 'text-pink-400'},
    gql: {badge: 'GQ', icon: 'hub', color: 'text-pink-400'},
    proto: {badge: 'PB', icon: 'data_object', color: 'text-teal-400'},
    json: {badge: '{}', icon: 'data_object', color: 'text-amber-300'},
    jsonc: {badge: '{}', icon: 'data_object', color: 'text-amber-300'},
    json5: {badge: '{}', icon: 'data_object', color: 'text-amber-300'},
    yaml: {badge: 'YM', icon: 'tune', color: 'text-rose-300'},
    yml: {badge: 'YM', icon: 'tune', color: 'text-rose-300'},
    toml: {badge: 'TM', icon: 'tune', color: 'text-orange-300'},
    ini: {icon: 'tune', color: 'text-on-surface-variant'},
    conf: {icon: 'tune', color: 'text-on-surface-variant'},
    cfg: {icon: 'tune', color: 'text-on-surface-variant'},
    tf: {badge: 'TF', icon: 'cloud', color: 'text-purple-400'},
    tfvars: {badge: 'TF', icon: 'cloud', color: 'text-purple-400'},
    hcl: {badge: 'TF', icon: 'cloud', color: 'text-purple-400'},
    // Docs
    md: {badge: 'MD', icon: 'article', color: 'text-sky-400'},
    mdx: {badge: 'MX', icon: 'article', color: 'text-sky-400'},
    markdown: {badge: 'MD', icon: 'article', color: 'text-sky-400'},
    txt: {icon: 'description', color: 'text-on-surface-variant'},
    pdf: {icon: 'picture_as_pdf', color: 'text-red-400'},
    // Shell / Scripts
    sh: {icon: 'terminal', color: 'text-emerald-400'},
    bash: {icon: 'terminal', color: 'text-emerald-400'},
    zsh: {icon: 'terminal', color: 'text-emerald-400'},
    fish: {icon: 'terminal', color: 'text-emerald-400'},
    ps1: {icon: 'terminal', color: 'text-blue-400'},
    bat: {icon: 'terminal', color: 'text-emerald-400'},
    // Images / Media
    png: {icon: 'image', color: 'text-pink-400'},
    jpg: {icon: 'image', color: 'text-pink-400'},
    jpeg: {icon: 'image', color: 'text-pink-400'},
    webp: {icon: 'image', color: 'text-pink-400'},
    gif: {icon: 'image', color: 'text-pink-400'},
    ico: {icon: 'image', color: 'text-pink-400'},
    woff: {icon: 'font_download', color: 'text-on-surface-variant'},
    woff2: {icon: 'font_download', color: 'text-on-surface-variant'},
    ttf: {icon: 'font_download', color: 'text-on-surface-variant'},
    // Archives / Diff
    diff: {icon: 'difference', color: 'text-teal-400'},
    patch: {icon: 'difference', color: 'text-teal-400'},
    lock: {icon: 'lock', color: 'text-on-surface-variant/70'},
}

const DEFAULT_FILE: FileVisual = {icon: 'draft', color: 'text-on-surface-variant/75'}

export function fileVisualFor(path: string): FileVisual {
    const slash = path.lastIndexOf('/')
    const name = (slash >= 0 ? path.slice(slash + 1) : path).toLowerCase()

    const byName = BY_FILENAME[name]
    if (byName) return byName

    if (name.startsWith('.env.')) return {icon: 'key', color: 'text-amber-400'}
    if (name.startsWith('dockerfile.')) return {icon: 'deployed_code', color: 'text-sky-400'}
    if (name.endsWith('rc') && name.startsWith('.')) return {icon: 'tune', color: 'text-on-surface-variant'}

    const dot = name.lastIndexOf('.')
    if (dot > 0 && dot < name.length - 1) {
        const ext = name.slice(dot + 1)
        const byExt = BY_EXT[ext]
        if (byExt) return byExt
    }

    return DEFAULT_FILE
}

export interface FolderVisual {
    icon: string
    openIcon: string
    color: string
}

const SPECIAL_FOLDERS: Record<string, FolderVisual> = {
    '.github': {icon: 'hub', openIcon: 'hub', color: 'text-sky-400'},
    '.claude': {icon: 'smart_toy', openIcon: 'smart_toy', color: 'text-amber-400'},
    '.agents': {icon: 'smart_toy', openIcon: 'smart_toy', color: 'text-primary'},
    '.vscode': {icon: 'code', openIcon: 'code', color: 'text-blue-400'},
    docker: {icon: 'deployed_code', openIcon: 'deployed_code', color: 'text-sky-400'},
    db: {icon: 'database', openIcon: 'database', color: 'text-violet-400'},
    migrations: {icon: 'database', openIcon: 'database', color: 'text-violet-400'},
    config: {icon: 'settings', openIcon: 'settings', color: 'text-amber-400/90'},
    docs: {icon: 'menu_book', openIcon: 'menu_book', color: 'text-sky-400'},
    spec: {icon: 'science', openIcon: 'science', color: 'text-emerald-400'},
    test: {icon: 'science', openIcon: 'science', color: 'text-emerald-400'},
    tests: {icon: 'science', openIcon: 'science', color: 'text-emerald-400'},
    __mocks__: {icon: 'science', openIcon: 'science', color: 'text-emerald-400/80'},
    __tests__: {icon: 'science', openIcon: 'science', color: 'text-emerald-400'},
    public: {icon: 'public', openIcon: 'public', color: 'text-teal-400'},
    assets: {icon: 'perm_media', openIcon: 'perm_media', color: 'text-pink-400/90'},
    scripts: {icon: 'terminal', openIcon: 'terminal', color: 'text-emerald-400'},
    backend: {icon: 'dns', openIcon: 'dns', color: 'text-cyan-400'},
    frontend: {icon: 'web', openIcon: 'web', color: 'text-blue-400'},
    src: {icon: 'folder_code', openIcon: 'folder_open', color: 'text-primary'},
    app: {icon: 'folder_code', openIcon: 'folder_open', color: 'text-primary'},
    lib: {icon: 'inventory_2', openIcon: 'inventory_2', color: 'text-indigo-400'},
}

export function folderVisualFor(name: string): FolderVisual {
    const special = SPECIAL_FOLDERS[name.toLowerCase()]
    if (special) return special
    return {icon: 'folder', openIcon: 'folder_open', color: 'text-primary/80'}
}
