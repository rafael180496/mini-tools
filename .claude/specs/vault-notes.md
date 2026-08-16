# Vault Notes — base de conocimiento cifrada

> Estado: **implementado** (1.6.0). Núcleo cifrado, WikiLinks, backlinks,
> buscador y cortafuegos de privacidad. Los bloques `/slash`, los runbooks
> ejecutables y el grafo visual son la fase 4 del
> [plan](sistema-agentico-unificado.md).

Módulo de documentación técnica propia dentro del vault: runbooks,
procedimientos, notas de incidentes. Markdown puro, cifrado, con el grafo de
enlaces de un Obsidian y una regla de privacidad que el resto de la app no
tiene — **una nota nace invisible para los agentes**.

## Por qué está adentro del vault y no en archivos

Un runbook real tiene adentro nombres de host, rutas internas, procedimientos
de producción y, con más frecuencia de la que uno quisiera, alguna credencial.
Eso ya vive en esta app (conexiones, claves SSH) bajo una clave maestra;
tenerlo además en un `.md` suelto en el disco sería tener la misma información
con dos niveles de protección distintos, y el más débil manda.

## Cifrado

Igual que `connections.encrypted_dsn` y por el mismo motivo (regla 3 de
[technical.md](../rules/technical.md)): **por columna, no por archivo**. Cifrar
`vault.db` entero exigiría SQLCipher, que exige cgo, que rompe el cross-compile
a Windows.

| Columna | Cómo se guarda |
|---|---|
| `encrypted_title` + `title_nonce` | AES-256-GCM con la clave maestra |
| `encrypted_content` + `content_nonce` | ídem — el Markdown del cuerpo |
| `encrypted_frontmatter` + `frontmatter_nonce` | ídem — etiquetas y metadatos |
| `title_hash` | **en claro**: SHA-256 del título normalizado |
| `is_private` | **en claro**: 1 = oculta para los agentes (default) |
| `checksum_hash` | **en claro**: SHA-256 del texto plano antes de cifrar |
| `created_at` / `updated_at` | en claro |

**Tres nonces y no uno.** Reusar un nonce con la misma clave rompe GCM, y tres
columnas que se escriben en la misma operación son exactamente donde uno se
tienta de compartirlo.

**Por qué el hash del título va en claro.** Es lo que permite resolver
`[[Nota]]` y dibujar el grafo sin descifrar una sola nota: se comparan hashes.
Un hash no revela el título, y sin él cada enlace obligaría a descifrar toda la
base para encontrar su destino. Mismo criterio que el título cifrado de
`agent_chats` (migración 31), un paso más allá.

**Normalización del título** (`NormalizeTitle`): minúsculas, sin espacios en
los bordes, espacios internos colapsados. `[[Runbook  SGC]]` y `[[runbook sgc]]`
son la misma nota — un grafo que los trata como dos nodos no sirve para nada.

## Cortafuegos de privacidad (AI Access Firewall)

```
Nota nueva ──► is_private = 1  (el DEFAULT vive en el esquema, no en el código)
   │
   ├── En la app: se ve, se busca, se enlaza, entra al grafo.  ✅
   └── Para un agente (chat, @note, servidor MCP):             ⛔ BLOQUEADA
                                                                  hasta que el
                                                                  usuario la abra
```

**La única puerta es `vault.NoteForAI`.** El filtro `is_private = 0` está en la
consulta SQL, no en un `if` de Go: un `if` se puede reordenar, negar o saltear
en una refactorización; una cláusula `WHERE` no llega a leer la fila. Lo mismo
para `SearchNotesForAI`.

El error de una nota bloqueada dice **qué nota, por qué y cómo permitirlo**, y
se muestra tal cual en la ficha del compositor del chat. Un "no encontrado"
mandaría a buscar un título mal escrito que no es el problema.

**Abrir una nota es asimétrico a propósito**: cerrarla es inmediato, abrirla
pide confirmación diciendo qué va a poder leerse. Volver a esconder algo nunca
puede salir mal; mostrarlo sí.

