/**
 * mydsh — 预设层「modlens 视觉」工具（agent plane，随 preset 挂载）。
 *
 * 让纯文本模型看懂图片：`vision_describe(path, prompt?)` 把本地图片通过
 * attachment 通道提交，再用已配置的视觉模型（默认 qwen-vl-max，
 * provider `aliyun-bailian-vision`）生成描述/回答，文本回传给调用模型。
 *
 * 机制完全复用「粘贴图片」的既有链路：saveImage → durable ref → ImageBlock
 * → llm.stream（pi-ai 适配器把 ref 转 base64 data URL 交给视觉模型）。
 *
 * 安全边界（2026-08-17 收紧，见 docs/journal.md）：
 *   本工具按「模型给定的路径」读本地文件，且图片字节会发往外部视觉 provider
 *   —— 任意路径即是一条可被提示注入利用的出机器数据通道（注入指令可让模型
 *   读取含敏感信息的截图，并诱导视觉模型把内容描述出来）。因此：
 *   - 路径限制在 会话工作区（exec.agent.session.header.cwd）+ 环境变量
 *     MYDSH_VISION_EXTRA_ROOTS（':' 分隔的绝对路径，支持 ~ 展开）内；
 *   - resolve + realpath 双重解析防符号链接逃逸；只收普通文件；
 *     单文件 ≤ 20MB 预检（attachment 服务自己的上限在其后仍生效）；
 *   - 无法确定任何可用根时 fail closed（不回退 process.cwd()：dsh 进程 cwd
 *     是 harness checkout，可能含带密钥的 .env，回退反而扩大读取面）；
 *   - 每次调用（含被拒）写审计行到 $DSH_HOME/mydsh/vision.jsonl——
 *     「被拒的读取」本身即提示注入的痕迹。
 *   - 附加根用环境变量而非 preset YAML config 块：本地插件行带 config 块而
 *     插件未导出运行时 schemastery Config 会直接崩掉预设加载（POSTMORTEM 坑 6）。
 *
 * 引用方式（agent.cordis.yml）：
 *   - id: mydsh-vision
 *     name: './plugins/vision-tool.ts'
 *   （provider/model 等参数用源码内默认值；不要加 YAML config 块，见上。）
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ImageAttachmentRef } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdirSync, realpathSync, statSync, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'mydsh-vision'
export const inject = ['tools']

/** 扩展名 → attachment 接受的媒体类型（v1 图片通道只收这四种）。 */
const MEDIA_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 附加允许根的环境变量（':' 分隔绝对路径，支持 ~）。用 env 而非 YAML config：见文件头。 */
const EXTRA_ROOTS_ENV = 'MYDSH_VISION_EXTRA_ROOTS'
/** 读取前的大小预检上限：防巨型文件读入内存（attachment 服务自身上限在其后仍生效）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const AUDIT_DIR = join(DSH_HOME, 'mydsh')
const AUDIT_FILE = join(AUDIT_DIR, 'vision.jsonl')

/** 路径限制结果：ok 携带可直接读取的真实路径；其余为拒绝原因。 */
type ContainResult =
  | { kind: 'ok'; path: string; size: number }
  | { kind: 'no-roots' }
  | { kind: 'missing' }
  | { kind: 'not-file' }
  | { kind: 'too-large'; size: number }
  | { kind: 'outside' }

/** 解析 env 附加根：跳过空段；'~'/'~/' 展开为 home；非绝对路径的段忽略。 */
function extraRootsFromEnv(): string[] {
  const raw = process.env[EXTRA_ROOTS_ENV]
  if (raw === undefined || raw.trim() === '') return []
  const roots: string[] = []
  for (const part of raw.split(':')) {
    let p = part.trim()
    if (p === '') continue
    if (p === '~') p = homedir()
    else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    if (isAbsolute(p)) roots.push(p)
  }
  return roots
}

/**
 * 把模型给定的路径限制到允许根内：
 * resolve → 必须普通文件 → 大小预检 → realpath（防符号链接逃逸）→
 * 与各根 realpath 比较（根不存在则跳过）。
 * 返回成功时的真实路径；失败返回原因。
 * 注：realpath 与后续 readFile 之间的换链 TOCTOU 在单用户本机下不具实际
 * 可利用性（能并发换链者已可直接读文件），不额外上锁。
 */
function containToRoots(input: string, roots: string[]): ContainResult {
  if (roots.length === 0) return { kind: 'no-roots' }
  const abs = resolve(input)
  let st: Stats
  try {
    st = statSync(abs)
  } catch {
    return { kind: 'missing' }
  }
  if (!st.isFile()) return { kind: 'not-file' }
  if (st.size > MAX_IMAGE_BYTES) return { kind: 'too-large', size: st.size }
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return { kind: 'missing' }
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue // 根不存在：跳过
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
      return { kind: 'ok', path: real, size: st.size }
    }
  }
  return { kind: 'outside' }
}

/** 审计行：每次调用（含被拒）落一条，便于回溯「模型想读什么、被拒了多少次」。 */
function audit(event: string, path: string, detail: string | null): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true })
    appendFileSync(AUDIT_FILE, `${JSON.stringify({ t: new Date().toISOString(), event, path, detail })}\n`)
  } catch {
    // 审计失败不阻断工具。
  }
}

