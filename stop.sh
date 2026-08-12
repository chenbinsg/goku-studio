#!/bin/bash
# Thin wrapper — start.sh owns the PID file and the port sweep, so stopping is
# delegated to it. Keeping a second implementation here is what let this script
# drift: it looked for $DIR/frontend.pid, a path start.sh never wrote, so it
# only ever killed whatever happened to hold :5107 and always left the backend
# on :8107 running.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/start.sh" stop
