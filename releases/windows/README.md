# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS**. **Esta versión NO se corrió todavía en una
Windows real** — ver "Estado de verificación" abajo. No es un release firmado ni se publica automáticamente a ningún lado —
solo empaqueta el `.exe` para distribuirlo manualmente (GitHub Releases, USB,
red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 2.8.0 |
| Archivo | `mini-tools-v2.8.0-windows-amd64.exe` |
| Tamaño | ~58 MB (57,6 MB) |
| SHA-256 | `1add2b803b73222df3cc8f6899f75b18edf6274b307c4e3b4d8518bbd4e113b1` |
| Arquitectura | `amd64` (x86-64) — verificado con `file` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v2.8.0-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```


> **El archivo publicado es este.** El workflow de release **no recompila**:
> sube exactamente el binario versionado en esta carpeta, así que el SHA-256 de
> la tabla de arriba es el del archivo que se descarga del GitHub Release. Es la
> razón de reusar en vez de compilar en CI — dos compilaciones de Go en máquinas
> distintas no dan un binario bit a bit idéntico, y el release terminaría siendo
> un archivo que nadie probó.

## Estado de verificación en Windows real

**La 2.8.0 NO se corrió en una Windows real.** Solo se confirmó que
cross-compila limpio desde macOS y que el binario es un `PE32+ x86-64`. La
2.7.0 sí se probó en Windows 10 y 11, pero eso no dice nada de esta versión:
WebView2, DPI y los diálogos nativos se confirman únicamente corriéndola.

Esta versión trae **dos** migraciones nuevas del vault, que corren en el primer
`Open()` después de actualizar. Las dos son aditivas —agregan una columna con
valor por defecto— y un `vault.db` de la versión anterior no pierde nada:

- **55**: `vault_notes.pinned` (notas fijadas), `DEFAULT 0`: ninguna nota
  queda fijada sola.
- **56**: `settings.language` (idioma de la interfaz), `DEFAULT ''` = sin
  elegir, que la app lee como **inglés**. Consecuencia visible: **al
  actualizar, la app pasa a inglés** hasta que se elija español en la pantalla
  de desbloqueo o en Configuración → Apariencia → Idioma.

Lo nuevo de esta versión que más depende de la plataforma, y donde hay que
mirar primero si algo falla en Windows:

- **Cambio de idioma en caliente** con terminales SSH abiertas y consultas
  corriendo: no debería cortar nada.
- **Exportar una nota como Markdown**: usa el diálogo nativo de guardado.
- **Los procesos hijos heredan el idioma** por la variable `MINI_TOOLS_LANG`
  (hook de aprobación de los agentes, servidor MCP por named pipe, askpass y
  editor de rebase de git).
- Lo que ya estaba pendiente de la 2.7.0 sigue sin ejercitarse en Windows: el
  flujo OAuth 2.0 (aviso del Firewall), el servidor MCP por named pipe, lanzar
  los CLIs agénticos (`.cmd`/`.exe` del `PATH`), varias terminales SSH contra
  el mismo servidor (ConPTY), abrir en VS Code / el explorador y pegar
  imágenes en una nota.

**Esta sección se reescribe en cada release.** Si la versión siguiente sale sin
que nadie la corra en una Windows real, va la advertencia explícita de "no
verificado" — nunca extrapolar de un release anterior.


## Compatibilidad del sistema

- **Windows 10 y Windows 11** son los objetivos declarados. La 2.7.0 se corrió
  en las dos; esta versión todavía no (ver la sección de arriba). Wails v2 en Windows depende del
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

1. Descargar `mini-tools-v2.8.0-windows-amd64.exe`.
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
