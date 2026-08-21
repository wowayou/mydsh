# @mydsh/ui-session-tabs

**Multi-session browser tabs** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): open any session in its own tab through a `?session=<id>` deep link, and start a new session in a chosen workspace in a new tab.

Part of [mydsh](https://github.com/wowayou/mydsh). Hand-written `__ModuleLoader__` bundle, zero build dependencies (only `react`/`react-dom` from the platform module table).

## Install

```bash
dsh plugin --profile web add @mydsh/ui-session-tabs

# pnpm 9 refuses a root add (ERR_PNPM_ADDING_TO_ROOT) — pass -w:
#   dsh plugin --profile web add -w @mydsh/ui-session-tabs

# check the row made it into the composed tree:
#   dsh --profile web --dump-config | grep mydsh
```

Then reload the browser tab. Manual alternative — add the row to
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mydsh-ui-session-tabs
      name: '@mydsh/ui-session-tabs'
```

## What you get

- **"⧉" in the session header action row** — copies `?session=<id>` to the clipboard and
  opens that session in a new tab. Uses the `sessionId` prop from the framework kit
  (no module-level service lookup), so it always targets the session you clicked.
- **URL deep links** — a null component in `conversation.input.dock` reads `?session=<id>`
  on load and opens the matching session. Each tab therefore selects its own session
  independently: `localStorage` is only a reload seed, the URL always wins.
- **"New" at the sidebar foot** — pops a workspace picker (current pick marked ✓), then
  opens a fresh session in that workspace in a new tab. With no workspace configured it
  degrades to opening a blank new tab.

Visit `http://127.0.0.1:<port>/?session=<id>` by hand and you land on that session too.

## Compatibility · uninstall

- Verified against **dsh `0.1.0-rc.5`**, web profile. Registration is by UI slot name; if a
  future dsh renames or drops a slot, the plugin logs one `console.warn` and does nothing
  else — it never patches or wraps host code.
- No network, no telemetry, no storage of its own. `window.open` and the clipboard write
  only ever happen from your click.
- Installed twice (npm bundle layer **and** mydsh's repo rows), the duplicate copy registers
  nothing and logs one `console.warn` naming the fix — so you never get two "⧉" buttons or a
  deep link opened twice.
- Best-effort, single-maintainer, in the open — issues welcome, no SLA.
- Uninstall: `dsh plugin --profile web remove @mydsh/ui-session-tabs`, then reload the tab.

## 中文

DSH 的**多会话新标签页**：会话头操作行「⧉」一键把 `?session=<id>` 深链复制并在新标签页打开；
输入区一个不占位的 null 组件负责读 URL 打开对应会话，所以每个标签页各选各的会话互不干扰
（`localStorage` 只是重载种子，URL 每次覆盖）。侧栏底部「新建」按钮弹出工作区选择框，
选定后在该工作区新建会话并新标签页打开（无工作区时退化为打开空白标签页）。

安装：`dsh plugin --profile web add @mydsh/ui-session-tabs`（pnpm 9 会要求加 `-w`），然后刷新页面。
手动访问 `http://127.0.0.1:<端口>/?session=<id>` 也能直达某个会话。

对 dsh `0.1.0-rc.5`（web profile）验证过；按名字注册 UI 槽位，宿主换名字最多打一条
`console.warn`，不改也不包宿主代码。不联网、无遥测、自己不存任何数据；`window.open` 与
写剪贴板都只在你点击时发生。两条安装路径都装了的话，重复那份不注册任何东西，只打一条告警
（不会出现两个「⧉」、也不会把深链打开两次）。个人维护、尽力而为、无 SLA。
卸载：`dsh plugin --profile web remove @mydsh/ui-session-tabs`，然后刷新页面。

## License

MIT © 2026 wowayou
