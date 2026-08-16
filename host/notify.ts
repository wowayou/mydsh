/**
 * mydsh — 主机层「任务完成通知」插件（host plane）。
 *
 * 监听 `agent/status`（running → idle 的下降沿），做两件事：
 *   1. 追加 JSONL 日志到 `$DSH_HOME/mydsh/notify.jsonl`（可回溯的过程记录）；
 *   2. 尽力调用桌面通知 `notify-send`（探测一次可用性并缓存；无桌面会话则跳过）。
 *
 * 挂在 `~/.dsh/profiles/web/cordis.patch.yml`（或 home patch），随 patch 热重载。
 * 不发布任何服务 —— 纯监听行，符合 preset/host 分层规则（跨会话行为 → host）。
 *
 * 浏览器侧的可视提醒由客户端插件 `@mydsh/ui-notify` 负责（Notification API + 提示音）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { execFile, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'mydsh-notify'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LOG_DIR = join(DSH_HOME, 'mydsh')
const LOG_FILE = join(LOG_DIR, 'notify.jsonl')

/** 探测桌面通知能力：需要图形会话 + notify-send 可执行。结果缓存，避免反复 spawn。 */
let osNotifyAvailable: boolean | undefined
function probeOsNotify(): boolean {
  if (osNotifyAvailable !== undefined) return osNotifyAvailable
  const hasDisplay = process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
  osNotifyAvailable = false
  if (hasDisplay) {
    try {
      const probe = spawnSync('notify-send', ['--version'], { timeout: 3000 })
      osNotifyAvailable = probe.error === undefined && probe.status === 0
    } catch {
      osNotifyAvailable = false
    }
  }
  return osNotifyAvailable
}

/** 会话名：优先 agent.id（= sessionId），并尽力附加 cwd 目录名作为人类可读提示；无 id 时取标题字段，兜底 unknown。 */
function sessionLabel(agent: { id?: unknown; sessionId?: unknown; title?: unknown; session?: { header?: { cwd?: unknown } } } | undefined): string {
  if (agent === undefined) return 'unknown'
  const id = String(agent.id ?? agent.sessionId ?? '')
  if (id !== '' && id !== 'undefined') {
    // 会话标题在事件日志里（host 侧不重读），这里用创建时的工作目录名做提示：
    // 与浏览器侧 displayTitle 的兜底逻辑一致（title → cwd 目录名 → id）。
    const cwd = agent.session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''
      if (base !== '') return `${base} (${id.slice(0, 8)})`
    }
    return id
  }
  const title = String(agent.title ?? '')
  return title !== '' && title !== 'undefined' ? title : 'unknown'
}

export function apply(ctx: Context): void {
  mkdirSync(LOG_DIR, { recursive: true })
  const canNotify = probeOsNotify()
  // 记录每个 agent 的最近状态，只在 running → idle 的下降沿发提醒，避免重复轰炸。
  const lastStatus = new Map<string, string>()

  // 自诊断心跳：插件 apply 生效即落一条日志（也用于确认 host 行确实挂载）。
  try {
    appendFileSync(LOG_FILE, `${JSON.stringify({ t: new Date().toISOString(), event: 'plugin-started' })}\n`)
  } catch { /* noop */ }

  ctx.on('agent/status', (payload: { agent?: { id?: unknown; sessionId?: unknown; title?: unknown }; status: string }) => {
    const { agent, status } = payload
    const sessionId = sessionLabel(agent)
    const prev = lastStatus.get(sessionId)
    lastStatus.set(sessionId, status)
    // 诊断：每次状态变化都落一条记录（transition + 时间），方便回溯与排障。
    try {
      appendFileSync(LOG_FILE, `${JSON.stringify({ t: new Date().toISOString(), event: 'agent-status', sessionId, prev: prev ?? null, status })}\n`)
    } catch {
      // 日志失败不阻断通知。
    }
    if (!(prev === 'running' && status === 'idle')) return

    const record = { t: new Date().toISOString(), event: 'agent-idle', sessionId }
    try {
      appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`)
    } catch {
      // 日志失败不阻断通知。
    }
    if (canNotify) {
      execFile('notify-send', ['--app-name=mydsh', '✅ 任务完成', `会话 ${sessionId} 已完成`], () => {})
    }
  })
}
