# Releases — mini-tools

Spec del proceso de empaquetado/publicación local. Complementa
[commands.md](commands.md) (qué hace cada script) con el flujo completo que
se espera cuando alguien pide un build oficial, no solo `wails build`.

## Trigger: "compila la versión oficial"

Cuando el usuario pida compilar/empaquetar "la versión oficial" (o
variantes: "compila el build oficial", "arma el release", "empaqueta para
mac/[SO]"), ejecutar sin pedir confirmación:

1. Correr el script de empaquetado del SO correspondiente — hoy solo existe
   `./scripts/package-macos.sh` (build de producción + `.dmg` sin firmar,
   ver [commands.md](commands.md) y [scripts/README.md](../../scripts/README.md)).
2. Crear (si no existe) `releases/<os>/` — hoy solo `releases/macos/`.
3. **Copiar** (nunca mover) el artefacto generado
   (`build/bin/mini-tools-vX.Y.Z.dmg`) a `releases/<os>/`. `build/bin/`
   sigue siendo la salida cruda y efímera de los scripts de build;
   `releases/<os>/` es la copia "publicada" y estable.
4. Calcular el checksum: `shasum -a 256 releases/<os>/mini-tools-vX.Y.Z.dmg`.
5. Escribir/actualizar `releases/<os>/README.md` (usar el archivo actual
   como plantilla) con:
   - Tabla de versión: versión, nombre de archivo, tamaño, SHA-256,
     arquitectura.
   - **Compatibilidad verificada, no asumida:** arquitectura real del
     binario (`file build/bin/mini-tools.app/Contents/MacOS/mini-tools`) y
     versión mínima de macOS real — Apple Silicon (`arm64`) implica
     macOS 11+ aunque el `Info.plist` que genera Wails declara
     `LSMinimumSystemVersion = 10.13.0` (plantilla genérica heredada de
     cuando Wails también apuntaba a Intel). Aclarar explícitamente esa
     discrepancia — nunca repetir el valor del plist como si fuera la
     compatibilidad real sin esa nota.
   - Firma: no está firmado (sin Apple Developer ID ni notarización) — el
     workaround de Gatekeeper (clic derecho → Abrir / `xattr -cr` /
     Ajustes del Sistema → Privacidad y Seguridad → Abrir de todas formas).
   - Instrucciones de instalación paso a paso.
   - Sección "Regenerar este artefacto" con los comandos exactos.
6. Actualizar la sección de distribución del `README.md` raíz con la
   versión/checksum/compatibilidad actuales (resumen, no duplicar todo el
   detalle) y el link a `releases/<os>/`.
7. Confirmar que `.gitignore` excluye el binario (`releases/**/*.dmg` ya
   está agregado) — el `.dmg` no se versiona en git, solo el README con el
   checksum queda trackeado. Ver "Por qué no se versiona el binario" abajo.
8. **Nunca hacer `git add`/`commit` de esto automáticamente** — dejarlo en
   el working tree para que el usuario lo revise, salvo que pida
   explícitamente commitear.

## Por qué no se versiona el `.dmg`

Un binario empaquetado de ~15-20MB en cada tag/versión infla el
repositorio para siempre (git no lo saca del historial al borrarlo
después). La distribución real de un release es responsabilidad externa a
git (GitHub Releases, USB, red interna) — el repo solo necesita el
checksum para verificar integridad y el README para documentar qué se
publicó y cuándo.

## Multi-plataforma a futuro

Si se agrega Linux/Windows, seguir el mismo patrón: `releases/linux/`,
`releases/windows/`, cada uno con su propio README siguiendo esta misma
estructura (no un README único para todos los SOs) y su propio script de
empaquetado en `scripts/` (`package-linux.sh`, etc.) — no extender
`package-macos.sh` para cubrir otro SO.
