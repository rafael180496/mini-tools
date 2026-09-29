import type {Messages} from '../types'
import type es from '../es/workspace'

const en: Messages<typeof es> = {
    tabs: {
        untitledQuery: 'Untitled query',
        quickRequest: 'Quick request',
        note: 'Note',
        redisBrowser: 'Redis Browser',
        mongoBrowser: 'MongoDB Browser',
        mongoQuery: 'Mongo query',
        terminal: (p) => `Terminal — ${p.name}`,
        session: (p) => `Session — ${p.name}`,
        sftp: (p) => `SFTP — ${p.name}`,
        git: (p) => `Git — ${p.name}`,
    },
    modules: {
        connections: 'Connections',
        connectionsHint: 'databases: browse the schema and run queries',
        sshHint: 'remote servers: open a terminal or transfer files',
        gitHint: 'repositories: see changes, branches and work with agents',
        notes: 'Notes',
        notesHint: 'your encrypted knowledge base: runbooks and notes',
        httpHint: 'request collections: test and save endpoints',
    },
    gitSidebarLabel: 'Git sidebar',
    status: {
        backupSaved: (p) => `Backup saved to ${p.path}`,
        backupNotSaved: 'No backup was saved: the dialog was closed without choosing where.',
        txOpened: 'Transaction open — auto-commit off',
        committed: 'Committed — auto-commit on',
        rolledBack: 'Rolled back — auto-commit on',
        refreshingMetadata: 'Refreshing metadata…',
        txBusy: (p) =>
            `"${p.name}" has an open transaction and is already running: both runs would share that transaction. Wait for it to finish, or Commit/Rollback.`,
        unknownError: 'Unknown error',
        pickMongoDb: 'Pick a database in the sidebar tree before running MongoDB commands',
        bindFirst: 'Bind this tab to a connection before running (icon to the left of the title)',
        configExported: (p) => `Config exported to ${p.path}`,
        disconnected: 'Disconnected',
        connectionDeleted: 'Connection deleted',
        schemaDdlExported: (p) => `Schema DDL exported to ${p.path}`,
        remoteSaved: (p) => `Saved ${p.path} on ${p.conn}`,
        binaryFile: (p) => `"${p.path}" is a binary file — it can't be edited as text.`,
        tooLarge: (p) => `"${p.path}" is too large to open in the editor.`,
        catalogUnreadable: "couldn't read the catalog",
    },
    confirmRun: {
        prodTitle: (p) => `You're in PRODUCTION — ${p.name}`,
        prodDescription: (p) =>
            `This script modifies data or structure on a connection marked as Production:\n\n${p.detail}${
                p.more > 0 ? `\n\n…and ${p.more} more statement${p.more === 1 ? '' : 's'}.` : ''
            }`,
        lintTitle: 'Warnings before running',
        lintLine: (p) => `Line ${p.line}: ${p.message}`,
    },
    gridEdit: {
        rolledBack: '-- the whole transaction was rolled back, no statement was applied',
        origin: 'Grid edit',
        originMany: (n) => `Grid edit · ${n} statements in one transaction`,
    },
    deletedFiles: {
        title: 'Files not found',
        body: "These files were open last time but no longer exist on disk — they won't be reopened automatically:",
        closeTitle: 'Closes this notice — tabs for files that no longer exist on disk stay as unsaved tabs',
        ok: 'Got it',
    },
    agent: {
        editorQuery: 'Editor query',
        insertNote: 'Inserts the block into the note, at the cursor',
        insertEditor: "Inserts the block into the editor, at the cursor — it doesn't overwrite what you wrote",
    },
    toolbar: {
        save: "Save the tab to disk (Ctrl+S). If it's a new tab, it asks where to save it",
        runTitle: "Run the selection, or the statement under the cursor if there's no selection (Ctrl+Enter)",
        run: 'Run',
        runAll: 'Run ALL statements in the editor in order, one by one (Ctrl+Shift+Enter)',
        cancelDisabled: 'Cancel: disabled, no query is running in this tab',
        interruptMany: (n) => `Interrupt the ${n} runs in this tab. Doesn't touch what the other tabs are running.`,
        interruptOne: "Interrupt the query running in this tab. Doesn't touch what the other tabs are running.",
        explain:
            'Explain: shows the execution plan WITHOUT running anything. Explains the selection; with no selection, the statement under the cursor — not the whole file',
        explainAnalyze:
            'Explain Analyze — actually RUNS the query against the database and shows the plan with real rows and timings. Runs the selection; with no selection, the statement under the cursor. If it modifies data it asks for confirmation and runs inside a transaction that is rolled back',
        refresh: 'Refresh the catalog: re-reads tables and columns from the database (F5) — use it if you just created or altered a table',
        txOpen: 'Transaction open',
        commit: 'Commit: permanently confirms every change (INSERT/UPDATE/DELETE) made since the transaction was opened, and goes back to auto-commit',
        rollback: 'Rollback: discards every pending change in the transaction, returns to the state before opening it and turns auto-commit back on',
        autoCommit:
            'Auto-commit on: each statement is applied as soon as it finishes. Click to switch to a manual transaction — from then on changes stay pending until you Commit or Rollback',
        dbmsOn: 'DBMS_OUTPUT on: the DBMS_OUTPUT.PUT_LINE log of each PL/SQL block is captured and shown in its own tab. Click to turn it off — in a script with many blocks it saves the ENABLE/GET_LINE round-trips',
        dbmsOff: "DBMS_OUTPUT off: your PL/SQL blocks' PUT_LINE output isn't read or shown. Click to capture it",
        loadingCatalog: "Reading the connection's tables, columns and routines for editor autocomplete",
        catalogError: (p) =>
            `The editor couldn't read this connection's catalog, so autocomplete only offers keywords and functions — no tables or columns. Reason: ${p.reason}. It's usually permissions on the data dictionary or a dropped connection; reconnecting tries again.`,
        schemaAria: 'Active schema',
        schemaTitle: "This connection's active schema: narrows editor autocomplete and is the one assumed when you write a table without a prefix",
        mongoPlaceholder: 'pick a database',
        mongoAria: 'Active MongoDB database',
        mongoTitle: 'Database that `db` points to in the mongosh editor — changing it here repoints every command in this tab',
        wizard: 'Query assistant: build a find() visually (collection, conditions, sort, limit) — it opens in an editor tab and runs',
        wizardDisabled: 'Query assistant: pick a database first, the assistant needs to know which collections to build the find() on',
        boundTitle: (p) =>
            `This tab runs against the connection "${p.name}" (${p.engine}). To change it, use the selector to the left of the tab title.`,
        unboundTitle:
            "This tab isn't bound to any connection, so it can't run anything yet. Bind it with the icon to the left of the tab title.",
        noConnection: 'No connection',
    },
    bottom: {
        resizeTitle: 'Drag to change the editor height — the size is remembered',
        resultsTitle: 'Result of the last run: the grid of returned rows',
        results: 'Results',
        consoleTitle:
            'Execution console: every statement of the last script run, with its full text and whether it finished OK (with duration) or with an error — like the output of a desktop SQL client',
        console: 'Console',
        dbmsTitle: (n) =>
            `DBMS_OUTPUT.PUT_LINE output of the last PL/SQL block run — ${n} ${n === 1 ? 'line' : 'lines'}, with filter and copy`,
        explainTitle: 'Execution plan of the last explained query, with metrics and diagnostics. Close it with the X, like a results tab.',
        dbmsOutput: 'DBMS_OUTPUT',
        explain: 'Explain',
        explainAnalyze: 'Explain Analyze',
        criticalIssues: (n) => `${n} critical issue${n === 1 ? '' : 's'} found in the plan`,
        closeExplain: 'Closes the execution plan',
    },
    paging: {
        showing: 'Showing',
        rows: 'rows',
        loadMoreTitle: "Fetch the next rows of the same result — it doesn't rerun the query, it keeps reading the open cursor",
        loadMore: (p) => (p.n === null ? 'Load all' : `Load ${p.n} more`),
        loadingMore: 'Loading more…',
        cancelLoadTitle: 'Cancel loading this page — rows already fetched are kept',
        otherQuery: 'another query used this connection',
        closedTitle: (p) =>
            `The cursor paging this result was closed because ${p.reason}: the engine keeps only one paused cursor per connection (backend/query/paging.go). Run the query again to keep reading from the start.`,
        closed: (p) => `paging closed — ${p.reason}`,
        complete: '— complete result',
        pageSizeTitle: "How many rows each page fetches. 'All' turns paging off — careful with large tables. Saved as a preference.",
        pageSize: 'Rows per page',
        all: 'All',
    },
    footer: {
        runningProgress: (p) => `Running ${p.current}/${p.total}…`,
        running: 'Running…',
        liveRunsTitle: (n) => `${n} runs in progress in this tab. The progress shown is the latest one's; "Cancel" stops them all.`,
        liveRuns: (n) => `${n} runs`,
        rows: (p) => `${p.rows} rows ·`,
        durationMs: (p) => `${p.ms} ms`,
        cancelled: 'Cancelled',
        fixTitle:
            "Gives the agent the error, the query and the schema of the tables it mentions, and proposes a fixed version. It doesn't run it: you apply it.",
        fix: 'Explain and fix',
    },
    dialogs: {
        backupTitle: 'Confirm vault backup',
        backupDescription:
            "The backup includes your encrypted connections and may end up on another machine — re-enter your master key to confirm. Without it, the backup is useless even if someone copies it.",
        backupConfirm: 'Save backup',
        destructiveTitle: 'Destructive command',
        redisDescription: 'This script includes FLUSHALL/FLUSHDB, which deletes Redis data irreversibly. Run anyway?',
        mongoDescription:
            'This script includes a deleteMany/updateMany with an empty filter or a drop(), which affects or deletes data irreversibly. Run anyway?',
        run: 'Run',
        analyzeTitle: 'Explain Analyze runs the query',
        analyzeDescription:
            "This script modifies data or structure (INSERT/UPDATE/DELETE/DDL). EXPLAIN ANALYZE actually runs it to measure it. It will run inside a transaction that is rolled back at the end, so no changes should remain applied — but triggers, sequences and effects outside the transaction do happen.",
        analyzeConfirm: 'Run and measure',
        runAnyway: 'Run anyway',
        remoteTitle: 'The file changed on the server',
        remoteDescription: (p) =>
            `"${p.path}" was modified on ${p.conn} since you opened it. If you continue, your changes replace the ones now on the server and those are lost. Cancel if you'd rather reopen it and compare first.`,
        overwrite: 'Overwrite anyway',
    },
}
export default en
