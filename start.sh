#!/bin/bash
# goku-studio startup — launches the Studio frontend (:5107) as a background
# daemon.  Returns immediately; logs go to logs/ in this directory.
#
# The Studio backend (:8107) is NOT started: since the A1/A2 merge the frontend
# proxies every /api and /icons request to goku-core on :8106 (see
# frontend/vite.config.ts), and the Studio backend no longer carries the
# services those requests need — embedding / vector_store / chunker live only in
# core. So this script verifies core is up instead, and fails loudly if it is
# not; a "started" banner with a dead core is exactly the failure mode that let
# the knowledge-upload 500 go unnoticed.
#
# Set STUDIO_WITH_BACKEND=1 to also start :8107 — only useful while the backend
# is kept around as a rollback path.
#
# Usage:
#   ./start.sh          — start (no-op if already running)
#   ./start.sh stop     — gracefully stop everything this script started
#   ./start.sh restart  — stop then start
#   ./start.sh status   — show running PIDs and log paths

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PID_FILE="$DIR/.studio.pids"
LOG_DIR="$DIR/logs"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

mkdir -p "$LOG_DIR"

# ── environment ───────────────────────────────────────────────────────────────
# Loaded before the command dispatch so that `stop`/`status` resolve the same
# ports as `start` (a stop that sweeps the wrong port stops nothing).

# Load .env — prefer backend/.env, fall back to root .env
if [ -f "$DIR/backend/.env" ]; then
  set -a; . "$DIR/backend/.env"; set +a
