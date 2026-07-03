#!/bin/bash
# goku-studio startup — launches both the Studio backend (:8107) and frontend (:5107)
# as background daemons.  Returns immediately; logs go to logs/ in this directory.
#
# Usage:
#   ./start.sh          — start (no-op if already running)
#   ./start.sh stop     — gracefully stop both processes
#   ./start.sh restart  — stop then start
#   ./start.sh status   — show running PIDs and log paths

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PID_FILE="$DIR/.studio.pids"
LOG_DIR="$DIR/logs"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

mkdir -p "$LOG_DIR"

# ── helpers ───────────────────────────────────────────────────────────────────

pid_running() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

stop_studio() {
  if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found — studio may not be running."
    return 0
  fi
  # shellcheck disable=SC1090
  source "$PID_FILE"
  local stopped=0
  if pid_running "$BACKEND_PID"; then
    echo "Stopping backend (PID $BACKEND_PID)…"
    kill "$BACKEND_PID" 2>/dev/null && stopped=$((stopped+1))
  fi
  if pid_running "$FRONTEND_PID"; then
    echo "Stopping frontend (PID $FRONTEND_PID)…"
    kill "$FRONTEND_PID" 2>/dev/null && stopped=$((stopped+1))
  fi
  rm -f "$PID_FILE"
  echo "Stopped $stopped process(es)."
}

status_studio() {
  if [ ! -f "$PID_FILE" ]; then
    echo "studio is NOT running (no PID file)."
    return 1
  fi
  # shellcheck disable=SC1090
  source "$PID_FILE"
  echo "Backend  PID: ${BACKEND_PID:-—}  $(pid_running "$BACKEND_PID" && echo '✅ running' || echo '❌ dead')"
  echo "Frontend PID: ${FRONTEND_PID:-—}  $(pid_running "$FRONTEND_PID" && echo '✅ running' || echo '❌ dead')"
  echo "Backend  log: $BACKEND_LOG"
  echo "Frontend log: $FRONTEND_LOG"
}

# ── command dispatch ──────────────────────────────────────────────────────────

case "${1:-start}" in
  stop)    stop_studio;  exit $? ;;
  status)  status_studio; exit $? ;;
  restart) stop_studio; sleep 1 ;;
  start)   ;; # fall through
  *)       echo "Usage: $0 [start|stop|restart|status]"; exit 1 ;;
esac

# ── guard: already running? ───────────────────────────────────────────────────

if [ -f "$PID_FILE" ]; then
  # shellcheck disable=SC1090
  source "$PID_FILE"
  if pid_running "$BACKEND_PID" && pid_running "$FRONTEND_PID"; then
    echo "goku-studio is already running (backend=$BACKEND_PID, frontend=$FRONTEND_PID)."
    echo "Use '$0 restart' to restart or '$0 stop' to stop."
    exit 0
  fi
  rm -f "$PID_FILE"  # stale pids — clean up and proceed
fi

# ── load environment ──────────────────────────────────────────────────────────

# Load .env — prefer backend/.env, fall back to root .env
if [ -f "$DIR/backend/.env" ]; then
  set -a; . "$DIR/backend/.env"; set +a
