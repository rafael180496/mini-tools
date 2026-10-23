# mini-tools — release macOS

Artefacto de distribución local generado con `./scripts/package-macos.sh`
(build oficial). No es un release firmado de Apple ni se publica automáticamente
a ningún lado — solo empaqueta el `.dmg` para distribuirlo manualmente
(GitHub Releases, USB, red interna, etc.).

## Versión actual

| Campo | Valor |
|---|---|
| Versión | 2.10.4 |
| Archivo | `mini-tools-v2.10.4.dmg` |
| Tamaño | ~29 MB (28,6 MB; 28 631 188 bytes) — el binario suelto dentro del `.dmg` pesa 75,3 MB (75 318 544 bytes), bajo el techo de 100 MB |
| SHA-256 | `c69be59ec8410a8cde2adf73543c258aae679b9396ca5f03897487294f0334c6` |
| Arquitectura | `arm64` (Apple Silicon) — verificado con `file` sobre el binario dentro del `.dmg` |
| Generado | `wails build -clean` (modo producción, sin devtools) |

Verificar la integridad del archivo descargado:

```bash
shasum -a 256 mini-tools-v2.10.4.dmg
# debe coincidir con el hash de la tabla de arriba
```


> **El archivo publicado es este.** El workflow de release **no recompila**:
> sube exactamente el binario versionado en esta carpeta, así que el SHA-256 de
> la tabla de arriba es el del archivo que se descarga del GitHub Release. Es la
> razón de reusar en vez de compilar en CI — dos compilaciones de Go en máquinas
> distintas no dan un binario bit a bit idéntico, y el release terminaría siendo
> un archivo que nadie probó.

## Compatibilidad del sistema

- **Esta versión no agrega migraciones del vault.** El esquema sigue en la
  migración 65 (la de la 2.10.1), así que un `vault.db` de la 2.10.3, la 2.10.2 o la 2.10.1
  abre tal cual y también se puede volver a ellas sin tocarlo. Para pasar desde la
  2.10.0 o anterior, el vault migra solo la primera vez (las migraciones 57 a 65
  son aditivas y **no tienen rollback**: conviene un backup antes, en
  Configuración → Backup del vault).
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

1. Descargar `mini-tools-v2.10.4.dmg` y abrirlo (doble click).
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

**El `.dmg` de esta carpeta se commitea junto con el tag.** No es opcional: el
workflow de release no compila nada, sube exactamente este archivo, y
[comprueba antes de publicar](../../.github/workflows/release.yml) que esté en
el commit del tag y que su SHA-256 aparezca en este README. Un tag empujado sin
el artefacto —o con este README desactualizado— falla en CI en vez de publicar
un binario que no es el que dice ser.

El link de descarga del README raíz apunta igual al **asset del Release**
(`.../releases/download/vX.Y.Z/<archivo>`) y no a una ruta del árbol: es el
canal que la gente espera, y sobrevive a que algún día se poden las copias
viejas del repositorio.
