# mydsh — 我的 Agent 系统设计

> 一句话：在 DeepSeek Harness（DSH）之上，用「一切皆插件」的方式搭建自己的 Agent 系统。
> 本文件是静态架构蓝图；动态过程记录见 [`journal.md`](journal.md)；
> 经验教训与决策记录见 [`POSTMORTEM.md`](POSTMORTEM.md)。

## 0. 背景与约束

- 宿主：DeepSeek Harness（Cordis 组合式运行时），开发态跑在 `apps/cli/src/bin.ts`（tsx）。
- 用户诉求（原话要点）：
  1. 任务完成之后没有提醒；
  2. 文件上传待验证、图片粘贴可用；
  3. 标准模式 full access 下，非 DeepSeek 模型报
     `sandbox escalation to "danger-full-access" is not strictly wider than this call's current "danger-full-access" mode`；
  4. 想要 Codex 式「选中回复加批注」；
  5. 多个 Session 能在新窗口打开（不同标签页访问同一地址、各选各的会话）；
  6. 视频支持；任务完成提醒等全部做成自己的插件；
  7. modlens 视觉插件：让文本模型看懂图片；
  8. 完整记录过程、可回溯；KISS；少依赖外部，怕升级后变样。
- FAQ 实测：执行中关浏览器不丢任务（会话持久化在 `$DSH_HOME/sessions`）。

## 1. 哲学：一切皆插件

DSH 的每个能力都是一条 `cordis.yml` 里的插件行。我的系统 = 用户拥有的四层：

```
┌─ 0 部署层  deepseek-harness checkout       补丁（sandbox 同模式升级 + UA 覆盖）
├─ 1 主机层  $DSH_HOME/profiles/web/          宿主平面：跨会话行为（通知监听器 / 媒体路由）
│             cordis.patch.yml + plugins/
├─ 2 预设层  $DSH_HOME/.agent-presets/mydsh/  Agent 预设：一个会话的组成
│             agent.cordis.yml + preset.yml + plugins/
└─ 3 客户端层 $DSH_HOME/profiles/node_modules/@mydsh/
             浏览器插件：通知 / 批注 / 多标签会话 / 视频
```

原则（取自 DSH 官方 `editing-cordis-compositions` skill）：
- 发布服务的行 → 主机组合或 preset 内的 `isolate` realm；
- 只消费的行 → 放哪层都行，按「是否跨会话共享」判断；
- **永不修改随部署安装的 shipped preset**（`apps/cli/config/agent-presets/`）——升级会覆盖；要改就拷贝。
- 所有自定义代码的权威源在本项目，`install.sh` 幂等部署到 `$DSH_HOME`。

## 2. 特性 → 插件映射

| 用户诉求 | 层 | 插件/文件 | 机制 |
| --- | --- | --- | --- |
| 任务完成提醒（系统级） | 主机 | `host/notify.ts` | 监听 `agent/status`（running→idle），写 JSONL 日志 + 尽力 `notify-send` |
| 任务完成提醒（浏览器） | 客户端 | `@mydsh/ui-notify` | `conversation.input.dock` null 组件 + useSession + setInterval 轮询，idle 时 Notification + 提示音 |
| 自定义提示音 | 客户端 | `@mydsh/ui-notify` | `settings.general.item` 设置卡片：上传音频文件 → localStorage base64，回退 Web Audio beep |
| 主动通知工具 | 预设 | `preset/plugins/notify-tool.ts` | 模型可调 `notify_user(title, body)` 工具 |
| 视觉理解（modlens） | 预设 | `preset/plugins/vision-tool.ts` | 工具 `vision_describe(path, prompt)`：attachment 提交图片 → `llm.stream`（qwen-vl-max） |
| 视觉理解（技能层） | 技能 | `skills/vision/{SKILL.md,scripts/dsh-vision.mjs}` | `skill` 工具按需加载指令 → bash 跑零依赖 CLI，直连 provider HTTPS；支持多图/PDF 页/视频帧/上传前缩放/结果缓存 |
| 多会话新标签页 | 客户端 | `@mydsh/ui-session-tabs` | `conversation.session.header.actions` 会话头「⧉」按钮 + `conversation.input.dock` URL 打开器 |
| 视频支持 | 客户端 | `@mydsh/ui-video` | `conversation.input.dock` null 组件 + MutationObserver，消息中媒体链接渲染 `<video>` |
| 非 DeepSeek 模型 full-access 报错 | 部署层补丁 | `patches/sandbox-same-mode-escalation.patch` | 同模式升级视为 no-op 直接放行 |
| 第三式中转站 403 client_restricted | 部署层补丁 | `patches/user-agent-override.patch` + `patches/per-provider-ua-override.patch` | UA 全局环境变量覆盖 + per-provider headers 优先 |

