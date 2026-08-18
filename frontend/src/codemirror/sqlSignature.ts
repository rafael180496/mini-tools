// Parameter info: the tooltip that says which argument the cursor is on.
//
// It is the other half of backend/sqlintel's routine signatures. Completion
// answers "which routine?" and stops being useful the moment the opening
// parenthesis is typed; from there on the only question left is "what goes
// in this slot?", and that one stays open for as long as the call does.
// A list cannot answer it — the answer has to follow the cursor.
//
// Everything that decides WHAT to show lives in Go (backend/sqlintel/
// signature.go): finding the enclosing call, resolving the callee against
// the catalog, counting which argument the cursor sits in and following
// Oracle's "p_x => value" named notation. This module asks and renders.
//
// The round trip is debounced, and the answer carries the call's own range
// so a tooltip that no longer applies disappears the instant the cursor
// leaves it, instead of waiting for the reply that would have said so.

import {StateEffect, StateField} from '@codemirror/state'
import type {Extension} from '@codemirror/state'
import {EditorView, ViewPlugin, keymap, showTooltip} from '@codemirror/view'
import type {Tooltip, ViewUpdate} from '@codemirror/view'
import {SignatureSQL} from '../../wailsjs/go/main/App'
import type {sqlintel} from '../../wailsjs/go/models'

// activeSignature is what the tooltip renders, plus the document range the
// answer is valid for. `dismissed` survives until the cursor leaves that
// range, so Escape hides the tooltip without it popping straight back on
// the next keystroke inside the same call.
type SignatureState = {
    resp: sqlintel.SignatureResponse | null
    dismissed: boolean
}

const setSignature = StateEffect.define<sqlintel.SignatureResponse | null>()
const dismissSignature = StateEffect.define<null>()

const signatureState = StateField.define<SignatureState>({
    create: () => ({resp: null, dismissed: false}),
    update(value, tr) {
        let next = value
        for (const effect of tr.effects) {
            if (effect.is(setSignature)) next = {resp: effect.value, dismissed: false}
            if (effect.is(dismissSignature)) next = {...next, dismissed: true}
        }
        if (next.resp && (tr.docChanged || tr.selection)) {
            // Left the call the answer was computed for: drop it rather
            // than letting a stale signature linger over unrelated text.
            const pos = tr.state.selection.main.head
            if (pos < next.resp.from || pos > next.resp.to) return {resp: null, dismissed: false}
        }
        return next
    },
    provide: (field) => showTooltip.from(field, buildTooltip),
})

function buildTooltip(state: SignatureState): Tooltip | null {
    const resp = state.resp
    if (state.dismissed || !resp) return null
    const signatures = resp.signatures
    if (!signatures || signatures.length === 0) return null

    return {
        pos: resp.from,
        above: true,
        // Never take focus and never steal the arrow keys: the user is
        // typing arguments, and the tooltip is something they read out of
        // the corner of their eye.
        create: () => ({dom: renderSignatures(signatures)}),
    }
}

function renderSignatures(signatures: sqlintel.SignatureInfo[]): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-sqlintel-signature'

    signatures.forEach((sig, index) => {
        const block = document.createElement('div')
        block.className = 'cm-sqlintel-signature-item'

        const line = document.createElement('div')
        line.className = 'cm-sqlintel-signature-line'

        // An overloaded name shows every candidate, numbered — the engine
        // cannot tell which one is meant until the arguments are typed, and
        // guessing one would hide the very ambiguity the user is resolving.
        if (signatures.length > 1) {
            const badge = document.createElement('span')
            badge.className = 'cm-sqlintel-signature-badge'
            badge.textContent = `${index + 1}/${signatures.length}`
            line.appendChild(badge)
        }

        if (!sig.params || sig.params.length === 0) {
            // A dialect built-in (no structured argument list) or a routine
            // that genuinely takes none: the pre-rendered label is all
            // there is to show.
            const label = document.createElement('span')
            label.textContent = sig.label
            line.appendChild(label)
        } else {
            line.appendChild(textSpan(`${sig.name}(`))
            sig.params.forEach((param, i) => {
                if (i > 0) line.appendChild(textSpan(', '))
                const span = document.createElement('span')
                span.className = 'cm-sqlintel-signature-param'
                if (i === sig.active) span.classList.add('cm-sqlintel-signature-param-active')
                if (param.out) span.classList.add('cm-sqlintel-signature-param-out')
                span.textContent = param.optional ? `[${param.label}]` : param.label
                line.appendChild(span)
            })
            line.appendChild(textSpan(')'))
            if (sig.return) line.appendChild(textSpan(` → ${sig.return}`))
        }

        block.appendChild(line)

        if (sig.doc) {
            const doc = document.createElement('div')
            doc.className = 'cm-sqlintel-signature-doc'
            doc.textContent = sig.doc
            block.appendChild(doc)
        }

        root.appendChild(block)
    })

    return root
}

