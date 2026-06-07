#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Read ports from backend/.env ─────────────────────────────────────────────
BACKEND_PORT=$(grep 'VITE_STUDIO_BACKEND_PORT' "$DIR/backend/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
FRONTEND_PORT=$(grep 'VITE_STUDIO_PORT' "$DIR/backend/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
BACKEND_PORT="${BACKEND_PORT:-8107}"
FRONTEND_PORT="${FRONTEND_PORT:-5107}"

# ── Frontend: install deps if needed, then start ─────────────────────────────
cd "$DIR/frontend"
if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
fi

echo "Starting Studio frontend on port $FRONTEND_PORT..."
npm run dev > "$DIR/frontend.log" 2>&1 &
echo $! > "$DIR/frontend.pid"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Goku Studio:  frontend :$FRONTEND_PORT                              ║"
echo "║  (Studio uses goku-core backend at :8107 via shared DB)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
