#!/bin/bash
# goku-studio startup — launches both the Studio backend (:8107) and frontend (:5107).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Load .env if exists
if [ -f "$DIR/.env" ]; then
  set -a
  . "$DIR/.env"
  set +a
fi

# Also load backend/.env for VITE_* port vars
if [ -f "$DIR/backend/.env" ]; then
  set -a
  . "$DIR/backend/.env"
  set +a
fi

# Activate venv if present
if [ -d ".venv" ]; then
  source .venv/bin/activate
elif [ -d "backend/.venv" ]; then
  source backend/.venv/bin/activate
fi

BACKEND_PORT="${VITE_STUDIO_BACKEND_PORT:-${PORT:-8107}}"
FRONTEND_PORT="${VITE_STUDIO_PORT:-5107}"

echo "=== goku-studio: applying migrations ==="
cd "$DIR/backend"
alembic -c alembic/studio/alembic.ini upgrade head

echo "=== goku-studio: starting API on :${BACKEND_PORT} ==="
uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "$BACKEND_PORT" \
  --reload &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID"

echo "=== goku-studio: installing frontend dependencies ==="
cd "$DIR/frontend"
if [ ! -d "node_modules" ]; then
  npm install
fi

echo "=== goku-studio: starting frontend on :${FRONTEND_PORT} ==="
npm run dev &
FRONTEND_PID=$!
echo "Frontend PID: $FRONTEND_PID"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Goku Studio running                         ║"
echo "║  Backend  → http://localhost:${BACKEND_PORT}           ║"
echo "║  Frontend → http://localhost:${FRONTEND_PORT}           ║"
echo "╚══════════════════════════════════════════════╝"

# Wait for either process to exit and kill both on Ctrl-C
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait $BACKEND_PID $FRONTEND_PID