## 3. 数据流（关键路径）

### 3.1 完成通知
```
agent-loop --emit--> agent/status (running|idle)
   ├─ host/notify.ts（主机层）: idle 时 append JSONL + notify-send（如可用）
   └─ 会话快照 running 字段 -> 浏览器 useSession 订阅 + setInterval 轮询
      -> ui-notify 发 Notification + 播放声音（自定义音频或 beep）
```

### 3.2 视觉理解（modlens）
```
vision_describe(path, prompt)
  → fs 读文件 → ctx.attachments.saveImage()（复用图片提交通道，得到 durable ref）
  → ctx.llm.stream({provider, model, messages:[{role:'user', content:[text, image-block]}]})
  → 汇总结论文本返回给文本模型
```

### 3.2b 视觉理解（技能层，2026-08-21）

与 3.2 是**两条互补路径**，不是替代关系：

```
模型判断需要看图
  → skill('vision') 载入 SKILL.md（渐进披露：目录里只有 name+description）
  → bash: node <skill-dir>/scripts/dsh-vision.mjs <文件...> [--preset ocr|ui|...]
      ├─ 路径限制: cwd(+MYDSH_VISION_EXTRA_ROOTS) / MYDSH_VISION_ROOTS 固定
      ├─ 素材: 图片直用 | PDF→pdftoppm 渲染页 | 视频→ffmpeg 抽帧 | 长边缩到 --max-side
      ├─ 路由: $DSH_HOME/settings.yaml 的 llm-pi-ai.providers（三方言：completions/responses/anthropic）
      │        密钥: provider.apiKey → env[apiKeyEnv] → $DSH_HOME/.credentials.yaml
      ├─ 缓存: sha256(方言+baseURL+model+prompt+图字节) → $DSH_HOME/mydsh/vision-cache
      └─ 审计: cli-sent | cli-cache-hit | cli-denied | cli-failed → $DSH_HOME/mydsh/vision.jsonl
  → stdout 纯文本回到模型上下文（元信息走 stderr）
```

设计取舍：

- **不走 harness `llm` 服务**，直连 provider HTTPS。原因是 pi-ai 会按
  `model.input.includes('image')` 拦截（`UNSUPPORTED_CONTENT`），而本能力的目标恰恰
  是「主模型不支持图片时也能看图」；直连还顺带免掉 attachment 服务、免重启、
  不 import 任何 `@deepseek-ai/*` 内部包。
- **技能层 vs 预设层**：预设工具是常驻 schema（每轮都占 tool 定义），技能是按需
  加载（目录里只有一行描述）；预设工具一次调用就能把结果嵌进对话，技能能做
  多图/PDF/视频/缩放/缓存这些"重"能力。两者共用同一份审计文件。
- **密钥不进模型上下文**：CLI 自己从 `$DSH_HOME/.credentials.yaml` 读，不要求模型
  在 shell 里 export；密钥只进请求头，不打印、不写审计。
- **路径限制是护栏 + 取证，不是外渗边界**：DSH 的 `SandboxMode` 只管文件效果，
  网络与进程策略不在它的词汇表里 —— 一个被注入的模型本来就能写自己的脚本发请求。
  真要硬边界，用 `MYDSH_VISION_ROOTS` 固定根（命令行无法扩大），并盯
  `vision.jsonl` 里的 `cli-denied`。

### 3.3 多标签页会话
```
标签页 A: ...?session=AAA  标签页 B: ...?session=BBB
  → ui-session-tabs 的 UrlSessionOpener 读 location.search → sessions.open(id)
  → 各标签页内存态独立；localStorage 只是重载种子，URL 每次覆盖
```

## 4. UI 设计决策（踩坑记录）

### 4.1 通知：后台标签页不弹通知

**坑**：初始实现用 `useSession(s => s.running)` + `useEffect` 检测 running→idle 下降沿。
React 18+ 在标签页隐藏时延迟 re-render（concurrent rendering 的 batch 调度），
导致 `useEffect` 直到标签页重新可见时才触发。此时 `document.hidden` 已为 false，
通知被 `if (!hidden) return` 跳过——用户只会在切换回标签页时听到一声 beep。

