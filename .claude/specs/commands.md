# Comandos — mini-tools

Wrappers en [scripts/](../../scripts/) (ver [scripts/README.md](../../scripts/README.md) para el detalle de cada uno):

```bash
./scripts/install.sh      # toolchain (Wails CLI) + deps de Go y frontend
./scripts/start-dev.sh    # wails dev — hot reload
./scripts/build.sh        # wails build -clean — build de producción
./scripts/start.sh        # correr el binario ya compilado en build/bin/
./scripts/clean.sh        # borrar build/bin + frontend/dist (--all también node_modules y cache de Go)
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
