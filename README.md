# mini-tools

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Go](https://img.shields.io/badge/go-1.26-00ADD8)
![Wails](https://img.shields.io/badge/wails-v2-DF0000)

Cliente SQL de escritorio para **Oracle, PostgreSQL y SQLite** — tipo DataGrip, pero minimalista. Go + Wails v2 en el backend, React + Tailwind en el frontend. Sin Electron.

> En desarrollo activo. El spec funcional completo vive en [docs/SPEC.md](docs/SPEC.md).

## Por qué

La mayoría de clientes SQL multi-motor son pesados (JVM, Electron, cientos de MB). mini-tools apunta a lo contrario: un binario nativo liviano, dark por defecto, sin telemetría, con las conexiones cifradas en un vault local — nada más.

## Features

- **3 motores nativos**: Oracle (TNS / Easy Connect / SID / Service Name), PostgreSQL (SSL modes completos), SQLite — todos vía `database/sql`, sin cliente Oracle/Postgres instalado aparte.
- **Vault cifrado local**: las conexiones se guardan en SQLite, con el DSN cifrado columna a columna (AES-256-GCM, clave derivada con Argon2id). Sin clave maestra correcta, no hay acceso — no hay bypass.
- **Backup/restore del vault**: exportar e importar el vault completo (conexiones + salt) como un solo archivo, para mover de máquina o recuperarse de un borrado accidental.
- **Editor SQL** con tabs, ejecución de queries con streaming de resultados y cancelación en caliente.
- **Grid de resultados** virtualizado para miles de filas sin lag.
- Dark mode por defecto, toggle a light.

## Requisitos

- [Go](https://go.dev/dl/) 1.26 o superior
- [pnpm](https://pnpm.io/) — nunca `npm` ni `yarn`
- Node.js (solo para compilar el frontend; no hay runtime Node en producción)
- [Wails CLI v2](https://wails.io/) (el script de instalación de abajo lo instala si falta)

## Instalación

```bash
git clone https://github.com/rafael180496/mini-tools.git
cd mini-tools
./scripts/install.sh
```

## Desarrollo

```bash
./scripts/start-dev.sh   # backend Go + frontend Vite con hot reload
```

## Build de producción

```bash
./scripts/build.sh        # genera build/bin/mini-tools.app (macOS) — binario objetivo <35MB
./scripts/start.sh        # corre el binario ya compilado
```

Ver [scripts/README.md](scripts/README.md) para el detalle de cada script (incluye `clean.sh` para limpiar artefactos de build).

## Estructura del proyecto

```
/backend        crypto, vault (SQLite cifrado), conectores DB, ejecución de queries
/frontend        React + TypeScript + Tailwind
app.go           superficie de binding Go↔React
main.go          bootstrap de Wails
```

Detalle completo en [docs/SPEC.md](docs/SPEC.md) y en [CLAUDE.md](CLAUDE.md) (convenciones de código, reglas técnicas).

## Seguridad

- El DSN de cada conexión se cifra con AES-256-GCM antes de guardarse; la clave se deriva de tu clave maestra con Argon2id y nunca se persiste en ningún lado.
- Sin clave maestra correcta, la app no arranca — no hay bypass, ni siquiera desde las bindings internas.
- El DSN nunca llega al frontend ni se loguea, tampoco en modo debug.

## Licencia

[MIT](LICENSE)
