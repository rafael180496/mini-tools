// Messages<T> es "la misma forma que el diccionario de referencia (español),
// con las mismas firmas": cada texto fijo es un string y cada texto con datos
// es una función con los mismos parámetros. El diccionario inglés se declara
// con este tipo, así que una clave que falta, sobra o cambia de parámetros es
// un error de compilación — no un texto en blanco descubierto en pantalla.
export type Messages<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => string
        ? (...args: A) => string
        : T[K] extends string
          ? string
          : Messages<T[K]>
}
