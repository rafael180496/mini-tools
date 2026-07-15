# Releases — mini-tools

Spec del proceso de empaquetado/publicación local. Complementa
[commands.md](commands.md) (qué hace cada script) con el flujo completo que
se espera cuando alguien pide un build oficial, no solo `wails build`.

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
1. **Correr el script de empaquetado de CADA SO soportado, en la misma
   pasada — nunca uno solo por default.** Hoy son dos:
   `./scripts/package-macos.sh` (nativo, requiere correr desde macOS,
   produce `.dmg` sin firmar) y `./scripts/package-windows.sh`
   (cross-compila desde cualquier SO con Go+Wails, produce `.exe` portable
   sin firmar — ver [commands.md](commands.md) y
   [scripts/README.md](../../scripts/README.md) para el detalle de cada
   uno). Si el usuario pide explícitamente un solo SO ("empaquetá solo para
   windows"), correr solo ese — el default sin aclaración es ambos.
2. Crear (si no existe) `releases/<os>/` para cada SO empaquetado en el
   paso anterior — hoy `releases/macos/` y `releases/windows/`.
3. **Copiar** (nunca mover) cada artefacto generado
   (`build/bin/mini-tools-vX.Y.Z.dmg`, `build/bin/mini-tools-vX.Y.Z-windows-amd64.exe`)
   a su `releases/<os>/` correspondiente. `build/bin/` sigue siendo la
   salida cruda y efímera de los scripts de build; `releases/<os>/` es la
   copia "publicada" y estable, y **sí se versiona en git** (ver "Por qué
   los artefactos se versionan en git" abajo) — no agregar
   `releases/**/*.dmg`/`releases/**/*.exe` (ni ningún patrón equivalente)
   a `.gitignore`.
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
   - **El `.exe` de Windows lleva además una advertencia explícita de "no
     verificado en Windows real"** — se genera cross-compilando desde
     macOS/Linux, nadie confirmó que corra en una Windows de verdad
     (WebView2 runtime, DPI scaling, diálogos nativos). No quitar esa nota
     solo porque una versión nueva se empaquetó sin problemas — "compila
     limpio" no es lo mismo que "se probó".
   - Instrucciones de instalación paso a paso.
   - Sección "Regenerar este artefacto" con los comandos exactos.
6. Actualizar **ambas** secciones de distribución del `README.md` raíz
   (`## Distribución / Empaquetado macOS` y `## Distribución / Empaquetado
   Windows`) con la versión/checksum/compatibilidad actuales de cada una
   (resumen, no duplicar todo el detalle) y un link directo al archivo
   (`.dmg`/`.exe`) dentro de su `releases/<os>/` (no solo a la carpeta) —
   así el link del README descarga el binario directo desde GitHub. Si el
   README tiene una sección "Descargas" cerca del inicio, actualizar
   también esos links ahí.
7. **Actualizar `CHANGELOG.md`** (formato [Keep a
   Changelog](https://keepachangelog.com/en/1.1.0/), ver cabecera del
   archivo — SemVer, fuente de verdad en `VERSION`):
   - Mover **todo** el contenido actual de `## [Unreleased]` a una sección
     nueva `## [X.Y.Z] - AAAA-MM-DD` (la versión recién bumpeada en el
     paso 0, fecha real del día del empaquetado — nunca inventada ni
     copiada de un ejemplo).
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
8. Los artefactos **sí se versionan en git** (`.dmg` y `.exe` por igual) —
   no agregar `releases/**/*.dmg`, `releases/**/*.exe` (ni patrón
   equivalente) a `.gitignore`. Ver "Por qué los artefactos se versionan
   en git" abajo para el porqué de esta decisión.
9. **Nunca `git add`/`commit`/`push` nada de esto — ni los artefactos, ni
   las docs tocadas.** Regla dura y sin excepción (ver "Commits / PRs" en
   [conventions.md](../rules/conventions.md)): el usuario hace todo el
   staging y los commits siempre, a mano. Terminar el proceso con los
   artefactos y las docs actualizadas en el working tree y avisar qué
   archivos quedaron listos para que el usuario los commitee — incluso si
   en una conversación anterior pidió explícitamente subir algo puntual,
   eso no habilita hacerlo de nuevo sin que lo pida otra vez.

## Por qué los artefactos sí se versionan en git

Decisión explícita del usuario (corrigiendo un intento anterior de este
mismo proceso que lo excluía vía `.gitignore` con el argumento de "no
inflar el repo con binarios"): cada artefacto tiene que estar disponible
directamente desde un link del repo en GitHub, sin depender de un flujo
aparte (GitHub Releases, USB, etc.). El repo acepta el costo de que cada
versión empaquetada sume ~15-45MB permanentes por SO al historial de git
a cambio de que "bajar la última versión" sea un solo link del README. Si
el tamaño del repo se vuelve un problema real más adelante, la
alternativa a evaluar es Git LFS para `releases/**/*.dmg`/`*.exe` — no
volver a excluirlos silenciosamente vía `.gitignore` sin discutirlo
primero con el usuario.

## Estado multi-plataforma

macOS (`releases/macos/`, `package-macos.sh`) y Windows
(`releases/windows/`, `package-windows.sh`) están cubiertos — el paso 1
del trigger corre ambos por default en la misma pasada. Windows se
cross-compila desde macOS/Linux sin necesitar una máquina Windows (ningún
conector de base de datos usa CGO) pero **no está verificado corriendo en
Windows real** — esa advertencia va siempre en `releases/windows/README.md`
y no se retira solo porque un empaquetado nuevo compiló sin errores.

Si se agrega Linux, seguir el mismo patrón: `releases/linux/`, con su
propio README siguiendo esta misma estructura (no un README único para
todos los SOs) y su propio script de empaquetado en `scripts/`
(`package-linux.sh`) — no extender `package-macos.sh`/`package-windows.sh`
para cubrir otro SO, y sumarlo también como default del paso 1 de este
trigger (todos los SOs soportados en la misma pasada, no uno por vez).
