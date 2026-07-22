// Same mutable-holder pattern as redisKeysStore.ts — the mongosh completion
// provider (mongoLanguage.ts) is registered once, globally, outside the React
// tree, so it can't take "the active tab's known collections" as a prop.
// MongoCollectionTree.tsx pushes into this as it lists collections, but ONLY
// when its own connId matches the active tab's bound connection (its
// isActiveTabConnection prop) — otherwise browsing another connection's
// collections in the sidebar would leak into an unrelated tab's suggestions.
let active: string[] = []

export function setActiveMongoCollections(collections: string[]) {
    active = collections
}

export function getActiveMongoCollections(): string[] {
    return active
}
