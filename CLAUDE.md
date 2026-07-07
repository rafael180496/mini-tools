# mini-tools

App de escritorio tipo DataGrip para Oracle/PostgreSQL/SQLite. Go + Wails v2 + React + Tailwind. Sin Electron. Filosofía: simple, minimalista, sin feature bloat.

`README.md` (raíz) es la presentación pública del repo — no confundir con este archivo.

Este archivo es solo un índice; el contenido real vive en archivos dedicados, cada uno enfocado en una sola cosa:

| Archivo | Qué tiene |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | Spec funcional completo (intención original del proyecto) |
| [.claude/specs/architecture.md](.claude/specs/architecture.md) | Stack y estructura de carpetas **actuales** (mantenido fase a fase, con notas de desviación vs. el plan original) |
| [.claude/specs/commands.md](.claude/specs/commands.md) | Comandos de dev/build/test, wrappers de `scripts/` |
| [.claude/specs/go-react-contract.md](.claude/specs/go-react-contract.md) | Contrato completo de bindings `App` (Go↔React), fase por fase |
| [.claude/rules/technical.md](.claude/rules/technical.md) | Restricciones técnicas duras y no negociables (cgo, `database/sql`, cifrado, tamaño de binario, etc.) |
| [.claude/rules/conventions.md](.claude/rules/conventions.md) | Convenciones de Go/frontend, testing, commits, CodeGraph |
| [.claude/skills/mini-tools-patterns/SKILL.md](.claude/skills/mini-tools-patterns/SKILL.md) | Patrones de conectores/queries/theming — consultar antes de tocar un motor de BD, el executor, o el sistema de temas |

Antes de un cambio no trivial: leer `architecture.md` para el estado actual, `go-react-contract.md` si toca `app.go`, y el `SKILL.md` si toca conectores/executor/explain/theming — tienen las desviaciones reales vs. lo planeado y los bugs ya encontrados, para no repetirlos.
