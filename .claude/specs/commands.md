# Comandos — mini-tools

Wrappers en [scripts/](../../scripts/) (ver [scripts/README.md](../../scripts/README.md) para el detalle de cada uno):

```bash
./scripts/install.sh        # toolchain (Wails CLI) + deps de Go y frontend
./scripts/start-dev.sh      # wails dev — hot reload
./scripts/build.sh          # wails build -clean — build de producción (embebe VERSION vía ldflags)
./scripts/start.sh          # correr el binario ya compilado en build/bin/
./scripts/uishot.sh files   # CAPTURA de una vista de la interfaz, sin abrir la app
./scripts/clean.sh          # borrar build/bin + frontend/dist (--all también node_modules y cache de Go)
./scripts/package-macos.sh   # empaqueta build/bin/mini-tools.app en un .dmg sin firmar (solo macOS, solo local)
./scripts/package-windows.sh # cross-compila un .exe portable sin firmar para windows/amd64 (no requiere Windows, no verificado en Windows real)
./scripts/bump-version.sh    # patch|minor|major — bumpea VERSION, no toca git
```

Equivalentes directos, por si hace falta correrlos sin los wrappers:

```bash
wails dev
wails build -clean

cd frontend && pnpm install   # pnpm SIEMPRE, nunca npm/yarn
cd frontend && pnpm build

go build ./...
go vet ./...
go test ./...
```

Después de agregar o eliminar un archivo de código, correr `codegraph sync` para mantener el índice de `.codegraph/` al día antes de seguir trabajando.

## Capturas de la interfaz (`scripts/uishot.sh`)

```bash
./scripts/uishot.sh files            # árbol de archivos + editor
./scripts/uishot.sh agents 520 780   # panel de agentes, con ancho y alto
./scripts/uishot.sh chat
```

Imprime la ruta del PNG. Sirve para **revisar disposición, jerarquía y textos**
sin compilar la app, abrirla y desbloquear el vault.

**Por qué existe y no un `screencapture` normal:** sacarle una foto a la
ventana desde afuera requiere el permiso de grabación de pantalla de macOS,
que un proceso automatizado no tiene — `screencapture` falla con *"could not
create image from display"*. Acá los componentes se montan en Chrome headless
con los bindings de Wails simulados (`frontend/src/uishot.tsx`), y el navegador
se fotografía a sí mismo: sin permisos del sistema, sin vault y sin backend.

**Lo que NO prueba:** nada del backend. Los datos son fijos. Que un binding
devuelva lo correcto se verifica con los tests de Go.

**Para agregar una vista:** sumarla al objeto `views` de `uishot.tsx` y, si
pide un binding nuevo, agregar su fixture. Un método sin fixture devuelve
`null` y el componente se dibuja vacío — ese vacío es la señal de que falta el
dato, no un error.

No entra en el build de producción: Vite solo empaqueta `index.html`.
