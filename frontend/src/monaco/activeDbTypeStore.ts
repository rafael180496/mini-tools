// Same pattern as metadataStore.ts — the snippet/keyword completion
// provider in sqlLanguage.ts is registered once, globally, at module load,
// so it can't take the active connection's dbType as a prop. This tiny
// mutable holder is how Workspace.tsx feeds it in without re-registering
// providers on every connection switch.
let active: string | null = null

export function setActiveDbType(dbType: string | null) {
    active = dbType
}

export function getActiveDbType(): string | null {
    return active
}
