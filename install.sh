#!/usr/bin/env bash
# mydsh 幂等部署：把本项目（权威源）安装到 $DSH_HOME。
#
#   ./install.sh              部署全部（预设 + 主机插件 + 客户端插件 + patch 行 + 补丁）
#   ./install.sh --no-patch   跳过 checkout 补丁
#   ./install.sh --dry-run    只打印将要做的改动
#
# 生效方式：
#   - 主机/客户端插件行写入 profile patch（~/.dsh/profiles/web/cordis.patch.yml），
#     配置文件热重载（无需重启进程）；客户端插件需刷新页面。
#   - 预设复制到 ~/.dsh/.agent-presets/mydsh/，新会话选择「mydsh 模式」。
#   - checkout 补丁需重启 dsh 进程（dev 态 tsx 直接读源码）。
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PRESET_DIR="$DSH_HOME/.agent-presets/mydsh"
# 技能根目录：dsh 用 chokidar 监听，新增/改动技能无需重启进程。
SKILLS_DIR="$DSH_HOME/skills"
# 预设本地插件（./plugins/*.ts）的依赖解析根：让 .agent-presets 能向上找到
# profile 的 node_modules。预设目录在用户 home 下，Node 从那里向上找
# node_modules 永远到不了 harness 的依赖，./plugins/*.ts 里的
# import '@deepseek-ai/dsh-tools' 等会直接崩掉（新建会话失败）。
PRESET_NM="$DSH_HOME/.agent-presets/node_modules"
PROFILE_NM="$DSH_HOME/profiles/node_modules"
HOST_PLUGIN_DIR="$PROFILE_DIR/plugins"
CLIENT_ROOT="$DSH_HOME/profiles/node_modules/@wowayou"
DRY=0
DO_PATCH=1

for arg in "$@"; do
  case "$arg" in
    --no-patch) DO_PATCH=0 ;;
    --dry-run) DRY=1 ;;
  esac
done

say() { if [ "$DRY" -eq 1 ]; then echo "[dry] $*"; else echo "$*"; fi; }
# 直接执行参数数组（不经 eval）：DSH_HOME/DSH_PROFILE 等环境变量里的单引号
# 无法再逃逸出引号注入命令。dry-run 输出用 %q 保持与真实执行一致的引用显示。
run() {
  if [ "$DRY" -eq 1 ]; then
    local out='' a
    for a in "$@"; do out+="${out:+ }$(printf '%q' "$a")"; done
    echo "[dry]   $out"
  else
    "$@"
  fi
}

echo "== mydsh 部署 =="
echo "  项目:    $PROJECT"
echo "  DSH_HOME: $DSH_HOME"
echo "  profile: $PROFILE"
echo

# 1) Agent 预设（权威源 = preset/）
say "1) 预设 → $PRESET_DIR"
run mkdir -p "$PRESET_DIR"
# --copy-unsafe-links：preset/plugins/lib/vision-core.mjs 是指向仓库根 lib/ 的符号
# 链接（共用核心的唯一权威源），部署时必须落成真实文件，否则装完就是断链。
run rsync -a --delete --copy-unsafe-links "$PROJECT/preset/" "$PRESET_DIR/"

# 1b) 技能包（权威源 = skills/）
#     $DSH_HOME/skills 是共享目录（用户自己的技能也在这里），所以**逐个技能**同步，
#     绝不对整个 skills/ 用 --delete —— 那会连带删掉别人的技能。
say "1b) 技能 → $SKILLS_DIR"
run mkdir -p "$SKILLS_DIR"
for skill in "$PROJECT"/skills/*/; do
  [ -d "$skill" ] || continue
  name="$(basename "$skill")"
  # --copy-unsafe-links 同上：skills/vision/scripts/lib/vision-core.mjs 也是符号链接。
  run rsync -a --delete --copy-unsafe-links "$skill" "$SKILLS_DIR/$name/"
done
# 技能里的脚本要可执行（rsync -a 已保留权限，这里兜底）。
run chmod -R u+rwX "$SKILLS_DIR"

# 1c) SKILL.md 里的脚本路径 → 真实绝对路径
#     仓库里写的是默认值 ~/.dsh/skills/...（离线可读），部署时替换成本机真实
#     $SKILLS_DIR，这样模型拿到的就是可直接执行的绝对路径（DSH_HOME 非默认时也对）。
#     只改本项目自己的技能，绝不碰 $DSH_HOME/skills 下用户其它技能。
say "1c) SKILL.md 路径绝对化 → $SKILLS_DIR"
for skill in "$PROJECT"/skills/*/; do
  [ -d "$skill" ] || continue
  name="$(basename "$skill")"
  target="$SKILLS_DIR/$name/SKILL.md"
  if [ "$DRY" -eq 1 ]; then
    echo "[dry]   (改写 $target 中的 ~/.dsh/skills/ → $SKILLS_DIR/)"
    continue
  fi
  [ -f "$target" ] || continue
  python3 - "$target" "$SKILLS_DIR" <<'PYEOF'
import sys
path, root = sys.argv[1], sys.argv[2].rstrip('/')
with open(path, encoding='utf-8') as f:
    text = f.read()
fixed = text.replace('~/.dsh/skills/', f'{root}/')
if fixed != text:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(fixed)
    print('  路径已绝对化:', path)
