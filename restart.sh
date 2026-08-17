#!/usr/bin/env bash
# mydsh: restart dsh web process (lets sandbox patch + latest plugin code take effect).
# Usage: ./restart.sh [checkout path] [port]
# Session data persists in $DSH_HOME; restart does not lose tasks.
#
# Important: when called from inside a dsh agent session, killing dsh would
# also kill this script (child of dsh). setsid detaches this script into a
# new session so the kill of the old dsh process does not cascade to us.
set -euo pipefail

# Detach from parent process group: when invoked from a dsh agent bash tool,
# killing dsh will not cascade to this script.
if [ -z "${MYDSH_RESTART_DETACHED:-}" ]; then
  export MYDSH_RESTART_DETACHED=1
  exec setsid bash "$0" "$@"
fi

CHECKOUT="${1:-${DSH_CHECKOUT:-$HOME/deepseek-harness}}"
PORT="${2:-${DSH_WEB_PORT:-3081}}"
# 端口校验：PORT 会被拼进 pgrep -f 的正则模式与 nohup 命令行——非数字值
# （含正则元字符）可能改变 pgrep 匹配范围（误杀其它端口的进程）或改变
# 启动命令语义。这里强制 0-65535 十进制整数（0 = 让 OS 分配，harness 支持）。
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -gt 65535 ]; then
  echo "error: port must be an integer 0-65535, got: $PORT" >&2
  exit 1
fi
LOG_DIR="${DSH_HOME:-$HOME/.dsh}/mydsh"
LOG="$LOG_DIR/dsh-restart.log"
mkdir -p "$LOG_DIR"

if [ ! -f "$CHECKOUT/package.json" ]; then
  echo "error: checkout not found: $CHECKOUT" >&2
  exit 1
fi

echo "== Stopping dsh web (:${PORT}) =="
PIDS="$(pgrep -f "apps/cli/src/bin.ts web --port $PORT" || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS || true
  for _ in $(seq 1 30); do
    pgrep -f "apps/cli/src/bin.ts web --port $PORT" >/dev/null 2>&1 || break
    sleep 1
  done
  STILL="$(pgrep -f "apps/cli/src/bin.ts web --port $PORT" || true)"
  if [ -n "$STILL" ]; then
    echo "warning: process did not exit, force killing: $STILL"
    kill -9 $STILL || true
    sleep 1
  fi
else
  echo "  no running dsh web process found"
fi

echo "== Starting dsh web (:${PORT}) =="
cd "$CHECKOUT"
# --expose-internals: enables cordis-plugin-hmr to access Node internal module
# loader, activating config HMR (cordis.patch.yml edits take effect live).
# 安全代价：它把 Node 内部模块面暴露给进程——harness（第三方代码、会升级）
# 或挂载插件被入侵时是额外立足点。HMR 是开发便利（POSTMORTEM 坑 2：缺了它
# 配置热更静默失效），默认保留；加固运行可 MYDSH_NO_HMR=1 关闭
# （配置改动将需要手动重启才生效）。
# UA alias: set DSH_APP_PRODUCT to spoof the User-Agent for third-party relay compatibility.
# Common presets:
#   DSH_UA_ALIAS=cursor      → User-Agent: cursor/<version>
#   DSH_UA_ALIAS=claude-code → User-Agent: claude-code/<version>
#   DSH_UA_ALIAS=codex       → User-Agent: codex/<version>
#   DSH_UA_ALIAS=opencode    → User-Agent: opencode/<version>
# Or set DSH_APP_PRODUCT directly for a custom value.
if [ -n "${DSH_UA_ALIAS:-}" ]; then
  export DSH_APP_PRODUCT="$DSH_UA_ALIAS"
  echo "  UA alias: $DSH_UA_ALIAS"
fi
if [ "${MYDSH_NO_HMR:-0}" = "1" ]; then
  echo "  HMR disabled (MYDSH_NO_HMR=1): --expose-internals off, config changes need manual restart"
  nohup node --import tsx/esm apps/cli/src/bin.ts web --port "$PORT" >>"$LOG" 2>&1 &
else
  nohup node --expose-internals --import tsx/esm apps/cli/src/bin.ts web --port "$PORT" >>"$LOG" 2>&1 &
fi
echo "  new PID: $!, log: $LOG"

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "== Ready: http://127.0.0.1:$PORT =="
    exit 0
  fi
  sleep 1
done
echo "warning: port ${PORT} not ready in 60s, check log: $LOG"
exit 1