import {db} from '../../wailsjs/go/models'

// The completion/hover providers are registered once, globally, at module
// load — Monaco's language providers aren't per-editor-instance. This tiny
// mutable holder is how Workspace.tsx feeds them the active connection's
// metadata without re-registering providers on every connection switch.
let active: db.SchemaMetadata | null = null

export function setActiveMetadata(meta: db.SchemaMetadata | null) {
    active = meta
}

export function getActiveMetadata(): db.SchemaMetadata | null {
    return active
}
