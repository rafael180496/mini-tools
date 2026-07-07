# scripts/

Wrappers de conveniencia sobre los comandos de `wails`/`go`/`pnpm`. Todos son idempotentes y se pueden correr desde cualquier directorio (resuelven la raíz del repo solos). Requieren `bash`.

| Script | Qué hace | Cuándo usarlo |
|---|---|---|
| `install.sh` | Verifica Go/pnpm, instala el CLI de Wails si falta (`go install .../wails/v2/cmd/wails@latest`), corre `go mod download` y `pnpm install` en `frontend/`. | Primera vez que se clona el repo, o después de un `git pull` que trajo dependencias nuevas. |
| `start-dev.sh` | `wails dev` — backend Go + Vite con hot reload en una sola ventana. | Loop normal de desarrollo. |
| `build.sh` | `wails build -clean` — build de producción (Wails ya aplica `-ldflags "-w -s"` por default, no hace falta pasarlo), limpia `build/bin` antes de compilar. Al final lista el tamaño del binario resultante. | Antes de probar el binario empaquetado, o para verificar el objetivo de <35MB tras añadir una dependencia. |
| `start.sh` | Abre/ejecuta el binario ya compilado en `build/bin/` (`open build/bin/mini-tools.app` en macOS). No compila nada. | Para correr el último build sin recompilar. |
| `clean.sh` | Borra `build/bin/`, `frontend/dist/` y cualquier binario suelto de `go build` en la raíz. Con `--all` también borra `frontend/node_modules` y la cache de build de Go (`go clean -cache`). | Cuando un build se ve raro / obsoleto, o antes de medir el tamaño del binario desde cero. |

## Uso típico

```bash
./scripts/install.sh      # una sola vez (o tras pull con deps nuevas)
./scripts/start-dev.sh    # desarrollo día a día

./scripts/build.sh        # build de producción
./scripts/start.sh        # correr ese build

./scripts/clean.sh        # limpiar build/bin + dist
./scripts/clean.sh --all  # + node_modules + cache de Go
```

Ninguno de estos scripts toca el vault (`~/Library/Application Support/mini-tools/` en macOS) ni ninguna conexión guardada — solo build/dev/clean del propio proyecto.
