#!/usr/bin/env bash
# 把 mydsh 对 deepseek-harness 的最小补丁应用到 checkout（幂等）。
# 用法: patches/apply-patches.sh [checkout 路径]
# 默认 checkout 路径: 环境变量 DSH_CHECKOUT，否则取 $HOME/deepseek-harness。
set -euo pipefail

CHECKOUT="${1:-${DSH_CHECKOUT:-$HOME/deepseek-harness}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$CHECKOUT/package.json" ]; then
  echo "error: 找不到 deepseek-harness checkout: $CHECKOUT" >&2
  exit 1
fi

# 已应用的标志：escalation.ts 里的同模式 no-op 注释。
MARKER="Same-mode request: the call already runs at exactly that mode"
TARGET="$CHECKOUT/packages/sandbox/sandbox/src/escalation.ts"

if [ -f "$TARGET" ] && grep -qF "$MARKER" "$TARGET"; then
  echo "补丁已应用（$TARGET），跳过。"
  exit 0
fi

echo "应用补丁: sandbox-same-mode-escalation.patch → $CHECKOUT"
cd "$CHECKOUT"
git apply --check "$SCRIPT_DIR/sandbox-same-mode-escalation.patch"
git apply "$SCRIPT_DIR/sandbox-same-mode-escalation.patch"
echo "已应用。重启 dsh 进程后生效（dev 态 tsx 直接读源码）。"
echo "验证: cd $CHECKOUT && pnpm vitest run packages/sandbox/sandbox/tests/escalation.spec.ts"
