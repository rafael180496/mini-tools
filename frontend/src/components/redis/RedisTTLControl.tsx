import {useEffect, useRef, useState} from 'react'
import {PersistRedisKey, SetRedisKeyTTL} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'
import {describeTTL, formatDuration, parseTTLInput, TTL_NO_EXPIRY} from '../../lib/redisFormat'

const TONE_CLASS: Record<string, string> = {
    none: 'bg-surface-variant text-on-surface-variant',
    ok: 'bg-surface-variant text-on-surface-variant',
    warn: 'bg-tertiary/15 text-tertiary',
    danger: 'bg-error/15 text-error',
}

interface RedisTTLControlProps {
    connId: string
    keyName: string
    // ttlSeconds as the server reported it: -1 no expiry, -2 key gone.
    ttlSeconds: number
    onChanged: () => void
    onError: (message: string) => void
}

// TTL display and editing for one key.
//
// The countdown ticks locally rather than polling the server: a TTL is a
// deadline, so once it is known the remaining time is arithmetic, and
// re-asking Redis every second would be a request per second per open key
// for information that cannot surprise us. The server value is re-read only
// when something changes it (or when the user asks).
//
// It turns red under five minutes and amber under an hour, because "1847"
// in a corner is not something anyone reads as "about to expire".
export default function RedisTTLControl({connId, keyName, ttlSeconds, onChanged, onError}: RedisTTLControlProps) {
    const [remaining, setRemaining] = useState(ttlSeconds)
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState('')
    const [saving, setSaving] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        setRemaining(ttlSeconds)
    }, [ttlSeconds, keyName])

    // Only a real countdown ticks; -1/-2 are states, not durations.
    useEffect(() => {
        if (remaining < 0) return
        const timer = window.setInterval(() => {
            setRemaining((prev) => (prev > 0 ? prev - 1 : 0))
        }, 1000)
        return () => window.clearInterval(timer)
    }, [remaining < 0, keyName]) // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (editing) inputRef.current?.focus()
    }, [editing])

    const display = describeTTL(remaining)
    const parsed = parseTTLInput(draft)

    async function applyTTL() {
        if (parsed === null) return
        setSaving(true)
        try {
            await SetRedisKeyTTL(connId, keyName, parsed)
            setEditing(false)
            setDraft('')
            onChanged()
        } catch (e) {
            onError(String(e))
        } finally {
            setSaving(false)
        }
    }

    async function persist() {
        setSaving(true)
        try {
            await PersistRedisKey(connId, keyName)
            onChanged()
        } catch (e) {
            onError(String(e))
        } finally {
            setSaving(false)
        }
    }

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void applyTTL()
                        if (e.key === 'Escape') {
                            setEditing(false)
                            setDraft('')
                        }
                    }}
                    placeholder="30m"
                    title="Cuánto debe durar la clave a partir de ahora. Aceptá segundos sueltos (3600) o abreviado: 90s, 30m, 2h, 7d."
                    className="w-20 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.5 font-mono text-xs text-on-surface"
                />
                {draft.trim() !== '' && (
                    <span className="font-mono text-[10px] text-on-surface-variant/70" title="Cómo se interpreta lo que escribiste">
                        {parsed === null ? 'no se entiende' : `= ${formatDuration(parsed)}`}
                    </span>
                )}
                <button
                    onClick={() => void applyTTL()}
                    disabled={parsed === null || saving}
                    title={parsed === null ? 'Escribí una duración válida (3600, 30m, 2h, 7d)' : `Aplica un vencimiento de ${formatDuration(parsed)} contado desde ahora`}
                    className="rounded bg-primary px-1.5 py-0.5 text-[11px] text-on-primary disabled:opacity-40"
                >
                    Aplicar
                </button>
                <button
                    onClick={() => {
                        setEditing(false)
                        setDraft('')
                    }}
                    title="Cancela sin cambiar el vencimiento"
                    className="rounded px-1 py-0.5 text-[11px] text-on-surface-variant hover:text-on-surface"
                >
                    Cancelar
                </button>
            </div>
        )
    }

    return (
        <div className="flex items-center gap-1">
            <span
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${TONE_CLASS[display.tone]}`}
                title={display.hint}
            >
                <Icon name={display.tone === 'none' ? 'all_inclusive' : 'timer'} size={12} />
                TTL {display.label}
            </span>

            <button
                onClick={() => {
                    setDraft(remaining > 0 ? String(remaining) : '')
                    setEditing(true)
                }}
                disabled={saving}
                title="Cambia el vencimiento de la clave (EXPIRE), contado desde ahora"
                className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
            >
                <Icon name="edit" size={13} />
            </button>

            {remaining !== TTL_NO_EXPIRY && (
                <button
                    onClick={() => void persist()}
                    disabled={saving}
                    title="Quita el vencimiento (PERSIST): la clave deja de expirar y queda permanente"
                    className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    <Icon name="all_inclusive" size={13} />
                </button>
            )}

            <button
                onClick={onChanged}
                disabled={saving}
                title="Vuelve a leer el TTL del servidor. La cuenta regresiva se calcula localmente; esto la resincroniza."
                className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
            >
                <Icon name="refresh" size={13} />
            </button>
        </div>
    )
}
