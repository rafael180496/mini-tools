# mini-tools — release Windows

Artefacto de distribución local generado con `./scripts/package-windows.sh`,
**cross-compilado desde macOS**. **Esta versión NO se verificó todavía en una
Windows real** — ver "Estado de verificación" abajo. No es un release firmado ni se publica automáticamente a ningún lado —
solo empaqueta el `.exe` para distribuirlo manualmente (GitHub Releases, USB,
red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 2.10.1 |
| Archivo | `mini-tools-v2.10.1-windows-amd64.exe` |
| Tamaño | ~78 MB (78,0 MB; 78 062 592 bytes) — es el binario suelto, bajo el techo de 100 MB |
| SHA-256 | `3f0dd07d121a7a4a17acd08e87615dcb7fb04097889a40525d7f245797963a06` |
| Arquitectura | `amd64` (x86-64) — verificado con `file`: `PE32+ executable (GUI) x86-64, for MS Windows` |
| Generado | `wails build -platform windows/amd64` (modo producción, sin devtools), cross-compilado desde macOS arm64 |

Verificar la integridad del archivo descargado (PowerShell):

```powershell
Get-FileHash mini-tools-v2.10.1-windows-amd64.exe -Algorithm SHA256
# debe coincidir con el hash de la tabla de arriba
```


> **El archivo publicado es este.** El workflow de release **no recompila**:
> sube exactamente el binario versionado en esta carpeta, así que el SHA-256 de
> la tabla de arriba es el del archivo que se descarga del GitHub Release. Es la
> razón de reusar en vez de compilar en CI — dos compilaciones de Go en máquinas
> distintas no dan un binario bit a bit idéntico, y el release terminaría siendo
> un archivo que nadie probó.

## Estado de verificación en Windows real

**La 2.10.1 NO está verificada en Windows real.** Todavía nadie la corrió en
Windows 10 ni en Windows 11; lo único confirmado es que cross-compila limpio
desde macOS, que el binario es un `PE32+ x86-64` y que pasan `go build`,
`go vet` y `go test` en el host de desarrollo. Que compile no dice nada de
WebView2, DPI ni los diálogos nativos: hasta que alguien la corra, es una
afirmación sin confirmar.

Contexto: **la 2.10.0 sí se corrió en Windows 10 y Windows 11 reales** (confirmado
por el usuario antes de publicar). Eso **no se extrapola** a la 2.10.1, aunque
la diferencia sea chica: la 2.10.1 **solo cambia la interfaz (frontend)** y un
cambio pequeño en Go —cómo se titulan y renombran las conversaciones del chat de
IA—, más la persistencia de las conversaciones (guardadas desde que se crean,
fijables, y con las pestañas de Chat de IA reabiertas al arrancar), que agrega la
**migración 65 del vault** (aditiva; un `vault.db` de la 2.10.0 migra solo y no
hay rollback). No toca conectores ni código específico de Windows.

Qué conviene mirar primero en una Windows real:

- **Utilidades → Chat de IA**: que la fila se despliegue con las pestañas
  abiertas y los grupos **Abiertas** (con las fijadas arriba) y **Recientes**; que la barra lateral tenga
  seis módulos (ya no existe «IA») y que la insignia de Utilidades cuente los
  chats que trabajan o esperan.
- **Conversaciones persistentes**: una pestaña de chat nueva figura enseguida en
  *Abiertas* como borrador; *Fijar* / *Desfijar*; *Cerrar chat* y *Eliminar* (con
  confirmación). Que un `vault.db` de la 2.10.0 en `%APPDATA%\mini-tools\` migre
  solo a la 65 al primer arranque.
- **Reabrir pestañas al arrancar**: cerrar la app con varias pestañas de Chat de
  IA (alguna dividida, alguna trabajando) y volver a abrirla: las pestañas vuelven
  con sus paneles, las que trabajaban figuran *Interrumpido al cerrar la app* y
  nada arranca solo hasta pulsar *Abrir*. Probar también un cierre brusco
  (terminar el proceso desde el Administrador de tareas).
- **Renombrar chats**: doble clic o F2 sobre una pestaña o su fila, clic derecho
  → Renombrar…, el lápiz de la cabecera y el menú ⋯; que Enter guarde, Esc cancele
  y que el campo en el lugar no pierda el foco (en Windows el menú contextual y
  F2 dependen del teclado y del webview).
- **Títulos automáticos**: una conversación nueva —también la abierta desde un
  repositorio de Git— toma el nombre de su primer mensaje, y renombrar ya no la
  sube a *Hoy*.
- **Barra de filtros del historial**: el botón **Filtros**, el panel (Esc o clic
  afuera lo cierran), las fichas con **Limpiar** y que los filtros se recuerden
  por pestaña.
- **Lo que verificó la 2.10.0** (selector nativo de carpeta, arrastrar archivos
  al chat, `run_command` del agente local, servidores de modelos remotos) no se
  da por verificado en la 2.10.1: es una versión distinta y no se volvió a
  ejercitar en Windows.
- Lo que sigue pendiente desde versiones anteriores: el flujo OAuth 2.0 (aviso
  del Firewall), el servidor MCP por named pipe, lanzar los CLIs agénticos
  (`.cmd`/`.exe` del `PATH`), varias terminales SSH contra el mismo servidor
  (ConPTY), abrir en VS Code / el explorador, pegar imágenes en una nota, y el
  módulo **Utilidades** (Monitor de actividad con Toolhelp32/`psapi`, Liberador
  de puertos con `netstat`/`tasklist` y UAC, Docker).

**Esta sección se reescribe en cada release.** Cuando alguien corra la 2.10.1
en Windows, se documenta aquí **en qué versiones de Windows** y qué se confirmó.

## Compatibilidad del sistema

- **Windows 10 y Windows 11** son los objetivos declarados. La 2.10.0 se corrió
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

1. Descargar `mini-tools-v2.10.1-windows-amd64.exe`.
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