PYEOF
done

# 2) 主机层插件（权威源 = host/）
say "2) 主机插件 → $HOST_PLUGIN_DIR"
run mkdir -p "$HOST_PLUGIN_DIR"
run rsync -a --delete "$PROJECT/host/" "$HOST_PLUGIN_DIR/"

# 3) 客户端插件包（权威源 = client/）
say "3) 客户端插件 → $CLIENT_ROOT"
run mkdir -p "$CLIENT_ROOT"
for pkg in "$PROJECT"/client/*/; do
  [ -d "$pkg" ] || continue
  name="$(basename "$pkg")"
  run rm -rf "$CLIENT_ROOT/$name"
  run cp -r "$pkg" "$CLIENT_ROOT/$name"
done

# 3b) 预设本地插件依赖解析（幂等：符号链接指向 profile node_modules）
#     依赖 $DSH_HOME/profiles/node_modules 存在（第 3 步已确保）。
say "3b) 预设插件依赖 → $PRESET_NM -> $PROFILE_NM"
if [ "$DRY" -eq 1 ]; then
  if [ -L "$PRESET_NM" ] && [ "$(readlink "$PRESET_NM")" = "$PROFILE_NM" ]; then
    echo "  [dry] (已就绪)"
  else
    echo "  [dry]   ln -s '$PROFILE_NM' '$PRESET_NM'"
  fi
elif [ -L "$PRESET_NM" ]; then
  if [ "$(readlink "$PRESET_NM")" = "$PROFILE_NM" ]; then
    echo "  (已就绪)"
  else
    echo "  warning: $PRESET_NM 指向 $(readlink "$PRESET_NM")，期望 $PROFILE_NM；"
    echo "           跳过（如需修复请手动删除后重跑 install.sh）"
  fi
elif [ -e "$PRESET_NM" ]; then
  echo "  warning: $PRESET_NM 是真实目录而非符号链接，跳过；"
  echo "           预设本地插件可能无法解析 @deepseek-ai/* 依赖"
else
  ln -s "$PROFILE_NM" "$PRESET_NM"
  echo "  符号链接已创建"
fi

# 4) profile patch 行（幂等：marker 块内整体替换，块外保留用户内容）
PATCH_BLOCK_START="# ==== mydsh begin (managed by install.sh, do not edit) ===="
PATCH_BLOCK_END="# ==== mydsh end ===="

say "4) patch 行 → $PATCH_FILE"
run mkdir -p "$PROFILE_DIR"
if [ "$DRY" -eq 1 ]; then
  echo "[dry]   (改写 marker 块)"
else
  if [ ! -f "$PATCH_FILE" ]; then
    printf '# dsh profile patch layer (mydsh 管理的插件行在 marker 块内)\n[]\n' > "$PATCH_FILE"
  fi
  python3 - "$PATCH_FILE" "$PATCH_BLOCK_START" "$PATCH_BLOCK_END" <<'PYEOF'
import sys
path, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
block = f"""{start}
- insert:
    # mydsh host: 任务完成通知监听 + 本地媒体服务
    - id: mydsh-notify
      name: './plugins/notify.ts'
    - id: mydsh-media
      name: './plugins/media.ts'
      inject: [webServer]
    # mydsh client: 浏览器插件（包位于 profiles/node_modules/@wowayou）
    - id: mydsh-ui-notify
      name: '@wowayou/ui-notify'
    - id: mydsh-ui-session-tabs
      name: '@wowayou/ui-session-tabs'
    - id: mydsh-ui-video
      name: '@wowayou/ui-video'
{end}
"""
with open(path, encoding='utf-8') as f:
    content = f.read()
if start in content:
    before = content.split(start, 1)[0]
    after = content.split(end, 1)[1] if end in content else ''
else:
    before, after = content, ''
# 丢弃 before 里的空数组 / 孤立反斜杠 / 空行，但保留注释与用户条目。
kept = [ln for ln in before.splitlines() if ln.strip() not in ('', '[]', '\\')]
before = '\n'.join(kept) + '\n' if kept else ''
# 归一化：整份文件只保留一个结尾换行（幂等，避免每次运行多一个空行）。
result = (before + block + after).rstrip('\n') + '\n'
with open(path, 'w', encoding='utf-8') as f:
    f.write(result)
print('  patch 行已写入:', path)
PYEOF
fi

# 5) checkout 补丁（sandbox 同模式升级 no-op）
if [ "$DO_PATCH" -eq 1 ]; then
  say "5) 应用 checkout 补丁"
  run bash "$PROJECT/patches/apply-patches.sh"
fi

echo
echo "== 完成 =="
echo "· 新会话在侧栏选择预设「mydsh 模式」即可使用 notify_user / vision_describe。"
echo "· 技能：\$DSH_HOME/skills/vision（热发现，无需重启）；模型用 skill 工具或你输入 /vision 触发。"
echo "· 浏览器插件：刷新页面（若跑着 dev:web 则自动热更新）。"
echo "· 补丁（若本轮应用）需重启 dsh 进程生效。"
echo "· 完成提醒日志: \$DSH_HOME/mydsh/notify.jsonl"
echo "· 预设插件依赖: \$DSH_HOME/.agent-presets/node_modules -> profiles/node_modules（install.sh 自动维护）"