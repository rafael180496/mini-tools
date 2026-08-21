# mini-tools

App de escritorio tipo DataGrip para Oracle/PostgreSQL/SQLite. Go + Wails v2 + React + Tailwind. Sin Electron. Filosofía: simple, minimalista, sin feature bloat.

`README.md` (raíz) es la presentación pública del repo — no confundir con este archivo.

Este archivo es solo un índice; el contenido real vive en archivos dedicados, cada uno enfocado en una sola cosa:

| Archivo | Qué tiene |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | Spec funcional completo (intención original del proyecto) |
| [index.html](index.html) | **Vitrina pública** (GitHub Pages): qué es la app, instalación, cada módulo con ejemplos de uso y capturas. Se actualiza con el mismo cambio que agrega un módulo o una funcionalidad — ver la regla en `conventions.md` |
| [.claude/specs/architecture.md](.claude/specs/architecture.md) | Stack y estructura de carpetas **actuales** (mantenido fase a fase, con notas de desviación vs. el plan original) |
| [.claude/specs/commands.md](.claude/specs/commands.md) | Comandos de dev/build/test, wrappers de `scripts/` |
| [.claude/specs/releases.md](.claude/specs/releases.md) | Proceso de empaquetado/publicación (`releases/<os>/`) — trigger "compila la versión oficial" |
| [.claude/specs/go-react-contract.md](.claude/specs/go-react-contract.md) | Contrato completo de bindings `App` (Go↔React), fase por fase |
| [.claude/specs/vault-migrations.md](.claude/specs/vault-migrations.md) | Sistema de migraciones del vault (schema_migrations, cómo agregar una migración, verificación) |
| [.claude/specs/design-system.md](.claude/specs/design-system.md) | Sistema de diseño Material Design 3 — tokens de color, tipografía/iconos self-hosted, mapeo semántico. Leer antes de tocar cualquier estilo. |
| [.claude/specs/agentic-git-workbench.md](.claude/specs/agentic-git-workbench.md) | **Implementado, S0 a S9.** Plan segmentado para editar código en el módulo Git (CodeMirror multi-lenguaje) e integrarlo con los CLIs agénticos: skills del repo, MCP, `.md` agénticos, chat y acciones agénticas sobre Git |
| [.claude/specs/vault-notes.md](.claude/specs/vault-notes.md) | Módulo de notas: cifrado por columna, cortafuegos de privacidad (`is_private`), grafo de WikiLinks por hash de título y diseño del buscador. Leer antes de tocar `backend/vault/notes*` o `components/notes/` |
| [.claude/specs/sistema-agentico-unificado.md](.claude/specs/sistema-agentico-unificado.md) | **Fases 1-7 implementadas y verificadas** (queda el empaquetado de la 2.0.0, que es un trigger del usuario). Plan 1.4.0 → 2.0.0: chat integral único para todos los módulos, sistema `@` de contexto, IA en bases de datos y SSH/SFTP, módulo nuevo Vault Notes (grafo + bloques, cifrado), servidor MCP nativo embebido y AI Access Firewall |
| [.claude/specs/http-client.md](.claude/specs/http-client.md) | **Implementado (las nueve fases).** Plan en fases del módulo de peticiones HTTP: colecciones estilo Postman en el vault, import/export Postman v2.1 con round-trip, variables de entorno/colección, auth estándar con herencia, cuerpos con archivos, snippets de código, docs sobre Vault Notes e IA |
| [.claude/rules/technical.md](.claude/rules/technical.md) | Restricciones técnicas duras y no negociables (cgo, `database/sql`, cifrado, tamaño de binario, migraciones, etc.) |
| [.claude/rules/conventions.md](.claude/rules/conventions.md) | Convenciones de Go/frontend, testing, commits, CodeGraph, y la regla de mantener `index.html` (la vitrina de GitHub Pages) al día con cada módulo nuevo |
| [.claude/skills/mini-tools-patterns/SKILL.md](.claude/skills/mini-tools-patterns/SKILL.md) | Patrones de conectores/queries/theming — consultar antes de tocar un motor de BD, el executor, o el sistema de temas |

Antes de un cambio no trivial: leer `architecture.md` para el estado actual, `go-react-contract.md` si toca `app.go`, `vault-migrations.md` si toca el schema de `vault.db`, `design-system.md` si toca cualquier estilo/color/ícono/fuente del frontend, y el `SKILL.md` si toca conectores/executor/explain/theming — tienen las desviaciones reales vs. lo planeado y los bugs ya encontrados, para no repetirlos.
