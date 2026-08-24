#!/usr/bin/env bash
# Imprime las notas de UNA versión del CHANGELOG, sin su encabezado.
#
#   ./scripts/changelog-section.sh 2.3.0
#
# Para qué: son las notas que van al cuerpo del GitHub Release. Escribirlas dos
# veces —una en el CHANGELOG y otra en el release— es garantizar que un día no
# digan lo mismo; el CHANGELOG es la fuente y esto lo lee.
#
# Lo usa .github/workflows/release.yml al publicar un tag, y sirve igual a mano
# para revisar qué va a salir antes de empujarlo.
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Uso: $0 X.Y.Z" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="$ROOT_DIR/CHANGELOG.md"

# Existe la sección? Se pregunta contra el ARCHIVO, que es chico, y no contra el
# texto ya extraído: cualquier tubería que reciba la sección entera —decenas de
# miles de caracteres— corre el riesgo de que el lector cierre antes de tiempo.
# Los puntos de la versión se escapan para que `2.3.0` no matchee `2x3x0`.
ESCAPED="${VERSION//./\\.}"
if ! grep -q "^## \[$ESCAPED\]" "$FILE"; then
  echo "No hay una sección '## [$VERSION]' en CHANGELOG.md." >&2
  echo "Las que hay:" >&2
  # Sin `| head`: con `pipefail`, head cierra el pipe, grep muere con SIGPIPE y
  # el estado de salida deja de ser el de esta comprobación. Se acota con awk,
  # que consume toda la entrada.
  grep -o '^## \[[0-9][^]]*\]' "$FILE" | awk 'NR <= 10' >&2
  exit 1
fi

# Se corta desde `## [X.Y.Z]` hasta el `##` siguiente, sin incluir ninguno de
# los dos. `[` y `]` se escapan porque en una expresión regular son un conjunto.
SECTION="$(awk -v v="$VERSION" '
  $0 ~ "^## \\[" v "\\]" { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$FILE")"

# `-z` mide la cadena y ya: no la recorre, no abre una tubería.
#
# Lo que había acá antes era `printf '%s' "$SECTION" | grep -q '[^[:space:]]'`, y
# eso falla de forma intermitente: `grep -q` sale en cuanto encuentra el primer
# carácter, cierra el pipe, `printf` recibe SIGPIPE y —con `pipefail`— ese error
# pasa a ser el resultado de la tubería. La comprobación daba "está vacía" sobre
# una sección que existe. En macOS casi nunca se veía (el texto entraba entero en
# el búfer del pipe antes de que grep cortara); en Linux, sí. Falló en CI.
if [[ -z "$SECTION" ]]; then
  echo "La sección '## [$VERSION]' existe pero no tiene contenido debajo." >&2
  exit 1
fi

# Se recortan los renglones en blanco de los bordes, no los del medio: adentro
# separan párrafos de una misma entrada. Los dos awk consumen toda su entrada,
# así que acá no hay riesgo de SIGPIPE.
printf '%s\n' "$SECTION" | awk 'NF { p = 1 } p' | awk '
  { lines[NR] = $0 }
  END {
    last = NR
    while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = 1; i <= last; i++) print lines[i]
  }
'
