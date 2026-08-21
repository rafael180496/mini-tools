# Plan — Módulo de peticiones HTTP (colecciones estilo Postman)

> **Estado: las nueve fases implementadas.** Plan segmentado en fases; cada
> fase es publicable por sí sola y ninguna depende de que la siguiente exista.
> Referencia visual: capturas de Postman aportadas por el usuario (árbol de
> colecciones, editor de request con Params/Auth/Headers/Body/Scripts/Settings,
> variables de colección y entornos, snippets de código, settings por request).

## Qué se pide

Quinto módulo del workspace: un cliente HTTP con **colecciones persistidas en
el vault**, import/export **compatible con Postman** (formato JSON v2.1) para
traer las colecciones existentes del usuario, variables de **entorno** y de
**colección**, **auth estándar HTTP** con herencia, cuerpos **JSON/XML con
formato**, endpoints **de tipo archivo** (subida binaria/form-data y descarga),
**export a cURL y snippets de código** en varios lenguajes, **documentación**
por request/colección compatible con las notas del vault, y **ayuda con IA**
sobre requests y respuestas.

## Hallazgos previos (lo que ya existe y se reutiliza)

La mitad del módulo no es construcción nueva. Verificado contra el código:

1. **Vault con migraciones y cifrado por columna.** `backend/vault` va por la
   migración 44; agregar tablas es una migración más (regla dura:
   [vault-migrations.md](vault-migrations.md), nunca recrear la base). El
   cifrado AES-256-GCM por columna que ya usan `connections.encrypted_dsn` y
   los tokens de Git es exactamente lo que necesitan los secretos de auth y
   las variables marcadas secretas. El backup del vault incluye las tablas
   nuevas sin trabajo extra.
2. **El editor CodeMirror ya trae `lang-json` y `lang-xml`** (registro por
   lenguaje en `codemirror/languageRegistry.ts`, con import dinámico por
   chunk). El cuerpo raw y el visor de respuesta son instancias más del mismo
   editor, con el mismo sistema de temas y apariencia.
3. **El sistema agéntico unificado está construido** (fases 1-7 de
   [sistema-agentico-unificado.md](sistema-agentico-unificado.md)):
   `WorkContext` (`components/agent/workContext.ts`) hoy admite
   `'git' | 'db' | 'ssh' | 'note' | 'none'` — agregar `'http'` es el mismo
   cableado que hizo Git. `agentchat.Manager.Ask` es el one-shot para acciones
   sin chat ("explicá esta respuesta").
4. **Vault Notes** tiene notas Markdown cifradas con `[[WikiLinks]]`,
   frontmatter de procedencia y visor — la documentación de una colección
   puede *exportarse como notas* en vez de inventar un segundo sistema de
   documentos.
5. **Patrones de UI ya resueltos**: quinto ícono en
   `SidebarMasterMenu.tsx` (`SidebarModuleId`), pestañas restaurables con tipo
   escrito (`EditorTabs.tsx`, nuevo `TabKind`), árbol con carpetas y buscador
   único de los módulos, diálogos MD3, `title` obligatorio en todo control.
6. **Reglas duras que condicionan el diseño** (`.claude/rules/technical.md`):
   sin CGO, dependencias mínimas, binario ≤80MB, nunca loguear secretos, todo
   binding gateado por `requireUnlocked`.

## Decisiones técnicas (tomadas acá, no en cada fase)

### Motor HTTP: `net/http` puro; UNA dependencia nueva en todo el plan

El motor HTTP no suma dependencias; la única de todo el plan es goja
(scripts, F5), con su costo medido como criterio de cierre de esa fase.

Todo lo de la captura de Settings se cubre con la librería estándar:
`Transport.TLSClientConfig.InsecureSkipVerify` (verificación SSL off),
`CheckRedirect` (seguir/no seguir, conservar método, conservar header
Authorization entre hosts, quitar referer), `ForceAttemptHTTP2` y
`TLSNextProto` (versión HTTP), timeouts por request, proxy del sistema
(`http.ProxyFromEnvironment`). La respuesta se lee en streaming con tope
configurable; pasado el tope se vuelca a archivo temporal y la UI ofrece
"guardar como" en vez de intentar renderizar 200 MB en el webview.

