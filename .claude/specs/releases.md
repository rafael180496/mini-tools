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
   `releases/<os>/` es la copia "publicada" y estable, y **sí se versiona
   en git** (ver "Por qué el `.dmg` se versiona en git" abajo) — no
   agregar `releases/**/*.dmg` (ni ningún patrón equivalente) a
   `.gitignore`.
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
   detalle) y un link directo al archivo `.dmg` dentro de
   `releases/<os>/` (no solo a la carpeta) — así el link del README
   descarga el binario directo desde GitHub.
7. El `.dmg` **sí se versiona en git** — no agregar `releases/**/*.dmg` (ni
   patrón equivalente) a `.gitignore`. Ver "Por qué el `.dmg` se versiona
   en git" abajo para el porqué de esta decisión.
8. **`git add`/`commit` de los archivos de `releases/<os>/` y las docs
   tocadas es parte normal del proceso — pero el `push` a un remoto sigue
   la misma regla general de este repo que cualquier otro cambio: se
   confirma con el usuario antes de pushear, no se asume autorización
   permanente por haberlo pedido una vez.** Si el usuario ya dijo
   explícitamente "subilo"/"pushealo" en la conversación en curso, no hace
   falta volver a preguntar en ese mismo turno.

## Por qué el `.dmg` sí se versiona en git

Decisión explícita del usuario (corrigiendo un intento anterior de este
mismo proceso que lo excluía vía `.gitignore` con el argumento de "no
inflar el repo con binarios"): el `.dmg` tiene que estar disponible
directamente desde un link del repo en GitHub, sin depender de un flujo
aparte (GitHub Releases, USB, etc.). El repo acepta el costo de que cada
versión empaquetada sume ~15-20MB permanentes al historial de git a
cambio de que "bajar la última versión" sea un solo link del README. Si
el tamaño del repo se vuelve un problema real más adelante, la
alternativa a evaluar es Git LFS para `releases/**/*.dmg` — no volver a
excluirlo silenciosamente vía `.gitignore` sin discutirlo primero con el
usuario.

## Multi-plataforma a futuro

Si se agrega Linux/Windows, seguir el mismo patrón: `releases/linux/`,
`releases/windows/`, cada uno con su propio README siguiendo esta misma
estructura (no un README único para todos los SOs) y su propio script de
empaquetado en `scripts/` (`package-linux.sh`, etc.) — no extender
`package-macos.sh` para cubrir otro SO.