**Guardar nunca cambia la privacidad.** `UpdateNote` no toca `is_private`; solo
lo hace `SetNotePrivacy`, que es su propia función para que pueda auditarse
leyendo una sola cosa.

## Grafo de enlaces

`vault_note_links` guarda `source_note_id → target_title_hash`. El destino es un
**hash de título** y no un id de nota por dos motivos:

1. Un enlace puede apuntar a una nota **que todavía no existe** — así es como se
   crean las notas en un grafo de conocimiento— y eso no se representa con una
   clave foránea.
2. Renombrar una nota cambia su hash, y ahí los enlaces que le apuntaban quedan
   **visiblemente rotos** en vez de apuntar en silencio a otro contenido.

Un enlace roto se dibuja distinto y ofrece crear la nota. Al borrar una nota,
sus aristas salientes se van y las **entrantes se quedan**: son enlaces rotos,
que es exactamente lo que pasó.

El extractor (`ExtractWikiLinks`) ignora lo que hay dentro de bloques de código
y de código en línea: un ejemplo que contenga `[[algo]]` no es un enlace, y
tratarlo como tal ensuciaría el grafo con nodos inventados.

## Buscador

Un `LIKE %texto%` no sirve para buscar en documentación propia — buscar es
justamente el momento en el que uno **no recuerda el título**. `SearchNotesSmart`
(`backend/vault/notesearch.go`):

- **Sin tildes ni mayúsculas**: `diagnostico` encuentra `Diagnóstico`.
- **Varios términos, todos obligatorios**, en cualquier orden.
- **Frases exactas** entre comillas.
- **Filtros**: `tag:produccion`, `enlaza:Runbook SGC`, `privado:no`.
- **Ordenado por relevancia**: el título pesa más que el cuerpo, la frase
  exacta más que los términos sueltos, varias apariciones más que una. La fecha
  desempata.
- **Devuelve el fragmento** donde acertó, marcado con `«…»` — la interfaz lo
  parte y resalta; **nunca se inyecta HTML**.

**Sin índice persistido, y no es una omisión.** Un índice de texto sobre
contenido cifrado guarda algo derivado del texto plano (tokens, hashes de
palabra) y eso es un canal lateral: con un diccionario se puede preguntar "¿esta
nota contiene tal palabra?" sin tener la clave. A escala de notas personales la
diferencia de velocidad no se percibe; el agujero sí se aprovecha.

## Estructura

```
backend/vault/notes_repo.go    CRUD + cifrado por columna + NoteForAI (el cortafuegos)
backend/vault/notelinks.go     ExtractWikiLinks + reindexado transaccional + backlinks
backend/vault/notesearch.go    buscador: plegado de acentos, ranking, fragmentos
app_notes.go                   bindings (todos con requireUnlocked)
app_refs.go                    resolvedor @note, que delega en NoteForAI

frontend/src/components/notes/
  NotesTree.tsx        módulo del sidebar: buscador + lista con fragmentos
  NoteEditorTab.tsx    pestaña de una nota: editor, privacidad, enlaces, backlinks
```

Una pestaña por nota, como el resto de la app: permite tener el runbook abierto
al lado de la consulta que se está depurando.

## Migraciones

- **34** — `vault_notes` + índices (`idx_notes_ai_access`, por fecha, por hash).
- **35** — `vault_note_links` + índices por origen y por destino.
- **36** — `settings.notes_last_open` / `notes_side_width`.

Verificadas con el patrón de script efímero en `HOME=$(mktemp -d)`, abriendo
`vault.db` con `sqlite3` para confirmar que **el título y el cuerpo son
ilegibles en disco** y que `title_hash` es un SHA-256 que no contiene el título.

## Lo que este módulo NO hace (todavía)

- **Bloques `/slash` y runbooks ejecutables** — fase 4.
- **Grafo visual** — fase 4.
- **Escribir notas desde un agente** — el MCP expone lectura. Un agente que
  escribe en la base de conocimiento cifrada necesita su propio diseño de
  confirmación y deshacer.
- **Sincronizar entre máquinas** — cifrado por columna + salt por instalación
  significa que el `vault.db` de una máquina no se descifra en otra. Es un plan
  propio, no un renglón de este.