### Formato Postman v2.1 con preservación round-trip

El import mapea lo soportado al modelo propio **y guarda el JSON original de
cada ítem no mapeado** (raw, cifrado como todo lo demás). El export
reconstruye desde el modelo y reinyecta lo preservado. Consecuencia: importar
una colección con scripts o un auth exótico y volverla a exportar **no pierde
nada**, aunque esta app no ejecute esa parte. Es la única forma honesta de
prometer "compatible con mis colecciones".

### Matriz de auth

Con herencia `request → carpeta → colección` ("Inherit auth from parent" es
el default, como en la captura).

| Nativos (se ejecutan) | Solo import/export (se preservan, no se ejecutan) |
|---|---|
| No Auth, Basic, Bearer, API Key (header/query), JWT Bearer (HS256/384/512), OAuth 2.0 (client credentials + refresh token + password; **authorization code al estándar de apps nativas — RFC 8252**: browser del sistema + captura del redirect en un puerto efímero de `127.0.0.1` + **PKCE S256** siempre — decisión del usuario, igual que Postman), Digest (RFC 7616), AWS Signature v4 (implementación propia, ~200 líneas, sin SDK) | OAuth 1.0, Hawk, NTLM, Akamai EdgeGrid, ASAP (Atlassian) |

Los "solo preservar" muestran en la UI un aviso honesto: "importado de
Postman; esta app todavía no lo ejecuta". Promoverlos después es agregar un
ejecutor, no tocar el modelo.

### Scripts (pre-request / tests): fase REAL, motor JS en Go (goja)

**Decisión del usuario (2026-08-20): parte de sus colecciones deriva tokens
en pre-request scripts, y el backend tiene que ser siempre Go.** Eso invierte
la propuesta original (Web Worker en el frontend) y sube la fase de
prioridad: sin scripts, esas colecciones importan pero no sirven. La muestra
real aportada (`chatwoot`) confirma que también hay scripts de **test** en
uso.

El motor es **goja** — intérprete JavaScript ES5.1+ en Go puro, sin CGO, la
única dependencia nueva de todo el plan. Costo estimado: +4-6 MB de binario
sobre los ~51 actuales, cómodo bajo el techo de 80 (`technical.md` punto 8);
se mide al cerrar la fase y se anota el número real. Qué se gana por correr
en Go y no en el webview:

- El script corre **dentro del pipeline de `HttpSend`**: sin ping-pong
  frontend↔backend por request, y el runner de colección queda 100% en Go.
- Las **variables secretas nunca cruzan al webview**: `pm.environment.get`
  se resuelve dentro del proceso Go; a la UI llega el request armado con los
  secretos enmascarados.
- Sandbox real: sin `require`, sin filesystem, red solo vía `pm.sendRequest`
  (mismo motor HTTP, mismos topes), timeout duro por script.

Subset `pm.*` inicial: `pm.environment.get/set`,
`pm.collectionVariables.get/set`, `pm.variables.get`, `pm.request` (mutable
en pre-request), `pm.response` (`status`, `headers`, `json()`, `text()` en
tests), `pm.test` + `pm.expect` mínimo, `pm.sendRequest`, `btoa/atob`, y un
subset de `CryptoJS` (HMAC-SHA1/256/512, MD5, SHA256, base64) implementado
en Go y expuesto al intérprete — lo que usan casi todos los scripts de firma
reales. Una API no soportada falla nombrándola, nunca en silencio; el script
original siempre se preserva (round-trip).

### Variables

