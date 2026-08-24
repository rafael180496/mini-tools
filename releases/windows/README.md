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
| Versión | 2.3.0 |
| Archivo | `mini-tools-v2.3.0-windows-amd64.exe` |
| Tamaño | ~54 MB |
| SHA-256 | `a6b5256cf055246b34c1af6e696056a5f7a7383a48263802106e2a9d338f8a12` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v2.3.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```


> **El archivo publicado es este.** El workflow de release **no recompila**:
> sube exactamente el binario versionado en esta carpeta, así que el SHA-256 de
> la tabla de arriba es el del archivo que se descarga del GitHub Release. Es la
> razón de reusar en vez de compilar en CI — dos compilaciones de Go en máquinas
> distintas no dan un binario bit a bit idéntico, y el release terminaría siendo
> un archivo que nadie probó.

## Estado de verificación en Windows real

**2.3.0 NO se probó en una Windows real.** Lo único confirmado es que
cross-compila limpio desde macOS (ninguno de los conectores de base de datos
—PostgreSQL, Oracle, SQLite, SQL Server, MongoDB— ni `go-redis` ni el PTY usan
CGO, así que no hace falta un toolchain de Windows/mingw). Que 2.1.0 se haya
verificado en Windows 10 y 11 **no dice nada de esta versión**: se anota acá
justamente para no arrastrar esa confirmación de una versión a la siguiente.

**Lo nuevo de 2.3.0 del lado de Windows es el módulo HTTP, y es lo primero a
mirar.** Es un módulo entero que se estrena en esta versión y toca tres caminos
que dependen del sistema operativo:

- **El flujo OAuth 2.0 de aplicación nativa** levanta un servidor efímero en
  `127.0.0.1` para capturar el redirect del navegador. En Windows eso puede
  disparar el **aviso del Firewall** la primera vez; hay que confirmar que
  alcanza con permitir "redes privadas" y que el redirect vuelve a la app.
- **Los diálogos nativos de archivo**: elegir un archivo para un cuerpo
  `form-data` o binario, y "Guardar…" una respuesta. Son los mismos diálogos que
  el backup del vault, pero por un camino nuevo.
- **Los volcados de respuestas grandes**, que van al temporal del sistema y se
  borran al cerrar la app: en Windows eso es `%TEMP%`, no `/tmp`.

También se estrena la **página de documentación** y su botón de ayuda, que abre
el navegador predeterminado — en Windows es otra llamada del runtime de Wails.

Después de eso, lo que sigue sin confirmarse en Windows, en orden de riesgo:

- **Las migraciones 45 a 49 del vault, nuevas en esta versión.** Al primer
  arranque crean las tablas del módulo HTTP (colecciones, ítems, historial,
  entornos), suman los scripts y las variables calculadas, y agregan el vínculo
  entre una colección y su nota de documentación — todo sobre el `vault.db` que
  ya existe en la máquina. Se suman a las 29–44, que siguen sin verificarse ahí.
  Es SQLite puro y el camino es igual en todos los SO, pero una migración que
  falle deja la app sin arrancar: es lo primero a mirar si alguien la prueba.
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

1. Descargar `mini-tools-v2.3.0-windows-amd64.exe`.
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
