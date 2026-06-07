#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$DIR/frontend.pid" ]; then
  PID=$(cat "$DIR/frontend.pid")
  kill "$PID" 2>/dev/null && echo "Stopped frontend (PID $PID)"
  rm -f "$DIR/frontend.pid"
fi

# Also kill anything on 5107
lsof -ti:5107 | xargs kill -9 2>/dev/null || true
echo "Studio stopped."
