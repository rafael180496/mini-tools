// Textos del área «git». Ver .claude/specs/i18n.md.
// Partido en un archivo por componente (gitparts/) para poder migrarlos en paralelo.
import tab from './gitparts/tab'
import settings from './gitparts/settings'
import agent from './gitparts/agent'
import clone from './gitparts/clone'
import remotes from './gitparts/remotes'
import diff from './gitparts/diff'
import conflicts from './gitparts/conflicts'
import graph from './gitparts/graph'
import rebase from './gitparts/rebase'
import fileEditor from './gitparts/fileEditor'
import output from './gitparts/output'
import stash from './gitparts/stash'
import reflog from './gitparts/reflog'
import commandLog from './gitparts/commandLog'
import errorBoundary from './gitparts/errorBoundary'
import commitMsg from './gitparts/commitMsg'
import search from './gitparts/search'

export default {
    tab,
    settings,
    agent,
    clone,
    remotes,
    diff,
    conflicts,
    graph,
    rebase,
    fileEditor,
    output,
    stash,
    reflog,
    commandLog,
    errorBoundary,
    commitMsg,
    search,
}
