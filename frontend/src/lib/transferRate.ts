// Speed and ETA for a running transfer, derived from the progress events it
// already emits.
//
// Nothing new is sent from the backend: two consecutive events carry
// bytesDone, and the clock is right here. Adding a server-side timer would
// only give a second, disagreeing answer to a question the frontend can
// already answer.

// SAMPLE_MS is the minimum gap between rate samples. Events arrive far faster
// than that on a fast link, and computing a rate from a 4 ms window makes the
// number flicker between wildly different values — unreadable, and no more
// accurate.
const SAMPLE_MS = 400

// SMOOTHING is the weight of the newest sample in the running average. A raw
// instantaneous rate jumps around with every chunk boundary and network hiccup;
// this keeps the displayed number stable enough to read while still tracking a
// real slowdown within a couple of seconds.
const SMOOTHING = 0.3

export interface RateSample {
    // BytesPerSec is 0 until there are two samples to compare.
    bytesPerSec: number
    // EtaSeconds is -1 when it cannot be estimated: no rate yet, or an unknown
    // total. Showing "0s remaining" in that case would be a lie, not a
    // placeholder.
    etaSeconds: number
}

interface State {
    lastAt: number
    lastBytes: number
    rate: number
}

const states = new Map<string, State>()

// observe records a progress reading and returns the current rate and ETA.
export function observe(id: string, bytesDone: number, bytesTotal: number, now: number): RateSample {
    const prev = states.get(id)

    if (!prev) {
        states.set(id, {lastAt: now, lastBytes: bytesDone, rate: 0})
        return {bytesPerSec: 0, etaSeconds: -1}
    }

    const elapsed = now - prev.lastAt
    if (elapsed >= SAMPLE_MS) {
        const delta = bytesDone - prev.lastBytes
        // A negative delta means the counter restarted (a retried transfer
        // reusing the id); treat it as a fresh start rather than reporting a
        // negative speed.
        const instant = delta >= 0 ? (delta * 1000) / elapsed : 0
        prev.rate = prev.rate === 0 ? instant : prev.rate * (1 - SMOOTHING) + instant * SMOOTHING
        prev.lastAt = now
        prev.lastBytes = bytesDone
    }

    let eta = -1
    if (prev.rate > 0 && bytesTotal > bytesDone) {
        eta = (bytesTotal - bytesDone) / prev.rate
    }
    return {bytesPerSec: prev.rate, etaSeconds: eta}
}

// forget drops a finished transfer's state. Without this the map would grow
// for the life of the session.
export function forget(id: string) {
    states.delete(id)
}

// formatRate renders a speed as "12.4 MB/s".
export function formatRate(bytesPerSec: number): string {
    if (bytesPerSec <= 0) return ''
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
    let value = bytesPerSec
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

// formatEta renders remaining time as "45s", "3m 20s" or "1h 04m".
export function formatEta(seconds: number): string {
    if (seconds < 0) return ''
    // Anything past an hour is guesswork over a link whose speed will change
    // long before then, so it is reported coarsely on purpose.
    if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600)
        const m = Math.floor((seconds % 3600) / 60)
        return `${h}h ${String(m).padStart(2, '0')}m`
    }
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60)
        const s = Math.round(seconds % 60)
        return `${m}m ${String(s).padStart(2, '0')}s`
    }
    return `${Math.max(1, Math.round(seconds))}s`
}