`{{var}}` con precedencia **request → carpeta → entorno activo → colección →
globales** — el orden de Postman (Local > Environment > Collection > Global),
**corregido durante la F2**: este documento decía antes "colección → entorno
activo", que es al revés y rompía el sentido mismo de un entorno. Una
colección define el `HOST` por defecto y `dev`/`prod` lo pisan; con la
colección ganando, cambiar de entorno no habría hecho nada y una colección
importada se habría comportado distinto que en Postman — justo lo que este
módulo promete que no pasa. Más **path variables** (`:id` en la URL, tabla propia como en la
captura). Resolución en Go en el momento de enviar — lo guardado nunca es el
valor resuelto. Variables marcadas **secretas**: cifradas en el vault,
enmascaradas en UI, y **excluidas del export** (Postman exporta los secrets
vacíos; se imita eso, no se inventa una fuga). Entorno **anclable por
colección** (pin de la captura). Sin resolver → resaltado en rojo en la barra
de URL, como hace Postman.

### Generación de código

Desde el request ya resuelto (menos secretos enmascarados, a elección), con
plantillas propias en Go: cURL, HTTP crudo, Go (net/http), JavaScript
(fetch), Python (requests), Java (OkHttp), C# (HttpClient), PHP (curl),
Dart (http), Ruby, PowerShell. Import inverso: **pegar un cURL** crea un
request (parser propio de las flags comunes: -X, -H, -d/--data-*, -F, -u,
--url, -k, -L).

### Documentación compatible con Vault Notes

Cada request y cada colección tienen pestaña **Docs** (Markdown, mismo editor
y visor de las notas). Dos salidas: **export de la doc de la colección
completa** a una nota del vault (o árbol de notas, una por carpeta) con
frontmatter de procedencia (`origen: http-docs`, id de colección) y
`[[enlaces]]` entre requests — y desde ahí todo lo que las notas ya saben
hacer (grafo, búsqueda, cifrado, export a Obsidian). No se inventa un
renderer nuevo ni un formato nuevo.

### IA

`WorkContextKind` gana `'http'`. Acciones concretas, mismo patrón que Git:
**explicar esta respuesta** (status, headers, cuerpo truncado), **diagnosticar
este error** (timeout, TLS, DNS — con los settings del request como contexto),
**generar un request desde una descripción o un cURL pegado**, **redactar la
doc** de un request desde su definición y su última respuesta, **generar
tests** (cuando exista la fase de scripts). El contexto que se le pasa al
agente **nunca incluye valores de variables secretas ni headers de auth** —
misma regla que el filtro de secretos del historial SSH.

## Modelo de datos (migraciones 45+)

```
http_collections   id, name, description, variables (json cifrado),
                   auth (json cifrado), postman_raw (cifrado, round-trip),
                   sort_order, timestamps
http_items         id, collection_id, parent_id NULL (carpeta o raíz),
                   kind ('folder'|'request'), name, sort_order,
                   method, url, params/headers/path_vars (json),
                   body (json cifrado — puede traer rutas de archivo),
                   auth (json cifrado, NULL = heredar),
                   settings (json), docs_md (cifrado),
                   postman_raw (cifrado), timestamps
http_environments  id, name, variables (json cifrado; cada var: key, value,
                   secret bool, enabled), pinned_collection_id NULL
http_history       id, item_id NULL (request suelto también), method, url
                   RESUELTA sin secretos, status, duration_ms, size_bytes,
                   response_headers (json), response_path NULL (cuerpo grande
                   en disco), executed_at   — con tope de filas por request y
                   el mismo interruptor de historial que SSH
```

Sin tabla de carpetas aparte: `parent_id` + `kind` da el árbol con un solo
join, igual que hace Postman en su propio formato.

## Bindings Go↔React (superficie completa, se reparte por fases)

CRUD: `HttpListCollections/Save/Delete`, `HttpListItems/SaveItem/DeleteItem/
MoveItem`, `HttpListEnvironments/SaveEnvironment/DeleteEnvironment`,
`HttpSetActiveEnvironment`. Ejecución: `HttpSend(itemId | requestInline,
envId) → respuesta tipada` (+ evento de progreso para cuerpos grandes),
`HttpCancel(execId)`, `HttpHistory/ClearHistory`, `HttpSaveResponseToFile`.
Formato: `HttpFormatBody(kind, text)` (JSON/XML pretty, en Go — sonic +
encoding/xml). Interop: `HttpImportPostman(json) → resumen`,
`HttpExportPostman(collectionId) → json`, `HttpImportCurl(text)`,
`HttpGenerateCode(itemId, lang, conSecretos bool)`. Docs:
`HttpExportDocsToNotes(collectionId)`. Cookies:
`HttpListCookies(envId)` / `HttpClearCookies(envId, domain)`. Los scripts no
tienen binding propio: corren adentro de `HttpSend` (pre-request antes de
armar la petición, tests después de la respuesta) y el resultado tipado de
los tests viaja en la misma respuesta. Todos detrás de `requireUnlocked`.

