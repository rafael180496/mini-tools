// Piezas compartidas del módulo HTTP: lo que necesitan tanto el árbol de la
// barra lateral como la pestaña de una petición.
//
// Vive aparte de los componentes para que el color de un método sea uno solo
// en toda la aplicación: el árbol y la barra de URL tienen que pintar `POST`
// del mismo color, y dos tablas de colores terminan divergiendo.

import {httpclient} from '../../../wailsjs/go/models'

// Métodos ofrecidos en el selector. El orden es el de uso real, no
// alfabético: GET y POST arriba porque son el 90% de las veces.
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

// Color por método, con tokens semánticos del sistema de diseño (MD3) — no
// colores crudos de Tailwind, que ya no existen en la paleta activa.
//
// El criterio es el riesgo, no la estética: lo que solo lee va en el color
// tranquilo, lo que modifica en el de acento, y lo que BORRA en el de error.
// Un `DELETE` tiene que saltar a la vista en una lista de treinta peticiones.
export function methodColor(method: string): string {
    switch (method.toUpperCase()) {
        case 'GET':
        case 'HEAD':
            return 'text-secondary'
        case 'POST':
            return 'text-tertiary'
        case 'PUT':
        case 'PATCH':
            return 'text-primary'
        case 'DELETE':
            return 'text-error'
        default:
            return 'text-on-surface-variant'
    }
}

// Color del status de la respuesta. 2xx bien, 3xx neutro, 4xx/5xx error —
// mismo criterio de riesgo.
export function statusColor(status: number): string {
    if (status >= 200 && status < 300) return 'text-secondary'
    if (status >= 300 && status < 400) return 'text-tertiary'
    if (status >= 400) return 'text-error'
    return 'text-on-surface-variant'
}

// Las columnas de tabla (params, headers, variables de ruta) se persisten
// como texto JSON en el vault: es una lista heterogénea que no vale una
// tabla relacional propia y que el import de Postman (F6) va a volcar tal
// cual. Estas dos funciones son la única frontera donde ese texto se
// convierte en datos.
export function parseRows(raw: string | undefined): httpclient.KeyValue[] {
    if (!raw || !raw.trim()) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.map((r) => new httpclient.KeyValue(r)) : []
    } catch {
        // Una fila corrupta no puede impedir abrir la petición.
        return []
    }
}

export function serializeRows(rows: httpclient.KeyValue[]): string {
    const kept = rows.filter((r) => r.key.trim() !== '' || r.value.trim() !== '')
    return kept.length === 0 ? '' : JSON.stringify(kept)
}

// Lee las variables de ruta que la URL declara (`:id`), preservando el valor
// ya escrito para las que siguen existiendo.
//
// Se recalcula desde la URL en vez de guardarse suelto porque la URL es la
// fuente de verdad: borrar `:id` del texto tiene que hacer desaparecer su
// fila, y una tabla que sobrevive a su variable es una fila que el usuario
// no entiende de dónde salió.
export function pathVarsFromURL(url: string, existing: httpclient.KeyValue[]): httpclient.KeyValue[] {
    const found: string[] = []
    // Solo en la parte de ruta: un `:` dentro de la query o del host
    // (`http://user:pass@`, `localhost:3000`) no es una variable.
    const withoutQuery = url.split('?')[0]
    const afterScheme = withoutQuery.replace(/^[a-zA-Z][\w+.-]*:\/\//, '')
    const firstSlash = afterScheme.indexOf('/')
    if (firstSlash < 0) return []
    for (const segment of afterScheme.slice(firstSlash).split('/')) {
        if (segment.startsWith(':') && segment.length > 1) {
            const name = segment.slice(1)
            if (!found.includes(name)) found.push(name)
        }
    }
    return found.map((name) => {
        const previous = existing.find((e) => e.key === name)
        return new httpclient.KeyValue({key: name, value: previous?.value ?? '', enabled: true})
    })
}

// Fila vacía para el final de cada tabla: escribir ahí crea una fila nueva,
// que es cómo se agregan sin un botón "+".
export function emptyRow(): httpclient.KeyValue {
    return new httpclient.KeyValue({key: '', value: '', enabled: true, description: ''})
}

// Tamaño legible, mismo formato que usa Go en el historial.
export function humanSize(n: number): string {
    if (n < 1024) return `${n} B`
    const units = ['KiB', 'MiB', 'GiB', 'TiB']
    let value = n / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return `${value.toFixed(1)} ${units[i]}`
}

// --- Tipos que NO viven en los modelos generados ------------------------------
//
// `Variable` y `Computed` existen en Go (backend/httpclient) pero **no
// aparecen en la firma de ningún binding**: viajan adentro de un texto JSON
// que el vault guarda como columna opaca. El generador de Wails solo emite
// las clases que alcanza desde una firma, así que estas dos nunca se generan
// — y escribirlas a mano en `models.ts` no funciona: `wails build` regenera
// ese archivo y se las lleva puestas.
//
// Por eso viven acá. Los nombres de campo son EXACTAMENTE los tags JSON de
// Go, que es lo que hace que el ida y vuelta por el vault funcione.

export interface HttpVariable {
    key: string
    value: string
    enabled: boolean
    secret: boolean
}

export interface HttpComputed {
    name: string
    op: string
    input: string
    key?: string
    encoding?: string
    enabled: boolean
}

export function newVariable(init: Partial<HttpVariable> = {}): HttpVariable {
    return {key: '', value: '', enabled: true, secret: false, ...init}
}

export function newComputed(init: Partial<HttpComputed> = {}): HttpComputed {
    return {name: '', op: 'hmac-sha256', input: '', key: '', encoding: 'hex', enabled: true, ...init}
}

// Las dos columnas se persisten como texto JSON, igual que params y headers.
export function parseVariables(raw: string | undefined): HttpVariable[] {
    return parseJsonRows<HttpVariable>(raw, newVariable)
}

export function parseComputed(raw: string | undefined): HttpComputed[] {
    return parseJsonRows<HttpComputed>(raw, newComputed)
}

function parseJsonRows<T>(raw: string | undefined, make: (init: Partial<T>) => T): T[] {
    if (!raw || !raw.trim()) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.map((r) => make(r as Partial<T>)) : []
    } catch {
        // Una fila corrupta no puede impedir abrir la petición.
        return []
    }
}
