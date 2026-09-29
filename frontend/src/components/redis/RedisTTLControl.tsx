import {useEffect, useRef, useState} from 'react'
import {PersistRedisKey, SetRedisKeyTTL} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'
import {describeTTL, formatDuration, parseTTLInput, TTL_NO_EXPIRY} from '../../lib/redisFormat'
import {useT} from '../../i18n'

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
    // Also subscribes this control to the language: describeTTL reads the
    // dictionary on each call.
    const t = useT()
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
                    title={t.redis.ttlControl.inputHint}
                    className="w-20 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.5 font-mono text-xs text-on-surface"
                />
                {draft.trim() !== '' && (
                    <span className="font-mono text-ui-10 text-on-surface-variant/70" title={t.redis.ttlControl.parsedHint}>
                        {parsed === null ? t.redis.ttlControl.unparsed : `= ${formatDuration(parsed)}`}
                    </span>
                )}
                <button
                    onClick={() => void applyTTL()}
                    disabled={parsed === null || saving}
                    title={parsed === null ? t.redis.ttlControl.invalidHint : t.redis.ttlControl.applyHint({duration: formatDuration(parsed)})}
                    className="rounded bg-primary px-1.5 py-0.5 text-ui-11 text-on-primary disabled:opacity-40"
                >
                    {t.redis.ttlControl.apply}
                </button>
                <button
                    onClick={() => {
                        setEditing(false)
                        setDraft('')
                    }}
                    title={t.redis.ttlControl.cancelHint}
                    className="rounded px-1 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                >
                    {t.common.cancel}
                </button>
            </div>
        )
    }

    return (
        <div className="flex items-center gap-1">
            <span
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-ui-11 ${TONE_CLASS[display.tone]}`}
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
                title={t.redis.ttlControl.editHint}
                className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
            >
                <Icon name="edit" size={13} />
            </button>

            {remaining !== TTL_NO_EXPIRY && (
                <button
                    onClick={() => void persist()}
                    disabled={saving}
                    title={t.redis.ttlControl.persistHint}
                    className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    <Icon name="all_inclusive" size={13} />
                </button>
            )}

            <button
                onClick={onChanged}
                disabled={saving}
                title={t.redis.ttlControl.refreshHint}
                className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
            >
                <Icon name="refresh" size={13} />
            </button>
        </div>
    )
}
