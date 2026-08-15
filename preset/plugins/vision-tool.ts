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
 * 引用方式（agent.cordis.yml）：
 *   - id: mydsh-vision
 *     name: './plugins/vision-tool.ts'
 *     config:
 *       provider: aliyun-bailian-vision   # 可选，默认同上
 *       model: qwen-vl-max                # 可选，默认同上
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ImageAttachmentRef } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

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

export interface Config {
  /** 视觉模型所在 provider（settings 里 llm-pi-ai 配置的 provider 名）。 */
  provider?: string
  /** 视觉模型 id。 */
  model?: string
  /** 默认提问（工具参数未给 prompt 时使用）。 */
  defaultPrompt?: string
  /** 返回文本的最大字符数。 */
  maxChars?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'aliyun-bailian-vision'
  const model = config.model ?? 'qwen-vl-max'
  const defaultPrompt = config.defaultPrompt ?? '请详细描述这张图片的内容，包括主体、场景、文字与可观察的细节。'
  const maxChars = config.maxChars ?? 8000

  ctx.tools.register(defineTool({
    name: 'vision_describe',
    description: 'Understand an image with a vision model and return its description as text. Use when the user attached or referenced an image and you (a text-only model) need to know what it shows. Pass the absolute or workspace path of the image file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to an image file (.png/.jpg/.jpeg/.webp/.gif).' },
      prompt: { type: 'string', description: 'Optional question or instruction about the image; defaults to a general detailed description.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: { path: string; prompt?: string }) {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      if (attachments === undefined) return 'ERROR: attachment service is not mounted'
      if (llm === undefined) return 'ERROR: llm service is not mounted'

      const abs = resolve(args.path)
      const mediaType = MEDIA_BY_EXT[basename(abs).match(/\.\w+$/)?.[0].toLowerCase() ?? '']
      if (mediaType === undefined) return `ERROR: unsupported image type (expected .png/.jpg/.jpeg/.webp/.gif): ${args.path}`

      let data: Uint8Array
      try {
        data = await readFile(abs)
      } catch (error) {
        return `ERROR: cannot read image file ${abs}: ${error instanceof Error ? error.message : String(error)}`
      }

      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType: mediaType as 'image/png', name: basename(abs) })
      } catch (error) {
        return `ERROR: image rejected by the attachment service (too large or invalid bytes?): ${error instanceof Error ? error.message : String(error)}`
      }

      const prompt = (args.prompt ?? defaultPrompt).trim()
      const message = createUserMessage({
        content: [
          { type: 'text', text: prompt },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'plugin', plugin: 'mydsh-vision' },
      })

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
      }
      if (failed) return `ERROR: vision model call failed: ${failure}`
      const text = parts.join('').trim()
      if (text === '') return 'ERROR: vision model returned no text'
      return text.length > maxChars ? text.slice(0, maxChars) : text
    },
  }))
}
