# mydsh 过程日志（可回溯）

> 追加式记录：时间、决策、改动文件、验证结果。配合 git 提交形成完整回溯链。
> 约定：`[D]` 决策、`[A]` 动作、`[V]` 验证、`[B]` 阻塞/边界、`[F]` 修复。

## 2026-08-15 项目启动

- [D] 用户需求梳理：完成提醒 / 文件上传待验证 / 非 DeepSeek 模型 full-access 报错 /
  回复批注 / 多会话新标签页 / 视频 / modlens 视觉 / 插件化 + 完整可回溯 + KISS。
- [A] 探索 DSH checkout（`/home/forbackup/deepseek-harness`）与 `$DSH_HOME`：
  - 运行方式：`pnpm dsh web --port 3081`（tsx dev 态，改 TS 源码需重启进程生效）。
  - 组合分层：`dsh-base` bundle → `dsh-web-app` bundle → 用户 profile patch
    （`~/.dsh/profiles/web/cordis.patch.yml`）→ home patch（`$DSH_HOME/cordis.patch.yml`）
    → `--patch` overlays。两处用户 patch 均被 watch-only HMR 热重载。
  - 预设机制：shipped 预设位于 `apps/cli/config/agent-presets/`（禁止修改）；
    用户预设位于 `$DSH_HOME/.agent-presets/<id>/`；预设可引用自身目录相对文件
    （`mount.ts` 明确支持 `./xxx.ts` 行，resolve 相对预设目录）。
  - 客户端插件：必须是可解析 npm 包，package.json 声明 `dsh.client: {platform:'web'}`，
    `exports["./client"]` 指向 `lib/client.js`，bundle 格式为
    `window.__ModuleLoader__.load({id, factory})`，只能 require 平台模块表
    （react、@deepseek-ai/cordis、dsh-client-ui-slots、dsh-client-ui-primitives、
    dsh-client-web-react、dsh-client-ui-attachment、dsh-client-schema-form、react-dom 等）。
    包放在 `~/.dsh/profiles/node_modules/@mydsh/*`（healProfilesModuleFallback 只增不删）。
  - 关键事件：`agent/status`（Scoped<Agent>，idle⇄running）— 完成通知的主信号；
    `session/event` 持久回放流。
  - 客户端服务：layout / locale / sessions / slots / theme / timer / workspaces；
    会话快照 `ConversationSnapshot.running` 用于浏览器侧判断运行中。
  - 槽位：`conversation.chat.assistant-actions`（ownerProps: messageId）→ 批注；
    `conversation.session.header.actions`（sessionId）→ 新标签页；
    会话作用域任意槽位可用 `useSession`。
  - `llm` 服务：`stream(GenerateOptions)`；图片块 `{type:'image', attachment}`，
    pi-ai 适配器把 durable ref 转 base64 data URL（qwen-vl-max 已配好
    `aliyun-bailian-vision` provider）。
  - attachment 通道 v1 仅图片（png/jpeg/webp/gif）。
  - 会话选择持久化：localStorage `dsh.sessions.current`（仅重载种子，无跨标签页存储事件监听）。
- [D] 架构定稿（见 design.md）：四层 = checkout 补丁 / 主机层 / 预设层 / 客户端层。
- [A] `git init` 于 `/home/forbackup/Dev/mydsh`；创建骨架与 design.md。

## 2026-08-15 实现阶段

- [A] 写入架构文件：`docs/design.md`（四层架构）、`docs/journal.md`（本文件）。
- [F] **sandbox 同模式升级修复**：
  - 改 `deepseek-harness/packages/sandbox/sandbox/src/escalation.ts`：`requestedMode === effectiveMode`
    时直接返回（no-op 放行，不询问审批）；严格更窄的请求仍 fail-closed。
  - 同步更新 `tests/escalation.spec.ts`：新增「同模式 no-op 授予且不询问」用例，
    原「非放宽请求」用例改为「严格更窄请求」。
  - [V] `pnpm vitest run packages/sandbox/sandbox/tests/escalation.spec.ts` → 12/12 通过。
  - 导出补丁 `patches/sandbox-same-mode-escalation.patch` + 幂等重放脚本 `patches/apply-patches.sh`。
- [A] **mydsh 预设**：复制 shipped `standard` → `preset/`，改动：
  - persona：mydsh 身份（中文沟通、notify_user / vision_describe 说明、完成时总结）；
  - 新增两个私有工具行（相对路径引用 preset 内文件）：
    `mydsh-notify-tool`（notify_user）、`mydsh-vision`（vision_describe / modlens）。
  - `preset.yml`：名称「mydsh 模式」。
