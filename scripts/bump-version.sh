#!/usr/bin/env bash
# Bumpea VERSION (patch/minor/major, semver). No toca git (ni commit ni tag) —
# eso lo maneja el usuario.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PART="${1:-}"
if [[ "$PART" != "patch" && "$PART" != "minor" && "$PART" != "major" ]]; then
  echo "Uso: $0 patch|minor|major"
  exit 1
fi

OLD_VERSION="$(cat VERSION)"
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"

case "$PART" in
  patch)
    PATCH=$((PATCH + 1))
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "$NEW_VERSION" > VERSION

echo "==> $OLD_VERSION → $NEW_VERSION"
