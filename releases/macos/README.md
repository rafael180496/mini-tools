# mini-tools — release macOS

Artefacto de distribución local generado con `./scripts/package-macos.sh`
(build oficial). No es un release firmado de Apple ni se publica automáticamente
a ningún lado — solo empaqueta el `.dmg` para distribuirlo manualmente
(GitHub Releases, USB, red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 2.3.0 |
| Archivo | `mini-tools-v2.3.0.dmg` |
| Tamaño | ~21 MB (21,4 MB) |
| SHA-256 | `03da48e2839b1b7ae1b7a72a245d48e4fb15dc1e9fd134fa375849a978f36a5b` |
| Arquitectura | `arm64` (Apple Silicon) — verificado con `file` sobre el binario dentro del `.dmg` |
| Generado | `wails build -clean` (modo producción, sin devtools) |

Verificar la integridad del archivo descargado:

```bash
shasum -a 256 mini-tools-v2.3.0.dmg
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

1. Descargar `mini-tools-v2.3.0.dmg` y abrirlo (doble click).
2. Arrastrar `mini-tools.app` al symlink de `Applications` que trae el `.dmg`.
3. Al abrir la app por primera vez, Gatekeeper bloquea la app sin firma.
   Cualquiera de estas tres opciones lo resuelve:
   - Clic derecho sobre `mini-tools.app` → **Abrir** → confirmar en el diálogo.
   - Terminal: `xattr -cr /Applications/mini-tools.app`
   - **Ajustes del Sistema → Privacidad y Seguridad** → "Abrir de todas formas".

## Regenerar este artefacto

```bash
./scripts/bump-version.sh minor   # patch/minor/major según lo que entre en la versión
./scripts/package-macos.sh        # genera build/bin/mini-tools-vX.Y.Z.dmg
cp build/bin/mini-tools-vX.Y.Z.dmg releases/macos/
shasum -a 256 releases/macos/mini-tools-vX.Y.Z.dmg   # actualizar la tabla de arriba
```

`package-macos.sh` solo corre en macOS (usa `hdiutil`) y siempre construye
para la arquitectura del Mac donde se ejecuta — para publicar un build
Intel además del de Apple Silicon hace falta correrlo también en (o desde)
un Mac `x86_64`, o extender el script con `-platform darwin/universal`
(cambio no incluido acá).

Este directorio es la **zona de preparación**: acá se deja el `.dmg` recién
generado para subirlo como asset del [GitHub Release](https://github.com/rafael180496/mini-tools/releases)
de su tag, y se borra después. El binario **no se commitea** — lo permanente de
esta carpeta es este `README.md`, que es donde viven el checksum y las
instrucciones. Por eso el link de descarga del README raíz apunta al asset del
Release y no a una ruta del repositorio.
