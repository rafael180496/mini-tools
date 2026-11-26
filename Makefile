.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash
PATH := $(HOME)/go/bin:$(PATH)

# Parámetros opcionales para targets específicos:
#   make help-shot SHOT=ui-workspace
#   make uishot VIEW=workspace WIDTH=1440 HEIGHT=900
#   make changelog VERSION=2.10.8
SHOT ?=
VIEW ?= workspace
WIDTH ?= 1440
HEIGHT ?= 900
VERSION ?= $(shell cat VERSION 2>/dev/null)

.PHONY: help \
	install ensure-pnpm dev start rebuild build build-frontend build-go bindings \
	clean clean-all \
	check i18n check-bindings check-docs vet test test-vault test-mcp \
	help-shots help-shot uishot \
	bump-patch bump-minor bump-major changelog \
	package package-macos package-windows

help: ## Muestra esta ayuda con todos los comandos disponibles
	@awk 'BEGIN {FS = ":.*##"; printf "\n\033[1mmini-tools — Comandos disponibles\033[0m\n"} \
		/^### / { printf "\n\033[1;36m%s\033[0m\n", substr($$0, 5) } \
		/^[a-zA-Z0-9_-]+:.*?## / { printf "  \033[33m%-18s\033[0m %s\n", $$1, $$2 } \
		END { printf "\n" }' $(MAKEFILE_LIST)

### Desarrollo
install: ## Instala Wails CLI si falta + go mod download + pnpm install (scripts/install.sh)
	./scripts/install.sh

ensure-pnpm: ## Verifica/prepara pnpm y versión de Node (scripts/ensure-pnpm.sh)
	./scripts/ensure-pnpm.sh

dev: ## Levanta Wails dev (Go + Vite con hot reload) (scripts/start-dev.sh)
	./scripts/start-dev.sh

start: ## Abre el último binario compilado en build/bin/ (scripts/start.sh)
	./scripts/start.sh

rebuild: ## Limpia, compila producción y abre la app (scripts/rebuild.sh)
	./scripts/rebuild.sh

### Build y Bindings
build: ## Compila el binario de producción (scripts/build.sh)
	./scripts/build.sh

build-frontend: ## Compila solo el frontend (tsc && vite build)
	cd frontend && pnpm build

build-go: ## Compila todos los paquetes Go (sin CGO)
	CGO_ENABLED=0 go build ./...

bindings: ## Regenera los bindings TypeScript de Wails y los verifica
	wails generate module
	python3 scripts/check-bindings.py

### Limpieza
clean: ## Borra build/bin/, frontend/dist/ y binarios sueltos (scripts/clean.sh)
	./scripts/clean.sh

clean-all: ## Limpieza profunda: clean + node_modules + go clean -cache (scripts/clean.sh --all)
	./scripts/clean.sh --all

### Calidad y Verificación
check: build-frontend i18n check-bindings check-docs build-go vet ## Corre todas las verificaciones (frontend, i18n, bindings, docs, Go build/vet)

i18n: ## Verifica textos sin traducir en frontend y Go (scripts/i18n-check.sh)
	./scripts/i18n-check.sh

check-bindings: ## Verifica consistencia entre bindings Wails y referencias frontend (scripts/check-bindings.py)
	python3 scripts/check-bindings.py

check-docs: ## Verifica paridad exacta de IDs entre index.html y es/index.html
	@diff -u <(grep -o 'id="[^"]*"' index.html | sort) <(grep -o 'id="[^"]*"' es/index.html | sort) && echo "docs: paridad de IDs OK"

vet: ## Ejecuta go vet en todo el módulo
	go vet ./...

test: ## Corre toda la suite de tests Go
	go test ./...

test-vault: ## Corre los tests de migraciones y repositorio SQLite (backend/vault)
	go test ./backend/vault/...

test-mcp: ## Corre los tests de configuración y servidor MCP
	go test ./backend/mcpconf/... ./backend/mcpserver/...

### Capturas y Centro de Ayuda
help-shots: ## Regenera TODAS las capturas del centro de ayuda EN y ES (scripts/help-shots.sh)
	./scripts/help-shots.sh

help-shot: ## Regenera una captura puntual (ej. make help-shot SHOT=ui-workspace)
	@test -n "$(SHOT)" || (echo "Uso: make help-shot SHOT=<nombre> (ej. SHOT=ui-workspace)" && exit 1)
	./scripts/help-shots.sh "$(SHOT)"

uishot: ## Toma una captura manual del banco UI (ej. make uishot VIEW=workspace WIDTH=1440 HEIGHT=900)
	./scripts/uishot.sh "$(VIEW)" "$(WIDTH)" "$(HEIGHT)"

### Versiones y Empaquetado
bump-patch: ## Sube versión patch en VERSION (scripts/bump-version.sh patch)
	./scripts/bump-version.sh patch

bump-minor: ## Sube versión minor en VERSION (scripts/bump-version.sh minor)
	./scripts/bump-version.sh minor

bump-major: ## Sube versión major en VERSION (scripts/bump-version.sh major)
	./scripts/bump-version.sh major

changelog: ## Imprime la sección de CHANGELOG.md para VERSION (scripts/changelog-section.sh)
	./scripts/changelog-section.sh "$(VERSION)"

package: ## Empaqueta macOS (.dmg) y Windows (.exe) juntos (scripts/package-all.sh)
	./scripts/package-all.sh

package-macos: ## Empaqueta solo el .dmg de macOS (scripts/package-macos.sh)
	./scripts/package-macos.sh

package-windows: ## Cross-compila el .exe portable de Windows amd64 sin CGO (scripts/package-windows.sh)
	./scripts/package-windows.sh
