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
| Versión | 2.2.0 |
| Archivo | `mini-tools-v2.2.0-windows-amd64.exe` |
| Tamaño | ~54 MB |
| SHA-256 | `ea04fcd7125b29c03c4990fca6758c579843cf91cbcfb16c55124c1b76df3cc1` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v2.2.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```

## Estado de verificación en Windows real

**2.2.0 NO se probó en una Windows real.** Lo único confirmado es que
cross-compila limpio desde macOS (ninguno de los conectores de base de datos
—PostgreSQL, Oracle, SQLite, SQL Server, MongoDB— ni `go-redis` ni el PTY usan
CGO, así que no hace falta un toolchain de Windows/mingw). Que 2.1.0 se haya
verificado en Windows 10 y 11 **no dice nada de esta versión**: se anota acá
justamente para no arrastrar esa confirmación de una versión a la siguiente.

**Lo nuevo de 2.2.0 del lado de Windows son las terminales locales, y es lo
primero a mirar.** Esta versión abre shells del sistema operativo como pestañas
del módulo SSH, con un menú que lista los intérpretes instalados. En Windows eso
toca dos caminos que no se ejercitaban:

- **Detección de intérpretes**: el menú tiene que listar PowerShell, pwsh y cmd
  con su ruta real, y marcar como "falta" lo que no esté instalado.
- **ConPTY** (`github.com/aymanbagabas/go-pty`), que es un camino de código
  distinto al `openpty` de Unix: que la shell arranque, que el redimensionado
  reflowe bien y que el prompt se dibuje derecho.
- **El historial de esas terminales**: se guarda por intérprete y filtra las
  líneas que parecen traer una contraseña. Ese filtro se corrigió en esta versión
  precisamente por Windows —`Get-Process`, `-Path` y `-Property` se leían como
  una contraseña pegada y se descartaba casi todo lo que se escribe en
  PowerShell— así que confirmar que ahora **sí** se guarda un comando normal de
  PowerShell es parte de probar esta versión.

Después de eso, lo que sigue sin confirmarse en Windows, en orden de riesgo:

- **Las migraciones 43 y 44 del vault, nuevas en esta versión.** Al primer
  arranque crean la tabla del historial de terminales locales y agregan a
  `settings` el permiso de escritura del servidor MCP, sobre el `vault.db` que ya
  existe en la máquina. Se suman a las 29–42, que siguen sin verificarse ahí. Es
  SQLite puro y el camino es igual en todos los SO, pero una migración que falle
  deja la app sin arrancar: es lo primero a mirar si alguien la prueba.
- **El servidor MCP, ahora que además escribe.** En Windows el canal es un
  **named pipe** en vez de un socket Unix, y esta versión suma dos herramientas
  que crean y reescriben notas, más el aviso de catálogo cambiado. Falta
  confirmarlo de punta a punta con un CLI real conectado.
- **Abrir el proyecto en VS Code y en el explorador de archivos.** En Windows
  resuelve `code` del `PATH` y usa `explorer`; sin probarlo no está confirmado
  que encuentre una instalación típica de VS Code.
- **El resto del subsistema agéntico**: lanzar los CLIs (`claude`, `codex`,
  `agy`) como procesos hijos implica otra resolución de ejecutables
  (`.cmd`/`.exe` del `PATH`) y otro manejo de saltos de línea.
- **El chrome frameless de la ventana**, que se estrenó en 2.1.0 y ahí sí se
  probó: redimensionar desde los bordes, arrastrar por la zona marcada y Aero
  Snap dependen del hit-test de Wails, no del marco nativo. En esta versión no
  se tocó, pero tampoco se volvió a verificar.
- **Pegar imágenes en una nota** (`Ctrl+V` desde Recortes), que depende de cómo
  el WebView2 expone el portapapeles.
- **Las transferencias SFTP con lecturas/escrituras concurrentes**: código Go
  idéntico en todos los SO, pero el rendimiento real depende de la red y no se
  midió desde Windows.
- **Las fuentes del sistema que ofrece Configuración → Editor.** Consolas existe
  en Windows y Menlo no; la app cae en silencio a la monoespaciada genérica
  cuando la elegida falta, pero no se comprobó ahí.
- **DPI scaling, tamaño y posición de ventana.**
- **Diálogos nativos** (abrir/guardar archivo, backup del vault).

Si alguien la corre entera en una Windows real, corresponde reemplazar esta
sección por lo que se haya confirmado y en qué versiones de Windows — no
borrarla sin más.

## Compatibilidad del sistema

- **Windows 10 y Windows 11** son los objetivos declarados — 2.1.0 se verificó
  ahí, esta versión todavía no (ver la sección de arriba). Wails v2 en
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

1. Descargar `mini-tools-v2.2.0-windows-amd64.exe`.
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
