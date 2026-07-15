// Same mutable-holder pattern as metadataStore.ts/activeDbTypeStore.ts — the
// Redis completion provider (redisLanguage.ts) is registered once, globally,
// outside the React tree, so it can't take "the active tab's known keys" as
// a prop. RedisKeyTree.tsx pushes into this as it scans pages, but ONLY
// when its own connId matches the active tab's bound connection (see its
// isActiveTabConnection prop) — otherwise browsing a different connection's
// keyspace in the sidebar would leak into the editor's suggestions for an
// unrelated tab.
let active: string[] = []

export function setActiveRedisKeys(keys: string[]) {
    active = keys
}

export function getActiveRedisKeys(): string[] {
    return active
}
