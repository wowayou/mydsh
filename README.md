# mydsh — Personal Agent System on DeepSeek Harness

[English](#english) | [中文](#中文)

---

## English

> Everything is a plugin. This project reorganizes DeepSeek Harness capabilities into your own personal Agent system.

### What it does

| Feature | Implementation | Layer |
| --- | --- | --- |
| Task completion notification | Host plugin listens to `agent/status` (running→idle): JSONL log + `notify-send`; browser plugin: Notification API + sound (alerts when tab is in background) | Host + Browser |
| Proactive notification | Model can call `notify_user(title, body)` tool | Preset |
| Vision for text models | `vision_describe(path, prompt)` — modlens visual assistant: reuses image attachment channel, calls qwen-vl-max to generate descriptions for text models | Preset |
| Multi-session tabs | "⧉" button in session header actions: copies `?session=<id>` deep link and opens in new tab; each tab selects its own session independently. Plus a "New" button at the sidebar foot that pops a workspace picker, then opens a fresh session in that workspace in a new tab (falls back to a blank tab when no workspace exists) | Browser |
| Video support | Media links with absolute paths (`[demo.mp4](/abs/path/demo.mp4)`) auto-render as draggable `<video>/<audio>` (host `/mydsh-media` route with Range support) | Host + Browser |
| Non-DeepSeek model full-access error fix | Minimal patch to harness: same-mode "escalation" treated as no-op pass-through (`patches/`, with unit tests) | Patch |

### Quick start

```bash
# 1) Deploy (idempotent, safe to re-run)
./install.sh

# 2) Restart dsh process (lets sandbox patch + latest plugin code take effect)
#    Stop `pnpm dsh web --port 3081` with Ctrl-C, then restart with --expose-internals
#    for config HMR (plugin rows hot-reload on cordis.patch.yml edits):
#    node --expose-internals --import tsx/esm apps/cli/src/bin.ts web --port 3081
#    Or simply: ./restart.sh  (already includes --expose-internals)
#    A restart is REQUIRED after the first install: the running process caches
#    the failed preset-plugin module resolution until then.

# 3) Refresh browser page
#    New session: select the "mydsh 模式" preset in the sidebar
```

### Install via dsh plugin command (community flow)

```bash
# Clone and deploy
git clone https://github.com/wowayou/mydsh.git
cd mydsh
./install.sh
```


### User-Agent override (third-party relay compatibility)

Some third-party API relays (New API / One API) block requests with `User-Agent: deepseek-harness/...`.
This patch makes the User-Agent overridable via environment variables:

```bash
# Preset aliases (recommended):
DSH_UA_ALIAS=cursor ./restart.sh         # → User-Agent: cursor/<version>
DSH_UA_ALIAS=claude-code ./restart.sh     # → User-Agent: claude-code/<version>
DSH_UA_ALIAS=codex ./restart.sh           # → User-Agent: codex/<version>
DSH_UA_ALIAS=opencode ./restart.sh       # → User-Agent: opencode/<version>

# Or set a custom product name directly:
DSH_APP_PRODUCT=my-app ./restart.sh
```

> **Note**: The version and URL stay from the harness package.json. Only the product name changes.
> This patch is applied to the checkout alongside the sandbox patch via `./install.sh`.

#### Per-provider UA override

For relay-specific UA without affecting other providers, set `headers.user-agent` in the provider profile:

```yaml
# In settings: providers config
providers:
  my-relay:
    baseURL: https://relay.example.com/v1
    apiKeyEnv: RELAY_KEY
    headers:
      user-agent: cursor/0.1.0   # per-provider UA override
```

Per-provider UA takes priority over the global `DSH_APP_PRODUCT` env var.

### Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed and running
- Node.js with tsx support
- `$DSH_HOME` set (defaults to `~/.dsh`)
- Optional: `notify-send` for desktop notifications (Linux/Wayland)

### Architecture

```
mydsh/
├── README.md
├── LICENSE
├── docs/{design.md, journal.md}   # Architecture blueprint + traceable process log
├── preset/                        # mydsh agent preset (standard mode, personalized)
│   ├── agent.cordis.yml           #   Composition (persona + two private tool rows)
│   └── plugins/{notify-tool,vision-tool}.ts
├── host/{notify,media}.ts         # Host plugins (notification listener / local media route)
├── client/                        # Browser plugins (handwritten __ModuleLoader__ bundles, zero build deps)
│   ├── ui-notify/  ui-session-tabs/  ui-video/
├── patches/                       # Sandbox + UA override patches + replay script
├── restart.sh                     # Restart dsh (setsid + --expose-internals)
├── install.sh                     # Idempotent deploy to $DSH_HOME
├── tests/{smoke.mjs, check-preset.mjs}   # Smoke tests + preset validation
└── manifest.json                  # File → deploy target manifest
```

> Deployed layout note: `install.sh` also creates the symlink
> `$DSH_HOME/.agent-presets/node_modules → $DSH_HOME/profiles/node_modules` so the
> preset's local plugin files (`./plugins/*.ts`) can resolve `@deepseek-ai/*`
> imports from their home-directory location (a preset-local plugin's bare
> imports resolve from the preset dir, not from the harness).

---

## 中文

# mydsh — 我的 Agent 系统（构建在 DeepSeek Harness 之上）

> 一切皆插件。这套系统把 DSH 的能力按「插件行」重新组织成你自己的 Agent：
> 一个私人 Agent 预设（mydsh 模式）+ 若干主机/浏览器插件 + 一个对 harness 的最小补丁。
> 全部代码的权威源在本仓库，`install.sh` 幂等部署到 `$DSH_HOME`；过程全部记录在
> [`docs/journal.md`](docs/journal.md)（可回溯）。

## 特性（对应你的诉求）

| 你的诉求 | 实现 | 层 |
| --- | --- | --- |
| 任务完成没提醒 | 主机层监听 `agent/status`（running→idle）：写 JSONL 日志 + `notify-send`；浏览器插件：Notification API + 提示音（页面后台时才提醒） | 主机 + 浏览器 |
| 主动通知 | 模型可调 `notify_user(title, body)` 工具 | 预设 |
| 文本模型看不懂图片 | `vision_describe(path, prompt)` —— modlens 视觉助手：复用图片提交通道，调 qwen-vl-max 生成描述回给文本模型 | 预设 |
| 多 Session 新窗口 | 会话头操作行「⧉」按钮：复制 `?session=<id>` 深链并在新标签页打开；各标签页各选各的会话互不干扰。侧栏底部「新建会话」selector pill（设置选中弹窗形态）：点击弹出工作区选择菜单（选中项带 ✓），选定后在该工作区下新建会话并新标签页打开（无工作区时退化为打开空标签页） | 浏览器 |
| 视频支持 | 消息里以绝对路径写的媒体链接（`[demo.mp4](/abs/path/demo.mp4)`）自动渲染成可拖动的 `<video>/<audio>`（主机 `/mydsh-media` 路由带 Range 支持） | 主机 + 浏览器 |
| 非 DeepSeek 模型 full-access 报错 | 对 harness 的最小补丁：同模式「升级」视为 no-op 直接放行（`patches/`，附单测与重放脚本） | 补丁 |

## 布局

```
mydsh/
├── README.md
├── docs/{design.md, journal.md}   # 架构蓝图 + 可回溯过程日志
├── preset/                        # mydsh agent 预设（标准模式私人定制版）
│   ├── agent.cordis.yml           #   组合（persona + 两个私有工具行）
│   └── plugins/{notify-tool,vision-tool}.ts
├── host/{notify,media}.ts         # 主机层插件（通知监听 / 本地媒体路由）
├── client/                        # 浏览器插件（手写 __ModuleLoader__ bundle，零构建依赖）
│   ├── ui-notify/  ui-session-tabs/  ui-video/
├── patches/                       # sandbox 同模式升级补丁 + 重放脚本
├── install.sh                     # 幂等部署到 $DSH_HOME
├── tests/{smoke.mjs, check-preset.mjs}   # 冒烟测试 + 预设解析校验
└── manifest.json                  # 文件 → 部署目标清单
```

## 快速开始

```bash
# 1) 部署（幂等，可重复执行）
./install.sh

# 2) 重启 dsh 进程（让 sandbox 补丁与最新插件代码生效）
#    Ctrl-C 停掉 `pnpm dsh web --port 3081`，再重新启动即可；会话数据不丢。
#    首次部署后重启是必须的：运行中的进程会缓存预设插件失败的模块解析，
#    不重启则「mydsh 模式」仍无法新建会话。

# 3) 浏览器刷新页面
#    新会话：侧栏选择预设「mydsh 模式」
```

验证：

```bash
# 插件冒烟测试（需在 harness checkout 内运行，tsx 解析 .ts；
# DSH_HOME 指向临时目录，避免测试写入真实日志）
cd /home/forbackup/deepseek-harness
DSH_HOME=/tmp/mydsh-smoke-home NODE_PATH=$HOME/.dsh/profiles/node_modules \
  node --import tsx/esm /home/forbackup/Dev/mydsh/tests/smoke.mjs

# 预设行解析校验（含部署位置上的插件依赖解析 + node_modules 符号链接断言）
node /home/forbackup/Dev/mydsh/tests/check-preset.mjs

# sandbox 补丁单测
cd /home/forbackup/deepseek-harness
pnpm vitest run packages/sandbox/sandbox/tests/escalation.spec.ts
```

## 使用提示

- **完成提醒**：浏览器开着（即使标签页在后台）→ 走浏览器通知；浏览器没开 → 主机 `notify-send`
  （需图形会话）。所有事件追加到 `$DSH_HOME/mydsh/notify.jsonl`。
- **多任务识别**：通知带会话标题（标题→目录名→短 id），后台标签页会在标签栏闪烁 `[✓] 任务名`；
  点击通知可定位并打开该会话；同一任务完成只会有一个标签页发声（跨标签去重）。
- **视觉**：直接对模型说「看一下这张图」并给出图片路径；或让模型用 `vision_describe`。
- **批注**：悬停一条回复 → 点击「✎ 批注」；先选中回复里的文字会被自动摘录进批注。
- **多标签**：会话头「⧉」一键新标签页打开本会话；手动访问 `http://127.0.0.1:3081/?session=<id>` 也可直达。侧栏底部「新建」按钮弹出工作区选择框，选定后在该工作区新建会话并新标签页打开。
- **视频**：让模型在回复里写 `[demo.mp4](/绝对/路径/demo.mp4)` 这种链接，页面自动渲染播放器。

## 升级与维护

- DSH 升级后：重跑 `./install.sh`（会把插件重新铺好），再用 `patches/apply-patches.sh`
  检查/重放 sandbox 补丁（幂等，已应用会自动跳过）。
- 升级可能覆盖 checkout 里的补丁文件 → 用 `git apply` 重放，或在升级前 `git stash`。
- 改动任何插件后：改仓库文件 → `./install.sh`（host/浏览器插件行热重载或刷新页面生效；
  改插件代码本身需重启进程）。