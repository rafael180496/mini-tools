// Qué sentencia está tocando el cursor.
//
// **Para qué.** Explain y Explain Analyze mandaban el archivo ENTERO. En una
// consola de trabajo real eso casi nunca es lo que uno quiere: la pestaña tiene
// diez consultas guardadas de la sesión y lo que se está mirando es una. El
// planner, encima, recibe el script completo y devuelve el plan de la última —
// así que el plan que se leía ni siquiera era el de la consulta que uno tenía
// bajo el cursor.
//
// **Cómo se decide el objetivo**, en este orden:
//   1. Lo que esté seleccionado, si hay algo. Una selección explícita es la
//      instrucción más clara que puede dar el usuario.
//   2. La sentencia donde está el cursor, delimitada por `;`.
//
// **Por qué no alcanza con partir por `;` a lo bruto.** Un punto y coma dentro
// de una cadena (`WHERE nota = 'a;b'`) o dentro de un comentario no termina
// nada, y cortar ahí parte la consulta al medio y produce un error de sintaxis
// que no está en el texto que el usuario escribió. Este recorrido saltea
// cadenas, identificadores citados y las dos formas de comentario.
//
// Lo que NO cubre, a propósito: los bloques PL/SQL, donde el `;` es parte del
// cuerpo y el separador real es el `/` de SQL*Plus. Partirlos bien es trabajo
// del separador del backend (backend/query/splitter.go), que ya lo hace para
// EJECUTAR. Acá, si el cursor cae en un bloque, se manda el pedazo que sale —
// y para eso está la regla 1: seleccionar a mano manda siempre.

export interface StatementSpan {
    text: string
    from: number
    to: number
}

// statementAt devuelve la sentencia que contiene `pos`.
export function statementAt(doc: string, pos: number): StatementSpan {
    // Cortes: la posición justo después de cada `;` que separa de verdad.
    const cuts: number[] = [0]

    let i = 0
    let quote: string | null = null
    while (i < doc.length) {
        const c = doc[i]

        if (quote) {
            // `''` adentro de una cadena es una comilla escapada, no el final:
            // tratarla como cierre invertiría el estado y todo lo que sigue se
            // leería al revés.
            if (c === quote && doc[i + 1] === quote) {
                i += 2
                continue
            }
            if (c === quote) quote = null
            i++
            continue
        }

        if (c === '-' && doc[i + 1] === '-') {
            const nl = doc.indexOf('\n', i)
            i = nl < 0 ? doc.length : nl
            continue
        }
        if (c === '/' && doc[i + 1] === '*') {
            const end = doc.indexOf('*/', i + 2)
            i = end < 0 ? doc.length : end + 2
            continue
        }
        if (c === "'" || c === '"' || c === '`') {
            quote = c
            i++
            continue
        }
        if (c === ';') {
            cuts.push(i + 1)
        }
        i++
    }
    cuts.push(doc.length)

    // El tramo que contiene el cursor. El `<=` del final es lo que hace que el
    // cursor pegado al `;` cuente como la sentencia que acaba de terminar y no
    // como la siguiente, que todavía está vacía.
    for (let n = 0; n < cuts.length - 1; n++) {
        const from = cuts[n]
        const to = cuts[n + 1]
        if (pos >= from && pos <= to) {
            const text = doc.slice(from, to)
            // Un tramo en blanco —el cursor quedó en las líneas vacías después
            // del último `;`— no es una sentencia: se usa la anterior, que es
            // lo que la persona acaba de escribir.
            if (text.trim()) return {text, from, to}
            if (n > 0) {
                const prevFrom = cuts[n - 1]
                return {text: doc.slice(prevFrom, from), from: prevFrom, to: from}
            }
            return {text, from, to}
        }
    }

    return {text: doc, from: 0, to: doc.length}
}