elif [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
fi

# Resolve venv — prefer backend/.venv, fall back to root .venv
if [ -d "$DIR/backend/.venv" ]; then
  VENV="$DIR/backend/.venv"
elif [ -d "$DIR/.venv" ]; then
  VENV="$DIR/.venv"
else
  echo "❌ No .venv found — run: python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

BACKEND_PORT="${VITE_STUDIO_BACKEND_PORT:-8107}"
FRONTEND_PORT="${VITE_STUDIO_PORT:-5107}"

# ── Ensure MCP runtimes: uv/uvx + node/npx ─────────────────────────────────────
# Studio's MCP server test/sync spawns the same stdio subprocesses as core:
# `npx -y <pkg>` presets (mysql, github, …) need node; `uvx <pkg>` presets
# (official ClickHouse: `uvx mcp-clickhouse`) need uv. Docker deploys bake both
# into the image (see backend/Dockerfile); this covers bare-metal/script deploys.
# Idempotent: skips instantly when already installed.
if ! command -v uvx >/dev/null 2>&1 && [ ! -x /usr/local/bin/uvx ] && [ ! -x /opt/homebrew/bin/uvx ]; then
  echo "uvx not found — installing uv (runtime for uvx-based MCP servers)..."
  if command -v brew >/dev/null 2>&1; then
    brew install uv || echo "WARN: brew install uv failed — install uv manually"
  else
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
      || curl -LsSf https://astral.sh/uv/install.sh | sh \
      || echo "WARN: uv install failed — uvx-based MCP servers (clickhouse) will not start"
    if [ -x "$HOME/.local/bin/uvx" ] && [ ! -x /usr/local/bin/uvx ]; then
      ln -sf "$HOME/.local/bin/uv" "$HOME/.local/bin/uvx" /usr/local/bin/ 2>/dev/null \
        || echo "WARN: could not link uvx into /usr/local/bin — do it manually: sudo ln -s $HOME/.local/bin/uv{,x} /usr/local/bin/"
    fi
  fi
  # Final verification — `curl | sh` can "succeed" silently on network failure,
  # so re-check and warn loudly if uvx is still absent.
  command -v uvx >/dev/null 2>&1 || [ -x /usr/local/bin/uvx ] || [ -x /opt/homebrew/bin/uvx ] || \
    echo "WARN: uv is still not installed — uvx-based MCP servers (clickhouse) will fail to start. Install manually: https://docs.astral.sh/uv/"
fi
command -v npx >/dev/null 2>&1 || [ -x /opt/homebrew/bin/npx ] || \
  echo "WARN: npx (node) not found — npx-based MCP servers (mysql, github, …) will fail to start. Install Node.js 20+."

# ── migrations ────────────────────────────────────────────────────────────────

echo "=== goku-studio: applying migrations ==="
cd "$DIR/backend"
if ! alembic -c alembic/studio/alembic.ini upgrade head; then
  echo "ERROR: migrations failed — aborting." >&2
  exit 1
fi

# ── start backend (daemon) ────────────────────────────────────────────────────

echo "=== goku-studio: starting backend on :${BACKEND_PORT} ==="
nohup uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "$BACKEND_PORT" \
  --reload \
  >> "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

# ── frontend dependencies ─────────────────────────────────────────────────────

cd "$DIR/frontend"
if [ ! -d "node_modules" ]; then
  echo "=== goku-studio: installing frontend dependencies ==="
  npm install
fi

# ── start frontend (daemon) ───────────────────────────────────────────────────

echo "=== goku-studio: starting frontend on :${FRONTEND_PORT} ==="
nohup npm run dev \
  >> "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# ── save PIDs ─────────────────────────────────────────────────────────────────

cat > "$PID_FILE" <<EOF
BACKEND_PID=$BACKEND_PID
FRONTEND_PID=$FRONTEND_PID
EOF

# Give uvicorn a moment to bind the port, then verify via HTTP
# (PID-based check is unreliable because uvicorn --reload spawns a reloader
#  parent that exits quickly, leaving a child process we don't track.)
sleep 2
if ! curl -s --max-time 3 "http://localhost:${BACKEND_PORT}/api/v1/agents" \
     -o /dev/null 2>/dev/null; then
  echo "⚠️  Backend may not be ready yet — check $BACKEND_LOG" >&2
fi
if ! pid_running "$FRONTEND_PID"; then
  echo "⚠️  Frontend failed to start — check $FRONTEND_LOG" >&2
fi

# ── done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Goku Studio started (daemon mode)                   ║"
echo "║                                                      ║"
printf "║  Backend  → http://localhost:%-5s  PID %-8s     ║\n" "$BACKEND_PORT"  "$BACKEND_PID"
printf "║  Frontend → http://localhost:%-5s  PID %-8s     ║\n" "$FRONTEND_PORT" "$FRONTEND_PID"
echo "║                                                      ║"
echo "║  Logs:                                               ║"
printf "║    backend:  %-38s  ║\n" "logs/backend.log"
printf "║    frontend: %-38s  ║\n" "logs/frontend.log"
echo "║                                                      ║"
echo "║  To stop:  ./start.sh stop                          ║"
echo "║  Status:   ./start.sh status                        ║"
echo "╚══════════════════════════════════════════════════════╝"
