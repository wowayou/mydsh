# @wowayou/ui-annotate (preview — read this first)

Codex-style **annotations on assistant replies** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): select text in a reply, attach a note.

> **Status: preview, deliberately incomplete.**
> Notes live in `localStorage` only. They do **not** enter the conversation history and the
> model **cannot see them** — so you cannot use an annotation to actually tell the model
> anything. The parent project ([mydsh](https://github.com/wowayou/mydsh)) therefore does
> **not** deploy this plugin by default; see `docs/POSTMORTEM.md` → "不成熟的功能不要放"
> (an incomplete feature is worse than no feature). It is published under the `preview`
> dist-tag for people who want a local scratchpad anyway. The full flow
> (select text → annotate → follow-up turn) is left for v2.

## Install

```bash
dsh plugin --profile web add @wowayou/ui-annotate@preview

# pnpm 9 refuses a root add (ERR_PNPM_ADDING_TO_ROOT) — pass -w:
#   dsh plugin --profile web add -w @wowayou/ui-annotate@preview

# check the row made it into the composed tree:
#   dsh --profile web --dump-config | grep mydsh
```

Then reload the browser tab. Manual alternative — add the row to
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mydsh-ui-annotate
      name: '@wowayou/ui-annotate'
```

## What it does

- Registers an "Annotate" button (with a count badge) in
  `conversation.chat.assistant-actions` — the action row of each finalized assistant message.
- Captures the current text selection on `mousedown` (before the browser clears it) as the
  note's excerpt, then opens a panel listing this message's notes, with add/delete.
- Stores everything under the `localStorage` key `mydsh.annotations.v1`, bucketed by
  `sessionId:messageId`. No backend, no network. Note ≤ 2000 chars, excerpt ≤ 500 chars,
  **whole store ≤ 256 KB** — the `localStorage` quota is shared across the origin with the
  dsh UI itself, so the store is not allowed to grow until the host's own writes start
  failing. At the cap, adding is refused with a visible reason (deleting always works).
- No `innerHTML`/`eval` anywhere; notes are rendered as text.

Clearing site data clears your notes; they are not part of session persistence.

## Compatibility · uninstall

- Verified against **dsh `0.1.0-rc.5`**, web profile. Registration is by UI slot name; if a
  future dsh renames or drops the slot, the plugin logs one `console.warn` and does nothing
  else — it never patches host code.
- Installed twice, the duplicate copy registers nothing and logs one `console.warn`, so no
  message ever grows two "Annotate" buttons.
- Preview quality, single-maintainer, no SLA. Do not build a workflow on it.
- Uninstall: `dsh plugin --profile web remove @wowayou/ui-annotate`, then reload the tab.
  Your notes stay in `localStorage` until you clear the `mydsh.annotations.v1` key.

## 中文

DSH 的**回复批注**（Codex 式）：选中助手回复里的文字 → 点消息操作条上的「批注」→ 写注记。

> **状态：preview，功能故意不完整。** 批注只存 `localStorage`，不进对话历史，
> 模型看不见 —— 你无法靠批注真的对模型说话。所以 mydsh 主项目默认不部署它
> （见仓库 `docs/POSTMORTEM.md`「不成熟的功能不要放」），这里以 `preview` 标签发布，
> 给只想要一个本地便签的人。完整流程（选中 → 批注 → followup 对话）留给 v2。

安装：`dsh plugin --profile web add @wowayou/ui-annotate@preview`（pnpm 9 会要求加 `-w`），然后刷新页面。
数据在 `localStorage` 的 `mydsh.annotations.v1`，按 `会话:消息` 分桶；清站点数据即丢。
单条 ≤ 2000 字、摘录 ≤ 500 字、**整库 ≤ 256 KB**（localStorage 配额是整个 origin 共享的，
不能让批注把宿主 UI 的写入挤掉）；到顶后新增会被拒绝并显示原因，删除永远放行。
对 dsh `0.1.0-rc.5` 验证过，按名字注册槽位，宿主换名字最多打一条告警，不改宿主代码；
装重了的话重复那份不注册（不会出现两个「批注」按钮）。preview 质量、无 SLA，别拿它搭流程。
卸载：`dsh plugin --profile web remove @wowayou/ui-annotate`，然后刷新页面（批注还在 localStorage 里）。

## License

MIT © 2026 wowayou
