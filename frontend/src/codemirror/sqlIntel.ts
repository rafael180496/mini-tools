// SQL IntelliSense wiring: the CodeMirror side of backend/sqlintel.
//
// Everything that decides WHAT to suggest — statement parsing, cursor scope
// resolution, the per-engine dialect catalog, foreign-key join prediction
// and ranking — lives in Go. This module only asks and renders: it turns a
// completion request into one Wails call and maps the reply onto
// CodeMirror's Completion shape, plus an inline ghost-text extension for
// predicted continuations.
//
// Why the round trip is not on the per-keystroke path: the reply carries
// `validFor`, so CodeMirror keeps filtering the same list locally while the
// user keeps typing word characters, and only asks Go again when the
// position changes shape (a new dot, a new clause, a new statement). The
// engine itself measures in microseconds; the bridge hop is the cost, and
// this is what keeps it off the hot path.

import {snippetCompletion} from '@codemirror/autocomplete'
import type {Completion, CompletionContext, CompletionResult, CompletionSource} from '@codemirror/autocomplete'
import {StateEffect, StateField, Prec} from '@codemirror/state'
import type {Extension} from '@codemirror/state'
import {Decoration, EditorView, ViewPlugin, WidgetType, keymap} from '@codemirror/view'
import type {ViewUpdate} from '@codemirror/view'
import {CompleteSQL, PrimeSchemaIndex, RecordCompletionUse, SuggestInlineSQL} from '../../wailsjs/go/main/App'
import type {sqlintel} from '../../wailsjs/go/models'

// Item kinds mirrored from backend/sqlintel/engine.go's Kind* constants —
// this map is the contract between the two halves. Values are CodeMirror's
// built-in completion types, which is what picks the icon shown next to
// each suggestion.
const KIND_TO_TYPE: Record<string, string> = {
    table: 'class',
    column: 'property',
    schema: 'namespace',
    function: 'function',
    routine: 'method',
    keyword: 'keyword',
    snippet: 'text',
    join: 'interface',
}

// Go returns an absolute score (roughly 0-1800). CodeMirror expects a
// boost in [-99, 99] that it adds to its OWN match score when it re-filters
// locally, so the mapping has to compress without collapsing: 500 is the
// neutral point (a plain match with no clause bonus), and the divisor keeps
// a schema-scoped column comfortably above an unrelated keyword without
// pinning everything to the ends of the range.
function toBoost(score: number): number {
    const boost = Math.round((score - 500) / 12)
    return Math.max(-99, Math.min(99, boost))
}

// A completion is only worth remembering when it names something from the
// schema — counting keyword and snippet picks would just add noise to a
// ranking signal meant to learn which TABLES and COLUMNS this session uses.
const TRACKED_KINDS = new Set(['table', 'column', 'schema', 'routine'])

function toCompletion(item: sqlintel.Item, connId: string): Completion {
    const base: Completion = {
        label: item.l,
        type: KIND_TO_TYPE[item.k] ?? 'text',
        detail: item.d,
        info: item.i || undefined,
        boost: toBoost(item.s),
    }

    const record = () => {
        if (!connId || !TRACKED_KINDS.has(item.k)) return
        // Fire and forget: a ranking hint is never worth interrupting an
        // insertion for, so a failure here is deliberately swallowed.
        RecordCompletionUse(connId, item.k, item.l).catch(() => {})
    }

    const apply = item.a
    if (!apply) {
        return {
            ...base,
            apply: (view, completion, from, to) => {
                record()
                view.dispatch({changes: {from, to, insert: item.l}, selection: {anchor: from + item.l.length}})
            },
        }
    }

    // "${1:…}" placeholder syntax is what Go emits for snippets and for
    // function calls, and it is exactly what snippetCompletion consumes —
    // the same syntax the Redis command snippets already use, so no
    // translation layer is needed in either direction.
    if (apply.includes('${')) {
        const snippet = snippetCompletion(apply, base)
        const inner = snippet.apply as (view: EditorView, completion: Completion, from: number, to: number) => void
        return {
            ...snippet,
            apply: (view, completion, from, to) => {
                record()
                inner(view, completion, from, to)
            },
        }
    }

    return {
        ...base,
        apply: (view, completion, from, to) => {
            record()
            view.dispatch({changes: {from, to, insert: apply}, selection: {anchor: from + apply.length}})
        },
    }
}

