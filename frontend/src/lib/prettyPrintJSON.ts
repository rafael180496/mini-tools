// Best-effort pretty-print — plenty of Redis strings are JSON blobs cached
// from an app (or, for RedisJSON keys/JSON.* command results, always JSON);
// falling back to the raw string for anything else costs nothing.
export function tryPrettyPrintJSON(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
        return raw
    }
}
