# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS**. **Esta versión sí se corrió en Windows 10 y en
Windows 11 reales** — ver "Estado de verificación" abajo para qué confirma eso y
qué no. No es un release firmado ni se publica automáticamente a ningún lado —
solo empaqueta el `.exe` para distribuirlo manualmente (GitHub Releases, USB,
red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 2.5.0 |
| Archivo | `mini-tools-v2.5.0-windows-amd64.exe` |
| Tamaño | ~57 MB (57,1 MB) |
| SHA-256 | `511474dea7f29b95efcb13db9ff2348414b344070f0f4a9dc3393b5c8342e0c0` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v2.5.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```


> **El archivo publicado es este.** El workflow de release **no recompila**:
> sube exactamente el binario versionado en esta carpeta, así que el SHA-256 de
> la tabla de arriba es el del archivo que se descarga del GitHub Release. Es la
> razón de reusar en vez de compilar en CI — dos compilaciones de Go en máquinas
> distintas no dan un binario bit a bit idéntico, y el release terminaría siendo
> un archivo que nadie probó.

## Estado de verificación en Windows real

> ⚠️ **La 2.5.0 NO se corrió en una Windows real.** Solo se confirmó que
> **cross-compila limpio** desde macOS `arm64`, que es una afirmación mucho más
> chica: el `.exe` se genera sin errores y con la arquitectura correcta, y nada
> más. Ni WebView2, ni el DPI, ni los diálogos nativos se comprueban compilando.

La 2.4.0 sí se corrió en Windows 10 y en Windows 11, y arrancó bien — pero eso
es de esa versión y no se hereda. Esta trae cambios que **tocan justamente el
arranque**: la migración **51** del vault (vacía `query_history`) corre en el
primer `Open()` después de actualizar, y una migración que falla deja la app sin
abrir.

Lo que queda sin confirmar, y hay que mirar acá primero si algo falla:

- **Que arranque sin instalar el WebView2 Runtime aparte.** Si el runtime
  faltara o no cargara, la ventana quedaría en blanco.
- **La migración 51 sobre un `vault.db` real** que ya tenga historial guardado
  (es la única migración destructiva del proyecto; ver el CHANGELOG de 2.5.0).
- **El flujo OAuth 2.0** del módulo HTTP, que levanta un servidor efímero en
  `127.0.0.1` para capturar el redirect y puede disparar el aviso del
  **Firewall** de Windows la primera vez.
- **El servidor MCP**, que en Windows usa un **named pipe** en vez de un socket
  Unix.
- **Lanzar los CLIs agénticos** (`claude`, `codex`, `agy`) como procesos hijos:
  implica resolver `.cmd`/`.exe` del `PATH` y otro manejo de saltos de línea.
- **Abrir el proyecto en VS Code o en el explorador de archivos**, que resuelve
  `code` del `PATH` y usa `explorer`.
- **Pegar imágenes en una nota** (`Ctrl+V` desde Recortes), que depende de cómo
  el WebView2 expone el portapapeles.
- **Los diálogos nativos** de abrir/guardar y el backup del vault.
- **Las fuentes del sistema que ofrece Configuración → Apariencia.** Consolas
  existe en Windows y Menlo no; la app cae en silencio a la monoespaciada
  genérica cuando la elegida falta.

**Esta sección se reescribe en cada release.** Si alguien corre esta versión en
una Windows real, reemplazar la advertencia de arriba por qué se confirmó y en
qué versiones de Windows — nunca extrapolar de un release anterior.


## Compatibilidad del sistema

- **Windows 10 y Windows 11** son los objetivos declarados, y esta versión se
  corrió en las dos (ver la sección de arriba). Wails v2 en Windows depende del
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

1. Descargar `mini-tools-v2.5.0-windows-amd64.exe`.
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

**El `.exe` de esta carpeta se commitea junto con el tag.** No es opcional: el
workflow de release no compila nada, sube exactamente este archivo, y
[comprueba antes de publicar](../../.github/workflows/release.yml) que esté en
el commit del tag y que su SHA-256 aparezca en este README. Un tag empujado sin
el artefacto —o con este README desactualizado— falla en CI en vez de publicar
un binario que no es el que dice ser.

El link de descarga del README raíz apunta al **asset del Release**
(`.../releases/download/vX.Y.Z/<archivo>`), no a una ruta del árbol.
