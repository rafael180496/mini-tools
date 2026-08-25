# Releases — mini-tools

Spec del proceso de empaquetado/publicación local. Complementa
[commands.md](commands.md) (qué hace cada script) con el flujo completo que
se espera cuando alguien pide un build oficial, no solo `wails build`.

## Dos caminos: el tag (automático) y el local (a mano)

**Empujar un tag `vX.Y.Z` publica el release solo.**
[.github/workflows/release.yml](../../.github/workflows/release.yml) crea el
GitHub Release con las notas de esa versión —sacadas del CHANGELOG con
[`scripts/changelog-section.sh`](../../scripts/changelog-section.sh)— y le
adjunta los dos binarios.

**No compila nada: sube lo que ya está versionado en `releases/<so>/`.** Esa es
la decisión de diseño y tiene un motivo: dos compilaciones de Go en máquinas
distintas no dan un binario bit a bit idéntico, así que un release compilado en
CI sería un archivo que nadie probó y cuyo checksum no coincidiría con el que
documentan los `releases/<so>/README.md`. Reusando, lo que baja la gente es
exactamente lo que se verificó en la máquina de desarrollo.

Tres cosas que el workflow **afirma** antes de publicar, y que lo hacen fallar:

1. El tag y el archivo `VERSION` coinciden. Si no, se estaría publicando un
   binario que por dentro se llama distinto que el release.
2. Los dos artefactos de esa versión están en el commit del tag, con un tamaño
   creíble (un archivo de pocos KB suele ser un puntero de LFS sin resolver).
3. El SHA-256 de cada uno **aparece en su `releases/<so>/README.md`**. Es lo que
   hace seguro reusar: si el binario se regeneró y el README quedó viejo —o al
   revés—, el release documentaría un hash que no es el del archivo.

Consecuencia de no compilar: corre en Linux, en segundos y sin toolchain.
`workflow_dispatch` hace lo mismo **sin publicar** — corre las comprobaciones y
muestra las notas en el resumen del run. Es la forma de probar un cambio en el
workflow sin gastar un tag.

**El proceso de abajo sigue vigente y es el que corre Claude** cuando se pide
"preparar la versión": deja todo listo —versión bumpeada, artefactos generados y
copiados a `releases/<os>/`, CHANGELOG volcado, READMEs con los checksums nuevos
e `index.html` al día— y el commit y el tag los hace el usuario. Lo que cambia
con el workflow es el **paso 9**: ya no hay que crear el release ni adjuntar los
archivos a mano.

**Los artefactos de `releases/<os>/` ahora se commitean sí o sí**, porque son
literalmente lo que se publica. Antes eran una zona de preparación descartable;
con este workflow, un tag sin ellos falla.

## Trigger: mención de "empaquetar"/"oficial"/"preparar la versión"

