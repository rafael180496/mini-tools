# mini-tools — release macOS

Artefacto de distribución local generado con `./scripts/package-macos.sh`
(build oficial). No es un release firmado de Apple ni se publica automáticamente
a ningún lado — solo empaqueta el `.dmg` para distribuirlo manualmente
(GitHub Releases, USB, red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 0.1.1 |
| Archivo | `mini-tools-v0.1.1.dmg` |
| Tamaño | ~16 MB |
| SHA-256 | `ccb0e27d78fe34921959b79fd33b2ef24e5cb064813a1fd9e86596995d32e4b8` |
| Arquitectura | `arm64` (Apple Silicon) |
| Generado | `wails build -clean` (modo producción, sin devtools) |

Verificar la integridad del archivo descargado:

```bash
shasum -a 256 mini-tools-v0.1.1.dmg
# debe coincidir con el hash de la tabla de arriba
```

## Compatibilidad del sistema

- **Solo Apple Silicon (M1/M2/M3/M4 — arquitectura `arm64`).** Este build
  se compiló en un Mac `arm64` con `wails build` sin el flag de binario
  universal, así que **no corre en Mac Intel** (`x86_64`) ni bajo Rosetta —
  Rosetta traduce binarios `x86_64` a `arm64`, no al revés. Un Mac Intel
  necesita un build separado (`GOARCH=amd64` / `-platform darwin/amd64`),
  que este artefacto no incluye.
- **macOS 11 (Big Sur) o superior**, en la práctica: es la primera versión
  de macOS que corrió en hardware Apple Silicon, así que es el piso real
  aunque el `Info.plist` generado por Wails declara
  `LSMinimumSystemVersion = 10.13.0` (valor genérico de la plantilla de
  Wails, heredado de cuando también soportaba Intel — no una garantía de
  que la app funcione en 10.13 real, que de todos modos no existe en
  arm64).
- **Sin firma de Apple Developer ID ni notarización.** El "Self-signing
  application: Done." que imprime `wails build` es un self-sign ad-hoc
  interno de Wails, no una firma real — Gatekeeper va a mostrar
  "desarrollador no identificado" al abrir la app en cualquier Mac que no
  sea el que la compiló.

## Instalación

1. Descargar `mini-tools-v0.1.1.dmg` y abrirlo (doble click).
2. Arrastrar `mini-tools.app` al symlink de `Applications` que trae el `.dmg`.
3. Al abrir la app por primera vez, Gatekeeper bloquea la app sin firma.
   Cualquiera de estas tres opciones lo resuelve:
   - Clic derecho sobre `mini-tools.app` → **Abrir** → confirmar en el diálogo.
   - Terminal: `xattr -cr /Applications/mini-tools.app`
   - **Ajustes del Sistema → Privacidad y Seguridad** → "Abrir de todas formas".

## Regenerar este artefacto

```bash
./scripts/bump-version.sh patch   # opcional, si corresponde una versión nueva
./scripts/package-macos.sh        # genera build/bin/mini-tools-vX.Y.Z.dmg
cp build/bin/mini-tools-vX.Y.Z.dmg releases/macos/
shasum -a 256 releases/macos/mini-tools-vX.Y.Z.dmg   # actualizar la tabla de arriba
```

`package-macos.sh` solo corre en macOS (usa `hdiutil`) y siempre construye
para la arquitectura del Mac donde se ejecuta — para publicar un build
Intel además del de Apple Silicon hace falta correrlo también en (o desde)
un Mac `x86_64`, o extender el script con `-platform darwin/universal`
(cambio no incluido acá).

Este directorio guarda el `.dmg` fuera de `build/bin/` (que es artefacto de
build efímero, gitignoreado) para tener un lugar estable de "última versión
empaquetada" — a diferencia de `build/bin/`, el `.dmg` acá **sí se versiona
en git y se pushea** (decisión explícita: el link de descarga del README
tiene que funcionar directo desde GitHub, sin depender de un release
aparte).
