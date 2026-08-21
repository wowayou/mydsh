# @wowayou/ui-notify

Browser-side **task completion notification** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): when an agent turn finishes, the tab raises a `Notification` and plays a sound — including when the tab is in the background.

Part of [mydsh](https://github.com/wowayou/mydsh). Hand-written `__ModuleLoader__` bundle, zero build dependencies (only `react` from the platform module table).

## Install

```bash
dsh plugin --profile web add @wowayou/ui-notify

# pnpm 9 refuses a root add (ERR_PNPM_ADDING_TO_ROOT) — pass -w:
#   dsh plugin --profile web add -w @wowayou/ui-notify

# check the row made it into the composed tree:
#   dsh --profile web --dump-config | grep mydsh
```

`dsh plugin` is a pnpm forwarder over `$DSH_HOME/profiles/<profile>`; this package declares
`dsh.bundle.patch`, so dsh appends it to the profile's bundle list and its `cordis.patch.yml`
inserts the plugin row. Reload the browser tab afterwards.

Manual alternative — add the row to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mydsh-ui-notify
      name: '@wowayou/ui-notify'
```

## What you get

- **Notification per finished session.** The title carries the session's display title
  (title → workspace basename → short id), so concurrent tasks stay distinguishable
  (one `tag` per session, so completions never replace each other).
- **Background tabs work.** The check polls the sessions store on an interval instead of
  relying on React re-render, which browsers defer in hidden tabs.
- **Which tab finished.** A hidden tab flashes its `document.title` to `[✓] <task>`.
- **Click to focus.** Clicking the notification focuses the tab and opens that session.
- **Cross-tab dedupe.** A `localStorage` claim (30s window) makes exactly one tab sound
  per completion; the tab where the session is current wins.
- **Custom sound, with a size cap.** Settings → General → a row to upload an audio file
  (stored as a `localStorage` base64 data URL, **512 KB max**); falls back to a Web Audio
  beep. The cap exists because the `localStorage` quota is shared across the whole origin —
  a multi-megabyte sound could starve the dsh UI's own writes. A rejected or failed save is
  shown in that row, never swallowed.
- **Mute switch.** Same row: mute keeps the desktop notification and drops the sound, so
  you don't have to uninstall the plugin to work in a quiet room. `Test` always plays.

It watches **all** sessions in the list, not just the current one, so a background task in
the same tab also pings.

## Notes

- Requires notification permission; the browser asks on first use.
- Chromium autoplay policy: the sound needs one prior user interaction in the tab.
- No network, no telemetry. Only `localStorage` keys `mydsh.notify.*`.
- Installed twice (npm bundle layer **and** mydsh's repo rows), the duplicate copy
  registers nothing and logs one `console.warn` telling you which install path to drop —
  so you never get two notifications per completion.

## Compatibility · uninstall

- Verified against **dsh `0.1.0-rc.5`**, web profile. Registration is by UI slot name; if a
  future dsh renames or drops a slot, the plugin logs one `console.warn` and does nothing
  else — it never patches or wraps host code, so it cannot break the host UI.
- Best-effort, single-maintainer, in the open — issues welcome, no SLA.
- Uninstall: `dsh plugin --profile web remove @wowayou/ui-notify`, then reload the tab.
  (Custom sound and mute state stay in `localStorage`; clear the `mydsh.notify.*` keys to
  drop them too.)

## 中文

DSH 的**任务完成提醒**（浏览器端）：一轮 agent 结束时弹 `Notification` + 提示音，
标签页在后台也会响（用轮询读会话快照，绕开 React 在隐藏标签页的延迟渲染）。
通知标题带会话名，多任务不混；后台标签页标题闪 `[✓] 任务名`；点击通知定位并打开该会话；
多标签跨标签去重（同一次完成只响一次）；提示音可在 设置 → 通用 里换成自定义音频。

安装：`dsh plugin --profile web add @wowayou/ui-notify`（pnpm 9 会要求加 `-w`），然后刷新页面。

需要通知权限；Chromium 的自动播放策略要求标签页里先有过一次用户交互，声音才会响。
不联网、无遥测，只用 `localStorage` 的 `mydsh.notify.*`。自定义音频有 **512 KB 上限**
（localStorage 配额是整个 origin 共享的，别把宿主 UI 的写入挤掉），存不下会在设置行里
直接显示原因；同一行还有「静音」开关（只弹通知不发声，试听不受影响）。

对 dsh `0.1.0-rc.5`（web profile）验证过；按插件行名字注册 UI 槽位，宿主换名字最多打一条
`console.warn`，不改也不包宿主代码，不会把 UI 弄坏。个人维护、尽力而为、无 SLA。
卸载：`dsh plugin --profile web remove @wowayou/ui-notify`，然后刷新页面。
两条安装路径都装了的话，重复那份不注册任何东西，只打一条告警告诉你该去掉哪条 —— 不会响两声。

## License

MIT © 2026 wowayou