function textSpan(text: string): HTMLElement {
    const span = document.createElement('span')
    span.textContent = text
    return span
}

const signatureTheme = EditorView.baseTheme({
    '.cm-sqlintel-signature': {
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '8px',
        backgroundColor: 'var(--color-surface-container-high)',
        color: 'var(--color-on-surface)',
        padding: '5px 9px',
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        fontSize: '11.5px',
        lineHeight: '1.55',
        maxWidth: 'min(52em, 90vw)',
        boxShadow: '0 8px 24px rgb(0 0 0 / 0.28)',
    },
    '.cm-sqlintel-signature-item + .cm-sqlintel-signature-item': {
        marginTop: '4px',
        paddingTop: '4px',
        borderTop: '1px solid var(--color-outline-variant)',
    },
    '.cm-sqlintel-signature-line': {
        whiteSpace: 'normal',
        wordBreak: 'break-word',
    },
    '.cm-sqlintel-signature-badge': {
        marginRight: '6px',
        opacity: '0.55',
        fontSize: '10px',
    },
    // The inactive arguments stay legible but recede; the active one is the
    // single thing this tooltip exists to point at.
    '.cm-sqlintel-signature-param': {
        opacity: '0.62',
    },
    '.cm-sqlintel-signature-param-active': {
        opacity: '1',
        fontWeight: '700',
        color: 'var(--color-primary)',
    },
    // An OUT argument is the one thing a caller can get wrong without the
    // engine complaining, so it is marked even when it is not the active
    // slot.
    '.cm-sqlintel-signature-param-out': {
        fontStyle: 'italic',
    },
    '.cm-sqlintel-signature-doc': {
        marginTop: '3px',
        fontFamily: 'inherit',
        fontSize: '10.5px',
        opacity: '0.7',
        whiteSpace: 'normal',
    },
})

// signatureFetcher asks Go after the cursor settles, with the same
// anti-zombie guards the ghost-text fetcher uses (a generation counter plus
// an alive flag): the reply is async, and rendering a signature computed
// for a position the cursor already left is what makes this kind of tooltip
// feel broken.
function signatureFetcher(connId: string, dbType: string | null | undefined) {
    return ViewPlugin.fromClass(
        class {
            private timer: number | undefined
            private generation = 0
            private alive = true

            constructor(readonly view: EditorView) {}

            update(update: ViewUpdate) {
                // Every cursor move re-asks, not just every edit: which
                // argument is active is a function of the position, so
                // arrowing from one argument to the next has to move the
                // highlight. The debounce below is what keeps that cheap,
                // and the state field drops a stale tooltip immediately
                // when the cursor leaves the call rather than waiting for
                // the answer that says so.
                if (!update.docChanged && !update.selectionSet) return
                this.schedule()
            }

            schedule() {
                window.clearTimeout(this.timer)
                const generation = ++this.generation
                this.timer = window.setTimeout(() => {
                    void this.fetch(generation)
                }, 140)
            }

            async fetch(generation: number) {
                const state = this.view.state
                const pos = state.selection.main.head
                if (!state.selection.main.empty) return

                let resp: sqlintel.SignatureResponse
                try {
                    resp = await SignatureSQL({
                        connId,
                        dbType: dbType ?? '',
                        sql: state.doc.toString(),
                        offset: pos,
                    })
                } catch {
                    // A locked vault or a closed connection: no tooltip,
                    // never an error surfaced into the editor.
                    return
                }

                if (!this.alive || generation !== this.generation) return
                if (this.view.state.selection.main.head !== pos) return

                const next = resp.signatures && resp.signatures.length > 0 ? resp : null
                const current = this.view.state.field(signatureState, false)?.resp ?? null
                if (!next && !current) return
                this.view.dispatch({effects: setSignature.of(next)})
            }

            destroy() {
                this.alive = false
                window.clearTimeout(this.timer)
            }
        },
    )
}

function hideSignature(view: EditorView): boolean {
    const state = view.state.field(signatureState, false)
    if (!state || !state.resp || state.dismissed) return false
    view.dispatch({effects: dismissSignature.of(null)})
    return true
}

// sqlSignatureHelp is the full parameter-info extension: state, tooltip,
// theme, the debounced fetcher and Escape to dismiss.
export function sqlSignatureHelp(connId: string, dbType: string | null | undefined): Extension {
    return [
        signatureState,
        signatureTheme,
        signatureFetcher(connId, dbType),
        keymap.of([{key: 'Escape', run: hideSignature}]),
    ]
}
