import type {Messages} from '../types'
import type es from '../es/editor'

const en: Messages<typeof es> = {
    tabs: {
        kindHint: {
            editor: 'Query editor',
            redisBrowser: 'Redis key browser',
            mongoBrowser: 'MongoDB collection browser',
            sshTerminal: 'Remote terminal',
            localTerminal: 'Terminal on this machine',
            sftp: 'File transfer between hosts',
            sshHybrid: 'Remote terminal with a file browser alongside',
            remoteFile: 'File on a server, edited live',
            gitRepo: 'Repository',
            note: 'Knowledge base note',
            httpRequest: 'HTTP request from a collection',
            redisConsole: 'Redis command console',
            mongoConsole: 'mongosh console',
        },
        badgeRemote: 'REMOTE',
        badgeNote: 'NOTE',
        boundTo: (p) => `Bound to "${p.name}" (${p.engine}) — click to change`,
        unbound: (p) =>
            `No connection bound (language: ${p.language}) — click to bind a connection or change the language. The bound connection is shown above, in the toolbar.`,
        tabTitle: (p) => `${p.path ?? 'Unsaved tab'} — drag to reorder · middle-click to close`,
        notBindable: (p) => `${p.hint} — can't be bound to a database connection; open a new tab for that`,
        running: 'This tab is running something right now',
        closeDirty: 'Close tab (there are unsaved changes)',
        close: 'Close tab',
        connection: 'Connection',
        noConnection: 'No connection',
        tabConnection: 'Tab connection',
        language: 'Language',
        tabLanguage: 'Tab language',
        newTitle: 'Opens a new blank tab to write a query without saving it yet',
        new: 'New',
        openTitle: 'Opens a .sql file from your disk in a new editor tab',
        open: 'Open',
    },
    recent: {
        title: 'Shows the last .sql files you opened, to reopen them quickly',
        button: 'Recent',
        empty: 'No recent files.',
        clearTitle: 'Clears the recent files list (the files stay, only the history goes)',
        clear: 'Clear history',
    },
    nl: {
        context: {
            sql: {
                one: 'table',
                many: 'tables',
                explain: 'It was given the DDL of these tables — columns, types and keys, no rows',
                empty: "It wasn't given the DDL of any table: the request didn't mention any that exists in this connection.",
            },
            mongodb: {
                one: 'collection',
                many: 'collections',
                explain: 'It was given the field names and types of these collections — no documents',
                empty: "It wasn't given details of any collection: the request didn't mention any that exists in this database.",
            },
            redis: {
                one: 'key pattern',
                many: 'key patterns',
                explain: 'It was given these key PATTERNS with their type — no full keys and no values',
                empty: "Couldn't sample any key from this connection.",
            },
        },
        fixTitle: 'Explain and fix',
        writeRedis: 'Write commands',
        writeMongo: 'Write a Mongo query',
        writeSql: 'Write a query',
        dialectHint:
            "The agent writes in THIS engine's dialect: the same query is written differently in Oracle, Postgres or SQL Server, and one written for the wrong engine fails when run.",
        closeTitle: 'Closes the assistant without applying anything (Esc)',
        placeholderChange: "What to change in what's in the editor… (Enter sends)",
        placeholderNew: 'What do you need… (Enter sends, Shift+Enter for a new line)',
        askTitle: "Asks the active agent for the query. It doesn't run it: it proposes it for you to review.",
        ask: 'Ask',
        busyFix: 'Reading the error and the schema…',
        busyWrite: 'Writing the query…',
        proposal: 'Proposal',
        lines: 'lines',
        contextTitle: (p) => `${p.explain}:\n${p.items}${p.total > p.totalOf ? `\n\n(of ${p.total} ${p.many} in the connection)` : ''}`,
        contextLabel: (p) => `context: ${p.n} ${p.noun}`,
        applyHint:
            'Apply only replaces the editor text. Running the query is still the usual button, with the production confirmation where it applies.',
        applyReplaces: 'Apply replaces the editor.',
        runsNothing: "It doesn't run anything.",
        discardTitle: 'Discards the proposal and leaves the editor as it was',
        discard: 'Discard',
        copyTitle: 'Copies the proposed query without touching the editor',
        copy: 'Copy',
        applyTitle: 'Replaces the editor content with the proposed query. You can undo with Cmd/Ctrl+Z.',
        apply: 'Apply',
    },
    params: {
        types: {
            text: 'Text',
            textHint: 'Sent as-is, as a string',
            number: 'Number',
            numberHint: 'Converted to an integer or decimal',
            boolean: 'Boolean',
            booleanHint: 'true / false',
            nullHint: 'Binds NULL, ignoring the typed value',
        },
        title: 'Query parameters',
        intro: (n) =>
            n === 1
                ? 'The query declares one parameter. Its value is sent bound, never inserted into the SQL text.'
                : `The query declares ${n} parameters. Their values are sent bound, never inserted into the SQL text.`,
        positional: (p) => `Positional parameter ${p.name}: the #${p.name} "?" in the query, counting from the start of the script`,
        named: (p) => `Parameter ${p.raw} as it appears in the query`,
        valuePlaceholder: 'value',
        nullDisabled: "Disabled because the type is NULL: NULL is bound no matter what's typed here",
        valueTitle: (p) => `Value bound to ${p.raw} when running`,
        typeAria: (p) => `Type of parameter ${p.raw}`,
        typeTitle: 'How the value is converted before binding: text as-is, number, boolean, or NULL',
        cancelTitle: 'Closes without running the query; the typed values are discarded',
        runAllEmpty: 'Runs binding every parameter empty — you probably want to type some value first',
        runTitle: 'Runs the query binding these values',
        run: 'Run',
    },
    languages: {
        plainText: 'Plain text',
    },
    lint: {
        selectStar: 'SELECT * may bring unnecessary columns — prefer listing the columns you need.',
        noWhere: 'UPDATE/DELETE without WHERE affects every row in the table.',
    },
    sqlGuard: {
        dropDatabase: {
            label: 'DROP DATABASE / SCHEMA',
            detail: 'Deletes the whole database or schema with everything in it. No ROLLBACK brings it back.',
        },
        drop: {
            label: 'DROP',
            detail: "Deletes the object and, if it's a table, its data. In Oracle a DDL also does an implicit COMMIT: it can't be undone with ROLLBACK.",
        },
        truncate: {
            label: 'TRUNCATE',
            detail: "Empties the whole table. It's DDL, so it does an implicit COMMIT and can't be undone with ROLLBACK nor is it kept in UNDO.",
        },
        noWhere: {
            label: 'DELETE / UPDATE without WHERE',
            detail: 'Affects every row in the table.',
        },
        alter: {
            label: 'ALTER',
            detail: "Changes the structure or configuration. In Oracle it's DDL with an implicit COMMIT.",
        },
        grant: {
            label: 'GRANT / REVOKE',
            detail: 'Changes access permissions in production.',
        },
        write: {
            label: 'Data write',
            detail: 'Modifies production data.',
        },
    },
}
export default en