**解法**：保留 React state 检测（tab 可见时即时），额外加 `setInterval(check, 500)` 轮询，
直接调 `useSession` 同步读取快照，绕过 React 渲染调度。同时移除 `document.hidden` 检查
（浏览器通知在后台标签也应弹出，主机层 `notify-send` 做兜底）。

### 4.2 自定义提示音：UI 位置演进

**第一版**：🔔 按钮放在 `conversation.input.dock`（输入框区域）。
**问题**：那是会话级交互区，配置项不应出现在那里；且依赖会话上下文，
无会话时按钮不渲染。

**最终版**：移到 `settings.general.item`（Settings → General 面板的一行）。
与 Appearance、Language、Permission 等设置并列，符合 DSH 原生模式。
root-scope，不依赖会话，刷新不丢失。

### 4.3 多标签按钮：从会话头到消息操作条

**第一版**：注册在 `conversation.session.header.actions`（会话标题栏）。
**问题**：用户希望在助手消息的「三点菜单」中找到该按钮；且使用了模块级
`sessionsService` 变量获取会话服务，违反数据流原则，会话 ID 定位不准。

**最终版**：
- 「⧉」按钮移回 `conversation.session.header.actions`（会话头操作行 = 会话级「三个点」菜单位置）；
- 「⧉」按钮移到 `conversation.chat.assistant-actions`（助手消息操作条 = 三点菜单位置）；
- 用 `sessionId` prop（PropsRuntime 框架标准 kit 直接提供）替代 `sessions` 服务闭包；
- URL 打开器（null 组件）移到 `conversation.input.dock`，不占视觉空间。

### 4.4 ui-video 生命周期

**坑**：初始实现把 MutationObserver disposer 挂在 `window.__mydshVideoDispose`，
旁路了 cordis effect 生命周期。插件卸载时不会自动断开 Observer，有内存泄漏风险。

**解法**：改为 `slots.inject` + React `useEffect` 管理 Observer 生命周期，
卸载时 `useEffect` cleanup 自动 `observer.disconnect()`。


### 4.5 批注功能：暂移除

**决策**：当前批注实现只存 localStorage（不进对话），
用户选中文本→加批注→继续对话的完整流程未实现。放上去反而误导。
移除部署，留待 v2 做完整的「选中文本 → 加批注 → followup 对话」。

## 5. HMR 热重载（踩坑记录）

### 5.1 Config HMR 不工作的根因

**现象**：编辑 `cordis.patch.yml` 后，插件行不热生效，需重启进程。

**根因**：DSH 的 config HMR 依赖 `cordis-plugin-hmr` 服务。该服务构造时
需要访问 Node.js 内部模块加载器（`loader.internal`），通过两条路径：
1. `--expose-internals` 进程标志 → `require('internal/modules/esm/loader')`
2. `node-addon-require-builtin` 回退

在当前运行环境中两条路径都没走通（`--expose-internals` 未传，
`node-addon-require-builtin` 在 tsx/esm 加载器上下文中不生效）。
`profile-boot.ts` 在 try/catch 中静默吞掉了 HMR 服务启动失败，
导致 `watchUserPatches` 从未执行。

**解法**：`restart.sh` 启动命令加 `--expose-internals` 标志。

### 5.2 HMR 两个层级

| 层级 | 机制 | 状态 |
|------|------|------|
| Config HMR | `cordis.patch.yml` 编辑 → loader tree 重组 | ✅ 需要 `--expose-internals` |
| Module HMR | 插件 .ts 源码变更 → 重新导入 | ❌ web profile 禁用（`hmr: disabled: true`）；需 `pnpm run dev:web` 重建 bundle |

### 5.3 restart.sh 自杀问题

**坑**：从 dsh agent 内部调用 `restart.sh` 时，杀死 dsh 进程会连带杀死
作为 dsh 子进程的 `restart.sh` 本身。`nohup` 不能防止此问题。

**解法**：脚本开头加 `setsid` 脱离父进程组，确保 kill 旧进程后脚本能继续执行。

## 6. UA 覆盖设计（踩坑记录）

### 6.1 问题

第三方中转站（New API / One API 类）检测到 `User-Agent: deepseek-harness/0.1.0-rc.5`
后返回 `403 channel:client_restricted`。

### 6.2 DSH 的 UA 机制

- `attribution.ts` 硬编码 `APP_IDENTITY = { product: 'deepseek-harness', version, url }`
- pi-ai adapter 的 `requestHeaders()` **剥离** user headers 中的 `user-agent`（reserved name），
  然后加全局 attribution
