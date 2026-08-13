# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS**. Esta versión **no se corrió en una Windows
real** antes de publicarla — ver "Estado de verificación" abajo. No es un
release firmado ni se publica automáticamente a ningún lado — solo empaqueta
el `.exe` para distribuirlo manualmente (GitHub Releases, USB, red interna,
etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 1.2.0 |
| Archivo | `mini-tools-v1.2.0-windows-amd64.exe` |
| Tamaño | ~53 MB |
| SHA-256 | `dcffd3b83e10b9320f8f136141c04cb23a12928c0af0334e20e87a0cbb4c3036` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v1.2.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```

## Estado de verificación en Windows real

**Esta versión (1.2.0) NO fue verificada en una Windows real.** Lo único
confirmado es que cross-compila limpio desde macOS (ninguno de los
conectores de base de datos —PostgreSQL, Oracle, SQLite, SQL Server,
MongoDB— ni `go-redis` ni el PTY usan CGO, así que no hace falta un
toolchain de Windows/mingw).

Importante, porque se acumula: **la 1.1.0 tampoco se verificó**, así que
todo lo que quedó pendiente de confirmar en aquella versión sigue
pendiente acá — no se reinicia la lista con cada release. Lo último que
corrió de verdad sobre Windows 10 y 11 fue la 1.0.0.

Queda sin confirmar en Windows, en orden de riesgo:

- **La migración 29 del vault, nueva en esta versión.** Al primer arranque
  crea la tabla `ssh_command_history` y agrega una columna a `settings`
  sobre el `vault.db` que ya existe en la máquina. Es SQLite puro y el
  camino es el mismo en todos los SO, pero una migración que falle deja la
  app sin arrancar, así que es lo primero a mirar si alguien la prueba.
- **La terminal local integrada** (pendiente desde 1.1.0). En Windows usa
  ConPTY (la API de pseudo-consola del sistema) vía
  `github.com/aymanbagabas/go-pty`, un camino de código completamente
  distinto al `openpty` de Unix. Sin probarlo no está confirmado que la
  shell arranque, que el redimensionado reflowe bien, ni que
  PowerShell/cmd/Git Bash/WSL se detecten y abran como corresponde.
- **Las sesiones de agentes de código** (pendiente desde 1.1.0). Dependen
  de encontrar los CLIs en las rutas de instalación típicas de Windows
  (`%APPDATA%\npm`, `~/.bun/bin`), que no se verificaron contra una
  instalación real.
- **Las transferencias SFTP con la configuración nueva del cliente.** Esta
  versión activa lecturas/escrituras concurrentes. Es código Go idéntico en
  todos los SO, pero el rendimiento real depende de la red y no se midió
  desde Windows.
- **WebView2 arranca sin instalar nada.** Confirmado en 1.0.0 sobre
  Windows 10 y 11; es razonable esperar lo mismo acá (no cambió nada del
  bootstrap), pero no se volvió a comprobar.
- **DPI scaling, tamaño y posición de ventana.**
- **Diálogos nativos** (abrir/guardar archivo, backup del vault).

Si alguien la corre en una Windows real, corresponde reemplazar esta
sección por lo que se haya confirmado y en qué versiones de Windows — no
borrarla sin más.

## Compatibilidad del sistema

- **Windows 10 y Windows 11**, esperado pero **no verificado en esta
  versión** (ver la sección de arriba). Wails v2 en Windows depende del
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

1. Descargar `mini-tools-v1.2.0-windows-amd64.exe`.
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
