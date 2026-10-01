import type {Messages} from '../types'
import type es from '../es'
import common from './common'
import shell from './shell'
import lock from './lock'
import settings from './settings'
import sidebar from './sidebar'
import workspace from './workspace'
import editor from './editor'
import results from './results'
import db from './db'
import git from './git'
import http from './http'
import redis from './redis'
import mongo from './mongo'
import sftp from './sftp'
import ssh from './ssh'
import terminal from './terminal'
import notes from './notes'
import agent from './agent'
import utilities from './utilities'

const en: Messages<typeof es> = {
    common,
    shell,
    lock,
    settings,
    sidebar,
    workspace,
    editor,
    results,
    db,
    git,
    http,
    redis,
    mongo,
    sftp,
    ssh,
    terminal,
    notes,
    agent,
    utilities,
}
export default en
