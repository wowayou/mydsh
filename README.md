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
| Vision as a skill | `skills/vision` — `SKILL.md` + a zero-dependency CLI (`node scripts/dsh-vision.mjs <files…>`): images, **PDF pages**, **video frames**, multi-image compare, OCR/UI-review presets, pre-upload downscale and a result cache. Talks to the provider directly, so it works even when the main model has no image input; hot-discovered, no restart | Skill |
| Multi-session tabs | "⧉" button in session header actions: copies `?session=<id>` deep link and opens in new tab; each tab selects its own session independently. Plus a "New" button at the sidebar foot that pops a workspace picker, then opens a fresh session in that workspace in a new tab (falls back to a blank tab when no workspace exists) | Browser |
| Video support | Media links with absolute paths (`[demo.mp4](/abs/path/demo.mp4)`) auto-render as draggable `<video>/<audio>` (host `/mydsh-media` route with Range support) | Host + Browser |
| Non-DeepSeek model full-access error fix | Minimal patch to harness: same-mode "escalation" treated as no-op pass-through (`patches/`, with unit tests) | Patch |

### Quick start

```bash
# Deploy + restart + verify in one command (recommended).
# Default port is 3081 (or $DSH_WEB_PORT); it safely replaces an existing dsh web
# instance on that port, but refuses to kill a non-dsh process.
./up.sh

# Use a different port, e.g. when your own foreground dsh is on 3080.
./up.sh 3080

# Restart + verify only (skip deployment), or stop a dsh web instance.
./up.sh --no-install 3080
./up.sh --stop 3080

# The underlying scripts remain available when you need only one action:
./install.sh
./restart.sh
```

`up.sh` starts dsh with `--expose-internals` by default so `cordis.patch.yml`
plugin rows can hot-reload. Set `MYDSH_NO_HMR=1` for the hardened mode (then
configuration changes require a manual restart). A restart is required after
the first install because the running process caches failed preset-plugin
module resolution until then.

### Install the browser plugins from npm (community flow)

The four browser plugins are standalone npm packages. Each one declares
`dsh.bundle.patch`, so `dsh plugin` installs it into the profile *and* activates its
plugin row — no YAML editing:

```bash
dsh plugin --profile web add @mydsh/ui-notify
dsh plugin --profile web add @mydsh/ui-session-tabs
dsh plugin --profile web add @mydsh/ui-video          # needs the host media route, see below
dsh plugin --profile web add @mydsh/ui-annotate@preview   # preview: notes are localStorage-only

# pnpm 9 refuses a root add (ERR_PNPM_ADDING_TO_ROOT) — pass -w
# verify: dsh --profile web --dump-config | grep mydsh
```

| Package | What it is | Extra requirement |
| --- | --- | --- |
| [`@mydsh/ui-notify`](client/ui-notify) | Completion notification + sound, works in background tabs | — |
| [`@mydsh/ui-session-tabs`](client/ui-session-tabs) | `?session=<id>` deep links, one session per tab, new-session-in-new-tab | — |
| [`@mydsh/ui-video`](client/ui-video) | Local video/audio links become players | host `/mydsh-media` route (`host/media.ts`, repo install) |
| [`@mydsh/ui-annotate`](client/ui-annotate) | Notes on assistant replies | preview — model cannot see the notes |

**Pick one path, not both.** `./install.sh` writes the same plugin rows into
`$DSH_HOME/profiles/web/cordis.patch.yml` directly. Doing both puts two rows with the same
id in the composed tree (verified with `--dump-config`), i.e. the plugin mounts twice.
Installing from npm? Drop the `# ==== mydsh begin/end ====` block from your profile patch first.
Each bundle also guards itself: the duplicate copy registers nothing and logs one
`console.warn` naming the fix, so you never get two notifications for one completion.

What the packages promise an installer (they run on **your** page, so this is the contract):
no network, no telemetry, no `postinstall`, no host code patched or wrapped; the only storage
is `localStorage` under `mydsh.*`, size-capped so the origin quota shared with the dsh UI
cannot be exhausted; a missing UI slot or service degrades to one `console.warn`; every
package documents the dsh version it was verified against (`0.1.0-rc.5`) and its uninstall
command. `@mydsh/ui-annotate` is `preview` on purpose — read its README first.