// sqlIntelCompletionSource is the editor's only schema-aware completion
// source. It replaces @codemirror/lang-sql's own (which is never given a
// `schema`, so it contributes nothing) as well as the retired frontend
// clause detector, snippet list and function list — all three now live in
// backend/sqlintel.
export function sqlIntelCompletionSource(connId: string, dbType: string | null | undefined): CompletionSource {
    return async (context: CompletionContext): Promise<CompletionResult | null> => {
        const word = context.matchBefore(/[\w$#]*/)
        const qualified = context.matchBefore(/[\w$#]\.[\w$#]*$/) !== null

        // Without an explicit trigger, only fire once there is something to
        // match on — a bare cursor after a space would otherwise pull the
        // whole scope across the bridge on every keystroke.
        if (!context.explicit && !qualified && (!word || word.from === word.to)) return null

        let resp: sqlintel.Response
        try {
            resp = await CompleteSQL({
                connId,
                dbType: dbType ?? '',
                sql: context.state.doc.toString(),
                offset: context.pos,
                explicit: context.explicit,
                limit: 0,
            })
        } catch {
            // A locked vault or a closed connection: silently no
            // suggestions, never a popup full of an error message.
            return null
        }

        if (context.aborted) return null

        // The schema index is still being built in the background. Nudge it
        // (idempotent — a scan already running is not started twice) so the
        // next request finds it ready, and meanwhile show whatever the
        // dialect alone can offer.
        if (resp.indexing && connId) {
            PrimeSchemaIndex(connId).catch(() => {})
        }

        if (!resp.items || resp.items.length === 0) return null

        return {
            from: resp.from,
            options: resp.items.map((item) => toCompletion(item, connId)),
            // Local re-filtering while the user keeps typing word
            // characters: this is what keeps the bridge off the keystroke
            // path. A dot, a space or a new clause fails the pattern and
            // triggers a fresh request, which is exactly when Go's answer
            // would actually change.
            validFor: /^[\w$#]*$/,
        }
    }
}

// --- Inline ghost text ----------------------------------------------------

const setGhost = StateEffect.define<string>()

// ghostState holds the current grey suggestion. It is cleared on every
// document change rather than being re-anchored: a stale ghost that lags a
// keystroke reads as the editor guessing wrong, which is worse than showing
// nothing for the 180 ms until the next answer arrives.
const ghostState = StateField.define<string>({
    create: () => '',
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setGhost)) return effect.value
        }
        if (tr.docChanged || tr.selection) return ''
        return value
    },
})

class GhostWidget extends WidgetType {
    constructor(readonly text: string) {
        super()
    }

    eq(other: GhostWidget) {
        return other.text === this.text
    }

    toDOM() {
        const span = document.createElement('span')
        span.className = 'cm-sqlintel-ghost'
        span.textContent = this.text
        return span
    }

    // The widget is decoration only — it must never be treated as document
    // text by selection, search or copy.
    ignoreEvent() {
        return true
    }
}

const ghostDecorations = EditorView.decorations.compute([ghostState, 'selection'], (state) => {
    const text = state.field(ghostState)
    if (!text) return Decoration.none
    const pos = state.selection.main.head
    return Decoration.set([Decoration.widget({widget: new GhostWidget(text), side: 1}).range(pos)])
})

const ghostTheme = EditorView.baseTheme({
    '.cm-sqlintel-ghost': {
        opacity: '0.45',
        fontStyle: 'italic',
        pointerEvents: 'none',
    },
})

// acceptGhost inserts the pending suggestion. Bound to Tab at the highest
// precedence so it wins over indentation, but only while a ghost is
// showing — with none, Tab keeps its normal meaning.
function acceptGhost(view: EditorView): boolean {
    const text = view.state.field(ghostState, false)
    if (!text) return false
    const pos = view.state.selection.main.head
    view.dispatch({
        changes: {from: pos, insert: text},
        selection: {anchor: pos + text.length},
        effects: setGhost.of(''),
    })
    return true
}

function dismissGhost(view: EditorView): boolean {
    if (!view.state.field(ghostState, false)) return false
    view.dispatch({effects: setGhost.of('')})
    return true
}

// ghostFetcher debounces a SuggestInlineSQL call after the cursor settles.
// It uses the same anti-zombie guards the WebSocket clients in this project
// use (a generation counter plus an alive flag), because the reply is
// async and the editor may have moved on — applying a suggestion computed
// for a position the cursor already left is the one failure mode that makes
// ghost text feel broken.
function ghostFetcher(connId: string, dbType: string | null | undefined) {
    return ViewPlugin.fromClass(
        class {
            private timer: number | undefined
            private generation = 0
            private alive = true

            constructor(readonly view: EditorView) {}

            update(update: ViewUpdate) {
                if (!update.docChanged && !update.selectionSet) return
                this.schedule()
            }

            schedule() {
                window.clearTimeout(this.timer)
                const generation = ++this.generation
                this.timer = window.setTimeout(() => {
                    void this.fetch(generation)
                }, 180)
            }

            async fetch(generation: number) {
                const state = this.view.state
                const pos = state.selection.main.head
                // Only predict at a collapsed cursor: a ghost hanging off a
                // selection has nowhere sensible to render.
                if (!state.selection.main.empty) return

                let inline = ''
                try {
                    inline = await SuggestInlineSQL({
                        connId,
                        dbType: dbType ?? '',
                        sql: state.doc.toString(),
                        offset: pos,
                        explicit: false,
                        limit: 0,
                    })
                } catch {
                    return
                }

                if (!this.alive || generation !== this.generation) return
                if (this.view.state.selection.main.head !== pos) return
                if (this.view.state.field(ghostState, false) === inline) return
                this.view.dispatch({effects: setGhost.of(inline)})
            }

            destroy() {
                this.alive = false
                window.clearTimeout(this.timer)
            }
        },
    )
}

// sqlInlineSuggestions is the full ghost-text extension: state, rendering,
// the debounced fetcher and the Tab/Escape bindings.
export function sqlInlineSuggestions(connId: string, dbType: string | null | undefined): Extension {
    return [
        ghostState,
        ghostDecorations,
        ghostTheme,
        ghostFetcher(connId, dbType),
        Prec.highest(
            keymap.of([
                {key: 'Tab', run: acceptGhost},
                {key: 'Escape', run: dismissGhost},
            ]),
        ),
    ]
}

// primeSchemaIndex kicks off the background schema extraction for a
// connection so the index is usually ready before the first keystroke.
// Safe to call repeatedly: the manager ignores a prime for a connection
// that is already indexed or already scanning.
export function primeSchemaIndex(connId: string | null | undefined): void {
    if (!connId) return
    PrimeSchemaIndex(connId).catch(() => {})
}