- [A] **主机层插件** `host/notify.ts`（agent/status 下降沿 → JSONL + notify-send 探测一次）、
  `host/media.ts`（`/mydsh-media` 路由：单段 encodeURIComponent 路径、Content-Type、206 Range）。
- [A] **浏览器插件**（手写 `__ModuleLoader__` bundle，仅 require 平台模块表 react）：
  - `@mydsh/ui-notify`：`conversation.input.dock` 空组件订阅 `useSession(s=>s.running)`，
    running→idle 且页面后台 → Notification + 提示音。
  - `@mydsh/ui-annotate`：`conversation.chat.assistant-actions` 批注按钮 + 弹层，
    mousedown 捕获选区，localStorage `mydsh.annotations.v1` 分桶存储。
  - `@mydsh/ui-session-tabs`：会话头「⧉」复制+新标签页打开 `?session=<id>`；
    加载时按 URL 选会话（等列表 ready 且包含目标后 `sessions.open`）。
  - `@mydsh/ui-video`：MutationObserver 把消息里指向本地媒体的 `<a>` 替换成
    `<video>/<audio>`（src=`/mydsh-media/<b64 绝对路径>`）。
- [A] **部署**：`install.sh`（幂等：rsync 预设/插件 + Python 改写 patch marker 块 + 补丁重放），
  部署到 `$DSH_HOME`；`manifest.json` 记录文件→目标映射。
- [V] **验证**：
  - patch 文件 YAML 解析 OK，6 行插件（2 host + 4 client）就位；
  - 实时运行验证：`window.__DSH_BOOT__` 图已包含 4 个 `@mydsh/*` 客户端插件，
    `/plugins/@mydsh/ui-notify/client.js` 200 可服务 —— 说明 profile patch 热重载生效；
  - `tests/check-preset.mjs`：31 行全部可解析/可导入（相对文件 + 裸包名 + cordis: 内建）；
  - `tests/smoke.mjs`：4 个客户端 bundle 在 VM 中真实执行 apply 并注册到正确槽位；
    主机插件（notify 状态机、media 200/206/404）；预设工具（notify_user 执行、
    vision_describe 走真实 defineTool + 假 attachments/llm 流式返回、缺失文件报错）。
- [B] **已知边界（记录在案）**：
  - 浏览器插件热重载走 config-HMR（行变更即时生效）；但**插件代码变更需重启进程**
    （web profile 关闭了模块级 HMR）。media.ts 的双重 decode bug 已在仓库修复并单测通过，
    但当前运行的进程仍是旧模块 —— 需要重启 dsh 才能让线上路由用上新代码。
  - sandbox 补丁同理需重启生效。
  - 核心 attachment 通道 v1 仅图片；视频走「绝对路径 + /mydsh-media 路由」方案。
  - 批注 v1 存浏览器 localStorage；升级到 host 存储（模型可见）留作 v2。
  - 文件上传（非图片）行为待实测确认（用户标注"待确定"）。

### 补充记录（同日）

- [F] `host/media.ts` 双 decode bug：先对整条 pathname `decodeURIComponent` 会把
  `%2F` 还原成 `/`，破坏「单编码段」判定 → 改为只对后缀段解码。已在仓库修复，
  smoke 测试直接驱动 handler 验证 200 / 206 Range / 404 全部通过。
- [B] 模块级热重载在当前 web profile 是关闭的（bundle 注释：TODO 待测）。
  因此**插件代码**的改动（media.ts 修复、sandbox 补丁）必须重启 dsh 进程才生效；
  patch 配置行（增删插件行）则可热重载（实测：写 patch 后 `__DSH_BOOT__` 图立即
  出现 4 个 @mydsh 客户端插件）。
- [A] `install.sh` 幂等修正：splice 输出归一化（只留一个结尾换行），重复执行零漂移。
- [V] 幂等实测：连续两次 `./install.sh --no-patch`，patch 文件 diff 为空。
- [V] 文件上传（非图片）结论：composer 草稿模型只有 text + `imageIds`，核心
  attachment 通道 v1 仅收图片（png/jpeg/webp/gif）→ **非图片文件暂不能经输入框上传**，
  视频/其它文件走「绝对路径引用 + /mydsh-media 路由」方案（用户标注"待确定"，此处已定案）。
- [A] git 初始提交 `08ed94e`；全部验证脚本（tests/）入库。
- [TODO] 用户侧收尾：重启 `pnpm dsh web --port 3081` 让 sandbox 补丁 + 最新插件代码
  生效；浏览器刷新；新会话选择「mydsh 模式」实测。
