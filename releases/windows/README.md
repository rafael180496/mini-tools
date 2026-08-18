# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS**. De esta versión se verificó **una parte** en
Windows 10 y 11 —la aprobación acción por acción, que en Windows usa un named
pipe— y el resto **no**: el `.exe` empaquetado no se corrió en una Windows real.
Ver "Estado de verificación" abajo. No es un
release firmado ni se publica automáticamente a ningún lado — solo empaqueta
el `.exe` para distribuirlo manualmente (GitHub Releases, USB, red interna,
etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 2.1.0 |
| Archivo | `mini-tools-v2.1.0-windows-amd64.exe` |
| Tamaño | ~54 MB |
| SHA-256 | `0f05b5db5bb224293ac96dbd0bf41004da516b6137739ef9dd7944e33d6b4cc1` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v2.1.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```

## Estado de verificación en Windows real

**Verificado en esta versión (2.1.0), en Windows 10 y 11**, según lo confirmó
quien mantiene el proyecto: la app arranca y se usa en las dos.

**Lo nuevo de 2.1.0 del lado de Windows es el chrome de la ventana, y es lo
primero a mirar si algo se ve raro.** Esta versión pasa la ventana a
**frameless**: Windows deja de dibujar el marco y la barra de título, y los
botones de minimizar / maximizar-restaurar / cerrar los dibuja la app. Eso
cambia cosas que el propio sistema resolvía solo:

- **Redimensionar desde los bordes** ahora depende del hit-test que hace Wails,
  no del marco nativo.
- **Arrastrar la ventana** se hace por la zona marcada con la propiedad CSS
  `--wails-draggable`, no por el marco.
- **Ajustar a los lados (Aero Snap)** y el doble clic para maximizar dependen de
  ese mismo camino.

Si alguna de esas tres falla, el síntoma es de esta versión y no de una
anterior — vale reportarlo indicando la versión de Windows.

**El resto se arrastra sin verificar desde antes**, y sigue igual: lo confirmado
de ese lado es que cross-compila limpio desde macOS (ninguno de los conectores
de base de datos —PostgreSQL, Oracle, SQLite, SQL Server, MongoDB— ni `go-redis`
ni el PTY usan CGO, así que no hace falta un toolchain de Windows/mingw).

Queda sin confirmar en Windows, en orden de riesgo:

- **Las migraciones 40 a 42 del vault, nuevas en esta versión.** Al primer
  arranque agregan a `settings` las columnas del módulo abierto y el ancho de la
  barra lateral, y las seis de la apariencia del editor, sobre el `vault.db` que
  ya existe en la máquina. Se suman a las 29–39, que siguen sin verificarse. Es
  SQLite puro y el camino es el mismo en todos los SO, pero una migración que
  falle deja la app sin arrancar: es lo primero a mirar si alguien la prueba.
- **El servidor MCP.** En Windows el canal es un **named pipe** en vez de un
  socket Unix. Falta confirmarlo de punta a punta con un CLI real conectado.
- **Abrir el proyecto en VS Code y en el explorador de archivos.** En Windows
  resuelve `code` del `PATH` y usa `explorer`; sin probarlo no está confirmado
  que encuentre una instalación típica de VS Code.
- **El resto del subsistema agéntico**: lanzar los CLIs (`claude`, `codex`,
  `agy`) como procesos hijos implica otra resolución de ejecutables
  (`.cmd`/`.exe` del `PATH`) y otro manejo de saltos de línea.
- **La terminal local integrada** (pendiente desde 1.1.0). En Windows usa
  ConPTY vía `github.com/aymanbagabas/go-pty`, un camino de código distinto al
  `openpty` de Unix: sin probarlo no está confirmado que la shell arranque, que
  el redimensionado reflowe bien, ni que PowerShell/cmd/Git Bash/WSL se
  detecten.
- **Pegar imágenes en una nota** (`Ctrl+V` desde Recortes), que depende de cómo
  el WebView2 expone el portapapeles.
- **Las transferencias SFTP con lecturas/escrituras concurrentes**: código Go
  idéntico en todos los SO, pero el rendimiento real depende de la red y no se
  midió desde Windows.
- **Las fuentes del sistema que ofrece Configuración → Editor.** Consolas
  existe en Windows y Menlo no; la app cae en silencio a la monoespaciada
  genérica cuando la elegida falta, pero no se comprobó ahí.
- **DPI scaling, tamaño y posición de ventana** — con más motivo ahora que la
  ventana es frameless.
- **Diálogos nativos** (abrir/guardar archivo, backup del vault).

Si alguien la corre entera en una Windows real, corresponde reemplazar esta
sección por lo que se haya confirmado y en qué versiones de Windows — no
borrarla sin más.

## Compatibilidad del sistema

- **Windows 10 y Windows 11**, donde se verificó que esta versión arranca y se
  usa (ver la sección de arriba para qué quedó sin confirmar). Wails v2 en
  Windows depende del
  WebView2 Runtime de Microsoft: Windows 11 lo trae preinstalado y los
  Windows 10 con Edge al día también (llega con las actualizaciones de
  Edge). Un Windows 10 viejo o sin actualizar puede no tenerlo — ahí se
  instala aparte, gratis
  ([enlace oficial](https://developer.microsoft.com/microsoft-edge/webview2/)).
- **La terminal integrada requiere ConPTY**, presente en Windows 10
  1809 (octubre de 2018) y posteriores. En un Windows anterior la app
  debería seguir funcionando, pero el panel de terminal/agentes no.
- **Solo `amd64` (x86-64).** No se generó build `arm64` (Windows on ARM)
  — se puede agregar cross-compilando con `-platform windows/arm64` si
  hace falta.
- **Sin firma Authenticode.** Windows SmartScreen va a mostrar "Windows
  protegió su PC" al abrirlo en otra máquina. Workaround: "Más
  información" → "Ejecutar de todas formas".
- **Portable, sin instalador.** No se generó instalador NSIS (requiere
  `makensis`, no instalado en este entorno — `wails doctor` lo lista como
  dependencia opcional). El `.exe` corre standalone, sin instalación.

## Instalación

No hay instalador: el `.exe` es portable y corre standalone desde
cualquier carpeta (Escritorio, `C:\Tools\`, un pendrive).

1. Descargar `mini-tools-v2.1.0-windows-amd64.exe`.
2. (Opcional pero recomendado) Verificar la integridad en PowerShell con
   el comando de la sección "Versión actual" — el hash tiene que coincidir
   con el de la tabla.
3. Doble click para correrlo.
4. **La primera vez, SmartScreen bloquea la app** con la pantalla azul
   "Windows protegió su PC". Es esperado: el `.exe` no está firmado con
   un certificado Authenticode (ver "Firma" abajo), no es una señal de
   que el archivo esté comprometido. Para abrirlo igual: clic en **"Más
   información"** (el link chico debajo del texto, fácil de pasar por
   alto) → aparece el botón **"Ejecutar de todas formas"** → clic ahí.
   Windows recuerda la decisión para ese archivo; las siguientes veces
   abre directo.
   - Si preferís sacarle la marca de "descargado de internet" de una vez:
     clic derecho sobre el `.exe` → Propiedades → tildar **"Desbloquear"**
     abajo de todo → Aceptar.
5. Si en vez de abrirse no pasa nada o aparece un error de WebView2, es un
   Windows 10 sin el runtime — instalarlo desde el
   [enlace oficial de Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/)
   (gratis, "Evergreen Standalone Installer") y reintentar. No pasó en los
   equipos donde se probó la 1.0.0, pero es el único requisito previo
   posible.

### Actualizar a una versión nueva

Reemplazar el `.exe` viejo por el nuevo. El vault (conexiones, clave
maestra, preferencias) vive aparte, en `%APPDATA%\mini-tools\`, así que
no se pierde nada al reemplazar el binario — y borrar el `.exe` **no**
borra el vault.

## Regenerar este artefacto

```bash
./scripts/bump-version.sh minor      # patch/minor/major según lo que entre en la versión
./scripts/package-windows.sh         # genera build/bin/mini-tools-vX.Y.Z-windows-amd64.exe
cp build/bin/mini-tools-vX.Y.Z-windows-amd64.exe releases/windows/
shasum -a 256 releases/windows/mini-tools-vX.Y.Z-windows-amd64.exe   # actualizar la tabla de arriba
```

`package-windows.sh` cross-compila desde cualquier host con Go 1.21+ y el
Wails CLI instalados (probado desde macOS arm64; no probado desde Linux)
— no requiere una máquina Windows para generar el `.exe`.

**Sí requiere una Windows real para verificarlo antes de publicar.** Que
cross-compile limpio no dice nada sobre WebView2, DPI o los diálogos
nativos; esos solo se confirman corriendo el binario. El paso de
verificación en Windows es parte del proceso de release desde 0.4.0 —
si una versión nueva sale sin ese paso, corresponde volver a poner la
advertencia de "no verificado" en este archivo, no dejarla implícita.

Este directorio guarda el `.exe` fuera de `build/bin/` (que es artefacto
de build efímero, gitignoreado) por el mismo motivo que
[releases/macos/](../macos/): un lugar estable de "última versión
empaquetada" que el link de descarga del README puede apuntar directo,
sin depender de un release aparte.
