# mydsh 经验教训与决策记录

> 本文记录项目开发过程中的关键决策、踩坑、和经验教训。
> 目的：让未来的 AI 工具或人类开发者能理解「为什么这样做」而非仅「做了什么」。

## 核心原则

### 1. 不要用户说什么就做什么

用户的需求是方向，但具体实现需要自己判断。每一条建议都要分析：
- 是否适合当前架构（DSH 的 slot 系统、host/preset/client 分层）
- 是否有更好的替代方案
- 是否有潜在风险（安全、性能、兼容性）
- 维护成本是否值得

如果不同意，要明确告知用户原因，不要默默执行。沉默等于默认同意，后面出问题。

### 2. UI 位置不是随便选的

DSH 有明确的 UI 插槽层级：
- settings.general.item — 全局偏好（Appearance, Language, Permission）
- conversation.session.header.actions — 会话级操作（每个会话头部的按钮）
- conversation.chat.assistant-actions — 消息级操作（每条助手消息的操作条）
- conversation.input.dock — 输入框区域（会话级，有 sessionId）

规则：配置项放 settings，会话级操作放 session header，消息级操作放 assistant-actions。
检测逻辑（null 组件）可以放 input dock（不占视觉空间）。

### 3. 不成熟的功能不要放

批注功能（ui-annotate）的第一版只存 localStorage，不进对话历史，
用户无法通过批注真正与模型交互。放上去反而误导。
不完整的功能比没有功能更糟糕。

正确做法：留待 v2 做完整的选中文本到加批注到followup对话。

## 踩坑记录

### 坑 1：React 隐藏标签页延迟 re-render

现象：浏览器通知只在用户切回标签页时才响一声。
根因：React 18+ concurrent rendering 在标签页隐藏时延迟 re-render。
useEffect 直到标签页重新可见才触发，此时 document.hidden 已为 false。
教训：不要依赖 React 渲染周期做必须在后台触发的操作。
用 setInterval 直接轮询 store 快照，绕过 React 调度。

### 坑 2：Config HMR 静默失败

现象：编辑 cordis.patch.yml 后插件行不热生效。
根因：cordis-plugin-hmr 服务构造需要 loader.internal，
通过 --expose-internals 标志获取。当前环境没传此标志，被 try/catch 静默吞掉。
教训：调试 HMR 问题时先检查 --expose-internals 是否在进程参数里。

### 坑 3：restart.sh 从 agent 内调用时自杀

现象：restart.sh 杀掉 dsh 进程后自己也死了。
根因：agent 的 bash 工具是 dsh 的子进程，kill dsh 连带杀子进程。
教训：从进程内部重启自身时，必须用 setsid 脱离父进程组。

### 坑 4：UA 覆盖不是改一个变量就行的

现象：第三方中转站返回 403 client_restricted。
根因：DSH 的 requestHeaders() 函数会剥离用户 headers 中的 user-agent（reserved name）。
教训：要改 UA 需要两层 patch：attribution.ts + adapter.ts 的 requestHeaders()。

### 坑 5：ui-video 生命周期旁路

现象：MutationObserver disposer 挂在 window 全局变量。
根因：没有走 cordis effect 生命周期，插件卸载时不会自动清理。
教训：所有资源都要通过 ctx.effect 或 useEffect cleanup 管理，不要旁路到全局变量。
**修复状态**：第一版标注「已修」但实际只是把 disposer 挂到 window.__mydshVideoDispose
（框架无法调度），observer 在插件卸载时仍泄漏。2026-08-16 压测发现并彻底修复：
改走 ctx.effect，disposer 由框架在卸载时调用，断开 observer 并重置 started 标志。


### 坑 6：Cordis config 块导致预设加载崩溃

现象：给 vision-tool 的 agent.cordis.yml 行加了 config 块后，
新建会话功能完全失效（预设加载崩溃，且错误被静默吞掉）。

根因：Cordis 的 resolveConfig() 在插件有 config 时会检查 runtime.Config
（schemastery schema）。我们的 vision-tool.ts 只导出了 TypeScript interface
（运行时被擦除），没有导出 export const Config（schemastery schema）。
当 YAML 里有 config 块时，Cordis 尝试验证 config，在没有 schema 的情况下
行为异常，导致预设加载崩溃。错误没有明显日志输出（在终端 stderr 上），
从 AI agent 侧完全看不到。

教训：
1. 不要给本地插件（./xxx.ts）的 YAML 行加 config 块，除非该插件导出了
   export const Config（schemastery schema）。TypeScript interface 不算。
2. 如果要传配置，要么在插件源码里写默认值，要么导出 schemastery schema。
3. 新会话创建失败时，首先检查 settings.yaml 的 agent-presets.default
   指向的预设是否能正常加载（临时改成 standard 排除预设问题）。
4. 排查预设加载问题最快的方法：在 settings.yaml 里把 default 改成 standard，
   如果能建会话，就是预设的问题；然后在预设里逐行注释自定义插件行。