## Fases

### F1 — Núcleo publicable: colecciones + enviar + respuesta
Migraciones 45+, modelo, CRUD, quinto módulo en el sidebar con árbol
(colecciones → carpetas → requests, drag para reordenar), `TabKind` nuevo
`http-request`, editor de request mínimo (método, URL,
Params con query + **path variables**, Headers con los auto-generados
ocultables — el "6 hidden" de la captura—, Body raw con selector
JSON/XML/texto y **botón de formato**), visor de respuesta (status, tiempo,
tamaño, headers, cuerpo con highlight, pretty/raw), historial por request,
cancelación. Settings por request (SSL, redirects y variantes, versión HTTP,
timeout) — entran acá porque el motor se escribe una sola vez.
**[BE][FE][DB]**

> **Corrección durante la implementación:** el plan decía "pestañas
> restaurables". No se hizo, y a propósito: las pestañas de Git y de notas
> **tampoco** se restauran al reabrir la app (solo se persisten las de editor
> con archivo y las de Redis — ver el filtro de `SetOpenTabs` en
> `Workspace.tsx`). Hacer que una petición HTTP fuera la única pestaña de su
> clase en volver sola sería inconsistente, y exigiría además ampliar
> `OpenTabInfo` con un id de ítem, o sea otra migración del vault. Se
> reabren desde el árbol, igual que un repositorio o una nota.

### F2 — Variables y entornos
Tabla de entornos + selector con pin por colección, variables de colección,
resolución con precedencia, secretas cifradas y enmascaradas, resaltado de
`{{var}}` resuelta/sin resolver en la barra de URL y en headers/body.
**[BE][FE][DB]**

### F3 — Cuerpos completos y archivos
form-data (campos + **archivos**, multipart real en streaming),
x-www-form-urlencoded, binary (archivo como cuerpo), GraphQL (query +
variables). Respuesta tipo archivo: detección por Content-Type/Disposition,
preview de imagen/PDF donde el webview pueda, "guardar como", tope de
render con volcado a disco. **[BE][FE]**

### F4 — Auth estándar con herencia
La matriz de arriba: cadena de herencia, los ocho nativos, almacenamiento
cifrado, aviso honesto en los preservados. OAuth2 con cache de token por
entorno y refresh automático. **[BE][FE]**

### F5 — Scripts

> **MEDICIÓN REAL (2026-08-21) — la estimación de este plan estaba mal por
> un factor de cuatro, y activa el criterio de corte que el propio plan
> fijó.** Se midió con `go build -ldflags="-s -w"` sobre el binario real:
>
> | | binario | delta |
> |---|---|---|
> | sin motor JS | 37,6 MB | — |
> | **con goja** | 57,4 MB | **+19,8 MB** |
> | **con otto** | 52,7 MB | **+15,1 MB** |
>
> El plan estimaba +4-6 MB y decía "si supera +8 MB, se revisa la decisión
> antes de seguir". Referencia dura: el artefacto **Windows publicado de la
> 2.2.0 pesa 55,66 MB**, y el techo de 80 MB de `technical.md` punto 8
> aplica **al mayor de las dos plataformas**. Con goja quedaría en ~75 MB
> (≈4,5 MB de aire); con otto en ~71 MB (≈9 MB).
>
> **Primera mitad de la fase, ya hecha y sin costo de binario:** los scripts
> se **guardan cifrados y se preservan** (migración 47, `pre_request` y
> `test_script` en ítems y colecciones) y se ven/editan en la pestaña
> Scripts, que dice claramente que todavía no se ejecutan. F6 puede importar
> y re-exportar colecciones con scripts sin perder nada, que era la razón
> por la que esta fase iba antes del import.
>
> **Decisión del usuario (2026-08-21): NO entra ningún motor JS.** En vez de
> ejecutar JavaScript, la segunda mitad de la fase entrega **variables
> calculadas declarativas** en Go: un formulario donde se configura la
> derivación (HMAC-SHA256 sobre `{{$timestamp}}` con `{{secreto}}`, base64,
> hash simple…) y el resultado queda como una variable que el resto de la
> petición usa con `{{sig}}`. Costo de binario: **0 MB**.
>
> Lo que se gana: cubre el caso real —derivar un token para firmar— sin
> tocar el techo, sin sandbox que auditar y con los secretos siempre del
> lado de Go. Lo que se pierde, dicho sin vueltas: **los scripts existentes
> no corren**; hay que traducir a mano cada uno a su equivalente
> declarativo. Los que no se puedan expresar así siguen guardados y se
> exportan intactos, con el aviso de que no se ejecutan.

