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

# Se corta desde `## [X.Y.Z]` hasta el `##` siguiente, sin incluir ninguno de
# los dos. `[` y `]` se escapan porque en una expresión regular son un conjunto.
SECTION="$(awk -v v="$VERSION" '
  $0 ~ "^## \\[" v "\\]" { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$FILE")"

# La comprobación va con grep y no con `${SECTION//[[:space:]]/}`: la
# sustitución de patrones de bash sobre una cadena de decenas de miles de
# caracteres —que es lo que mide la sección de una versión grande— tarda
# minutos. Con grep es instantáneo.
if ! printf '%s' "$SECTION" | grep -q '[^[:space:]]'; then
  echo "No hay una sección '## [$VERSION]' en CHANGELOG.md." >&2
  echo "Las que hay:" >&2
  grep -o '^## \[[0-9][^]]*\]' "$FILE" | head -10 >&2
  exit 1
fi

# Se recortan los renglones en blanco de los bordes, no los del medio: adentro
# separan párrafos de una misma entrada.
printf '%s\n' "$SECTION" | awk 'NF {p = 1} p' | awk '{ lines[NR] = $0 } END { last = NR; while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--; for (i = 1; i <= last; i++) print lines[i] }'
