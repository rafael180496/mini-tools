# Sistema de diseño — Material Design 3 (post-lanzamiento)

Reemplaza la paleta neutral (`neutral-*`/`emerald-*`/`red-*`/`amber-*` de Tailwind) que tenía toda la UI hasta esta fase. Origen: el usuario pegó un mockup HTML generado con Google Stitch (Material Design 3, tema oscuro) y pidió adoptarlo como "nuevo estándar" — no un cambio puntual de un componente, sino la base de diseño de toda la app de acá en adelante.

## Tokens de color

`frontend/src/styles/globals.css` define un `@theme` de Tailwind v4 con los roles semánticos de MD3 (`primary`, `on-primary`, `primary-container`, `on-primary-container`, y lo mismo para `secondary`/`tertiary`/`error`, más la familia `surface`/`background`/`outline`/`inverse-*`). Cada `--color-X` del `@theme` apunta a `var(--md-X)`, y `--md-X` se define dos veces — una vez en `:root` (claro) y otra en `.dark` (oscuro) — así que las utilidades de Tailwind (`bg-primary`, `text-on-surface-variant`, etc.) cambian de valor solas cuando se togglea la clase `.dark` en `<html>`, exactamente el mismo mecanismo que ya usaba `frontend/src/hooks/useTheme.ts` antes de este cambio (no se tocó ese hook).

**Los valores no son inventados.** El modo oscuro es el que trae el mockup literal (un scheme dinámico MD3 real, variante "Fidelity", spec 2021, semilla `#4a8eff`). El modo claro se derivó, no se adivinó a mano: se instaló temporalmente `@material/material-color-utilities` (Google, la misma librería que usa Material Theme Builder) en un script Node de un solo uso (no commiteado — mismo patrón que otros scripts efímeros de este proyecto), se extrajo el hue/chroma real de cada familia de color (primary/secondary/tertiary/neutral/neutral-variant) desde los swatches oscuros dados, y se regeneró el scheme COMPLETO (claro y oscuro) desde esas familias. El oscuro regenerado reprodujo los hex del mockup casi exactamente (distancia RGB promedio ~2 sobre 441 posibles, en 33 roles) — eso validó la derivación antes de confiar en su salida clara. Si en algún momento se agrega un color de marca nuevo (no solo ajustar los actuales), repetir este proceso en vez de inventar valores a mano: da un scheme internamente consistente que ningún ajuste manual por ojo puede igualar.

`surface-variant` está fijado a ser igual a `surface-container-highest` en ambos modos — así viene en los valores oscuros dados por el mockup (una simplificación que usan algunas herramientas MD3 para el rol legacy `surfaceVariant`), se mantuvo por consistencia en vez de usar el valor ligeramente distinto que da la librería.

## Mapeo semántico de color → uso

No todos los roles se usan de la misma forma que en un mockup "de referencia" — así quedó decidido para esta app, mantenerlo consistente en componentes nuevos:

- **`primary`** — identidad de marca, navegación, selección activa (conexión seleccionada en el árbol, focus rings, checkboxes).
- **`secondary`** (verde/menta) — la acción CTA principal de una pantalla: botones "Ejecutar"/"Bloque" en el toolbar, "Commit", indicadores de éxito/ok (Test Connection exitoso).
- **`tertiary`** (naranja) — estados de advertencia no destructivos: "Transacción abierta", "Cancelada", warnings de `full scan` en EXPLAIN.
- **`error`** — únicamente acciones/resultados destructivos o de fallo real: "Rollback", "Cancelar" query, mensajes de error, Test Connection fallido.
- **`surface-container-*`** (lowest→highest) — jerarquía de "elevación" de paneles: `-lowest` para fondos hundidos (editor, grillas), `-low`/DEFAULT para barras, `-high`/`-highest` para diálogos modales y menús flotantes (más "elevados" = más claros en dark, más oscuros en light).
- **`on-surface-variant`** — texto secundario/labels en toda la app (reemplaza lo que antes era `text-neutral-500`).

## Tipografía e iconos (self-hosted, sin CDN)

mini-tools es 100% offline — nunca cargar fuentes/iconos desde Google Fonts en runtime (el mockup original lo hacía vía `<link>` a `fonts.googleapis.com`, NO replicar eso). En su lugar:

- `frontend/src/assets/fonts/*.woff` — Hanken Grotesk (400/600/700/800) y JetBrains Mono (400/500), subset `latin` únicamente (cubre acentos/ñ/¿¡ del español, no cirílico/griego/vietnamita que trae Google Fonts por defecto). `frontend/src/assets/fonts/material-symbols-outlined.woff2` — el ícono variable completo.
- `globals.css` declara los `@font-face` apuntando a esos archivos locales y sobreescribe `--font-sans`/`--font-mono` del `@theme` de Tailwind (Hanken Grotesk y JetBrains Mono respectivamente) — así que `font-sans`/`font-mono`, ya usados en toda la app, quedan con las tipografías nuevas sin renombrar ninguna clase existente. Deliberadamente NO se agregó una escala de tamaños con nombres custom (`text-headline-md`, etc., como tenía el mockup) — se reutiliza la escala default de Tailwind (`text-xs`/`sm`/`base`/...) para no forzar un rename masivo sin beneficio visual real.
- `MonacoSQLEditor.tsx` fija `fontFamily: "'JetBrains Mono', ..."` explícitamente en las opciones de `monaco.editor.create` — Monaco no hereda `font-mono` de CSS.

**Iconos: usar siempre `frontend/src/components/Icon.tsx`, nunca escribir el `<span className="material-symbols-outlined">` a mano ni usar emoji/texto como ícono.** `<Icon name="close" />` — el `name` es el nombre de ligadura de Material Symbols Outlined (buscar en fonts.google.com/icons, familia "Outlined"). **Antes de usar un nombre de ícono nuevo, verificarlo** — no todos los nombres "intuitivos" existen (p.ej. `database` y `file_export` NO existen; los correctos son `storage` y `output`). Si el nombre está mal, el ícono renderiza como texto literal roto en vez de fallar — no hay error en build ni en consola.

## Radios de borde

`--radius`/`--radius-lg`/`--radius-xl` en el `@theme` quedaron en 2px/4px/8px (más cuadrado que el default de Tailwind) para el look MD3 "boxy" del mockup — así que `rounded`/`rounded-lg`/`rounded-xl` en cualquier componente ya salen con el tamaño correcto sin cambiar la clase usada. `rounded-full` se dejó intacto (círculo/pill real) — el mockup redefinía "full" como 0.75rem, pero eso hubiera roto los usos existentes de `rounded-full` para elementos circulares (avatar, indicadores).

## Qué NO se migró

- El plan original de theming (`.claude/rules/conventions.md`, sección Frontend) sigue vigente: el toggle de tema se mantiene (no se fue dark-only, decisión explícita del usuario), sigue viviendo en `useTheme.ts`, sigue persistiendo en `settings.theme` sin cifrar.
- Ningún componente pasó a cargar nada por red en runtime — todo el sistema de diseño (fuentes, iconos, colores) es estático, empaquetado en el bundle, funciona sin internet igual que el resto de la app.
