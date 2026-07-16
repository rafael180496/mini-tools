# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS** (no hay una máquina Windows en el loop de
build todavía). No es un release firmado ni se publica automáticamente a
ningún lado — solo empaqueta el `.exe` para distribuirlo manualmente
(GitHub Releases, USB, red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 0.2.1 |
| Archivo | `mini-tools-v0.2.1-windows-amd64.exe` |
| Tamaño | ~46 MB |
| SHA-256 | `5d43c6aa0533fcb3541baae7f3b6418ade9d35b0f2aa4a9e220c2a82f15780a8` |
| Arquitectura | `amd64` (x86-64) |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v0.2.1-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```

## ⚠️ No verificado en Windows real

Este `.exe` se generó cross-compilando desde macOS — `go build`/`wails
build` para `windows/amd64` terminan sin error y producen un PE32+ GUI
válido (ninguno de los 3 conectores de base de datos ni `go-redis` usan
CGO, así que no hace falta un toolchain de Windows/mingw para esto), pero
**nadie corrió todavía este binario en una máquina Windows real**. Cosas
que solo se pueden confirmar ahí, no cross-compilando:

- Que el runtime de WebView2 se inicialice correctamente (Wails requiere
  el WebView2 Runtime de Microsoft instalado — viene preinstalado en
  Windows 11 y en la mayoría de Windows 10 actualizados, pero no en todos).
- DPI scaling, tamaño/posición de ventana, atajos de teclado nativos.
- Diálogos nativos (abrir/guardar archivo, backup del vault) vía la API
  de Windows.
- Que el ícono/manifest embebido por Wails se vea y comporte bien.

Tratar este artefacto como beta hasta que alguien lo pruebe en Windows de
verdad y lo confirme acá.

## Compatibilidad del sistema (esperada, no confirmada)

- **Windows 10 (con WebView2 Runtime) o Windows 11.** Wails v2 en Windows
  depende del WebView2 Runtime de Microsoft — Windows 11 lo trae
  preinstalado; en Windows 10 puede hacer falta instalarlo aparte
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

1. Descargar `mini-tools-v0.2.1-windows-amd64.exe`.
2. Doble click para correrlo — no hace falta instalar nada.
3. Si SmartScreen bloquea la app: clic en "Más información" → "Ejecutar
   de todas formas".

## Regenerar este artefacto

```bash
./scripts/bump-version.sh patch      # opcional, si corresponde una versión nueva
./scripts/package-windows.sh         # genera build/bin/mini-tools-vX.Y.Z-windows-amd64.exe
cp build/bin/mini-tools-vX.Y.Z-windows-amd64.exe releases/windows/
shasum -a 256 releases/windows/mini-tools-vX.Y.Z-windows-amd64.exe   # actualizar la tabla de arriba
```

`package-windows.sh` cross-compila desde cualquier host con Go 1.21+ y el
Wails CLI instalados (probado desde macOS arm64; no probado desde Linux)
— no requiere una máquina Windows para generar el `.exe`, solo para
correrlo y verificarlo de verdad.

Este directorio guarda el `.exe` fuera de `build/bin/` (que es artefacto
de build efímero, gitignoreado) por el mismo motivo que
[releases/macos/](../macos/): un lugar estable de "última versión
empaquetada" que el link de descarga del README puede apuntar directo,
sin depender de un release aparte.
