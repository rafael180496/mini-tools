// Textos de git.graph (CommitGraph). Ver .claude/specs/i18n.md.
export default {
    loading: 'Cargando historial…',
    empty: 'Este repositorio todavía no tiene commits.',
    rowTitle: (p: {hash: string; author: string}) =>
        `Ver los archivos y el diff de este commit — ${p.hash} por ${p.author}. Click derecho para revert, cherry-pick, crear rama/tag o reset`,
    tag: (p: {name: string}) => `Tag: ${p.name}`,
    remoteBranch: (p: {name: string}) => `Rama remota: ${p.name}`,
    localBranch: (p: {name: string}) => `Rama local: ${p.name}`,
}