export interface Config {
  /** 视觉模型所在 provider（settings 里 llm-pi-ai 配置的 provider 名）。 */
  provider?: string
  /** 视觉模型 id。 */
  model?: string
  /** 默认提问（工具参数未给 prompt 时使用）。 */
  defaultPrompt?: string
  /** 返回文本的最大字符数。 */
  maxChars?: number
  /** 并发视觉模型调用上限（防模型一次响应内堆叠请求打爆视觉 provider）。 */
  maxConcurrency?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'aliyun-bailian-vision'
  const model = config.model ?? 'qwen-vl-max'
  const defaultPrompt = config.defaultPrompt ?? '请详细描述这张图片的内容，包括主体、场景、文字与可观察的细节。'
  const maxChars = config.maxChars ?? 8000
  const maxConcurrency = config.maxConcurrency ?? 4

  // 简易并发闸：模型可在一次响应里多次调用 vision_describe，无限制会堆叠
  // 视觉模型请求打爆 provider 配额。用一个信号量把同时在飞的调用数限制住。
  let active = 0
  const queue: Array<() => void> = []
  const acquire = (): Promise<void> => new Promise((release) => {
    if (active < maxConcurrency) { active++; release() }
    else queue.push(() => { active++; release() })
  })
  const release = (): void => { active--; const next = queue.shift(); if (next !== undefined) next() }

  ctx.tools.register(defineTool({
    name: 'vision_describe',
    description: 'Understand an image with a vision model and return its description as text. Use when the user attached or referenced an image and you (a text-only model) need to know what it shows. Pass the path of the image file (.png/.jpg/.jpeg/.webp/.gif); it must be inside this session\'s workspace (extra roots may be configured via MYDSH_VISION_EXTRA_ROOTS). Note: the image bytes are sent to the vision provider API.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to an image file (.png/.jpg/.jpeg/.webp/.gif) inside the session workspace.' },
      prompt: { type: 'string', description: 'Optional question or instruction about the image; defaults to a general detailed description.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: { path: string; prompt?: string }, exec?: { agent?: { session?: { header?: { cwd?: unknown } } } }) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      if (attachments === undefined) return 'ERROR: attachment service is not mounted'
      if (llm === undefined) return 'ERROR: llm service is not mounted'

      // ── 安全边界：路径限制到 会话工作区 + env 附加根（见文件头）──
      // exec.agent 由 agent loop 为每次模型调用设置（tool-calls.ts:
      // ctx.agents.requireInitiator()）；非 agent 上下文缺失时 fail closed。
      const cwd = exec?.agent?.session?.header?.cwd
      const roots = [
        typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
        ...extraRootsFromEnv(),
      ].filter((r): r is string => r !== undefined)

      const contained = containToRoots(args.path, roots)
      if (contained.kind !== 'ok') {
        const detail = contained.kind === 'too-large'
          ? `too large (${contained.size} bytes)`
          : contained.kind
        audit('vision-describe-denied', args.path, detail)
        switch (contained.kind) {
          case 'no-roots':
            return `ERROR: no allowed root for vision_describe: session workspace unknown and ${EXTRA_ROOTS_ENV} unset`
          case 'missing':
            return `ERROR: cannot read image file ${args.path}`
          case 'not-file':
            return `ERROR: not a regular file: ${args.path}`
          case 'too-large':
            return `ERROR: image too large (${contained.size} bytes > ${MAX_IMAGE_BYTES}): ${args.path}`
          case 'outside':
            return `ERROR: path outside allowed roots (session workspace ${cwd ?? 'unknown'}${roots.length > 0 ? ' + ' + EXTRA_ROOTS_ENV : ''}): ${args.path}`
        }
      }
      const abs = contained.path

      // 扩展名校验放在真实路径上（防「x.png 符号链接指向 y.jpg」绕过）。
      const mediaType = MEDIA_BY_EXT[basename(abs).match(/\.\w+$/)?.[0].toLowerCase() ?? '']
      if (mediaType === undefined) {
        audit('vision-describe-denied', args.path, 'unsupported type')
        return `ERROR: unsupported image type (expected .png/.jpg/.jpeg/.webp/.gif): ${args.path}`
      }

      let data: Uint8Array
      try {
        data = await readFile(abs)
      } catch (error) {
        audit('vision-describe-failed', args.path, `read: ${error instanceof Error ? error.message : String(error)}`)
        return `ERROR: cannot read image file ${abs}: ${error instanceof Error ? error.message : String(error)}`
      }

      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType: mediaType as 'image/png', name: basename(abs) })
      } catch (error) {
        audit('vision-describe-failed', args.path, `attachment: ${error instanceof Error ? error.message : String(error)}`)
        return `ERROR: image rejected by the attachment service (too large or invalid bytes?): ${error instanceof Error ? error.message : String(error)}`
      }

      // 此刻图片已被外部视觉 provider 通道接收——记录出机器事件（路径 + 大小），
      // 便于事后审计「哪些本地图片被发到了外部视觉模型」。
      audit('vision-describe-sent', abs, `${data.length} bytes → ${provider}/${model}`)

      const prompt = (args.prompt ?? defaultPrompt).trim()
      const message = createUserMessage({
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'plugin', plugin: 'mydsh-vision' },
      })

      await acquire()
      const parts: string[] = []
      let failed = false
      let failure = ''
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          messages: [message],
          system: 'You are a vision assistant. Answer the user\'s question about the image concisely but completely.',
        })) {
          if (chunk.type === 'text-delta') parts.push(chunk.text)
          else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
            failed = true
            failure = chunk.reason.failure?.message ?? chunk.reason.kind
          }
        }
      } catch (error) {
        return `ERROR: vision model call failed: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        release()
      }
      if (failed) return `ERROR: vision model call failed: ${failure}`
      const text = parts.join('').trim()
      if (text === '') return 'ERROR: vision model returned no text'
      return text.length > maxChars ? text.slice(0, maxChars) + '… [truncated]' : text
    },
  }))
}