Cualquier mensaje del usuario que mencione **"empaquetar"/"empaquetá"/"empaquete"**,
**"oficial"**, o **"preparar"/"prepará"/"preparación" + "versión"** en el contexto
de compilar/buildear (p. ej. "empaquetá para mac", "compila la versión oficial",
"arma el build oficial", "prepará la versión nueva", "preparemos una nueva
versión") dispara este proceso completo sin pedir confirmación — no hace falta
ninguna frase exacta, cualquier mención de esas palabras clave alcanza:

0. **Bumpear la versión primero:** `./scripts/bump-version.sh patch` (patch
   por default — si el usuario especificó minor/major en su pedido, usar
   esa parte en su lugar). Esto ya NO es un paso opcional para este flujo
   automático, a diferencia de como lo describe `scripts/README.md` para
   uso manual suelto.
1. **Correr `./scripts/package-all.sh`** — orquesta el empaquetado de CADA
   SO soportado en la misma pasada (nunca uno solo por default). Hoy son
   dos: macOS (nativo, requiere correr desde macOS, produce `.dmg` sin
   firmar) y Windows (cross-compila desde cualquier SO con Go+Wails,
   produce `.exe` portable sin firmar — ver [commands.md](commands.md) y
   [scripts/README.md](../../scripts/README.md) para el detalle de cada
   uno). **Nunca correr `package-macos.sh` y `package-windows.sh` sueltos
   en secuencia manual** — los dos usan `wails build -clean`, que borra
   `build/bin/` completo al arrancar, así que el segundo script borra el
   artefacto que acababa de dejar el primero antes de poder copiarlo a
   ningún lado (bug real, ver el comentario de cabecera de
   `package-all.sh`, que ya resuelve esto moviendo cada artefacto a un
   directorio temporal apenas termina su propio script). Si el usuario pide
   explícitamente un solo SO ("empaquetá solo para windows"), ahí sí correr
   solo ese script individual — el default sin aclaración es
   `package-all.sh` (ambos).
2. Crear (si no existe) `releases/<os>/` para cada SO empaquetado en el
   paso anterior — hoy `releases/macos/` y `releases/windows/`.
3. **Copiar** (nunca mover) cada artefacto generado
   (`build/bin/mini-tools-vX.Y.Z.dmg`, `build/bin/mini-tools-vX.Y.Z-windows-amd64.exe`)
   a su `releases/<os>/` correspondiente. `build/bin/` sigue siendo la
   salida cruda y efímera de los scripts de build; `releases/<os>/` es de
   donde los toma el workflow. **Se commitean** junto con el tag — ver el
   paso 9 y "Dónde viven los binarios" abajo.
4. Calcular el checksum de cada artefacto:
   `shasum -a 256 releases/<os>/mini-tools-vX.Y.Z*`.
5. Escribir/actualizar `releases/<os>/README.md` de **cada** SO empaquetado
   (usar el archivo actual de ese SO como plantilla) con:
   - Tabla de versión: versión, nombre de archivo, tamaño, SHA-256,
     arquitectura.
   - **Compatibilidad verificada, no asumida:** arquitectura real del
     binario (`file build/bin/mini-tools.app/Contents/MacOS/mini-tools` en
     mac, `file build/bin/mini-tools.exe` en Windows) y versión mínima
     real del SO — Apple Silicon (`arm64`) implica macOS 11+ aunque el
     `Info.plist` que genera Wails declara `LSMinimumSystemVersion =
     10.13.0` (plantilla genérica heredada de cuando Wails también
     apuntaba a Intel). Aclarar explícitamente esa discrepancia — nunca
     repetir el valor del plist como si fuera la compatibilidad real sin
     esa nota.
   - Firma: ninguno de los dos está firmado. macOS: sin Apple Developer ID
     ni notarización — workaround de Gatekeeper (clic derecho → Abrir /
     `xattr -cr` / Ajustes del Sistema → Privacidad y Seguridad → Abrir de
     todas formas). Windows: sin firma Authenticode — SmartScreen avisa
     "Windows protegió su PC", workaround "Más información" → "Ejecutar de
     todas formas".
   - **Estado de verificación del `.exe` de Windows, según lo que
     realmente pasó con ESA versión** — no un texto fijo. El `.exe` se
     cross-compila desde macOS/Linux, y "compila limpio" nunca es lo
     mismo que "se probó": WebView2 runtime, DPI scaling y diálogos
     nativos solo se confirman corriendo el binario en Windows. Regla:
     - Si alguien corrió esta versión en una Windows real y lo confirmó,
       documentarlo indicando **en qué versiones de Windows** (ej.: "10 y
       11") y qué se confirmó. Nunca extrapolar de una versión anterior:
       que 0.4.0 se haya probado no dice nada de 0.5.0.
     - Si nadie la probó, va la advertencia explícita de "no verificado
       en Windows real" con las cosas que quedan sin confirmar. No
       quitarla solo porque el empaquetado no dio errores.
     - Ante la duda de si se probó o no: **preguntarle al usuario**, no
       asumir el caso optimista — esto es una afirmación de
       compatibilidad de cara a quien descarga el binario.
   - Instrucciones de instalación paso a paso.
   - Sección "Regenerar este artefacto" con los comandos exactos.
6. Actualizar **ambas** secciones de distribución del `README.md` raíz
   (`## Distribución / Empaquetado macOS` y `## Distribución / Empaquetado
   Windows`) con la versión/checksum/compatibilidad actuales de cada una
   (resumen, no duplicar todo el detalle) y un link directo al **asset del
   GitHub Release** de esa versión:
   `https://github.com/rafael180496/mini-tools/releases/download/vX.Y.Z/<archivo>`.
   Si el README tiene una sección "Descargas" cerca del inicio, actualizar
   también esos links ahí. **Nunca linkear a `releases/<os>/<archivo>`**:
   ese archivo no está en el repositorio y el link daría 404.
7. **Actualizar `CHANGELOG.md`** (formato [Keep a
   Changelog](https://keepachangelog.com/en/1.1.0/), ver cabecera del
   archivo — SemVer, fuente de verdad en `VERSION`). Este paso es la
   contraparte de la regla "todo cambio se acumula en `[Unreleased]`
   primero" de [conventions.md](../rules/conventions.md): si esa regla se
   respetó durante el ciclo, acá solo hay que mover lo ya escrito:
   - Mover **todo** el contenido actual de `## [Unreleased]` a una sección
     nueva `## [X.Y.Z] - AAAA-MM-DD` (la versión recién bumpeada en el
     paso 0, fecha real del día del empaquetado — nunca inventada ni
     copiada de un ejemplo).
   - **Nunca escribir en la sección de una versión ya publicada.** Si
     aparecen cambios posteriores a un release ya commiteado, van a
     `[Unreleased]` y salen en la versión siguiente — ver el caso real
     documentado en conventions.md.
   - Agregar ahí mismo cualquier feature/fix de la sesión actual que
     todavía no estuviera listado en `[Unreleased]` — no es solo
     "renombrar la sección", es la oportunidad de dejar el changelog al
     día con lo que se hizo recién.
   - Entradas concisas, una línea por feature/fix, agrupadas bajo
     `### Agregado`/`### Corregido`/etc. según corresponda — mismo nivel
     de detalle que las entradas ya existentes en el archivo (qué cambió y
     por qué le importa a quien lo lee), nunca un resumen genérico tipo
     "varias mejoras" o "fixes varios".
   - Dejar `## [Unreleased]` en el archivo (encabezado vacío, sin
     contenido debajo) para que la próxima tanda de cambios post-release
     tenga dónde acumularse hasta el siguiente empaquetado.
8. **Actualizar `index.html`, la documentación pública.** Es el paso que hace
   que la versión nueva se pueda *usar*, no solo descargar: el CHANGELOG dice
   qué cambió, y la página dice **cómo se usa**. Uno es para quien ya la tiene;
   la otra, para quien todavía no.
   - Por cada entrada de la versión que se acaba de volcar en el CHANGELOG,
     preguntarse: **¿esto cambia lo que el usuario puede hacer?** Si sí, tiene
     que estar en la página. Si es interno (un refactor, una optimización, un
     bug que nadie llegó a notar), no va.
   - **Módulo nuevo** → **grupo nuevo** en el índice, con un tema por asunto,
     su captura y al menos un ejemplo de uso concreto.
   - **Funcionalidad que es un asunto en sí mismo** → **tema nuevo**
     (`<article class="topic">`) en el grupo que le corresponde, más su entrada
     en el índice. Un detalle de algo ya documentado → un `<h2>` dentro del tema
     que ya existe. No alcanza con nombrarla: la ayuda existe para que alguien
     la use sin preguntar.
   - **Algo que cambia el flujo de trabajo de punta a punta** → un tema más en
     el grupo «Recetas».
   - Actualizar la **insignia de versión** de la barra (`<span class="ver">`) y
     la línea del pie, que nombran la versión que documenta la página.
   - Las capturas salen de `./scripts/uishot.sh` (hay que agregar la vista al
     banco con datos inventados), **nunca de una instalación real**.
   - Revisar además el bloque **«En desarrollo — todavía sin publicar»** del
     `README.md`: lo que acaba de salir ya no va ahí.
   - Ver la regla completa —incluida la anatomía de un tema— en
     [conventions.md](../rules/conventions.md#indexhtml--la-ayuda-se-actualiza-con-el-mismo-cambio).
9. **Los artefactos de `releases/<os>/` se commitean junto con el resto**: son
   exactamente lo que va a publicar el workflow, así que un tag sin ellos falla.
   Publicar es entonces **empujar el tag `vX.Y.Z`** — el release se crea solo,
   con las notas del CHANGELOG y los dos archivos adjuntos. No hay que crear
   nada a mano ni subir binarios por la web. Ver "Dónde viven los binarios"
   abajo.
10. **Nunca `git add`/`commit`/`push` nada de esto — ni los artefactos, ni
   las docs tocadas.** Regla dura y sin excepción (ver "Commits / PRs" en
   [conventions.md](../rules/conventions.md)): el usuario hace todo el
   staging y los commits siempre, a mano. Terminar el proceso con los
   artefactos y las docs actualizadas en el working tree y avisar qué
   archivos quedaron listos para que el usuario los commitee — incluso si
   en una conversación anterior pidió explícitamente subir algo puntual,
   eso no habilita hacerlo de nuevo sin que lo pida otra vez.

## Dónde viven los binarios

**En el commit del tag Y en el GitHub Release.** Las dos cosas, y no es
redundancia: el workflow no compila nada, así que lo que publica es literalmente
el archivo que está en `releases/<os>/` en el commit del tag. Un tag sin los
artefactos falla en CI antes de publicar nada.

Esto corrige lo que decía antes esta misma sección, que era del flujo anterior
—cuando el usuario subía cada artefacto a mano al Release y después borraba la
copia del repositorio para no cargar el historial de git—. Ese borrado ahora
rompe el release de esa versión.

Consecuencias prácticas, y son las que hay que respetar en cada empaquetado:

- El `.dmg` y el `.exe` de la versión que se está preparando **se commitean**.
  Lo permanente de cada carpeta sigue siendo su `README.md`, que es donde viven
  el checksum y las instrucciones — y el workflow **comprueba que ese checksum
  sea el del archivo** antes de publicar.
- **Los artefactos de versiones anteriores sí se pueden borrar**, y conviene:
  ya están publicados en el Release de su tag, y su commit los conserva. Esa
  baja va en el mismo commit que el alta de los nuevos.
- Los links de descarga del `README.md` raíz apuntan al **asset del Release**
  (`.../releases/download/vX.Y.Z/<archivo>`), nunca a una ruta del árbol: un
  link a `releases/macos/mini-tools-vX.Y.Z.dmg` da 404 apenas se poda la copia.
- El `.gitignore` sigue **sin** patrones para `releases/**/*.dmg`/`*.exe`. No es
  un descuido: dejarlos ignorados escondería un artefacto recién generado del
  `git status`, que es justo donde el usuario lo ve para acordarse de
  commitearlo.

## Estado multi-plataforma

macOS (`releases/macos/`, `package-macos.sh`) y Windows
(`releases/windows/`, `package-windows.sh`) están cubiertos — el paso 1
del trigger corre ambos por default en la misma pasada. Windows se
cross-compila desde macOS/Linux sin necesitar una máquina Windows (ningún
conector de base de datos usa CGO); **correrlo en Windows real es un paso
aparte, manual, y no lo cubre ningún script**.

Estado a 0.4.0 (2026-07-22): el `.exe` **fue verificado corriendo en
Windows 10 y Windows 11** — arranca sin instalar el WebView2 Runtime
aparte, con DPI scaling y diálogos nativos correctos. Ese estado es de
esa versión, no del proyecto: cada release nuevo vuelve a la pregunta de
si alguien lo probó (ver la regla del paso 5).

Si se agrega Linux, seguir el mismo patrón: `releases/linux/`, con su
propio README siguiendo esta misma estructura (no un README único para
todos los SOs) y su propio script de empaquetado en `scripts/`
(`package-linux.sh`) — no extender `package-macos.sh`/`package-windows.sh`
para cubrir otro SO, y sumarlo también como default del paso 1 de este
trigger (todos los SOs soportados en la misma pasada, no uno por vez).