- deepseek adapter 直接用 `attributionHeaders()`，无 per-profile headers

### 6.3 补丁方案（三级优先级）

```
per-provider headers.user-agent  >  DSH_APP_PRODUCT 环境变量  >  默认 deepseek-harness
```

| 补丁 | 文件 | 效果 |
|------|------|------|
| `user-agent-override.patch` | `attribution.ts` | APP_IDENTITY 从 `DSH_APP_PRODUCT` / `DSH_APP_URL` 环境变量读取 |
| `per-provider-ua-override.patch` | `llm-pi-ai/adapter.ts` | `requestHeaders()` 检测 profile.headers 是否含 `user-agent`，有则用 per-provider 值 |

`restart.sh` 支持 `DSH_UA_ALIAS` 快捷别名（cursor/claude-code/codex/opencode）。

## 7. 目录布局

```
mydsh/
├── README.md                 # 总览 + 快速开始
├── LICENSE                   # MIT
├── docs/
│   ├── design.md             # 本文件（架构蓝图 + 决策记录）
│   └── journal.md            # 可回溯过程日志（追加式）
├── preset/                   # mydsh agent 预设（权威源）
│   ├── agent.cordis.yml
│   ├── preset.yml
│   └── plugins/              # 预设私有工具（相对路径引用）
├── host/notify.ts            # 主机层通知监听器
├── host/media.ts             # 主机层本地媒体路由
├── client/
│   ├── ui-notify/            # 浏览器完成通知 + 声音设置
│   ├── ui-annotate/          # 批注
│   ├── ui-session-tabs/      # 新标签页会话
│   └── ui-video/             # 视频渲染
├── patches/                  # 对 checkout 的补丁 + 重放脚本
│   ├── sandbox-same-mode-escalation.patch
│   ├── user-agent-override.patch
│   ├── per-provider-ua-override.patch
│   └── apply-patches.sh      # 幂等应用（marker 检测）
├── install.sh                # 幂等部署到 $DSH_HOME
├── restart.sh                # 重启 dsh（setsid + --expose-internals + DSH_UA_ALIAS）
├── tests/{smoke.mjs, check-preset.mjs}
└── manifest.json             # 文件 → 部署目标清单
```

## 8. 部署机制（KISS）

| 目标 | 位置 | 生效方式 |
| --- | --- | --- |
| 主机插件 | `~/.dsh/profiles/web/plugins/*.ts`，行加进 `cordis.patch.yml` | 配置文件热重载（需 `--expose-internals`）|
| 客户端插件 | `~/.dsh/profiles/node_modules/@mydsh/*`（真实目录，heal 不删） | 刷新页面加载；bundle 内容变更经 dev:web/HMR |
| Agent 预设 | `~/.dsh/.agent-presets/mydsh/` | 新会话选择该预设 |
| 补丁 | checkout 源文件 | 重启 dsh 进程生效（dev 态 tsx 直接读源码） |

## 9. 安全与边界

- 客户端插件 bundle 只能 `require` 平台模块表（react 等），跨插件协作走 cordis 服务；
- 主机插件是普通 Node 模块，保持最小行为：只监听、只写日志；
- `media.ts` 安全边界：单段路径编码 + 绝对路径校验 + Origin/Referer CSRF 检查（只允许 127.0.0.1/localhost）；
- 补丁仅放宽「同模式升级」为 no-op，绝不扩大任何模式的权限边界；
- UA 覆盖仅改变产品名，不伪造版本号或 URL；用户应遵守中转服务商规则；
- 批注数据 v1 存 localStorage（浏览器本地），无 XSS 向量（无 innerHTML/eval）；
- 自定义提示音存 localStorage base64 data URL，无敏感信息；
- 无硬编码密钥/Token（所有 Key 走 `apiKeyEnv` + `ctx.credentials`）。

## 10. 已知边界 / 后续

- 核心 attachment 通道 v1 只收图片（png/jpeg/webp/gif）；视频用路径引用方案；
- 文件上传（非图片）行为待实测确认（用户标注"待确定"）；
- 批注 → 模型可见（进入会话历史或 host 存储 + 查询工具）留作 v2；
- 多图视觉（compare/diff 模式）留作后续；
- 通知去重/合并（多会话并发 debounce）留作后续；
- 勿扰/摘要模式留作后续；
- 每个客户端插件都是手写 `__ModuleLoader__` 格式 bundle，零构建依赖；
  若要接 tsdown/dev:web 生态，需把包放回 checkout `packages/client/`。