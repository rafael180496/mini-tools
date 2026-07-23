# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS** y **verificado corriendo en Windows 10 y
Windows 11**. No es un release firmado ni se publica automáticamente a
ningún lado — solo empaqueta el `.exe` para distribuirlo manualmente
(GitHub Releases, USB, red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 0.5.0 |
| Archivo | `mini-tools-v0.5.0-windows-amd64.exe` |
| Tamaño | ~51 MB |
| SHA-256 | `2f962f071bc24965a39d279ceafea8763bcd08a2a7fa7de78abcb15953cbeea3` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v0.5.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```

## Verificado en Windows real

Este `.exe` se cross-compila desde macOS (ninguno de los conectores de
base de datos —PostgreSQL, Oracle, SQLite, SQL Server, MongoDB— ni
`go-redis` usan CGO, así que no hace falta un toolchain de
Windows/mingw), pero **no se distribuye solo porque compile**: esta
versión (0.5.0) se corrió en **Windows 10 y Windows 11 reales** antes de
publicarla, y la app arranca y funciona en ambos.

Lo que se confirmó ahí y no se puede confirmar cross-compilando:

- **WebView2 arranca sin instalar nada.** En los dos equipos de prueba
  —Windows 11 y Windows 10— la app abrió directo, sin instalar el
  WebView2 Runtime aparte. Ver la nota de compatibilidad abajo sobre qué
  pasa en un Windows 10 sin actualizar.
- **DPI scaling, tamaño y posición de ventana** correctos.
- **Diálogos nativos** (abrir/guardar archivo, backup del vault) vía la
  API de Windows.
- **Ícono y manifest** embebidos por Wails.

Sin problemas conocidos abiertos en Windows al momento de esta versión.
Lo único que sigue molestando al primer arranque es SmartScreen, por la
falta de firma Authenticode — ver abajo.

## Compatibilidad del sistema

- **Windows 10 y Windows 11** — ambos verificados corriendo la app (ver
  arriba). Wails v2 en Windows depende del WebView2 Runtime de Microsoft:
  Windows 11 lo trae preinstalado y los Windows 10 con Edge al día
  también (llega con las actualizaciones de Edge), que fue el caso en las
  pruebas. Un Windows 10 viejo o sin actualizar puede no tenerlo — ahí se
  instala aparte, gratis
  ([enlace oficial](https://developer.microsoft.com/microsoft-edge/webview2/)).
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

1. Descargar `mini-tools-v0.5.0-windows-amd64.exe`.
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
   (gratis, "Evergreen Standalone Installer") y reintentar. No pasó en
   ninguno de los equipos de prueba, pero es el único requisito previo
   posible.

### Actualizar a una versión nueva

Reemplazar el `.exe` viejo por el nuevo. El vault (conexiones, clave
maestra, preferencias) vive aparte, en `%APPDATA%\mini-tools\`, así que
no se pierde nada al reemplazar el binario — y borrar el `.exe` **no**
borra el vault.

## Regenerar este artefacto

```bash
./scripts/bump-version.sh patch      # opcional, si corresponde una versión nueva
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