### 坑 7：预设本地插件的裸依赖在部署位置解析不到

现象：选择「mydsh 模式」新建会话失败（default 指向 code 时可建），
API 报 agent-preset-invalid + `Cannot find module '@deepseek-ai/dsh-tools'`，
Require stack 指向 ~/.dsh/.agent-presets/mydsh/plugins/*.ts。

根因：预设目录在用户 home 下。预设「行的名字」是裸包名时，
dsh-agent-presets 的 PresetTree.import() 会改从 harness base 解析（没问题）；
但「相对文件」行（./plugins/xxx.ts）按文件位置解析，文件里
`import '@deepseek-ai/dsh-tools'` 等裸依赖由 Node 从文件目录向上找
node_modules——home 下永远到不了 harness 的依赖树，导入必崩。

坑点：smoke 测试从仓库路径 + NODE_PATH 导入插件，掩盖了这个真实运行时的
解析失败；check-preset 只检查相对文件「存在」，没检查其「依赖可解析」。

教训：
1. 预设本地插件（./xxx.ts）的裸依赖必须在部署位置可解析。
   install.sh 用符号链接把 $DSH_HOME/profiles/node_modules 挂到
   $DSH_HOME/.agent-presets/node_modules（profile 依赖根最终指向 checkout
   同一份源码，模块实例一致）。
2. 回归测试要按「部署后的解析路径」验证，而不是按仓库路径 + NODE_PATH 验证。
   check-preset.mjs 现在会解析每个相对插件文件的裸依赖，并断言符号链接存在。
3. 运行中的 dsh 进程会缓存失败的 ESM 解析，修复后必须重启进程才生效。

## 13 条社区建议采纳状态

| # | 建议 | 状态 | 理由 |
|---|------|------|------|
| 1 | ui-video 生命周期 | 已修 | 正确，改为 slots + useEffect |
| 2 | ui-session-tabs 闭包 | 已修 | 正确，用 props 替代模块级变量 |
| 3 | 异步日志写入 | 不采纳 | 频率极低不阻塞；增加复杂度不值得 |
| 4 | 通知去重合并 | 已修 | 跨标签去重（localStorage 认领）+ 并发完成独立通知，见 journal 2026-08-16 |
| 5 | media CSRF 安全 | 已修 | 正确，加 Origin 检查 |
| 6 | 批注 v2 | v2 规划 | 架构升级，当前实现不完整已移除 |
| 7 | 多图视觉 | 待做 | 功能增强，当前单图够用 |
| 8 | 勿扰/摘要 | 待做 | 体验增强 |
| 9 | 预设 config 传参 | 已修 | 正确，agent.cordis.yml 加 config |
| 10 | 健康检查端点 | 待做 | 运维便利，非紧急 |
| 11 | 测试路径参数化 | 已修 | 正确，用 homedir 替代硬编码 |
| 12 | TypeScript 类型声明 | 不采纳 | 保持零构建依赖是核心设计原则 |
| 13 | 去掉 Python 依赖 | 不采纳 | YAML marker 块用 Python 更健壮 |

## 架构决策记录

### 决策 1：四层架构
补丁层（checkout patch）/ 主机层（host plugin）/ 预设层（preset）/ 客户端层（client bundle）。
理由：DSH 的分层规则要求发布服务的行放 host；只消费的行可放任意层。

### 决策 2：手写 __ModuleLoader__ bundle
理由：用户要求少依赖外部，怕升级后变样。不依赖 tsdown/webpack。
代价：无类型检查、无 JSX、无 CSS Modules。

### 决策 3：三个 checkout 补丁
1. sandbox 同模式升级 no-op
2. UA 全局环境变量覆盖
3. per-provider UA 覆盖
每个补丁都幂等（marker 检测），可重复 apply。

### 决策 4：批注功能移除
理由：当前实现只存 localStorage 不进对话。不完整的功能比没有更糟糕。

### 决策 5：提示音设置放 Settings General
理由：DSH 标准模式，所有偏好设置都放 settings.general.item。

## 给未来开发者的建议

1. 先读 DSH 源码再写插件：slot 系统、host/preset/client 分层、PropsRuntime 标准 kit。
2. 手写 bundle 的限制：无 JSX、无 import、无 CSS Modules。
   用 createElement + inline styles + DSH CSS 变量（var(--dsw-alias-*)）。
3. 测试先行：tests/smoke.mjs 在 VM 里真实执行 bundle 并验证 slot 注册。
4. 幂等部署：install.sh 用 marker 块管理 patch 行，连续运行零漂移。
5. 补丁幂等：apply-patches.sh 用 marker 字符串检测已应用状态。
6. 不要旁路生命周期：所有资源通过 ctx.effect 或 useEffect cleanup 管理。
7. 后台操作不要依赖 React：用 setInterval/setTimeout 直接读 store。