// Confirmación antes de ejecutar algo destructivo contra una base marcada
// como Producción.
//
// Es el equivalente en SQL de lo que ya hacía la terminal SSH (ver
// lib/productionGuard.ts): la marca de entorno dejaba de ser decorativa y
// pasaba a pedir confirmación. En las conexiones de base la marca existía
// —la insignia PROD en la barra lateral— pero no hacía absolutamente nada,
// así que un DROP contra producción salía igual de rápido que contra la copia
// local.
//
// Deliberadamente NO reemplaza al linter (lib/linter.ts). Ese avisa por cosas
// que están mal escritas (un UPDATE sin WHERE) en cualquier base; esto avisa
// por cosas que están bien escritas pero van a un lugar donde el error no se
// deshace. Son preguntas distintas y por eso conviven: en una base de
// desarrollo un DROP TABLE no pregunta nada, y sigue sin preguntar.

export interface SqlRisk {
    // La sentencia recortada, para que la confirmación muestre qué se va a
    // ejecutar y no solo que "hay algo peligroso".
    statement: string
    // Qué se reconoció, en el título.
    label: string
    // Por qué importa, en términos de consecuencia y no de sintaxis.
    detail: string
}

interface Rule {
    test: RegExp
    label: string
    detail: string
}

// Ordenadas de más a menos grave: la primera que coincide es la que se
// muestra, así una sentencia no aparece etiquetada con la razón menos
// importante de las que cumple.
const RULES: Rule[] = [
    {
        test: /^\s*DROP\s+(DATABASE|SCHEMA)\b/i,
        label: 'DROP DATABASE / SCHEMA',
        detail: 'Elimina la base o el esquema entero con todo lo que contiene. No hay ROLLBACK que lo devuelva.',
    },
    {
        test: /^\s*DROP\s+(TABLE|VIEW|INDEX|SEQUENCE|PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|SYNONYM)\b/i,
        label: 'DROP',
        detail: 'Elimina el objeto y, si es una tabla, sus datos. En Oracle un DDL además hace COMMIT implícito: no se puede deshacer con ROLLBACK.',
    },
    {
        test: /^\s*TRUNCATE\b/i,
        label: 'TRUNCATE',
        detail: 'Vacía la tabla entera. Es DDL, así que hace COMMIT implícito y no se puede deshacer con ROLLBACK ni queda en el UNDO.',
    },
    {
        test: /^\s*(DELETE|UPDATE)\b(?![\s\S]*\bWHERE\b)/i,
        label: 'DELETE / UPDATE sin WHERE',
        detail: 'Afecta todas las filas de la tabla.',
    },
    {
        test: /^\s*ALTER\s+(TABLE|USER|DATABASE|SYSTEM|SESSION)\b/i,
        label: 'ALTER',
        detail: 'Cambia la estructura o la configuración. En Oracle es DDL con COMMIT implícito.',
    },
    {
        test: /^\s*(GRANT|REVOKE)\b/i,
        label: 'GRANT / REVOKE',
        detail: 'Cambia permisos de acceso en producción.',
    },
    {
        test: /^\s*(DELETE|UPDATE|INSERT|MERGE)\b/i,
        label: 'Escritura de datos',
        detail: 'Modifica datos de producción.',
    },
]

// stripNoise saca comentarios y literales antes de buscar patrones, para que
// un `-- no hagas DROP TABLE` o un `WHERE msg = 'DROP TABLE x'` no disparen la
// confirmación. Misma precaución que toma el guard de la terminal.
function stripNoise(sql: string): string {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .replace(/'(?:''|[^'])*'/g, "''")
}

// splitTopLevel parte en sentencias por ';' de forma deliberadamente ingenua:
// esto decide si preguntar, no qué ejecutar. El corte de verdad lo hace
// backend/query/splitter.go, que sí entiende bloques PL/SQL; duplicar acá esa
// lógica sería tener dos definiciones de "una sentencia" que se desincronizan.
// Un bloque PL/SQL cortado a la mitad sigue conteniendo el DROP que hay que
// mostrar, que es todo lo que se necesita para preguntar.
function splitTopLevel(sql: string): string[] {
    return sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
}

// inspectSQL devuelve las sentencias del script que ameritan confirmación.
// Vacío = ejecutar sin preguntar.
export function inspectSQL(sql: string): SqlRisk[] {
    const out: SqlRisk[] = []
    for (const raw of splitTopLevel(stripNoise(sql))) {
        for (const rule of RULES) {
            if (rule.test.test(raw)) {
                out.push({
                    statement: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw,
                    label: rule.label,
                    detail: rule.detail,
                })
                break
            }
        }
    }
    return out
}
