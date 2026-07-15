import postgresIcon from '../assets/db-icons/postgres.svg'
import oracleIcon from '../assets/db-icons/oracle.svg'
import sqliteIcon from '../assets/db-icons/sqlite.svg'
import redisIcon from '../assets/db-icons/redis.svg'

const ICONS: Record<string, string> = {
    postgres: postgresIcon,
    oracle: oracleIcon,
    sqlite: sqliteIcon,
    redis: redisIcon,
}

const LABELS: Record<string, string> = {
    postgres: 'PostgreSQL',
    oracle: 'Oracle',
    sqlite: 'SQLite',
    redis: 'Redis',
}

// Usado tanto por ConnectionTree.tsx (árbol de conexiones) como por
// ConnectionDialog.tsx (selector de tipo al crear/editar) — vive en el
// nivel compartido de components/, no bajo sidebar/, porque ya no es
// exclusivo del sidebar.
export const DB_TYPES = ['sqlite', 'postgres', 'oracle', 'redis'] as const

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
