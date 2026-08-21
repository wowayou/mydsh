# @mydsh/ui-video

**Play local video/audio referenced in a conversation** on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a link to a local media file in a message is replaced by a real `<video>`/`<audio>` player.

Part of [mydsh](https://github.com/wowayou/mydsh). Hand-written `__ModuleLoader__` bundle, pure DOM — it does not even require `react`.

## Requires the host media route

The player's `src` is `/mydsh-media/<encodeURIComponent(absolute path)>`, served by the
**host-side** plugin `host/media.ts` in the [mydsh repo](https://github.com/wowayou/mydsh)
(loopback only, media extensions allow-list, `Origin`/`Referer` check, HTTP Range support).
That half is **not** in this npm package: install it from the repo (`./install.sh`) or copy
`host/media.ts` into `$DSH_HOME/profiles/web/plugins/` and add its row.

Without that route the plugin **degrades instead of breaking**: the player reports an error,
hides itself, and puts the original link back with a one-line reason — so you can still click
through to the file and you know why nothing played.

## Install

```bash
dsh plugin --profile web add @mydsh/ui-video

# pnpm 9 refuses a root add (ERR_PNPM_ADDING_TO_ROOT) — pass -w:
#   dsh plugin --profile web add -w @mydsh/ui-video

# check the row made it into the composed tree:
#   dsh --profile web --dump-config | grep mydsh
```

Then reload the browser tab. Manual alternative — add the row to
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mydsh-ui-video
      name: '@mydsh/ui-video'
```

## Usage

Write the media link with an **absolute path** in a message (you or the model):

```markdown
[demo.mp4](/home/me/videos/demo.mp4)
```

A `MutationObserver` on the conversation area rewrites `<a>` links whose href ends in
`.mp4/.webm/.mov/.m4v/.mkv/.ogv` (→ `<video controls>`) or
`.mp3/.wav/.ogg/.flac/.m4a` (→ `<audio controls>`).

Only hrefs that are a **single-leading-slash absolute path** are touched — exactly the shape
the host route accepts. `http(s)`, `data:`, `blob:`, `javascript:`, protocol-relative
(`//host/x.mp4`) and relative hrefs are left completely alone, so nothing in a message can
be turned into a media request that was not already a local file path.

The original `<a>` is never thrown away: it is kept inside the player's wrapper and shown
again if playback fails. Processed nodes are marked, so it is idempotent and new messages are
handled as they stream in. The observer is owned by the plugin's `ctx.effect` lifecycle, so
unloading the plugin disconnects it — and no globals are left on `window`.

## Compatibility · uninstall

- Verified against **dsh `0.1.0-rc.5`**, web profile. It only observes the DOM and inserts
  its own nodes — it never patches host code.
- Installed twice (npm bundle layer **and** mydsh's repo rows), the duplicate copy starts no
  observer and logs one `console.warn` naming the fix.
- Best-effort, single-maintainer, in the open — issues welcome, no SLA.
- Uninstall: `dsh plugin --profile web remove @mydsh/ui-video`, then reload the tab.

## 中文

DSH 的**本地视频/音频播放**：消息里用绝对路径写的媒体链接（`[demo.mp4](/绝对/路径/demo.mp4)`）
自动渲染成 `<video>`/`<audio>` 播放器，`src` 指向主机层路由 `/mydsh-media/<路径>`。

**前提**：播放地址由 mydsh 仓库的主机层插件 `host/media.ts` 提供（仅 loopback、
只服务媒体扩展名、带 Origin 校验与 Range 支持），**不在本 npm 包内** ——
只装本包会渲染出播放器但取不到数据。请用仓库的 `./install.sh` 部署主机半边。

安装：`dsh plugin --profile web add @mydsh/ui-video`（pnpm 9 会要求加 `-w`），然后刷新页面。

只装浏览器半边也不会「坏掉」：播放器取不到数据时会自己隐藏，把原链接显示回来并附一句原因，
你照样点得开文件。只改写「单个前导斜杠的绝对路径」链接（正是主机层路由能接受的形状），
`http(s)`/`data:`/`blob:`/`javascript:`/协议相对（`//host/x.mp4`）/相对路径一律不动。
对 dsh `0.1.0-rc.5` 验证过；只观察 DOM、只插自己的节点，不改宿主代码，也不往 `window` 挂全局名。
两条安装路径都装了的话，重复那份不启动 observer，只打一条告警。个人维护、尽力而为、无 SLA。
卸载：`dsh plugin --profile web remove @mydsh/ui-video`，然后刷新页面。

## License

MIT © 2026 wowayou
