#!/usr/bin/env bash
# manage.sh — start/stop the static dev server (python -m http.server)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8890}"  # 8889 = Gridworks
PID_FILE=.server.pid
LOG_FILE=.server.log

# python3 on most boxes; plain python or the py launcher on Windows. Probe with
# --version because the Windows Store ships a fake python.exe that only opens the Store.
PY=
for c in python3 python py; do
  if "$c" --version >/dev/null 2>&1; then PY=$c; break; fi
done
[[ -n $PY ]] || { echo "no python found (need python3/python/py for the dev server)"; exit 1; }

running() { [[ -f $PID_FILE ]] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; }

case "${1:-}" in
  start)
    if running; then echo "already running (pid $(cat $PID_FILE)) on port $PORT"; exit 0; fi
    nohup "$PY" -m http.server "$PORT" >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    sleep 0.3
    if ! running; then
      echo "failed to start (port $PORT busy? try another: PORT=nnnn $0 start):"
      tail -n 3 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1
    fi
    echo "started pid $(cat $PID_FILE) — http://localhost:$PORT"
    ;;
  stop)
    if running; then kill "$(cat $PID_FILE)"; rm -f "$PID_FILE"; echo "stopped"
    else rm -f "$PID_FILE"; echo "not running"; fi
    ;;
  restart)
    "$0" stop; "$0" start
    ;;
  status)
    if running; then echo "running (pid $(cat $PID_FILE)) — http://localhost:$PORT"
    else echo "not running"; fi
    ;;
  logs)
    tail -n "${2:-50}" "$LOG_FILE"
    ;;
  test)
    node tests/test_gen.mjs && node tests/test_sim.mjs && node tests/test_ui.mjs
    ;;
  deploy)
    # No build step: the site is the repo root. Ship it as-is, minus dev-only files.
    # --chmod: local dirs like favicon/ are 700, which the web server can't enter (404s).
    rsync -avz --delete --chmod=D755,F644 \
      --exclude .git --exclude .github --exclude .claude --exclude .superpowers --exclude .venv \
      --exclude docs --exclude tests \
      --exclude manage.sh --exclude CHANGELOG.md --exclude .gitignore --exclude '.server.*' \
      ./ "${DEPLOY_TARGET:-dogzrbar@firetailfab.com:/home/dogzrbar/public_html/firetailfab/idleswitch/}"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [n]|test|deploy}   (PORT=$PORT, override with PORT=nnnn)"
    exit 1
    ;;
esac
