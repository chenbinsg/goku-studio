#!/bin/bash
# goku-studio standalone startup script
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Load .env if exists
if [ -f "$DIR/.env" ]; then
  set -a
  . "$DIR/.env"
  set +a
fi

# Activate venv if present
if [ -d ".venv" ]; then
  source .venv/bin/activate
elif [ -d "backend/.venv" ]; then
  source backend/.venv/bin/activate
fi

PORT="${PORT:-8107}"
cd backend

echo "=== goku-studio: applying migrations ==="
alembic -c alembic/studio/alembic.ini upgrade head

echo "=== goku-studio: starting API on :${PORT} ==="
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "$PORT" \
  --reload
