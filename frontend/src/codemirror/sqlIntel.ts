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
import {EventsOn} from '../../wailsjs/runtime'
import type {sqlintel} from '../../wailsjs/go/models'

// Item kinds mirrored from backend/sqlintel/engine.go's Kind* constants —
// this map is the contract between the two halves. The value becomes the
// option's CSS class (cm-completionIcon-<type>), which is what picks the
// icon.
//
// The types are deliberately NOT CodeMirror's built-ins ('class',
// 'property', 'namespace'…). Those come with abstract geometric glyphs — a
// table rendered as "○" and a column as "□" — that carry no meaning in SQL
// and, at 12px, read as a checkbox. Own names mean own icons, with no
// specificity fight against the library's defaults.
const KIND_TO_TYPE: Record<string, string> = {
    table: 'sqlintel-table',
    column: 'sqlintel-column',
    schema: 'sqlintel-schema',
    function: 'sqlintel-function',
    routine: 'sqlintel-routine',
    keyword: 'sqlintel-keyword',
    snippet: 'sqlintel-snippet',
    join: 'sqlintel-join',
    alias: 'sqlintel-alias',
    expand: 'sqlintel-expand',
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

// Tope de espera de una llamada al motor, y la razón por la que existe.
//
// **Una respuesta que no llega mata el autocompletado de la pestaña, no la
// petición.** CodeMirror guarda cada consulta en curso en una lista y no
// vuelve a preguntarle a esa misma fuente mientras haya una consulta suya
// pendiente (`startQuery` en @codemirror/autocomplete). Si la promesa no se
// resuelve NI se rechaza, esa entrada no se saca nunca: el popup deja de
// abrirse, Ctrl+Espacio no hace nada, y la única salida es cerrar y volver a
// abrir la pestaña. Reproducido en un banco de pruebas con CodeMirror real:
// una sola llamada colgada y el editor no se recupera ni escribiendo sesenta
// caracteres más.
//
// Y que una llamada quede colgada es posible: Wails no le pone tiempo límite
// a ninguna (`Call` con timeout 0 = infinito), y ante un pánico del lado de
// Go responde con una cadena vacía que el runtime no puede parsear, así que
// la promesa queda pendiente para siempre. El backend ahora recupera esos
// pánicos (ver recoverEditorCall en app.go); este tope es la segunda mitad
// del cinturón, para cualquier otra forma de perder una respuesta.
//
// Tres segundos: el motor contesta en microsegundos y el puente en
// milisegundos, así que llegar acá ya significa que algo se rompió — pero
// una lista vacía por una vez es infinitamente mejor que un editor al que
// hay que reabrirle la pestaña.
const BRIDGE_TIMEOUT_MS = 3_000

// settled corre una llamada al puente con tope de tiempo. Nunca lanza: el
// caller recibe `null` tanto si falló como si tardó demasiado, que para el
// editor son la misma cosa (no hay nada que mostrar).
export async function settled<T>(call: Promise<T>): Promise<T | null> {
    let timer: number | undefined
    try {
        return await Promise.race([
            call,
            new Promise<null>((resolve) => {
                timer = window.setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)
            }),
        ])
    } catch {
        return null
    } finally {
        window.clearTimeout(timer)
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

        // Nothing typed yet is the position where suggestions are most
        // wanted ("FROM |", "WHERE |", "SELECT a, |") and also the one that
        // would pull the whole scope across the bridge on every space bar.
        // The compromise is to ask only where the text right before the
        // cursor is a clause keyword, a comma or an open paren. Go narrows it
        // a second time by the clause it parsed (schema-backed clauses only,
        // and only tables/columns in the answer), so the two gates are
        // complementary: this one keeps the bridge quiet, that one keeps the
        // popup relevant. Anywhere else a bare cursor waits for Ctrl-Space.
        // The 64-char window is cut at its first whitespace so a slice that
        // began mid-word ("…rgin ") cannot pass that fragment off as "in".
        const before = context.state.sliceDoc(Math.max(0, context.pos - 64), context.pos).replace(/^\S+/, '')
        const autoOpen = /(?:\b(?:from|join|where|on|select|set|by|having|and|or|like|in)\s+|[,(]\s*)$/i.test(before)
        // "FROM clientes |" is the alias position, and it is the one place
        // the engine PROPOSES a name instead of looking one up — so it has
        // to open by itself. The rule above cannot see it: the word right
        // before the cursor is the table, not a clause keyword.
        // "into" queda deliberadamente afuera: después de INSERT INTO tabla
        // no va un alias sino la lista de columnas, VALUES o un SELECT, y
        // abrir ahí solo pondría la lista de tablas encima de lo que se está
        // por escribir. Go aplica la misma exclusión del lado del motor.
        const aliasSlot = /\b(?:from|join|update|using)\s+[\w$#]+(?:\.[\w$#]+){0,2}\s+$/i.test(before)

        if (!context.explicit && !qualified && !autoOpen && !aliasSlot && (!word || word.from === word.to)) return null

        // Vault bloqueado, conexión cerrada o una respuesta que nunca llega:
        // en los tres casos no hay nada que sugerir, y en ninguno se deja la
        // promesa sin resolver (ver BRIDGE_TIMEOUT_MS).
        const resp = await settled(
            CompleteSQL({
                connId,
                dbType: dbType ?? '',
                sql: context.state.doc.toString(),
                offset: context.pos,
                explicit: context.explicit,
                limit: 0,
            }),
        )
        if (!resp) return null

        if (context.aborted) return null

        // The schema index is still being built in the background. Nudge it
        // (idempotent — a scan already running is not started twice) so the
        // next request finds it ready, and meanwhile show whatever the
        // dialect alone can offer.
        if (resp.indexing && connId) {
            PrimeSchemaIndex(connId).catch(() => {})
        }

        if (!resp.items || resp.items.length === 0) return null

        // Armar las opciones no puede tirar abajo la fuente: `snippetCompletion`
        // parsea la plantilla acá mismo, y una excepción en este map rechazaría
        // la promesa — con el mismo final que una respuesta perdida, porque
        // CodeMirror tampoco saca de su lista una consulta que rechazó.
        let options: Completion[]
        try {
            options = resp.items.map((item) => toCompletion(item, connId))
        } catch (e) {
            console.error('sqlintel: no se pudo armar la lista de sugerencias', e)
            return null
        }

        return {
            from: resp.from,
            options,
            // Local re-filtering while the user keeps typing word
            // characters: this is what keeps the bridge off the keystroke
            // path. A dot, a space or a new clause fails the pattern and
            // triggers a fresh request, which is exactly when Go's answer
            // would actually change.
            validFor: /^[\w$#]*$/,
        }
    }
}

// --- Popup presentation ---------------------------------------------------

// CodeMirror's stock completion popup is a narrow list of bare labels: the
// detail sits inline right after the name, so a column reads as one run of
// text ("NUM_AF AN_TRABPEND_AF · VARCHAR2 · PK") and the eye has nothing to
// anchor on when scanning twenty of them. Every rule below serves the same
// goal — the NAME is the column being scanned, and where it comes from and
// what type it is are supporting text, aligned in their own column to the
// right so they can be ignored until wanted.
//
// Colours come from the app's design tokens rather than hard-coded values,
// which is also what makes the popup follow the light/dark theme without a
// second definition (see .claude/specs/design-system.md).
export const sqlCompletionTheme = EditorView.baseTheme({
    '.cm-tooltip.cm-tooltip-autocomplete': {
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '8px',
        backgroundColor: 'var(--color-surface-container-high)',
        boxShadow: '0 8px 24px rgb(0 0 0 / 0.28)',
        overflow: 'hidden',
    },
    // A whole JOIN clause is a long label; the popup is given room to show
    // one rather than clipping every suggestion to the width of a name.
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        fontSize: '12px',
        maxHeight: '18em',
        // El piso sube junto con el del nombre (18em) + ícono + un detalle
        // corto; el techo deja lugar a una cláusula JOIN entera, que es el
        // ítem más largo que este motor produce.
        minWidth: '32em',
        maxWidth: 'min(60em, 92vw)',
    },
    // Every rule below is written one class deeper than the library's own
    // (".cm-tooltip.cm-tooltip-autocomplete …" rather than plain
    // ".cm-completionDetail"). CodeMirror's base theme styles the same
    // elements at equal specificity, so at equal specificity the winner is
    // whichever style sheet the browser happened to insert last — which is
    // how the detail text kept rendering in the library's italic even with
    // this rule present.
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        display: 'flex',
        alignItems: 'center',
        gap: '0.5em',
        padding: '3px 8px',
        lineHeight: '1.5',
        color: 'var(--color-on-surface)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 18%, transparent)',
        color: 'var(--color-on-surface)',
    },
    // El nombre manda, y eso hay que decirlo en dos lugares del layout:
    //
    // `min-width` reserva ancho para un identificador entero. Antes decía 0, y
    // un elemento flex con min-width 0 no aporta NADA al ancho intrínseco del
    // contenedor: el popup se medía como si los nombres no existieran, salía
    // angosto, y adentro de ese ancho el único que cedía era justamente el
    // nombre. Resultado: "TIP_FA…" al lado de un detalle completo. 18em son
    // los 30 caracteres que Oracle permite en un identificador, así que la
    // enorme mayoría entra sin cortarse.
    //
    // Reservarlo también cuando el nombre es corto es deliberado: alinea los
    // detalles en una columna en vez de dejarlos escalonados según el largo de
    // cada nombre, que es lo que hace escaneable una lista de veinte.
    '.cm-tooltip-autocomplete .cm-completionLabel': {
        flex: '1 1 auto',
        minWidth: '18em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    // The typed fragment, highlighted in place instead of underlined: it
    // shows WHY a suggestion is in the list, which matters most when the
    // match is an acronym or a subsequence rather than a prefix.
    '.cm-tooltip-autocomplete .cm-completionMatchedText': {
        textDecoration: 'none',
        fontWeight: '700',
        color: 'var(--color-primary)',
    },
    // Supporting text, never the thing being scanned: smaller, dimmer, and
    // upright — italic at 11px in a monospace face is the hardest possible
    // combination to read at a glance.
    // El detalle es el que cede. `0 1 auto` con min-width 0 lo hace encogible,
    // así que cuando no entra todo se corta "FUECICLO · VARCHAR2 · PK · NOT
    // NULL" —donde lo que se pierde es la cola, que es lo menos importante— en
    // vez de cortarse el nombre de la columna.
    '.cm-tooltip-autocomplete .cm-completionDetail': {
        flex: '0 1 auto',
        minWidth: '0',
        fontStyle: 'normal',
        fontSize: '11px',
        opacity: '0.6',
        maxWidth: '24em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    // Icons: the app's self-hosted Material Symbols, addressed by ligature
    // name exactly like <Icon name="…" /> does everywhere else (see
    // components/Icon.tsx). Each name below was checked against the shipped
    // woff2 — an unknown ligature renders as the literal word with no error,
    // which is the failure mode the design-system rules warn about.
    //
    // Colour groups the kinds rather than tinting each one differently: a
    // schema object, a value, something executable, and plain syntax. Four
    // groups is what a glance can actually separate; eight tints would just
    // be noise. All four are semantic MD3 tokens, so they follow the theme.
    '.cm-tooltip-autocomplete .cm-completionIcon': {
        flex: '0 0 auto',
        width: '1.15em',
        paddingRight: '0',
        opacity: '1',
        fontFamily: "'Material Symbols Outlined'",
        fontSize: '15px',
        fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20",
        lineHeight: '1',
        textAlign: 'center',
        // The ligature is what turns "view_column" into a glyph; without it
        // the popup would print the name.
        fontFeatureSettings: "'liga'",
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-table::after': {
        content: "'table'",
        color: 'var(--color-primary)',
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-schema::after': {
        content: "'schema'",
        color: 'var(--color-secondary)',
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-column::after': {
        content: "'view_column'",
        color: 'var(--color-tertiary)',
    },
    // A predicted JOIN is the one suggestion that writes a whole clause, so
    // it gets the icon that says "these two tables meet here".
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-join::after': {
        content: "'join_inner'",
        color: 'var(--color-primary)',
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-function::after': {
        content: "'function'",
        color: 'var(--color-secondary)',
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-routine::after': {
        content: "'bolt'",
        color: 'var(--color-secondary)',
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-keyword::after': {
        content: "'abc'",
        color: 'var(--color-on-surface-variant)',
    },
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-snippet::after': {
        content: "'code'",
        color: 'var(--color-on-surface-variant)',
    },
    // An alias is a name the engine PROPOSES (for a table just written) or
    // one the query invented (a "AS total" in the SELECT list) — in both
    // cases a label, not something looked up in the catalog.
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-alias::after': {
        content: "'label'",
        color: 'var(--color-tertiary)',
    },
    // The star expansion rewrites what is already there rather than adding a
    // name, so it gets the "unfold" glyph instead of an identifier icon.
    '.cm-tooltip-autocomplete .cm-completionIcon-sqlintel-expand::after': {
        content: "'unfold_more'",
        color: 'var(--color-primary)',
    },
    // lang-sql contributes its own keyword completions from a separate
    // source and types them 'keyword'; without this they would keep the
    // library's 🔑 next to this engine's identical suggestions. The extra
    // class outranks the default rule whatever order the sheets land in.
    '.cm-tooltip-autocomplete .cm-completionIcon-keyword::after': {
        content: "'abc'",
        color: 'var(--color-on-surface-variant)',
    },
    '.cm-tooltip.cm-completionInfo': {
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '8px',
        backgroundColor: 'var(--color-surface-container-high)',
        color: 'var(--color-on-surface)',
        padding: '6px 8px',
        maxWidth: '22em',
        fontSize: '11px',
        lineHeight: '1.45',
    },
})

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

                const inline = await settled(
                    SuggestInlineSQL({
                        connId,
                        dbType: dbType ?? '',
                        sql: state.doc.toString(),
                        offset: pos,
                        explicit: false,
                        limit: 0,
                    }),
                )
                if (inline === null) return

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
//
// The cooldown guards the one case the manager cannot absorb: an extraction
// that FAILED leaves the index empty, so every subsequent completion sees
// `indexing` and asks again — turning a broken catalog into a full scan per
// keystroke, each one blocking on a database that is already not answering.
// Ten seconds is long enough that the retry is a retry and not a loop.
//
// It is CLEARED on every scan that settles without an error (see
// onSchemaIndexReady), which is what keeps it from delaying a legitimate
// rebuild. Disconnecting a connection drops its index on the Go side, and
// the editor tab stays bound to the same connection id — so nothing
// re-primes on reconnect except the `indexing` flag coming back from the
// next completion. Without the clear, a disconnect/reconnect inside the
// cooldown window would leave the editor on keywords alone until it
// expired, for no reason: the previous scan had succeeded.
const PRIME_COOLDOWN_MS = 10_000
const lastPrime = new Map<string, number>()

