#!/usr/bin/env bash
# mydsh 一键：部署最新代码 + 重启 dsh web + 验证生效。
#
#   ./up.sh                部署（install.sh）+ 重启（restart.sh，默认 :3081 / $DSH_WEB_PORT）
#   ./up.sh 3080           用指定端口
#   ./up.sh --no-install   代码没变，跳过部署，只重启 + 验证
#   ./up.sh --stop         只停端口上的 dsh web 实例，不起新进程（端口同前，默认 3081）
#
# 设计：部署/重启逻辑仍全部在 install.sh / restart.sh（单一权威源），本脚本只做
#   编排 + 端口预检 + 启动后验证，不复制部署逻辑。
#   - 端口预检：被 dsh 实例占用 → 交给 restart.sh 停旧起新；被非 dsh 进程占用 →
#     报出 PID 并拒绝启动（避免 EADDRINUSE 顶着插件树错误栈排查）。
#   - 启动后验证：/mydsh-media 三条边界（非媒体 404 / 无 Origin 200 / Range 206），
#     确认跑起来的确是部署后的代码。
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=""
DO_INSTALL=1
STOP_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --no-install) DO_INSTALL=0 ;;
    --stop) STOP_ONLY=1 ;;
    *)
      if [ -n "$PORT" ]; then
        echo "error: 端口已指定 $PORT，又给了: $arg" >&2
        exit 1
      fi
      case "$arg" in
        *[!0-9]*) echo "error: 端口必须是 0-65535 整数，got: $arg" >&2; exit 1 ;;
      esac
      if [ "$arg" -gt 65535 ]; then
        echo "error: 端口必须是 0-65535 整数，got: $arg" >&2
        exit 1
      fi
      PORT="$arg"
      ;;
  esac
done

# 该端口上的 dsh web 进程 PID（空 = 没有）。模式与 restart.sh 的 pgrep 一致。
dsh_pids() { pgrep -f "apps/cli/src/bin.ts web --port ${1}" 2>/dev/null || true; }

# 端口是否被监听（不关心是谁）。
port_in_use() { ss -tln 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${1}$"; }

# 停掉端口上的 dsh web 实例（先 SIGTERM 等 30s，再 SIGKILL）。
stop_instance() {
  local port="$1" pids _
  pids="$(dsh_pids "$port")"
  if [ -z "$pids" ]; then
    echo "  :$port 上没有 dsh web 实例"
    return 0
  fi
  echo "  停止 :$port（PID: $(echo "$pids" | tr '\n' ' '))"
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 30); do
    [ -z "$(dsh_pids "$port")" ] && break
    sleep 1
  done
  pids="$(dsh_pids "$port")"
  if [ -n "$pids" ]; then
    echo "  未退出，强制停止: $(echo "$pids" | tr '\n' ' ')"
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
}

if [ "$STOP_ONLY" -eq 1 ]; then
  PORT="${PORT:-${DSH_WEB_PORT:-3081}}"
  if [ "$PORT" = "0" ]; then
    echo "error: --stop 需要具体端口（0 由 OS 分配，无法定位实例）" >&2
    exit 1
  fi
  echo "== 停止 dsh web (:$PORT) =="
  stop_instance "$PORT"
  echo "== 已停止 =="
  exit 0
fi

# ── 1) 端口预检 ─────────────────────────────────────────────────────────
PORT="${PORT:-${DSH_WEB_PORT:-3081}}"
if [ "$PORT" != "0" ] && port_in_use "$PORT"; then
  if [ -n "$(dsh_pids "$PORT")" ]; then
    echo "  :$PORT 由 dsh web 实例占用，restart.sh 将停旧起新"
  else
    echo "error: :$PORT 已被非 dsh 进程占用，请手动停掉它（本脚本不 kill 非 dsh 进程）：" >&2
    ss -tlnp 2>/dev/null | grep -E "[:.]${PORT}$" || true
    exit 1
  fi
fi

# ── 2) 部署 ─────────────────────────────────────────────────────────────
echo
if [ "$DO_INSTALL" -eq 1 ]; then
  bash "$PROJECT/install.sh"
else
  echo "(--no-install：跳过部署)"
fi

# ── 3) 重启（restart.sh 自带 60s 就绪探测）──────────────────────────────
echo
if ! bash "$PROJECT/restart.sh" "" "$PORT"; then
  echo "error: dsh web 未在 60s 内就绪，查日志: \${DSH_HOME:-$HOME/.dsh}/mydsh/dsh-restart.log" >&2
  exit 1
fi

# ── 4) 验证新代码确实生效（media 路由三条边界）──────────────────────────
if [ "$PORT" = "0" ]; then
  echo "  (port=0 由 OS 分配，跳过 HTTP 验证；看日志确认监听端口)"
  exit 0
fi
echo
echo "== 验证 =="
tmpbase="$(mktemp /tmp/mydsh-up-verify-XXXXXX)"
tmpf="$tmpbase.mp4"
mv "$tmpbase" "$tmpf"
trap 'rm -f "$tmpf"' EXIT
head -c 64 /dev/zero > "$tmpf"
enc="$(python3 -c 'import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$tmpf")"
code() { curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
base="http://127.0.0.1:$PORT/mydsh-media"
c_nonmedia="$(code "$base/%2Fetc%2Fpasswd")"
c_media="$(code "$base/$enc")"
c_range="$(code -H 'Range: bytes=0-7' "$base/$enc")"
fail=0
[ "$c_nonmedia" = "404" ] || { echo "  ✗ 非媒体扩展名应 404，实际 $c_nonmedia" >&2; fail=1; }
[ "$c_media" = "200" ] || { echo "  ✗ 媒体文件无 Origin 应 200，实际 $c_media" >&2; fail=1; }
[ "$c_range" = "206" ] || { echo "  ✗ Range 请求应 206，实际 $c_range" >&2; fail=1; }
if [ "$fail" -ne 0 ]; then
  echo "  warning: 验证异常——部署可能未生效（插件热重载失败？），查日志: \${DSH_HOME:-$HOME/.dsh}/mydsh/dsh-restart.log" >&2
  exit 1
fi
echo "  ✓ media 边界 404/200/206 符合预期"
echo "== 完成: http://127.0.0.1:$PORT =="
