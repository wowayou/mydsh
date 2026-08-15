# mydsh — 我的 Agent 系统设计

> 一句话：在 DeepSeek Harness（DSH）之上，用「一切皆插件」的方式搭建自己的 Agent 系统。
> 本文件是静态架构蓝图；动态过程记录见 [`journal.md`](journal.md)。

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
┌─ 0 部署层  deepseek-harness checkout       只打一个补丁（sandbox 同模式升级）
├─ 1 主机层  $DSH_HOME/profiles/web/          宿主平面：跨会话行为（通知监听器）
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
- 所有自定义代码的权威源在本项目（`/home/forbackup/Dev/mydsh`），`install.sh` 幂等部署到 `$DSH_HOME`。

## 2. 特性 → 插件映射

| 用户诉求 | 层 | 插件/文件 | 机制 |
| --- | --- | --- | --- |
| 任务完成提醒（系统级） | 主机 | `host/notify.ts` | 监听 `agent/status`（running→idle），写 JSONL 日志 + 尽力 `notify-send` |
| 任务完成提醒（浏览器） | 客户端 | `@mydsh/ui-notify` | 会话作用域槽位组件订阅 `useSession(s=>s.running)`，idle 时 Notification + 提示音 |
| 主动通知工具 | 预设 | `preset/plugins/notify-tool.ts` | 模型可调 `notify_user(title, body)` 工具 |
| 视觉理解（modlens） | 预设 | `preset/plugins/vision-tool.ts` | 工具 `vision_describe(path, prompt)`：attachment 提交图片 → `llm.stream`（qwen-vl-max） |
| 选中回复加批注 | 客户端 | `@mydsh/ui-annotate` | `conversation.chat.assistant-actions` 槽位 + 文本选区浮动按钮，localStorage 持久化 |
| 多会话新标签页 | 客户端 | `@mydsh/ui-session-tabs` | 会话头按钮复制/打开 `?session=<id>` 深链；插件启动时按 URL 打开对应会话（各标签页互不干扰） |
| 视频支持 | 客户端 | `@mydsh/ui-video` | 消息中的本地/链接视频渲染 `<video>` 播放器（核心 attachment 仍是图片优先，视频走路径引用） |
| 非 DeepSeek 模型 full-access 报错 | 部署层补丁 | `patches/sandbox-same-mode-escalation.patch` | 同模式升级视为 no-op 直接放行，不再抛错 |

## 3. 数据流（关键路径）

### 3.1 完成通知
```
agent-loop --emit--> agent/status (running|idle)
   ├─ host/notify.ts（主机层）: idle 时 append JSONL + notify-send（如可用）
   └─ 会话快照 running 字段 -> 浏览器 useSession 订阅 -> ui-notify 发 Notification + 音效
```

### 3.2 视觉理解（modlens）
```
vision_describe(path, prompt)
  → fs 读文件 → ctx.attachments.saveImage()（复用图片提交通道，得到 durable ref）
  → ctx.llm.stream({provider:'aliyun-bailian-vision', model:'qwen-vl-max',
                     messages:[{role:'user', content:[text, image-block]}]})
  → 汇总结论文本返回给文本模型
```

### 3.3 多标签页会话
```
标签页 A: ...?session=AAA  标签页 B: ...?session=BBB
  → ui-session-tabs 启动时读 location.search → sessions.open(id)
  → 各标签页内存态独立；localStorage 只是重载种子，URL 每次覆盖
```

## 4. 目录布局

```
mydsh/
├── README.md                 # 总览 + 快速开始
├── docs/
│   ├── design.md             # 本文件
│   └── journal.md            # 可回溯过程日志（追加式）
├── preset/                   # mydsh agent 预设（权威源）
│   ├── agent.cordis.yml
│   ├── preset.yml
│   └── plugins/              # 预设私有工具（相对路径引用）
├── host/notify.ts            # 主机层通知监听器
├── client/
│   ├── ui-notify/            # 浏览器完成通知
│   ├── ui-annotate/          # 批注
│   ├── ui-session-tabs/      # 新标签页会话
│   └── ui-video/             # 视频渲染
├── patches/                  # 对 checkout 的最小补丁 + 重放脚本
├── install.sh                # 幂等部署到 $DSH_HOME
└── manifest.json             # 文件 → 部署目标清单
```

## 5. 部署机制（KISS）

| 目标 | 位置 | 生效方式 |
| --- | --- | --- |
| 主机插件 | `~/.dsh/profiles/web/plugins/*.ts`，行加进 `cordis.patch.yml` | 配置文件热重载（watch-only HMR，无需重启） |
| 客户端插件 | `~/.dsh/profiles/node_modules/@mydsh/*`（真实目录，heal 不删） | 刷新页面加载；bundle 内容变更经 dev:web/HMR |
| Agent 预设 | `~/.dsh/.agent-presets/mydsh/` | 新会话选择该预设 |
| 补丁 | checkout `packages/sandbox/sandbox/src/escalation.ts` | 重启 dsh 进程生效（dev 态 tsx 直接读源码） |

## 6. 安全与边界

- 客户端插件 bundle 只能 `require` 平台模块表（react、@deepseek-ai/cordis、
  @deepseek-ai/dsh-client-ui-slots 等），跨插件协作走 cordis 服务；
- 主机插件是普通 Node 模块（组合层），但保持最小行为：只监听、只写日志；
- 补丁仅放宽「同模式升级」为 no-op，绝不扩大任何模式的权限边界；
- 批注数据 v1 存 localStorage（浏览器本地），文档记录升级到 host 存储的路径。

## 7. 已知边界 / 后续（记录在案）

- 核心 attachment 通道 v1 只收图片（png/jpeg/webp/gif）；视频用路径引用方案，核心级
  视频通道留待上游演进；
- 文件上传（非图片）行为待实测确认（用户标注"待确定"）；
- 批注 → 模型可见（进入会话历史或 host 存储 + 查询工具）留作 v2；
- 每个客户端插件都是手写 `__ModuleLoader__` 格式 bundle，零构建依赖；
  若要接 tsdown/dev:web 生态，需把包放回 checkout `packages/client/`（记录在 journal）。
