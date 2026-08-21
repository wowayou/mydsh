/**
 * mydsh — 预设层「modlens 视觉」工具（agent plane，随 preset 挂载）。
 *
 * 让纯文本模型看懂本地视觉素材：`vision_describe(path, prompt?, pages?, frames?)`
 * 把图片 / PDF 渲染页 / 视频抽帧通过 attachment 通道提交，再用已配置的视觉模型
 * （默认 qwen-vl-max，provider `aliyun-bailian-vision`）生成描述/回答，文本回传
 * 给调用模型。
 *
 * 机制完全复用「粘贴图片」的既有链路：saveImage → durable ref → ImageBlock
 * → llm.stream（pi-ai 适配器把 ref 转 base64 data URL 交给视觉模型）。
 *
 * 路径限制 / 素材准备 / 结果缓存 / 审计 全部来自 `lib/vision-core.mjs` —— 与
 * skills/vision 的 CLI 同一份权威源（安全代码不重复实现；仓库里 ./lib 是指向
 * 项目根 lib/ 的符号链接，install.sh 用 rsync --copy-unsafe-links 落成真实文件）。
 *
 * 安全边界（2026-08-17 收紧，2026-08-21 抽取共用核心，见 docs/journal.md）：
 *   本工具按「模型给定的路径」读本地文件，且图片字节会发往外部视觉 provider
 *   —— 任意路径即是一条可被提示注入利用的出机器数据通道（注入指令可让模型
 *   读取含敏感信息的截图，并诱导视觉模型把内容描述出来）。因此：
 *   - 路径限制在 会话工作区（exec.agent.session.header.cwd）+ 环境变量
 *     MYDSH_VISION_EXTRA_ROOTS（':' 分隔的绝对路径，支持 ~ 展开）内；
 *     MYDSH_VISION_ROOTS 一旦设置即权威根（与 CLI 同语义，会话工作区不再自动加入）；
 *   - resolve + realpath 双重解析防符号链接逃逸；只收普通文件；类型判定落在
 *     真实路径上；单文件大小预检（attachment 服务自己的上限在其后仍生效）；
 *   - 无法确定任何可用根时 fail closed（不回退 process.cwd()：dsh 进程 cwd
 *     是 harness checkout，可能含带密钥的 .env，回退反而扩大读取面）；
 *   - 每次调用（含被拒）写审计行到 $DSH_HOME/mydsh/vision.jsonl（带
 *     via: preset-tool）——「被拒的读取」本身即提示注入的痕迹。
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_IMAGES, audit as auditLine, cacheKeyOf, cacheRead, cacheWrite, contain, denialDetail,
  prepareImages, readImageBytes, rootsFrom,
} from './lib/vision-core.mjs'

export const name = 'mydsh-vision'
export const inject = ['tools']

/** 附加/权威允许根的环境变量名（仅用于报错文案，解析在共用核心里）。 */
const EXTRA_ROOTS_ENV = 'MYDSH_VISION_EXTRA_ROOTS'

/** 审计行：本平面固定 via=preset-tool，与 skill CLI 共用同一份 vision.jsonl。 */
const audit = (event: string, path: string, detail: string | null): void => {
  auditLine(event, { via: 'preset-tool', path, detail })
}