### F5 — Variables calculadas (declarativas, sin motor JS)
Promovida de opcional a fase real por decisión del usuario. Entra **antes
que el import de Postman** a propósito: importar colecciones cuyos scripts
todavía no corren invita a concluir que el import está roto. goja + sandbox
+ subset `pm.*` + cripto de firma (ver la decisión de arriba). Pestaña
Scripts en el editor con el resultado visible del pre-request (qué variables
tocó, qué headers agregó) y de los tests por request. **[BE][FE]**

### F6 — Interop: Postman, cURL, snippets
Import/export Postman v2.1 con preservación round-trip, import de cURL
pegado, panel "Code snippet" con los lenguajes listados. Fixture de
aceptación: la colección real `chatwoot` del usuario
(`~/Downloads/chatwoot.postman_collection.json`, schema v2.1.0 verificado:
23 requests planos, GET/POST/PUT/PATCH, bodies raw, scripts de test, una
variable de colección y `{{vars}}` en URL) más `reservev3`, `ConfigApi`,
`localrestv2` y `agent_socket` exportadas de su Postman. **El fixture vive
FUERA del repo y no se commitea**: las capturas muestran JWTs reales en los
headers de esas colecciones, y una colección exportada es exactamente el
tipo de archivo que filtra secretos. La verificación importa → re-exporta →
compara sin pérdida, con los secretos excluidos del export como hace
Postman. **[BE][FE]**

### F7 — Docs sobre Vault Notes — HECHA
Pestaña Docs por request/colección, export a notas con procedencia y
enlaces, regeneración que respeta la regla de las notas (lo editado por el
usuario no se pisa — mismo contrato que las notas del agente MCP). **[BE][FE]**

Cómo quedó:

- `backend/httpclient/docs.go` genera el Markdown de la colección entera
  (índice por carpeta, una sección por petición, variables, autenticación).
  Es una función pura: no lee el vault ni resuelve variables.
- **Ninguna credencial sale en la nota.** De la autenticación se documenta su
  forma —tipo, usuario, dónde viaja el token, URL de token, ámbito—, nunca su
  valor; las variables secretas salen listadas y sin valor; y el documento
  entero pasa por `MaskSecrets` como último paso, para tapar también un
  secreto escrito a mano dentro de una URL o de un cuerpo. Una nota la puede
  leer el agente: el filtro va al final, no repartido por campo.
- Los `{{marcadores}}` se dejan **sin resolver** a propósito, al revés que en
  el envío: documentan la forma de la petición, y resolverlos incrustaría el
  valor del entorno activo.
- La nota se vincula por id (`http_collections.docs_note_id`, migración 49),
  no por título: así el usuario puede renombrarla sin que la regeneración
  cree una segunda.
- La regla de procedencia se generalizó (`vault.GeneratorCanEdit` +
  `HTTPDocsOriginMark`). Marca propia y distinta de la del agente MCP: que el
  usuario haya editado la documentación de una colección no habilita al
  agente a reescribir esa nota, ni al revés.
