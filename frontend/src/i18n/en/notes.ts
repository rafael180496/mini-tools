import type {Messages} from '../types'
import type es from '../es/notes'

const en: Messages<typeof es> = {
    untitled: 'Untitled',
    image: 'image',
    imageFailed: (p) => `${p.alt} — couldn't load`,

    editor: {
        imageReadFailed: "Couldn't read the image",
        imageTypeUnreadable: (p) =>
            `Couldn't read an image of type ${p.type}. Notes store PNG and JPG; try a screenshot.`,
        imageTypeUnknown: 'unknown',
        imageConvertFailed: "Couldn't convert the image",
        pastedImageName: 'screenshot',
        titleRequired: 'The note needs a title: it is what makes it linkable with [[…]]',
        placeholder: 'Write in Markdown. «[[» links another note, «/» inserts a block.',
        tagCount: (n) => (n === 1 ? '1 note' : `${n} notes`),
        completionPrivate: 'private',
        completionVisible: 'visible to AI',
        privateTitle:
            'PRIVATE: no agent can read this note, neither through the chat nor through the MCP server. It still shows up in your graph and your searches. Click to share it again.',
        visibleTitle:
            'VISIBLE TO AI (the default): agents can read this note if you reference it or they search for it. Click to hide it.',
        private: 'Private',
        aiAllowed: 'AI access allowed',
        noAgent: 'No agentic CLI is installed. mini-tools uses Claude Code, Codex or Antigravity.',
        chatPrivate:
            "Opens the chat with this note as context. Since it is marked PRIVATE, its content isn't sent: you can still ask, but the agent won't read it.",
        chatVisible:
            'Opens the chat with this note already referenced, to ask about it, expand it or review a procedure.',
        backToEdit: 'Back to editing the Markdown',
        showPreview: 'See the rendered note, with clickable links',
        deleteTitle:
            "Deletes this note. Links pointing to it from other notes stay visible as broken; they aren't removed silently.",
        corrupt:
            "This note's checksum doesn't match its content: it may be damaged. It is shown anyway so you can rescue what's left — saving it recalculates the checksum.",
        foldSummary: 'Show details',
        externalChange: 'An agent rewrote this note while you were editing it. Your unsaved changes are still here.',
        viewAgentVersionTitle: 'Discards what you wrote without saving and shows the version the agent left',
        viewAgentVersion: "See the agent's version",
        keepMineTitle:
            "Keep editing yours. When you save, your version replaces the agent's — and the note becomes yours: the agent won't be able to change it again.",
        keepMine: 'Keep mine',
        titleFieldTitle:
            'The title is what other notes use to link it with [[…]]. Changing it breaks the links pointing to it — they show up marked in the note that has them.',
        outgoing: 'Outgoing links',
        outgoingHint: 'Notes THIS one mentions with [[…]]',
        uncreated: (n) => `Not created (${n})`,
        uncreatedTitle:
            "This note links to something that doesn't exist yet. Click to create it — that's how the graph grows.",
        untitledLink: 'untitled note',
        backlinks: 'Backlinks',
        backlinksHint: 'Notes pointing to THIS one',
        none: 'None',
        privateSuffix: (p) => `${p.title} — private`,
        linkGroupTitle: (p) => `${p.title} (${p.n})`,
        backlinkCountTitle:
            'How many notes point to this one with [[…]]. Zero means it is isolated from the rest of your knowledge base.',
        backlinkCount: (p) => `${p.formatted} ${p.n === 1 ? 'backlink' : 'backlinks'}`,
        wordsTitle: "Words in the note's body",
        words: (p) => `${p.formatted} words`,
        linesTitle:
            "Lines and characters. The notes editor doesn't show line numbers on the side —a document has no lines to reference— but the number is still here when you need it.",
        linesChars: (p) => `${p.lines} lines · ${p.chars} characters`,
        saving: 'Saving…',
        unsaved: 'Unsaved',
        saved: 'Saved',
        shareConfirmTitle: 'Share this note with agents again',
        shareConfirmDescription: (p) =>
            `The full content of «${p.title}» can be read by Claude Code, Codex or Antigravity when you reference it with @note or when they search for it. Any credentials, keys and personal data in it go along with it. You can hide it again at any time.`,
        share: 'Share',
        deleteConfirmTitle: 'Delete note',
        deleteConfirmDescription: (p) =>
            `«${p.title}» is deleted from the vault. Notes that linked to it will show the link as broken, with the option to create it again. This can't be undone.`,
    },

    toolbar: {
        alignLeft: 'Align left',
        alignCenter: 'Center',
        alignRight: 'Align right',
        alignJustify: 'Justify',
        alignTitle: (p) =>
            `${p.label}. It's a property of the note, not of the text: the Markdown stays clean and opens the same in any other editor.`,
        h1: 'Section heading (# in Markdown)',
        h2: 'Subheading (## in Markdown)',
        h3: 'Sub-subheading (### in Markdown)',
        bold: 'Bold — select the text and click here (Cmd/Ctrl+B)',
        italic: 'Italic — select the text and click here (Cmd/Ctrl+I)',
        strike: 'Strikethrough',
        inlineCode: 'Inline code',
        bullets: 'Bulleted list',
        numbered: 'Numbered list',
        checklist: 'Checklist',
        quote: 'Quote',
        webLink: 'Link to a web page. To link ANOTHER NOTE, type [[ and pick it from the list.',
        noteLink: 'Link to another note. Also opens by typing [[ in the text.',
        image:
            'Inserts a PNG or JPG image. It is stored ENCRYPTED inside the vault, just like the note text, and PNGs are recompressed without losing a single pixel. You can also paste it with Cmd/Ctrl+V.',
        table: 'Two-column table',
        tableField: 'Field',
        tableValue: 'Value',
        fold: 'Collapsible block, for long details',
        markdownTitle:
            'The note is stored as plain Markdown: exported, it opens in Obsidian or any text editor without losing anything.',
    },

    slash: {
        h1: 'Section heading',
        h2: 'Subheading',
        h3: 'Sub-subheading',
        callout: 'Highlighted box — INFO, WARNING, SECURITY or TIP',
        warning: 'Warning box',
        security: 'Security box — for what must never be done',
        table: '3-column Markdown table',
        tableHeader: '| Field | Value | Notes |',
        toggle: "Collapsible block — for long details you don't always need",
        checklist: 'Checklist — the steps of a procedure',
        sql: 'EXECUTABLE SQL block against a saved connection',
        ssh: 'Command block for a saved server',
        mermaid: 'Diagram (shown as code: see the weight note in the plan)',
        code: 'Code block',
    },

    lint: {
        brokenLink: (p) =>
            `The note «${p.target}» doesn't exist yet. That's normal in a knowledge graph: the link stays pending until you write it.`,
        createNote: 'Create the note',
        headingSpace:
            "A heading needs a space after the hash marks. Without it this is a TAG, not a heading — it's the most common Markdown mix-up.",
        convertToHeading: 'Turn into heading',
        exampleUrl: 'This link still has the example address: replace `url` with the real one.',
        unclosedFence:
            "This code block isn't closed, so everything after it is shown as code. Add ``` at the end.",
        closeAtEnd: 'Close it at the end',
    },

    frontmatterLint: {
        missing:
            "The frontmatter block is missing. Without it the CLI doesn't load this file — and doesn't tell you: it just doesn't show up. It must start with a \"---\" line.",
        unclosed: 'The frontmatter block is never closed: the closing "---" line is missing.',
        whyName: 'Without `name`, the CLI has nothing to refer to this by and ignores it.',
        whyDescription:
            "Without `description`, the agent can't decide whether this is relevant to what you asked, so in practice it never uses it.",
        missingKey: (p) => `\`${p.key}\` is missing from the frontmatter. ${p.why}`,
        emptyKey: (p) => `\`${p.key}\` is empty. ${p.why}`,
    },

    livePreview: {
        wikiEditing: (p) => `Cmd/Ctrl + click to open «${p.target}». Without the key, a click edits the link.`,
        wikiOpen: (p) => `Open «${p.target}». If it doesn't exist yet, you'll be offered to create it.`,
    },

    preview: {
        tagTitle: 'Tag. Search «tag:…» in the notes search to find every note that has it.',
        openNote: (p) => `Open the note «${p.target}». If it doesn't exist, you'll be offered to create it.`,
        noteRef: (p) => `Note: ${p.target}`,
        callout: {
            INFO: 'Info',
            TIP: 'Tip',
            WARNING: 'Warning',
            SECURITY: 'Security',
            DANGER: 'Danger',
            NOTE: 'Note',
        },
        checkboxTitle: 'It is checked by typing in the editor: this is the reading view.',
        frontmatterTitle: 'Frontmatter: whether the CLI loads this file depends on these fields',
    },

    graph: {
        title: 'Knowledge graph',
        counts: (p) => `${p.notes} notes · ${p.links} links`,
        selfLinksTitle:
            "Notes that link to themselves. They aren't drawn —a line from a node to itself says nothing— but they're counted here: otherwise the link shows in the note's side panel, no line appears in the graph, and the graph looks broken.",
        selfLinks: (n) => `· ${n} to itself`,
        brokenLinksTitle:
            "Links pointing to notes that don't exist yet. They aren't drawn because there's nowhere to put them, but they're counted: they're your base's pending work.",
        brokenLinks: (n) => `· ${n} without target`,
        hideOrphansTitle: "Hides notes that don't link to or aren't linked from any other",
        hideOrphans: 'Hide orphans',
        hidePrivateTitle:
            'Hides notes marked as private. It only changes this view: they still exist and remain unreadable to agents.',
        hidePrivate: 'Hide private',
        closeTitle: 'Closes the graph and goes back to what you were doing (Esc)',
        emptyBefore: 'No notes to graph yet. Write',
        emptyExample: '[[Another note]]',
        emptyAfter: 'inside one to start connecting them.',
        canvasTitle: 'Drag a node to move it, the background to pan the graph, and the wheel to zoom. A click opens the note.',
    },

    runbook: {
        rowsSummary: (p) => `${p.rows} rows · ${p.ms} ms`,
        cancelled: 'Cancelled',
        unknownError: 'unknown error',
        connectionGone: (p) => `The connection «${p.name}» is no longer saved on this machine.`,
        sshConnection: (p) => `«${p.name}» is an SSH connection: this block is SQL.`,
        moreStatements: (n) => `…and ${n} more statement(s).`,
        executable: 'executable block',
        cancelTitle: 'Stops the running execution',
        runTitle: (p) =>
            `Runs ONLY this block against «${p.name}». If that connection is marked as production and the statement changes data or structure, you'll get the same confirmation as in the SQL editor.`,
        run: 'Run',
        resultTitle:
            "The result isn't saved inside the note: it's shown here and goes away when you close it. A note with the last run's rows pasted in is documentation that goes stale on its own.",
        showing: (p) => ` · showing 200 of ${p.total}`,
        prodTitle: (p) => `You're in PRODUCTION — ${p.name}`,
        prodDescription: (p) =>
            `This runbook block changes data or structure on a connection marked as Production:\n\n${p.detail}`,
        runAnyway: 'Run anyway',
    },
}
export default en