export function primeSchemaIndex(connId: string | null | undefined): void {
    if (!connId) return
    const now = Date.now()
    const previous = lastPrime.get(connId)
    if (previous !== undefined && now - previous < PRIME_COOLDOWN_MS) return
    lastPrime.set(connId, now)
    PrimeSchemaIndex(connId).catch(() => {})
}

// forgetPrimeCooldown drops the throttle for a connection, so an explicit
// user action (rebinding a tab, refreshing metadata) primes immediately
// instead of waiting out a cooldown started by a failed background attempt.
export function forgetPrimeCooldown(connId: string | null | undefined): void {
    if (connId) lastPrime.delete(connId)
}

// Mirrors sqlIntelIndexEvent in app.go — the two names are the contract.
const SCHEMA_INDEX_EVENT = 'sqlintel:index'

// onSchemaIndexReady subscribes to the backend's "sqlintel:index" event —
// the notification Go already emits when a background extraction settles.
// Until now nothing listened to it, so the whole point of the event was
// lost: a popup opened while the index was still building stayed
// keyword-only until the user retyped, which reads as completion having
// silently forgotten the schema. The callback fires only for a settled
// scan of the connection asked about.
export function onSchemaIndexReady(connId: string | null, callback: (status: sqlintel.Status) => void): () => void {
    if (!connId) return () => {}
    return EventsOn(SCHEMA_INDEX_EVENT, (status: sqlintel.Status) => {
        if (!status || status.connId !== connId) return
        if (status.state === 'loading') return
        // A scan that settled without an error proves the connection answers,
        // so the throttle has nothing left to protect against.
        if (status.state !== 'error') lastPrime.delete(connId)
        callback(status)
    })
}