- Un `[[enlace]]` escrito en la pestaña Docs de una petición llega a la nota
  tal cual, así que se convierte en una arista real del grafo al publicar.
- **Tapado de credenciales sin declarar** (`redactCredentials`, docs.go). Lo
  pidió la colección real: las descripciones que Postman genera al importar de
  cURL traen la cookie de sesión y el `access-token` enteros, y `MaskSecrets`
  no las alcanza porque nunca fueron variables. Se tapa el VALOR y se conserva
  el NOMBRE en: cabeceras de credencial (`Authorization`, `Cookie`,
  `access-token`, `client`, `uid`, …), banderas `-b`/`-u` de cURL, campos JSON
  con `password`/`secret`/`token`/`api_key`/`signature` en el nombre, y esos
  mismos nombres en la query de una URL. Es line-based **con estado**: una
  cookie del navegador ocupa varias líneas, y el cierre del valor se busca
  salteando las comillas escapadas del `$'…'` de bash. Tope de 50 líneas
  tragadas, para que una detección equivocada no se coma el documento.
- Topes de tamaño (300 caracteres por celda, 4000 por cuerpo). La misma
  colección pasó de 184.000 a 57.000 caracteres: lo que sobraba eran las
  descripciones de manual que Postman le pone a cada cabecera. El texto entero
  sigue en la colección; la nota es un resumen navegable.

### F8 — IA — HECHA
`'http'` en WorkContext, historial agrupado, las cinco acciones, filtro de
secretos en el contexto. **[FE][BE]**

Cómo quedó:

- Cinco acciones en el menú de la petición, todas de **un turno** con
  `AgentAsk`: explicar la respuesta, diagnosticar el fallo, escribir la
  petición desde una descripción, redactar la documentación y escribir los
  tests. Ninguna manda nada ni escribe nada: devuelven texto y aplicarlo es un
  clic. Las dos primeras quedan deshabilitadas hasta que haya respuesta, en vez
  de dejar que el agente conteste sobre la nada.
- **«Escribir la petición» devuelve un comando cURL**, no un formato propio: es
  lo que todo modelo escribe bien, lo que el usuario puede verificar de un
  vistazo, y lo que esta app ya sabe importar (`ParseCurl`). Un formato propio
  sería otro parser que mantener y una cosa más que el modelo puede equivocar.
  Al probarlo apareció un bug real: `looksLikeURL` no reconocía
  `{{baseUrl}}/pedidos` —sin esquema y sin punto—, así que el comando que el
  propio prompt pide era el único que no se podía importar.
- **«Escribir los tests» los pide en el dialecto de Postman** y el prompt dice
  que esta app no los ejecuta: se guardan, viajan en el export y los corre
  Postman o newman. Es la consecuencia honesta de haber descartado el motor de
  JavaScript en F5; pedirlos en un dialecto que acá nadie corre sería una
  promesa falsa.
- **Filtro de secretos: tres capas y una sola salida.** Los `{{marcadores}}` van
  sin resolver, las cabeceras de credencial se tapan por nombre, y el contexto
  entero pasa al final por `MaskSecrets` + `RedactCredentials`
  (`redactExchange`). De la autenticación viaja el TIPO y nada más. El armado
  vive en `app_httpagent.go` y no en `agentctx` a propósito: es el único lado
  con acceso al vault, así que es el único que puede tapar — si el filtrado
  viviera en el que arma el texto, agregar un campo sería una forma silenciosa
  de filtrarlo.
- Cada prompt **aclara que lo tapado existe**. Sin esa línea, un agente que ve
  `Authorization: «oculto»` concluye que la petición sale sin autenticar y
  diagnostica el problema equivocado.
- Una petición rápida tiene `id` vacío, así que todas comparten una
  conversación: no son "sobre" nada guardado.

### F9 — Runner, cookies y cierre — HECHA
Runner de colección (botón "Run": una colección o carpeta en orden, con
entorno elegido y resumen pasa/falla), **cookie jar por ENTORNO** (decisión del
usuario: probar prod y dev a la vez no puede mezclar sesiones;
`net/http/cookiejar`, uno por entorno, visible y borrable por dominio; sin
entorno activo, jar propio de "No environment"), export de una respuesta como
ejemplo en la doc. **[BE][FE]**