### Install everything from the repo (host plugins, preset, skill)

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
- Optional (vision skill): `pdftoppm` (poppler-utils) for PDF pages, `ffmpeg`/`ffprobe` for video frames and pre-upload downscale

### Security model

| Surface | Boundary |
| --- | --- |
| `/mydsh-media` route | Loopback-only (the harness rejects `--host 0.0.0.0`). Serves **only** files with a media extension (`.mp4/.webm/.mov/.m4v/.mkv/.ogv/.mp3/.wav/.ogg/.flac/.m4a`); anything else is 404. Requests carrying an `Origin`/`Referer` must come from the dsh UI itself (same host + exact listening port). Requests **without** Origin (the `<video>` element's own load, local `curl`) are allowed — on loopback that equals the local user reading a media file. |
| `vision_describe` | Image bytes leave the machine to the configured vision provider (that is the feature). Readable paths are contained to the **session workspace** plus optional `MYDSH_VISION_EXTRA_ROOTS` (`:`-separated absolute paths, `~` ok), or a pinned `MYDSH_VISION_ROOTS` that overrides the workspace; symlinks are resolved (realpath) before the check, and the type check runs on the real path. Every attempt, allowed or denied, is audited to `$DSH_HOME/mydsh/vision.jsonl` with `via: preset-tool` — a denied read is a prompt-injection trace. The containment, media preparation (PDF pages / video frames), result cache and audit all come from one shared `lib/vision-core.mjs`, identical to the skill CLI's. |
| `skills/vision` CLI | Same containment code (`lib/vision-core.mjs`), different base root: **cwd** plus `MYDSH_VISION_EXTRA_ROOTS`, or a pinned `MYDSH_VISION_ROOTS` that command-line args cannot widen; realpath before the root check, and the extension check runs on the real path. The API key is read from `$DSH_HOME/.credentials.yaml` by the CLI itself — it never enters the model's shell, the transcript, or the audit log. Audited to the same `vision.jsonl` with `via: skill-cli`. **Honest caveat**: DSH's `SandboxMode` governs file effects only, not network/process, so this is a guardrail plus forensic trail, not an exfiltration boundary. |
| `restart.sh` | `--expose-internals` stays on by default (config HMR depends on it); `MYDSH_NO_HMR=1` runs hardened (config edits then need a manual restart). `PORT` must be an integer 0-65535. |
| `install.sh` | Deploy commands run as arg arrays (no `eval`) — hostile `$DSH_HOME`/`$DSH_PROFILE` values can no longer inject commands. |

### Architecture

```
mydsh/
├── README.md
├── LICENSE
├── docs/{design.md, journal.md}   # Architecture blueprint + traceable process log
├── preset/                        # mydsh agent preset (standard mode, personalized)
│   ├── agent.cordis.yml           #   Composition (persona + two private tool rows)
│   └── plugins/{notify-tool,vision-tool}.ts
├── skills/vision/                 # Skill: SKILL.md + scripts/dsh-vision.mjs (zero-dep CLI)
├── lib/vision-core.mjs            # Shared vision core (containment / media prep / cache / audit)
├── host/{notify,media}.ts         # Host plugins (notification listener / local media route)
├── client/                        # Browser plugins (handwritten __ModuleLoader__ bundles, zero build deps)
│   ├── ui-notify/  ui-session-tabs/  ui-video/
├── patches/                       # Sandbox + UA override patches + replay script
├── restart.sh                     # Restart dsh (setsid + --expose-internals)
├── install.sh                     # Idempotent deploy to $DSH_HOME
├── up.sh                          # One-command deploy + restart + media verification
├── tests/{smoke.mjs, check-preset.mjs}   # Smoke tests + preset validation
├── tests/vision-cli.mjs           # Vision skill CLI tests (plain `node`, no harness deps)
├── tests/npm-packages.mjs         # npm packaging checks for the four @mydsh client packages
└── manifest.json                  # File → deploy target manifest
```

> Deployed layout note: `install.sh` also creates the symlink
> `$DSH_HOME/.agent-presets/node_modules → $DSH_HOME/profiles/node_modules` so the
> preset's local plugin files (`./plugins/*.ts`) can resolve `@deepseek-ai/*`
> imports from their home-directory location (a preset-local plugin's bare
> imports resolve from the preset dir, not from the harness).

> Shared-core note: `lib/vision-core.mjs` is the single authoritative copy of the
> vision containment / media prep / cache / audit logic. The two consumer sites
> (`preset/plugins/lib/` and `skills/vision/scripts/lib/`) hold **symlinks** to it in
> the repo; `install.sh` rsyncs with `--copy-unsafe-links` so each deployed tree gets a
> real file and never depends on the repo staying in place. `tests/check-preset.mjs`
> asserts that invariant.

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
| 视觉能力（技能形态） | `skills/vision` —— `SKILL.md` + 零依赖 CLI（`node scripts/dsh-vision.mjs <文件...>`）：图片、**PDF 按页**、**视频抽帧**、多图对比，内置 OCR/UI 评审等提问预设，上传前缩放 + 结果缓存。直连 provider，所以主模型不支持图片输入时也能看图；热发现，无需重启 | 技能 |
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
├── skills/vision/                 # 技能：SKILL.md + scripts/dsh-vision.mjs（零依赖 CLI）
├── lib/vision-core.mjs            # 视觉共用核心（路径限制/素材准备/缓存/审计，预设与技能同源）
├── host/{notify,media}.ts         # 主机层插件（通知监听 / 本地媒体路由）
├── client/                        # 浏览器插件（手写 __ModuleLoader__ bundle，零构建依赖）
│   ├── ui-notify/  ui-session-tabs/  ui-video/
├── patches/                       # sandbox 同模式升级补丁 + 重放脚本
├── install.sh                     # 幂等部署到 $DSH_HOME
├── up.sh                          # 一键部署 + 重启 + media 边界验证
├── tests/{smoke.mjs, check-preset.mjs}   # 冒烟测试 + 预设解析校验
├── tests/vision-cli.mjs           # 视觉技能 CLI 测试（纯 node，不依赖 harness）
├── tests/npm-packages.mjs         # 四个 @mydsh 客户端包的 npm 打包校验（纯 node）
└── manifest.json                  # 文件 → 部署目标清单
```

## 快速开始

```bash
# 推荐：部署 + 重启 + media 安全边界验证一键完成。
# 默认端口 3081（或 $DSH_WEB_PORT）；同端口已有 dsh web 时安全替换，
# 非 dsh 进程占用时会拒绝停止，避免误杀。
./up.sh

# 例如：保留/替换运行在 3080 的 dsh web。
./up.sh 3080

# 只重启并验证（不部署），或只停止对应端口的 dsh web。
./up.sh --no-install 3080
./up.sh --stop 3080

# 需要单独操作时，底层脚本仍可直接使用。
./install.sh
./restart.sh
```

`up.sh` 默认以 `--expose-internals` 启动，`cordis.patch.yml` 的插件行可热更。
加固运行可设 `MYDSH_NO_HMR=1`（随后配置改动需手动重启）。首次部署后必须重启：
运行中的进程会缓存预设插件失败的模块解析，不重启则「mydsh 模式」仍无法新建会话。

验证：

```bash
# 插件冒烟测试（需在 harness checkout 内运行，tsx 解析 .ts；
# DSH_HOME 指向临时目录，避免测试写入真实日志）
cd /home/forbackup/deepseek-harness
DSH_HOME=/tmp/mydsh-smoke-home NODE_PATH=$HOME/.dsh/profiles/node_modules \
  node --import tsx/esm /home/forbackup/Dev/mydsh/tests/smoke.mjs

# 预设行解析校验（含部署位置上的插件依赖解析 + node_modules 符号链接断言）
node /home/forbackup/Dev/mydsh/tests/check-preset.mjs

# 视觉技能 CLI 测试（纯 node 即可，CLI 零依赖；内含本地假 provider）
node /home/forbackup/Dev/mydsh/tests/vision-cli.mjs

# 浏览器插件 npm 打包校验（纯 node；dsh.bundle.patch / files / 行 id 与 install.sh 一致性）
node /home/forbackup/Dev/mydsh/tests/npm-packages.mjs

# sandbox 补丁单测
cd /home/forbackup/deepseek-harness
pnpm vitest run packages/sandbox/sandbox/tests/escalation.spec.ts
```

## 浏览器插件（npm 安装）

四个浏览器插件是独立 npm 包，各自带 `dsh.bundle.patch`（包内 `cordis.patch.yml`），
所以 `dsh plugin` 装完即生效，不用手改 YAML：

```bash
dsh plugin --profile web add @mydsh/ui-notify
dsh plugin --profile web add @mydsh/ui-session-tabs
dsh plugin --profile web add @mydsh/ui-video              # 需要主机层媒体路由，见下
dsh plugin --profile web add @mydsh/ui-annotate@preview   # preview：批注只存 localStorage

# pnpm 9 会拒绝往 workspace root 加依赖（ERR_PNPM_ADDING_TO_ROOT）→ 加 -w
# 验证：dsh --profile web --dump-config | grep mydsh
```

| 包 | 是什么 | 额外前提 |
| --- | --- | --- |
| [`@mydsh/ui-notify`](client/ui-notify) | 完成提醒 + 提示音（后台标签页也响） | — |
| [`@mydsh/ui-session-tabs`](client/ui-session-tabs) | `?session=<id>` 深链、每标签页各选各的会话、新标签页新建会话 | — |
| [`@mydsh/ui-video`](client/ui-video) | 消息里的本地媒体链接渲染成播放器 | 主机层 `/mydsh-media` 路由（`host/media.ts`，走仓库部署） |
| [`@mydsh/ui-annotate`](client/ui-annotate) | 助手回复批注 | preview —— 模型看不见批注 |

**两条路径只选一条。** `./install.sh` 会把同样的插件行直接写进
`$DSH_HOME/profiles/web/cordis.patch.yml`；两条都走 → 组合后的 tree 里同一个 id 出现两行
（已用 `--dump-config` 实测），插件会挂载两次。要走 npm 的话，先把 profile patch 里
`# ==== mydsh begin/end ====` 这个 marker 块删掉。每个 bundle 自己也兜住了这一层：
重复的那份不注册任何东西，只打一条告警说明该去掉哪条 —— 不会一次完成响两声。

**对安装者的承诺**（这些代码跑在别人的页面上）：不联网、无遥测、无 `postinstall`、
不改也不包宿主代码；只用 `mydsh.*` 的 `localStorage` 键且都有体积上限（origin 配额是和
dsh UI 共享的，不能被插件吃满）；拿不到 UI 槽位/服务时退化成一条 `console.warn`；
每个包都写明验证过的 dsh 版本（`0.1.0-rc.5`）与卸载命令。`@mydsh/ui-annotate` 故意留在
`preview`，装之前先读它的 README。

主机插件 / 预设 / 技能仍然只从仓库装（`./install.sh`）—— 它们要落到 `$DSH_HOME` 的
不同位置，不是 npm 包的形态。

## 使用提示

- **完成提醒**：浏览器开着（即使标签页在后台）→ 走浏览器通知；浏览器没开 → 主机 `notify-send`
  （需图形会话）。所有事件追加到 `$DSH_HOME/mydsh/notify.jsonl`。
- **多任务识别**：通知带会话标题（标题→目录名→短 id），后台标签页会在标签栏闪烁 `[✓] 任务名`；
  点击通知可定位并打开该会话；同一任务完成只会有一个标签页发声（跨标签去重）。
- **视觉**：直接对模型说「看一下这张图」并给出图片路径；或让模型用 `vision_describe`。
- **视觉（技能）**：PDF / 视频 / 多图对比 / OCR 这类"重"活让模型走 `vision` 技能
  （模型自己调 `skill`，你也可以直接输入 `/vision`）。也能手动跑：
  ```bash
  node ~/.dsh/skills/vision/scripts/dsh-vision.mjs shot.png --preset ui
  node ~/.dsh/skills/vision/scripts/dsh-vision.mjs scan.pdf --pages 1-3 --preset ocr
  node ~/.dsh/skills/vision/scripts/dsh-vision.mjs demo.mp4 --frames 4 -p "用户点了哪些按钮？"
  node ~/.dsh/skills/vision/scripts/dsh-vision.mjs a.png --dry-run   # 只看会发什么，不花钱
  ```
  预设：`describe`（默认）`ocr` `ui` `chart` `code` `diff`。只读 cwd（+`MYDSH_VISION_EXTRA_ROOTS`）
  内的文件；结果按「模型+问题+图字节」缓存，重复问不重复付费。
- **批注**：悬停一条回复 → 点击「✎ 批注」；先选中回复里的文字会被自动摘录进批注。
- **多标签**：会话头「⧉」一键新标签页打开本会话；手动访问 `http://127.0.0.1:3081/?session=<id>` 也可直达。侧栏底部「新建」按钮弹出工作区选择框，选定后在该工作区新建会话并新标签页打开。
- **视频**：让模型在回复里写 `[demo.mp4](/绝对/路径/demo.mp4)` 这种链接，页面自动渲染播放器。

## 安全模型（2026-08-17 收紧）

| 面 | 边界 |
| --- | --- |
| `/mydsh-media` 路由 | 仅绑定 127.0.0.1（harness 拒绝 `--host 0.0.0.0`）。**只服务媒体扩展名**（`.mp4/.webm/.mov/.m4v/.mkv/.ogv/.mp3/.wav/.ogg/.flac/.m4a`），其余一律 404。携带 `Origin`/`Referer` 的请求必须来自 dsh UI 自身（同源 + 精确监听端口）；无 Origin 的请求（`<video>` 元素自身的加载、本地 curl）放行——loopback 下等价于本机用户读媒体文件。 |
| `vision_describe` | 图片字节会发往外部视觉 provider（功能本身）。可读路径限制在**会话工作区** + 可选 `MYDSH_VISION_EXTRA_ROOTS`（`:` 分隔绝对路径，支持 `~`）；`MYDSH_VISION_ROOTS` 一旦设置即权威根（工作区不再自动加入）。先 realpath 再校验，防符号链接逃逸，类型判定落在真实路径上。每次调用（含被拒）审计到 `$DSH_HOME/mydsh/vision.jsonl`（带 `via: preset-tool`）——被拒的读取即提示注入痕迹。路径限制 / 素材准备（PDF 页、视频帧）/ 结果缓存 / 审计 与技能 CLI 共用同一份 `lib/vision-core.mjs`。 |
| `skills/vision` CLI | 同一份路径限制代码（`lib/vision-core.mjs`），只是基准根不同：默认 = **cwd** + `MYDSH_VISION_EXTRA_ROOTS`；`MYDSH_VISION_ROOTS` 一旦设置即权威，命令行无法扩大（硬边界开关）。先 realpath 再比对根，扩展名判定也落在真实路径上。密钥由 CLI 自己从 `$DSH_HOME/.credentials.yaml` 读——不进模型的 shell、不进对话、不进审计。审计写同一份 `vision.jsonl`（带 `via: skill-cli`）。**诚实说明**：DSH 的 `SandboxMode` 只管文件效果，不管网络与进程，所以这层是护栏 + 取证，不是外渗边界。 |
| `restart.sh` | `--expose-internals` 默认保留（配置 HMR 依赖它）；`MYDSH_NO_HMR=1` 可加固运行（配置改动需手动重启）。`PORT` 强制 0-65535 整数。 |
| `install.sh` | 部署命令以参数数组直接执行（不经 `eval`）——恶意 `$DSH_HOME`/`$DSH_PROFILE` 值无法再注入命令。 |

## 升级与维护

- DSH 升级后：重跑 `./install.sh`（会把插件重新铺好），再用 `patches/apply-patches.sh`
  检查/重放 sandbox 补丁（幂等，已应用会自动跳过）。
- 升级可能覆盖 checkout 里的补丁文件 → 用 `git apply` 重放，或在升级前 `git stash`。
- 改动任何插件后：改仓库文件 → `./install.sh`（host/浏览器插件行热重载或刷新页面生效；
  改插件代码本身需重启进程）。