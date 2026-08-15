#!/usr/bin/env bash
# Apply mydsh patches to the deepseek-harness checkout (idempotent).
# Usage: patches/apply-patches.sh [checkout path]
# Default checkout: $DSH_CHECKOUT or $HOME/deepseek-harness
set -euo pipefail

CHECKOUT="${1:-${DSH_CHECKOUT:-$HOME/deepseek-harness}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$CHECKOUT/package.json" ]; then
  echo "error: deepseek-harness checkout not found: $CHECKOUT" >&2
  exit 1
fi

cd "$CHECKOUT"

# --- Patch 1: sandbox same-mode escalation no-op ---
ESCALATION_MARKER="Same-mode request: the call already runs at exactly that mode"
ESCALATION_TARGET="$CHECKOUT/packages/sandbox/sandbox/src/escalation.ts"

if [ -f "$ESCALATION_TARGET" ] && grep -qF "$ESCALATION_MARKER" "$ESCALATION_TARGET"; then
  echo "Patch 1 (sandbox escalation): already applied, skipping."
else
  echo "Patch 1 (sandbox escalation): applying..."
  git apply --check "$SCRIPT_DIR/sandbox-same-mode-escalation.patch" 2>/dev/null
  git apply "$SCRIPT_DIR/sandbox-same-mode-escalation.patch"
  echo "  Applied."
fi

# --- Patch 2: global User-Agent override via env vars ---
UA_MARKER="DSH_APP_PRODUCT"
UA_TARGET="$CHECKOUT/packages/llm/llm/src/attribution.ts"

if [ -f "$UA_TARGET" ] && grep -qF "$UA_MARKER" "$UA_TARGET"; then
  echo "Patch 2 (UA env override): already applied, skipping."
else
  echo "Patch 2 (UA env override): applying..."
  git apply --check "$SCRIPT_DIR/user-agent-override.patch" 2>/dev/null
  git apply "$SCRIPT_DIR/user-agent-override.patch"
  echo "  Applied."
fi

# --- Patch 3: per-provider UA override (profile.headers wins) ---
PERPROVIDER_MARKER="per-provider UA override"
PERPROVIDER_TARGET="$CHECKOUT/packages/llm/llm-pi-ai/src/adapter.ts"

if [ -f "$PERPROVIDER_TARGET" ] && grep -qF "$PERPROVIDER_MARKER" "$PERPROVIDER_TARGET"; then
  echo "Patch 3 (per-provider UA): already applied, skipping."
else
  echo "Patch 3 (per-provider UA): applying..."
  git apply --check "$SCRIPT_DIR/per-provider-ua-override.patch" 2>/dev/null
  git apply "$SCRIPT_DIR/per-provider-ua-override.patch"
  echo "  Applied."
fi

echo ""
echo "All patches applied. Restart dsh to take effect."
echo ""
echo "UA configuration:"
echo "  Global:   DSH_UA_ALIAS=cursor ./restart.sh"
echo "  Per-provider: set headers.user-agent in provider profile config"
echo "  (Settings > Models > provider > headers: { user-agent: cursor/0.1.0 })"