elif [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
fi

BACKEND_PORT="${VITE_STUDIO_BACKEND_PORT:-8107}"
FRONTEND_PORT="${VITE_STUDIO_PORT:-5107}"
CORE_URL="${VITE_CORE_BACKEND_URL:-http://localhost:8106}"

# ── helpers ───────────────────────────────────────────────────────────────────

pid_running() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

stop_studio() {
  local stopped=0
  if [ -f "$PID_FILE" ]; then
    # shellcheck disable=SC1090
    source "$PID_FILE"
    if pid_running "$BACKEND_PID"; then
      echo "Stopping backend (PID $BACKEND_PID)…"
      kill "$BACKEND_PID" 2>/dev/null && stopped=$((stopped+1))
    fi
    if pid_running "$FRONTEND_PID"; then
      echo "Stopping frontend (PID $FRONTEND_PID)…"
      kill "$FRONTEND_PID" 2>/dev/null && stopped=$((stopped+1))
    fi
    rm -f "$PID_FILE"
  else
    echo "No PID file found — falling back to a port sweep."
  fi

  # Port sweep: uvicorn --reload spawns a child the PID file does not track, and
  # older runs of this script used a different PID-file layout, so a PID-only
  # stop reliably leaves processes behind on :8107.
  for port in "${FRONTEND_PORT:-5107}" "${BACKEND_PORT:-8107}"; do
    local pids
    pids=$(lsof -ti:"$port" 2>/dev/null)
    if [ -n "$pids" ]; then
      echo "Reclaiming port $port (PIDs: $(echo "$pids" | tr '\n' ' '))…"
      echo "$pids" | xargs kill 2>/dev/null
      sleep 1
      pids=$(lsof -ti:"$port" 2>/dev/null)
      [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null
      stopped=$((stopped+1))
    fi
  done

  echo "Stopped $stopped process(es)/port(s)."
}

core_up() {
  curl -sf --max-time 3 "$CORE_URL/health" -o /dev/null 2>/dev/null
}

status_studio() {
  echo "Core (:${CORE_URL##*:})  $(core_up && echo '✅ reachable' || echo "❌ unreachable at $CORE_URL")"
  if [ ! -f "$PID_FILE" ]; then
    echo "studio is NOT running (no PID file)."
    return 1
  fi
  # shellcheck disable=SC1090
  source "$PID_FILE"
  echo "Frontend PID: ${FRONTEND_PID:-—}  $(pid_running "$FRONTEND_PID" && echo '✅ running' || echo '❌ dead')"
  if [ -n "$BACKEND_PID" ]; then
    echo "Backend  PID: $BACKEND_PID  $(pid_running "$BACKEND_PID" && echo '✅ running (rollback mode)' || echo '❌ dead')"
  fi
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
  if pid_running "$FRONTEND_PID"; then
    echo "goku-studio is already running (frontend=$FRONTEND_PID)."
    echo "Use '$0 restart' to restart or '$0 stop' to stop."
    exit 0
  fi
  rm -f "$PID_FILE"  # stale pids — clean up and proceed
fi

# ── require goku-core ─────────────────────────────────────────────────────────
# The frontend proxies /api and /icons to core, so a Studio that starts without
# core is a Studio where every page is broken. Fail here rather than print a
# green banner and let the user discover it click by click.

if ! core_up; then
  echo "❌ goku-core is not reachable at $CORE_URL" >&2
  echo "   Studio's frontend proxies every /api request there (frontend/vite.config.ts)," >&2
  echo "   so nothing will work until it is up. Start it with:  ../core/start.sh" >&2
  echo "   (different host/port? set VITE_CORE_BACKEND_URL)" >&2
  exit 1
fi

# uv/uvx and node/npx are deliberately NOT installed here any more: Studio's MCP
# test/sync no longer spawns stdio subprocesses, it forwards to core
# (services/core_runtime_proxy.py), so those runtimes are core's dependency.
#
# Alembic is likewise not run here: alembic/studio/versions/ holds zero
# revisions and core owns the `aios` schema (core/docs/A1-merge-plan.md). The
# upgrade only ever created an empty studio_alembic_version table.

# ── optional: Studio backend (rollback path only) ─────────────────────────────

BACKEND_PID=""
if [ "${STUDIO_WITH_BACKEND:-0}" = "1" ]; then
  if [ -d "$DIR/backend/.venv" ]; then
    VENV="$DIR/backend/.venv"
  elif [ -d "$DIR/.venv" ]; then
    VENV="$DIR/.venv"
  else
    echo "❌ STUDIO_WITH_BACKEND=1 but no .venv found — run: python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"

  echo "=== goku-studio: starting backend on :${BACKEND_PORT} (rollback mode) ==="
  cd "$DIR/backend"
  nohup uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "$BACKEND_PORT" \
    --reload \
    >> "$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
fi

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

# Verify the frontend actually serves — a dead vite exits within a second or two
# (port already in use, bad config), and the PID check alone would miss it.
sleep 3
if ! curl -sf --max-time 3 "http://localhost:${FRONTEND_PORT}/" -o /dev/null 2>/dev/null; then
  echo "⚠️  Frontend not answering on :${FRONTEND_PORT} yet — check $FRONTEND_LOG" >&2
fi
if [ -n "$BACKEND_PID" ] && ! pid_running "$BACKEND_PID"; then
  echo "⚠️  Backend failed to start — check $BACKEND_LOG" >&2
fi

# ── done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Goku Studio started (daemon mode)                   ║"
echo "║                                                      ║"
printf "║  Frontend → http://localhost:%-5s  PID %-8s     ║\n" "$FRONTEND_PORT" "$FRONTEND_PID"
printf "║  API      → %-40s ║\n" "$CORE_URL (goku-core)"
if [ -n "$BACKEND_PID" ]; then
  printf "║  Backend  → http://localhost:%-5s  PID %-8s     ║\n" "$BACKEND_PORT" "$BACKEND_PID"
  echo "║             (rollback mode — nothing routes here)    ║"
fi
echo "║                                                      ║"
printf "║  Log: %-45s ║\n" "logs/frontend.log"
echo "║                                                      ║"
echo "║  To stop:  ./start.sh stop                          ║"
echo "║  Status:   ./start.sh status                        ║"
echo "╚══════════════════════════════════════════════════════╝"