Cómo quedó:

- **Corrida secuencial, nunca en paralelo.** Una colección de pruebas casi
  siempre es una secuencia (login → lo que usa la sesión → lo que usa el id que
  devolvió la anterior); en paralelo eso se rompe y además dispara N sesiones
  simultáneas contra el servidor de alguien. Con pausa opcional entre
  peticiones, porque treinta seguidas sin respirar es lo que corta un WAF.
- **Cada petición se manda por el MISMO camino que el botón Enviar**
  (`HttpSend`): variables, autenticación heredada, variables calculadas,
  cookies del entorno e historial. Un segundo camino de envío terminaría
  comportándose distinto, y entonces el informe dejaría de decir algo sobre lo
  que pasa al mandarla a mano.
- **`pm.test` NO se evalúa, y la interfaz lo dice.** Se prometía en el plan
  original suponiendo que F5 traería un motor de JavaScript, que el usuario
  descartó. «Pasó» significa entonces lo único verificable: salió y contestó
  menos de 400. Un resumen «3 tests pasaron» calculado sobre scripts que nadie
  ejecutó sería una mentira con formato de informe.
- **Cortar marca lo que queda como SALTEADO, no como fallido** — no es lo
  mismo—, y solo entre peticiones: la que está en vuelo ya salió, y cancelarla
  del lado del cliente no la deshace del lado del servidor.
- **Un tarro de cookies por entorno** (`httpclient/jar.go`), en memoria. El
  tarro va en el `http.Client`, no en las cabeceras, así que `net/http` aplica
  las reglas de dominio, path y caducidad, y guarda también lo que llega por
  una redirección. Se listan y se borran por dominio; borrar uno no toca los
  demás. `net/http/cookiejar` no se puede enumerar, así que se recuerdan los
  hosts con los que se habló y se le pregunta por cada uno — la alternativa era
  reimplementar las reglas de cookies, que es exactamente donde uno se
  equivoca.
- **El ejemplo se agrega a la documentación, no la reemplaza**: una petición
  útil tiene el caso que funciona y el 422 que explica qué valida el servidor.
  Pasa por el mismo filtro de secretos que todo lo que sale del vault.
- El progreso viaja por el evento `http:run`. La corrida de verdad vive en
  `runCollection`, con el emisor inyectado: `runtime.EventsEmit` exige el
  contexto del ciclo de vida de Wails, así que una corrida que emita directo
  solo se puede probar con la ventana abierta — que es como no poder probarla.

## Decisiones resueltas (respuestas del usuario, 2026-08-20)

1. **Scripts: SÍ, y suben de prioridad** — parte de las colecciones deriva
   tokens en pre-request; el resto usa variables fijas. Y "siempre Golang
   como backend" cambió el motor de Web Worker (frontend) a **goja** (Go
   puro). Nueva F5, antes del import.
2. **OAuth2 authorization-code: al estándar** — RFC 8252: browser del
   sistema + redirect capturado en `127.0.0.1:<puerto efímero>` + PKCE S256,
   como Postman.
3. **Cookies: jar por ENTORNO**, en Go (`net/http/cookiejar`), para no
   mezclar sesiones de prod y dev.

## Verificación por fase

Regla del repo: sin tests nuevos. Cada fase cierra con `go build ./...`,
`go vet ./...`, `pnpm tsc --noEmit`, `wails dev` con flujo manual documentado
en la fase, `codegraph sync`, migración verificada contra un vault real
existente (nunca recreado), y entrada en `CHANGELOG.md` bajo `[Unreleased]`.
F6 además se verifica con el round-trip de las colecciones reales (empezando
por `chatwoot`, ver la fase) sin pérdida de ítems. F5 cierra midiendo el
tamaño real del binario con goja adentro y anotándolo acá — si supera +8 MB,
se revisa la decisión antes de seguir.
