#!/bin/bash
# Build a distributable source package for Goku-Studio.
#
# Environment variables:
#   STUDIO_VERSION      Version string (e.g. "1.9.33")  [required]
#   PACKAGE_OUTPUT_DIR  Directory to write the tarball   [default: repo root]
#   SKIP_DB_DUMP        Set to 1 to skip mysqldump       [default: 0]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

VERSION="${STUDIO_VERSION:-}"
if [[ -z "$VERSION" ]]; then
    # Fall back to git tag
    VERSION="$(git -C "$SCRIPT_DIR" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')" || true
fi
if [[ -z "$VERSION" ]]; then
    echo "❌ STUDIO_VERSION is not set and no git tag found." >&2
    exit 1
fi

OUTPUT_DIR="${PACKAGE_OUTPUT_DIR:-$SCRIPT_DIR}"
SKIP_DB_DUMP="${SKIP_DB_DUMP:-0}"

ARCHIVE_NAME="goku-studio-v${VERSION}.tar.gz"
BUILD_DIR="$(mktemp -d)"
STAGE="$BUILD_DIR/goku-studio-v${VERSION}"

echo "📦 Building Goku-Studio v${VERSION} source package..."
echo "   Output : $OUTPUT_DIR/$ARCHIVE_NAME"
echo "   Stage  : $STAGE"

mkdir -p "$STAGE"

# ── Core directories ────────────────────────────────────────────────────────
echo "📁 Copying backend..."
cp -r "$SCRIPT_DIR/backend" "$STAGE/backend"
rm -rf "$STAGE/backend/.venv" \
       "$STAGE/backend/__pycache__" \
       "$STAGE/backend/.pytest_cache"
find "$STAGE/backend" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/backend" -name "*.pyc" -delete 2>/dev/null || true
find "$STAGE/backend" -name "*.egg-info" -type d -exec rm -rf {} + 2>/dev/null || true

echo "📁 Copying frontend..."
cp -r "$SCRIPT_DIR/frontend" "$STAGE/frontend"
rm -rf "$STAGE/frontend/node_modules" \
       "$STAGE/frontend/dist" \
       "$STAGE/frontend/.vite"

echo "📁 Copying packages..."
cp -r "$SCRIPT_DIR/packages" "$STAGE/packages"
find "$STAGE/packages" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/packages" -name "*.egg-info" -type d -exec rm -rf {} + 2>/dev/null || true

echo "📁 Copying skill_packs..."
cp -r "$SCRIPT_DIR/skill_packs" "$STAGE/skill_packs"

echo "📁 Copying mcp_servers..."
cp -r "$SCRIPT_DIR/mcp_servers" "$STAGE/mcp_servers"

# ── Root files ───────────────────────────────────────────────────────────────
for f in \
    docker-compose.yml \
    .env.example \
    start.sh \
    stop.sh \
    Makefile \
    README.md \
    STUDIO_HANDOFF.md \
    package.sh
do
    [[ -f "$SCRIPT_DIR/$f" ]] && cp "$SCRIPT_DIR/$f" "$STAGE/$f" || true
done

# ── Optional src directory ───────────────────────────────────────────────────
[[ -d "$SCRIPT_DIR/src" ]] && cp -r "$SCRIPT_DIR/src" "$STAGE/src"

# ── Strip local secrets ──────────────────────────────────────────────────────
echo "🧹 Removing local secrets and build artifacts..."
find "$STAGE" -name ".DS_Store" -delete 2>/dev/null || true
find "$STAGE" -name "*.log" -delete 2>/dev/null || true
rm -f "$STAGE/backend/.env" "$STAGE/.env"

# ── Tarball ──────────────────────────────────────────────────────────────────
echo "📦 Creating $ARCHIVE_NAME..."
mkdir -p "$OUTPUT_DIR"
tar -czf "$OUTPUT_DIR/$ARCHIVE_NAME" -C "$BUILD_DIR" "goku-studio-v${VERSION}"

# ── Cleanup ──────────────────────────────────────────────────────────────────
rm -rf "$BUILD_DIR"

echo ""
echo "✅ Package ready: $OUTPUT_DIR/$ARCHIVE_NAME"
echo "   $(du -sh "$OUTPUT_DIR/$ARCHIVE_NAME" | cut -f1)  goku-studio-v${VERSION}.tar.gz"
