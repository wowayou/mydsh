#!/usr/bin/env bash
# mydsh：重启 dsh web 进程（让 checkout 补丁与最新插件代码生效）。
# 用法: ./restart.sh [checkout 路径] [端口]
# 说明: 会话数据持久化在 $DSH_HOME，重启不会丢任务；浏览器刷新即可重连。
set -euo pipefail

CHECKOUT="${1:-${DSH_CHECKOUT:-$HOME/deepseek-harness}}"
PORT="${2:-${DSH_WEB_PORT:-3081}}"
LOG_DIR="${DSH_HOME:-$HOME/.dsh}/mydsh"
LOG="$LOG_DIR/dsh-restart.log"
mkdir -p "$LOG_DIR"

if [ ! -f "$CHECKOUT/package.json" ]; then
  echo "error: 找不到 checkout: $CHECKOUT" >&2
  exit 1
fi

echo "== 停止当前 dsh web (:${PORT}) =="
PIDS="$(pgrep -f "apps/cli/src/bin.ts web --port $PORT" || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS || true
  for _ in $(seq 1 30); do
    pgrep -f "apps/cli/src/bin.ts web --port $PORT" >/dev/null 2>&1 || break
    sleep 1
  done
  STILL="$(pgrep -f "apps/cli/src/bin.ts web --port $PORT" || true)"
  if [ -n "$STILL" ]; then
    echo "警告: 进程未退出，强制终止: $STILL"
    kill -9 $STILL || true
    sleep 1
  fi
else
  echo "  未发现运行中的 dsh web 进程"
fi

echo "== 启动 dsh web (:${PORT}) =="
cd "$CHECKOUT"
nohup node --import tsx/esm apps/cli/src/bin.ts web --port "$PORT" >>"$LOG" 2>&1 &
echo "  新进程 PID: $!，日志: $LOG"

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "== 已就绪：http://127.0.0.1:$PORT =="
    exit 0
  fi
  sleep 1
done
echo "警告: 端口 ${PORT} 60 秒内未就绪，请查看日志: $LOG"
exit 1
