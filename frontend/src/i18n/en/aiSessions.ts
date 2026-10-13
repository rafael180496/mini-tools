import type {Messages} from '../types'
import type es from '../es/aiSessions'

// Persistent, background AI conversations: the «Open» and «Recent» groups of AI
// Chat (in Utilities, sidebar), the notices and the multiple AI Chat tabs. See
// lib/agentSessions.ts.
const en: Messages<typeof es> = {
    // Activity badge: sits on the Utilities icon and on the «AI Chat» row.
    module: {
        badgeTitle: (p) =>
            [
                p.approval > 0 ? (p.approval === 1 ? '1 conversation needs your approval' : `${p.approval} conversations need your approval`) : '',
                p.running > 0 ? (p.running === 1 ? '1 conversation working' : `${p.running} conversations working`) : '',
            ]
                .filter(Boolean)
                .join(' · '),
    },
    sidebar: {
        active: 'Open',
        activeHint:
            'Your open conversations. They stay here when you close their tab or the app —the ones that were working show as «interrupted» and resume with one click— until you close them with «Close chat» or delete them. Pinned ones go on top.',
        pinned: 'Pinned',
        pinnedHint: 'Conversations pinned to the top of the list. They are as open as the rest.',
        others: 'Open',
        recent: 'Recent',
        recentHint: 'The latest conversations that are not open, from any module and provider.',
        emptyActive: 'No open conversations.',
        emptyActiveHint: 'Every new chat shows up here as soon as you create it, even before you write to it, and stays until you close it.',
        emptyRecent: 'No conversations yet.',
        noMatches: (p) => `Nothing matches «${p.query}».`,
        untitled: 'Untitled',
        draftTitle: 'New chat · draft',
        status: {
            running: 'Working',
            awaiting_approval: 'Needs approval',
            idle: 'Finished — unread',
            error: 'Failed',
            cancelled: 'Stopped',
            interrupted: 'Interrupted when the app closed',
            draft: 'Draft — no messages',
        },
        idleRead: 'Finished',
        backgroundTag: 'in the background',
        backgroundTitle: 'Its tab is closed but the chat is still open. It stays here until you close it with «Close chat».',
        tokens: (p) => `${p.n} tokens`,
        tokensTitle: 'Tokens spent by the last turn (input + output). They are only known once it finishes.',
        elapsedTitle: 'How long this turn has been working.',
        rowTitle: (p) => `Open «${p.title}» in a tab (if it is working you watch its progress live)`,
        rowInterruptedTitle: (p) =>
            `«${p.title}» was working when the app closed and was cut off. Open it to resume: what was saved is drawn again and you can keep writing to it.`,
        open: 'Open',
        openTitle: 'Opens the conversation in an AI Chat tab (or goes to the one that already has it) and picks the turn up where it is.',
        openInterruptedTitle: 'Opens the interrupted conversation in an AI Chat tab, with what was saved, so you can keep writing to it.',
        pin: 'Pin',
        pinTitle: 'Pins this conversation to the top of the list. It stays open when you close the tab or the app; pinning only changes the order.',
        unpin: 'Unpin',
        unpinTitle: 'Removes the pin: the conversation stays open but sorts with the rest again.',
        stop: 'Stop',
        stopTitle:
            'Cuts the turn in progress and keeps the chat open: it stays in this list and you can write to it again. What the agent already wrote stays in the conversation. To end the chat for good, use «Close chat».',
        approve: 'Approve…',
        approveTitle: 'Opens the permission this conversation is waiting on, so you can allow or deny it.',
        markRead: 'Mark as read',
        markReadTitle: 'You have seen how it ended. The chat stays open in this list until you close it.',
        more: 'More chat actions',
        moreTitle: 'Open, pin, rename, stop, mark as read, close or delete the chat. Also available with a right-click on the row.',
        rename: 'Rename…',
        renameTitle: 'Changes the name of this conversation. It updates in the tabs, the history and this list.',
        closeChat: 'Close chat',
        closeChatTitle:
            'Closes the chat: stops whatever is running, removes it from «Open» and frees its memory. The conversation stays in «Recent» and can be opened again (an empty draft is discarded). Not the same as «Stop», which cuts the turn but keeps the chat open, nor «Delete», which erases it.',
        closeConfirm: {
            title: 'Close this chat?',
            description: (p) =>
                `«${p.title}» is working: it stops now and the chat is closed. What it already wrote or modified stays as it is; file changes are not undone on their own. The conversation stays in the history.`,
            confirm: 'Close chat',
        },
        stopConfirm: {
            title: 'Stop this conversation?',
            description: (p) =>
                `«${p.title}» stops working now. What it already wrote or modified stays as it is; file changes are not undone on their own.`,
            confirm: 'Stop',
        },
        delete: 'Delete',
        deleteTitle: 'Erases the conversation and all its saved messages. It cannot be undone. To keep it, use «Close chat».',
        deleteConfirm: {
            title: 'Delete this conversation?',
            description: (p) =>
                `«${p.title}» is erased with all its messages and, if it is working, it stops. It cannot be undone. The conversation the CLI itself keeps on its own is not touched.`,
            confirm: 'Delete',
        },
        recentOpenTitle: (p) => `Open «${p.title}» in an AI Chat tab`,
    },
    toast: {
        region: 'AI conversation notices',
        done: 'A conversation finished',
        error: 'A conversation failed',
        approval: 'Needs your approval',
        approvalText: (p) => `Wants to use ${p.tool}.`,
        review: 'Review',
        reviewTitle: 'Shows which action the agent is asking for so you can allow or deny it.',
        open: 'Open',
        openTitle: 'Goes to the conversation in an AI Chat tab.',
        close: 'Dismiss notice',
        backgroundTitle: 'Still working in the background',
        background: (p) => `«${p.title}» is still working in the background — find it under Utilities → AI Chat → Open.`,
        see: 'View',
        seeTitle: 'Opens Utilities → AI Chat → Open in the sidebar and takes you to this chat.',
        stop: 'Stop',
        stopTitle: 'Cuts the turn in progress. The chat stays open under AI Chat → Open; to close it for good use «Close chat» there.',
    },
    tabs: {
        newWindow: 'New chat tab',
        newWindowShort: 'New tab',
        newWindowTitle: (p) =>
            `Opens ANOTHER AI Chat tab, with its own project, provider and conversation (${p.shortcut}). Turns running in the others keep running.`,
        newChatMenu: 'More new chat options',
        newChatMenuTitle: 'Pick where the new chat opens: in this tab, in another tab, or by splitting this one into two panes.',
        newInThisTab: 'New chat in this tab',
        newInThisTabTitle: (p) => `Starts a new conversation in this same tab (${p.shortcut}). The current one stays in the history.`,
        newInNewTab: 'New chat in a new tab',
        newSplitTab: 'New split chat (new tab)',
        newSplitTabTitle: 'Opens a new AI Chat tab already split into two panes, to have two chats side by side.',
        splitMenu: 'Split: two chats side by side',
        unsplitShort: 'Remove split',
        emptyHint: (p) => `You can have several conversations at once: ${p.shortcut} opens another tab, or Split to see them side by side.`,
        openInNewTab: 'Open in a new tab',
        openInNewTabTitle: 'Opens this conversation in its own AI Chat tab, to keep it in view next to others.',
        split: 'Split',
        splitTitle: 'Shows TWO chats side by side in this tab, each with its own project, provider and session.',
        unsplit: 'Close pane',
        unsplitTitle: 'Closes the second pane. Its turns in progress do not stop: they keep going under Utilities → AI Chat → Open.',
        paneLabel: (p) => `Pane ${p.n}`,
        stateRunning: 'A conversation in this tab is working',
        stateApproval: 'A conversation in this tab is waiting for your approval',
        stateUnread: 'A conversation in this tab finished and you have not read it',
        closeTabTitle:
            'Closes the tab, not the chat: if a conversation is working it keeps going in the background and you will find it under Utilities → AI Chat → Open. To end it for good: right-click → «Close and stop the chat».',
        draftTitle: 'New chat',
        rename: 'Rename…',
        renameHint: 'F2',
        renameTitle:
            'Changes the name of the conversation this tab shows (also with a double-click or F2). The tab label is its conversation name; with no name and no project it says «New chat».',
        renameField: 'Conversation name',
        renameEditTitle: 'Type the new name. Enter saves, Esc cancels; leaving it empty changes nothing (up to 120 characters).',
        tabHint: (p) => `${p.title} — double-click or press F2 to rename the conversation`,
        closeTabKeep: 'Close tab (the chat keeps running in the background)',
        closeTabKeepTitle: 'Closes the tab without cutting anything: the conversations stay open under AI Chat → Open (the ones that are working keep working).',
        closeForReal: 'Close and stop the chat',
        closeForRealTitle: 'Closes the tab AND the conversations it shows: stops whatever is running, removes them from AI Chat → Open and frees their memory. The saved history stays.',
        closeForRealConfirm: {
            title: 'Close and stop the chat?',
            description: (p) =>
                p.n === 1
                    ? `«${p.title}» is working: it stops now and the chat is closed along with the tab. What it already wrote or modified stays as it is; file changes are not undone on their own.`
                    : `${p.n} conversations in this tab are working: they stop now and are closed along with the tab. What they already wrote or modified stays as it is; file changes are not undone on their own.`,
            confirm: 'Close and stop',
        },
    },
}

export default en
