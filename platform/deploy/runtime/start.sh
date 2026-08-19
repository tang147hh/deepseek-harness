#!/bin/sh
# Per-user dsh web. CLI refuses --host 0.0.0.0; listen on loopback 3079 and
# proxy 0.0.0.0:3080 → 127.0.0.1:3079 so the control-plane / manager can probe
# 3080 on dsh-runtimes. Do not publish host ports. Do not set DEEPSEEK_API_KEY.
set -eu

APP_HOST="${APP_HOST:-}"
if [ -z "${APP_HOST}" ]; then
  echo "dsh-runtime: APP_HOST is required (must match compose APP_HOST)" >&2
  exit 1
fi

export DSH_HOME="${DSH_HOME:-/data/home}"
export HOME="${HOME:-/data/home}"
# Force directory-picker-auto onto browse (no native OS chooser / openPath).
export SSH_CONNECTION="${SSH_CONNECTION:-gateway}"
unset DISPLAY || true
unset WAYLAND_DISPLAY || true

cd /data/workspace

DSH_BIN="${DSH_BIN:-/opt/dsh/apps/cli/lib/bin.js}"
if [ ! -f "${DSH_BIN}" ]; then
  echo "dsh-runtime: missing ${DSH_BIN}; image must be built with pnpm run build" >&2
  exit 1
fi

# trusted-host is APP_HOST so /api Host fence accepts the browser's authority.
# Repeatable: extra names here if needed; do not add pages hosts.
node "${DSH_BIN}" web --host 127.0.0.1 --port 3079 --trusted-host "${APP_HOST}" &
DSH_PID=$!

socat TCP-LISTEN:3080,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:3079 &
SOCAT_PID=$!

term() {
  kill -TERM "${DSH_PID}" "${SOCAT_PID}" 2>/dev/null || true
  wait "${DSH_PID}" "${SOCAT_PID}" 2>/dev/null || true
}
trap term TERM INT

wait "${DSH_PID}"
status=$?
kill -TERM "${SOCAT_PID}" 2>/dev/null || true
wait "${SOCAT_PID}" 2>/dev/null || true
exit "${status}"
