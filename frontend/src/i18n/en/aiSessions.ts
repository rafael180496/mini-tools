import type {Messages} from '../types'
import type es from '../es/aiSessions'

// Background AI sessions: the «Active» and «Recent» groups of AI Chat (in
// Utilities, sidebar), the notices and the multiple AI Chat tabs. See
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
        active: 'Active',
        activeHint:
            'Conversations that are working, waiting for your permission, failed, finished without you seeing them, or were left open in the background when their tab was closed. Only «Close chat» removes them from here.',
        recent: 'Recent',
        recentHint: 'The latest conversations, from any module and provider.',
        emptyActive: 'Nothing running.',
        emptyActiveHint: 'Working, waiting or background chats show up here.',
        emptyRecent: 'No conversations yet.',
        noMatches: (p) => `Nothing matches «${p.query}».`,
        untitled: 'Untitled',
        status: {
            running: 'Working',
            awaiting_approval: 'Needs approval',
            idle: 'Finished — unread',
            error: 'Failed',
            cancelled: 'Stopped',
        },
        idleRead: 'Finished',
        backgroundTag: 'in the background',
        backgroundTitle: 'Its tab is closed but the chat is still open. It stays here until you close it with «Close chat».',
        tokens: (p) => `${p.n} tokens`,
        tokensTitle: 'Tokens spent by the last turn (input + output). They are only known once it finishes.',
        elapsedTitle: 'How long this turn has been working.',
        rowTitle: (p) => `Open «${p.title}» in a tab and watch its progress live`,
        open: 'Open',
        openTitle: 'Opens the conversation in an AI Chat tab (or goes to the one that already has it) and picks the turn up where it is.',
        stop: 'Stop',
        stopTitle:
            'Cuts the turn in progress and keeps the chat open: it stays in this list and you can write to it again. What the agent already wrote stays in the conversation. To end the chat for good, use «Close chat».',
        letFinish: 'Let it finish',
        letFinishTitle: 'Removes it from this list without stopping it: the turn runs to completion, and it shows up again when it finishes or asks for permission.',
        approve: 'Approve…',
        approveTitle: 'Opens the permission this conversation is waiting on, so you can allow or deny it.',
        markRead: 'Mark as read',
        markReadTitle: 'You have seen how it ended. If its tab was closed, the chat stays open in this list until you close it.',
        more: 'More chat actions',
        moreTitle: 'Open, stop, let it finish, mark as read or close the chat. Also available with a right-click on the row.',
        rename: 'Rename…',
        renameTitle: 'Changes the name of this conversation. It updates in the tabs, the history and this list.',
        closeChat: 'Close chat',
        closeChatTitle:
            'Closes the chat: stops whatever is running, removes it from «Active» and frees its memory. The conversation stays in «Recent» and can be opened again. Not the same as «Stop», which cuts the turn but keeps the chat open.',
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
        background: (p) => `«${p.title}» is still working in the background — find it under Utilities → AI Chat → Active.`,
        see: 'View',
        seeTitle: 'Opens Utilities → AI Chat → Active in the sidebar and takes you to this chat.',
        stop: 'Stop',
        stopTitle: 'Cuts the turn in progress. The chat stays open under AI Chat → Active; to close it for good use «Close chat» there.',
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
        unsplitTitle: 'Closes the second pane. Its turns in progress do not stop: they keep going under Utilities → AI Chat → Active.',
        paneLabel: (p) => `Pane ${p.n}`,
        stateRunning: 'A conversation in this tab is working',
        stateApproval: 'A conversation in this tab is waiting for your approval',
        stateUnread: 'A conversation in this tab finished and you have not read it',
        closeTabTitle:
            'Closes the tab, not the chat: if a conversation is working it keeps going in the background and you will find it under Utilities → AI Chat → Active. To end it for good: right-click → «Close and stop the chat».',
        draftTitle: 'New chat',
        rename: 'Rename…',
        renameHint: 'F2',
        renameTitle:
            'Changes the name of the conversation this tab shows (also with a double-click or F2). The tab label is its conversation name; with no name and no project it says «New chat».',
        renameField: 'Conversation name',
        renameEditTitle: 'Type the new name. Enter saves, Esc cancels; leaving it empty changes nothing (up to 120 characters).',
        tabHint: (p) => `${p.title} — double-click or press F2 to rename the conversation`,
        closeTabKeep: 'Close tab (the chat keeps running in the background)',
        closeTabKeepTitle: 'Closes the tab without cutting anything: conversations that are working keep going and stay under AI Chat → Active.',
        closeForReal: 'Close and stop the chat',
        closeForRealTitle: 'Closes the tab AND the conversations it shows: stops whatever is running, removes them from AI Chat → Active and frees their memory. The saved history stays.',
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
