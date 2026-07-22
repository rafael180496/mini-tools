import postgresIcon from '../assets/db-icons/postgres.svg'
import oracleIcon from '../assets/db-icons/oracle.svg'
import sqliteIcon from '../assets/db-icons/sqlite.svg'
import sqlserverIcon from '../assets/db-icons/sqlserver.svg'
import mongodbIcon from '../assets/db-icons/mongodb.svg'
import redisIcon from '../assets/db-icons/redis.svg'
import sshIcon from '../assets/db-icons/ssh.svg'

const ICONS: Record<string, string> = {
    postgres: postgresIcon,
    oracle: oracleIcon,
    sqlite: sqliteIcon,
    sqlserver: sqlserverIcon,
    mongodb: mongodbIcon,
    redis: redisIcon,
    ssh: sshIcon,
}

const LABELS: Record<string, string> = {
    postgres: 'PostgreSQL',
    oracle: 'Oracle',
    sqlite: 'SQLite',
    sqlserver: 'SQL Server',
    mongodb: 'MongoDB',
    redis: 'Redis',
    ssh: 'SSH',
}

// Usado tanto por ConnectionTree.tsx (árbol de conexiones) como por
// ConnectionDialog.tsx (selector de tipo al crear/editar) — vive en el
// nivel compartido de components/, no bajo sidebar/, porque ya no es
// exclusivo del sidebar.
export const DB_TYPES = ['sqlite', 'postgres', 'oracle', 'sqlserver', 'mongodb', 'redis', 'ssh'] as const

export function dbTypeLabel(dbType: string): string {
    return LABELS[dbType] ?? dbType
}

interface DbTypeIconProps {
    dbType: string
    size?: number
    className?: string
}

export default function DbTypeIcon({dbType, size = 16, className}: DbTypeIconProps) {
    const src = ICONS[dbType]
    if (!src) return null
    return (
        <img
            src={src}
            alt=""
            width={size}
            height={size}
            title={LABELS[dbType] ?? dbType}
            className={`shrink-0${className ? ` ${className}` : ''}`}
        />
    )
}