/** 被拒原因 → 给模型看的英文说明（决策逻辑在共用核心，措辞留在本平面）。 */
function denialMessage(reason: string, path: string, roots: string[], pinned: boolean, cwd: unknown, size?: number): string {
  switch (reason) {
    case 'no-roots':
      return `ERROR: no allowed root for vision_describe: session workspace unknown and ${EXTRA_ROOTS_ENV} unset`
    case 'missing':
      return `ERROR: cannot read file ${path}`
    case 'not-file':
      return `ERROR: not a regular file: ${path}`
    case 'unsupported':
      return `ERROR: unsupported type (expected image .png/.jpg/.jpeg/.webp/.gif, .pdf, or video .mp4/.webm/.mov/.m4v/.mkv/.ogv/.avi): ${path}`
    case 'too-large':
      return `ERROR: file too large (${size} bytes): ${path}`
    default:
      return `ERROR: path outside allowed roots (${pinned ? 'pinned MYDSH_VISION_ROOTS' : `session workspace ${typeof cwd === 'string' && cwd !== '' ? cwd : 'unknown'}`}${roots.length > 1 ? ` + ${EXTRA_ROOTS_ENV}` : ''}): ${path}`
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
  /** 结果缓存：同模型 + 同问题 + 同图字节直接复用（默认开，省钱且幂等）。 */
  cache?: boolean
  /** 上传前把长边缩到该值（0 = 不缩放；缩放需要 ffmpeg）。 */
  maxSide?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'aliyun-bailian-vision'
  const model = config.model ?? 'qwen-vl-max'
  const defaultPrompt = config.defaultPrompt ?? '请详细描述这张图片的内容，包括主体、场景、文字与可观察的细节。'
  const maxChars = config.maxChars ?? 8000
  const maxConcurrency = config.maxConcurrency ?? 4
  const useCache = config.cache ?? true
  const maxSide = config.maxSide ?? 0

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
    description: 'Understand a local image, PDF page, or video frame with a vision model and return the answer as text. Use when the user attached or referenced visual material and you (a text-only model) need to know what it shows. Pass the file path (image .png/.jpg/.jpeg/.webp/.gif, .pdf, or video .mp4/.webm/.mov/.m4v/.mkv/.ogv/.avi); it must be inside this session\'s workspace (extra roots may be configured via MYDSH_VISION_EXTRA_ROOTS). PDFs need pdftoppm and videos need ffmpeg installed. Note: the image bytes are sent to the vision provider API.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to an image, PDF, or video file inside the session workspace.' },
      prompt: { type: 'string', description: 'Optional question or instruction about the material; defaults to a general detailed description.' },
      pages: { type: 'string', description: 'PDF pages to render, e.g. "1-3,7". Default "1". Ignored for images and videos.' },
      frames: { type: 'integer', description: 'Number of frames to sample from a video (evenly spaced, 1-8). Default 3. Ignored for images and PDFs.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: { path: string; prompt?: string; pages?: string; frames?: number }, exec?: { agent?: { session?: { header?: { cwd?: unknown } } } }) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      if (attachments === undefined) return 'ERROR: attachment service is not mounted'
      if (llm === undefined) return 'ERROR: llm service is not mounted'

      // ── 安全边界：路径限制到 会话工作区 + env 附加根（见文件头）──
      // exec.agent 由 agent loop 为每次模型调用设置（tool-calls.ts:
      // ctx.agents.requireInitiator()）；非 agent 上下文缺失时 fail closed。
      const cwd = exec?.agent?.session?.header?.cwd
      const { roots, pinned } = rootsFrom(process.env, typeof cwd === 'string' && cwd !== '' ? cwd : undefined)

      const contained = contain(args.path, roots)
      if (!contained.ok) {
        audit('vision-describe-denied', args.path, denialDetail(contained))
        return denialMessage(contained.reason, args.path, roots, pinned, cwd, contained.size)
      }

      if (args.frames !== undefined && (!Number.isInteger(args.frames) || args.frames < 1 || args.frames > MAX_IMAGES)) {
        return `ERROR: frames must be an integer between 1 and ${MAX_IMAGES}, got ${JSON.stringify(args.frames)}`
      }

      // ── 素材准备：图片直用；PDF 渲染页；视频抽帧（都在临时目录里）──
      const tmp = mkdtempSync(join(tmpdir(), 'mydsh-vision-'))
      try {
        let images: Array<{ path: string; mediaType: string; label: string; data: Uint8Array; bytes: number; sha256: string }>
        try {
          images = readImageBytes(await prepareImages([contained], {
            dir: tmp, pages: args.pages ?? '1', frames: args.frames ?? 3, maxSide,
          })) as typeof images
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          audit('vision-describe-failed', args.path, `prepare: ${detail}`)
          return `ERROR: cannot prepare ${args.path}: ${detail}`
        }

        const prompt = (args.prompt ?? defaultPrompt).trim()

        // ── 结果缓存：同模型 + 同问题 + 同图字节 → 直接复用（不占并发闸）──
        const cacheKey = cacheKeyOf({ plane: 'preset-tool', provider, model, prompt, images: images.map((i) => i.sha256) })
        if (useCache) {
          const cached = cacheRead(cacheKey)
          if (cached !== undefined && typeof cached.text === 'string') {
            audit('vision-describe-cache-hit', contained.path, `${images.length} image(s) → ${provider}/${model}`)
            return cached.text.length > maxChars ? cached.text.slice(0, maxChars) + '… [truncated]' : cached.text
          }
        }

        const refs: ImageAttachmentRef[] = []
        for (const image of images) {
          try {
            refs.push(await attachments.saveImage({ data: image.data, mediaType: image.mediaType as 'image/png', name: image.label }))
          } catch (error) {
            audit('vision-describe-failed', args.path, `attachment: ${error instanceof Error ? error.message : String(error)}`)
            return `ERROR: image rejected by the attachment service (too large or invalid bytes?): ${error instanceof Error ? error.message : String(error)}`
          }
        }

        // 此刻图片已被外部视觉 provider 通道接收——记录出机器事件（路径 + 大小），
        // 便于事后审计「哪些本地素材被发到了外部视觉模型」。
        const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0)
        audit('vision-describe-sent', contained.path, `${images.length} image(s), ${totalBytes} bytes → ${provider}/${model}`)

        const message = createUserMessage({
          content: [
            { type: 'text', text: prompt },
            ...refs.map((ref) => ({ type: 'image' as const, attachment: ref })),
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
        if (useCache) cacheWrite(cacheKey, { text, model, at: new Date().toISOString() })
        return text.length > maxChars ? text.slice(0, maxChars) + '… [truncated]' : text
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  }))
}
