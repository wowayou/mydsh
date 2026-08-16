/**
 * mydsh — 预设层「主动通知」工具（agent plane，随 preset 挂载）。
 *
 * 给模型一个 `notify_user(title, body)` 工具：长任务完成、需要人介入、
 * 或有值得立刻冒泡的结果时，模型可主动 ping 用户。
 * 与主机层监听器共用同一个 JSONL 日志文件（$DSH_HOME/mydsh/notify.jsonl）。
 *
 * 引用方式（agent.cordis.yml）：
 *   - id: mydsh-notify-tool
 *     name: './plugins/notify-tool.ts'
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'mydsh-notify-tool'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const LOG_DIR = join(DSH_HOME, 'mydsh')
const LOG_FILE = join(LOG_DIR, 'notify.jsonl')

export function apply(ctx: Context): void {
  mkdirSync(LOG_DIR, { recursive: true })
  ctx.tools.register(defineTool({
    name: 'notify_user',
    description: 'Send the user a desktop notification (title + body). Use it to ping the human when a long task finishes, when their input is required, or when you have a result worth surfacing immediately. Cheap and non-blocking.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short notification title (e.g. "任务完成").' },
      body: { type: 'string', required: true, description: 'One or two sentence notification body.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: { title: string; body: string }) {
      const record = { t: new Date().toISOString(), event: 'notify-user', title: args.title, body: args.body }
      try {
        appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`)
      } catch {
        // 日志失败不阻断通知。
      }
      execFile('notify-send', ['--app-name=mydsh', args.title, args.body], { timeout: 5000 }, () => {})
      return 'notification sent'
    },
  }))
}
