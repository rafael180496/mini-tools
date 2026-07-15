// Human-readable byte size (B/KB/MB/GB) — shared by RedisKeyTree.tsx's
// header stats (server-wide used memory) and RedisKeyDetailPanel.tsx's
// per-key size (MEMORY USAGE).
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}
