# Releases — cómo armar una versión nueva a mano

Runbook para un humano. Complementa [scripts/README.md](../scripts/README.md)
(qué hace cada script) y [.claude/specs/releases.md](../.claude/specs/releases.md)
(la misma info, pero para Claude Code — trigger phrases, reglas exactas). Si
alguna vez esto se hace sin el agente, seguir estos pasos en orden.

## Resumen rápido

```bash
./scripts/bump-version.sh patch   # o minor/major
./scripts/package-all.sh          # arma .dmg + .exe sin que se pisen entre sí
```

A partir de ahí, todo lo demás (copiar a `releases/<os>/`, checksums, docs)
es manual — ningún script de este repo hace `git add`/`commit`/`push`.

## Paso a paso

### 1. Bumpear la versión

```bash
./scripts/bump-version.sh patch   # 0.2.2 → 0.2.3
# o: minor (0.2.x → 0.3.0) / major (0.x.y → 1.0.0)
```

Solo reescribe el archivo `VERSION`. No toca git ni ningún otro archivo.

### 2. Empaquetar — usar `package-all.sh`, no los scripts sueltos en secuencia

```bash
./scripts/package-all.sh
```

**Por qué no correr `package-macos.sh` y después `package-windows.sh` a
mano:** los dos llaman `wails build -clean` internamente, que borra
`build/bin/` completo al arrancar. Si se corren en secuencia sin más, el
segundo borra el artefacto que acababa de dejar el primero antes de que
haya chance de copiarlo a ningún lado — un bug real, encontrado corriendo
exactamente esa secuencia. `package-all.sh` ya lo resuelve: mueve cada
artefacto a un directorio temporal apenas termina su propio script, y
recién al final los devuelve todos juntos a `build/bin/`.

Si por algún motivo hay que correr un solo SO puntual, copiar el artefacto
a `releases/<os>/` (paso 3) **inmediatamente**, antes de correr el
`package-*.sh` del otro SO — no dejarlo esperando en `build/bin/`.

Al terminar, `build/bin/` tiene:
- `mini-tools-vX.Y.Z.dmg` (solo si esto corrió en macOS — `package-macos.sh`
  usa `hdiutil`, no cross-compila)
- `mini-tools-vX.Y.Z-windows-amd64.exe` (siempre — cross-compilado, no hace
  falta una máquina Windows)

### 3. Copiar a `releases/<os>/`

```bash
cp build/bin/mini-tools-vX.Y.Z.dmg releases/macos/
cp build/bin/mini-tools-vX.Y.Z-windows-amd64.exe releases/windows/
```

`build/bin/` es la salida cruda y efímera de los scripts (gitignoreada);
`releases/<os>/` es la copia publicada y estable, y **sí se versiona en
git** — ver "Por qué los artefactos se versionan en git" más abajo.

### 4. Checksums

```bash
shasum -a 256 releases/macos/mini-tools-vX.Y.Z.dmg
shasum -a 256 releases/windows/mini-tools-vX.Y.Z-windows-amd64.exe
```

Guardar ambos hashes — van en las tablas de los pasos 6-8.

### 5. Verificar arquitectura real — nunca asumir

```bash
# macOS: montar el .dmg y mirar el binario de adentro
MOUNT_DIR=$(mktemp -d)
hdiutil attach releases/macos/mini-tools-vX.Y.Z.dmg -mountpoint "$MOUNT_DIR" -nobrowse -quiet
file "$MOUNT_DIR/mini-tools.app/Contents/MacOS/mini-tools"
hdiutil detach "$MOUNT_DIR" -quiet

# Windows
file releases/windows/mini-tools-vX.Y.Z-windows-amd64.exe
```

Resultado esperado: `Mach-O 64-bit executable arm64` y
`PE32+ executable (GUI) x86-64, for MS Windows`.

Por qué molestarse: el `Info.plist` que genera Wails declara
`LSMinimumSystemVersion = 10.13.0` por una plantilla genérica heredada de
cuando el proyecto también apuntaba a Intel — **no** es la compatibilidad
real de un build `arm64` (que en la práctica es macOS 11+, la primera
versión que corrió en Apple Silicon). Nunca copiar ese valor a las docs sin
esta verificación.

### 6-7. Actualizar `releases/macos/README.md` y `releases/windows/README.md`

Cada uno tiene una tabla "Versión actual" (Versión / Archivo / Tamaño /
SHA-256 / Arquitectura) — actualizarla a mano con los valores de los pasos
3-5. También el nombre de archivo en la sección "Instalación" de cada uno.

### 8. Actualizar `README.md` raíz

Dos lugares distintos, no uno solo:
1. La tabla de la sección **"Descargas"** cerca del inicio del archivo.
2. Las dos secciones **"Distribución / Empaquetado macOS"** y
   **"...Windows"** más abajo, cada una con su propia tabla "Última versión
   empaquetada" (Versión / Plataforma / Archivo / SHA-256).

Mismos valores que los pasos 6-7 — si un checksum queda desincronizado
entre `README.md` raíz y `releases/<os>/README.md`, es un bug de este
proceso, no una inconsistencia aceptable.

### 9. Actualizar `CHANGELOG.md`

Formato [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

1. Mover **todo** el contenido de `## [Unreleased]` a una sección nueva
   `## [X.Y.Z] - AAAA-MM-DD` (la versión del paso 1, fecha real del día —
   nunca inventada).
2. Agregar ahí mismo cualquier feature/fix de la sesión que todavía no
   estuviera en `[Unreleased]` — no es solo renombrar la sección.
3. Entradas concisas agrupadas bajo `### Agregado` / `### Corregido` /
   `### Cambiado` / `### Quitado` según corresponda — mismo nivel de
   detalle que las entradas ya existentes (qué cambió y por qué le importa
   a quien lo lee, no un genérico "varios fixes").
4. Dejar `## [Unreleased]` vacío arriba, listo para la próxima tanda de
   cambios post-release.

## Qué este proceso NUNCA hace solo

- **`git add`/`commit`/`push`** — nada de esto es automático. Todo queda en
  el working tree (artefactos + docs) para que quien esté a cargo lo revise
  y lo suba a mano.
- **Firmar los binarios** — ni Apple Developer ID/notarización en macOS, ni
  Authenticode en Windows. Ambos quedan sin firmar; el workaround de
  Gatekeeper/SmartScreen ya está documentado en cada
  `releases/<os>/README.md`, no hace falta repetirlo en ningún lado más.

## Por qué los artefactos sí se versionan en git

Decisión explícita del proyecto (no un default de conveniencia): cada
`.dmg`/`.exe` se commitea al repo en vez de excluirse por `.gitignore` —
así el link de descarga del README funciona directo desde GitHub, sin
depender de un flujo aparte (GitHub Releases, USB, etc.). El costo aceptado
es que cada versión empaquetada suma ~20-52MB permanentes por SO al
historial de git.

## Ver también

- [.claude/specs/releases.md](../.claude/specs/releases.md) — este mismo
  proceso, para Claude Code (qué frase lo dispara, reglas exactas sin
  ambigüedad).
- [scripts/README.md](../scripts/README.md) — qué hace cada script
  (`install.sh`, `build.sh`, `package-*.sh`, `clean.sh`, etc.) y cuándo
  usar cada uno.
- [releases/macos/README.md](macos/README.md) /
  [releases/windows/README.md](windows/README.md) — estado de la última
  versión empaquetada de cada SO (lo que este runbook mantiene al día).
