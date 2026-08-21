#!/usr/bin/env node
/**
 * mydsh — `vision` skill 的执行体：把本地图片 / PDF 页 / 视频帧交给视觉模型，
 * 回一段文本，让纯文本主模型也能「看见」。
 *
 * 与预设插件 `vision_describe` 的分工：
 *   - 本 CLI 属 **skill 层**：不进 harness 进程、不占常驻 tool schema（只在 skill
 *     被加载时才进上下文），直连 provider 的 OpenAI/Anthropic 兼容端点 ——
 *     绕开 harness 的模型 modality 门禁，并额外支持 多图 / 上传前缩放 / 三种方言。
 *     改动它不需要重启 dsh，也不依赖 `@deepseek-ai/*` 内部 API。
 *   - `vision_describe`（preset/plugins/vision-tool.ts）属 **agent 层**：一次工具
 *     调用即出结果并渲染在会话里，适合「一个文件 + 一个问题」的最短路径。
 *
 * 两者共用 `lib/vision-core.mjs`（路径限制 / 素材准备 / 缓存 / 审计的唯一权威源）；
 * 本文件只留 **CLI 独有** 的部分：配置读取与选路、三种 API 方言、HTTP 重试、参数解析。
 *
 * 配置完全复用 dsh 自身，不再单独配一份：
 *   $DSH_HOME/settings.yaml → llm-pi-ai.providers.<name>.{baseURL,api,apiKeyEnv,models}
 *   $DSH_HOME/.credentials.yaml → apiKeyEnv 对应的密钥
 * 密钥只在进程内使用：不打印、不写审计、不进模型上下文。
 *
 * 安全边界（细节见 lib/vision-core.mjs）：
 *   - 路径限制：MYDSH_VISION_ROOTS（一旦设置即权威，命令行参数无法扩大）；
 *     否则 cwd + MYDSH_VISION_EXTRA_ROOTS。先 realpath 再比对，防符号链接逃逸。
 *   - 每次调用（含被拒）追加审计到 $DSH_HOME/mydsh/vision.jsonl（与插件同一份，
 *     用 via 区分平面）。
 *   - 诚实说明：本 CLI 跑在模型的 bash 沙箱里，而 dsh 的 sandbox 只管文件效果、
 *     不限制网络（sandbox-policy README：network/process policy 不在其词汇表内）。
 *     所以对「已被提示注入的模型」来说，这里的 containment 是护栏 + 可回溯痕迹，
 *     不是不可绕过的边界（模型本就能直接 curl）。要硬边界：在启动器里固定
 *     MYDSH_VISION_ROOTS，并在系统层面限制 dsh 子进程的出网。
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  MAX_IMAGES, audit as auditLine, cacheKeyOf, cacheRead, cacheWrite, contain, dshHome,
  prepareImages, readImageBytes, rootsFrom,
} from './lib/vision-core.mjs'

// 路径限制 / 素材准备 / 页码解析 是共用核心的能力，这里透传出去供测试与复用。
export { contain, kindOf, parsePages, rootsFrom } from './lib/vision-core.mjs'

const DSH_HOME = dshHome()
/** base64 总量上限（对齐 harness 的 20MiB 请求图片预算，留头寸）。 */
const MAX_PAYLOAD_BYTES = 15 * 1024 * 1024

/** 审计：本平面固定 via=skill-cli。 */
const audit = (event, detail) => auditLine(event, { via: 'skill-cli', ...detail })

/** 提问预设：把「看图要看什么」固化下来，省得每次现编 prompt。 */
const PRESETS = {
  describe: '详细描述这张图的内容：主体、场景、可见文字、以及任何值得注意的细节。若有多张图，逐张说明。',
  ocr: '逐字转写图中的所有文字，保持原有的行/列与阅读顺序，尽量还原表格与缩进。只输出文字本身，不要解释、不要总结。',
  ui: '这是一张 UI 截图。列出：1) 页面结构与主要区域；2) 可见组件及其状态（按钮/输入框/开关/加载中/报错）；3) 全部可见文案；4) 可疑的视觉缺陷（错位、截断、对比度过低、间距不一致）。',
  chart: '这是一张图表。说明图表类型、坐标轴与单位、每条数据系列、关键数值与极值、以及整体趋势或结论。数值读不准时明确说「读数近似」。',
  code: '这是一张代码或终端截图。逐字转写其中的代码/输出（保持缩进与换行），然后指出其中的报错、异常或可疑之处。',
  diff: '比较给出的这些图片：先说它们的共同点，再逐条列出差异（位置 + 具体表现）。如果是同一界面的前后版本，指出哪些改动是有意为之、哪些看起来像回归。',
}

const USAGE = `dsh-vision — 让文本模型看懂图片 / PDF 页 / 视频帧（mydsh vision skill）

用法:
  dsh-vision <文件...> [选项]

输入可以是图片（.png/.jpg/.jpeg/.webp/.gif）、PDF（.pdf，按页渲染）或视频
（.mp4/.webm/.mov/.m4v/.mkv/.ogv/.avi，按时间点抽帧）。可混合，最多 ${MAX_IMAGES} 张图。

选项:
  -p, --prompt <文本>    要问的问题（默认用 --preset 的提问）
      --preset <名字>    提问预设: ${Object.keys(PRESETS).join(' | ')}（默认 describe）
      --pages <范围>     PDF 页码，如 1-3,7（默认 1）
      --frames <n>       视频均匀抽 n 帧（默认 3）
      --at <秒[,秒...]>  视频按指定时间点抽帧（覆盖 --frames）
      --max-side <px>    上传前把长边缩到该值（默认 1280；0 = 不缩放）
      --model <p/m>      provider/model，覆盖自动选择（等价 MYDSH_VISION_MODEL）
      --max-chars <n>    返回文本上限（默认 8000）
      --timeout <ms>     单次请求超时（默认 120000）
      --retries <n>      429/5xx/网络错误重试次数（默认 2）
      --json             输出 JSON（含 model / 用了哪些图 / 是否命中缓存）
      --no-cache         跳过结果缓存
      --dry-run          只解析并打印计划，不发请求
  -h, --help

环境变量:
  MYDSH_VISION_MODEL=provider/model     指定视觉路由
  MYDSH_VISION_ROOTS=/a:/b              权威可读根（设置后命令行无法扩大）
  MYDSH_VISION_EXTRA_ROOTS=/c:/d        在 cwd 之外追加可读根
  MYDSH_VISION_BASE_URL / _API / _API_KEY / _API_KEY_ENV
                                        不走 settings.yaml，直接给端点与密钥
  DSH_HOME                              默认 ~/.dsh（settings/credentials/审计/缓存都在这里）

示例:
  dsh-vision shot.png                                   # 详细描述
  dsh-vision shot.png --preset ui                       # UI 审查
  dsh-vision scan.pdf --pages 1-3 --preset ocr          # 扫描件转文字
  dsh-vision demo.mp4 --frames 4 -p "用户点了哪些按钮？"
  dsh-vision before.png after.png --preset diff         # 两图对比
`

// ── YAML ────────────────────────────────────────────────────────────────────

/**
 * 优先用 harness 自带的 `yaml` 包（$DSH_HOME/profiles/node_modules 或 NODE_PATH），
 * 拿不到就退回内置迷你解析器 —— 我们只需要「缩进映射 + 标量序列 + `- key: v` 映射序列」
 * 这一小块子集（settings.yaml / .credentials.yaml 的真实形状），不支持锚点/多行标量。
 */
function parseYaml(text) {
  for (const base of [join(DSH_HOME, 'profiles/node_modules/yaml/package.json'), ...(process.env.NODE_PATH ?? '').split(':').filter(Boolean).map((p) => join(p, 'yaml/package.json'))]) {
    try {
      if (!existsSync(base)) continue
      return createRequire(base)('yaml').parse(text)
    } catch {
      // 换下一个候选。
    }
  }
  return miniYaml(text)
}

/** 迷你 YAML：按缩进建树，够用且行为可预期（失败宁可少读一个字段，不猜）。 */
export function miniYaml(text) {
  const lines = []
  for (const raw of text.split('\n')) {
    const noComment = raw.replace(/(^|\s)#.*$/, '$1')
    if (noComment.trim() === '') continue
    lines.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim() })
  }
  const [value] = build(lines, 0, 0)
  return value
}

/** 把标量文本转成 JS 值（引号、布尔、数字、null）。 */
function scalar(text) {
  if (text === '' || text === '~' || text === 'null') return null
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1)
  if (text === 'true' || text === 'false') return text === 'true'
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** 递归建树：返回 [值, 下一行下标]。indent 为本层的缩进列数。 */
function build(lines, i, indent) {
  if (i >= lines.length) return [null, i]
  // 序列
  if (lines[i].text === '-' || lines[i].text.startsWith('- ')) {
    const items = []
    while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
      const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2).trim()
      const childIndent = indent + 2
      if (rest === '') {
        const [value, next] = build(lines, i + 1, childIndent)
        items.push(value)
        i = next
      } else if (/^[\w.$@/-]+:(\s|$)/.test(rest)) {
        // `- key: value` —— 把行内首个键当作 childIndent 处的第一行映射，
        // 再把后续更深缩进的行并进同一子块单独解析。
        const sub = [{ indent: childIndent, text: rest }]
        let j = i + 1
        while (j < lines.length && lines[j].indent >= childIndent) sub.push(lines[j++])
        items.push(build(sub, 0, childIndent)[0])
        i = j
      } else {
        items.push(scalar(rest))
        i += 1
      }
    }
    return [items, i]
  }
  // 映射
  const map = {}
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
    const match = /^(.+?):(?:\s+(.*))?$/.exec(lines[i].text)
    if (match === null) { i += 1; continue }
    const key = String(scalar(match[1].trim()))
    const inline = (match[2] ?? '').trim()
    if (inline !== '') { map[key] = scalar(inline); i += 1; continue }
    const next = lines[i + 1]
    // 子块：缩进更深的映射，或同缩进的序列（YAML 允许序列不额外缩进）。
    if (next !== undefined && (next.indent > indent || (next.indent === indent && next.text.startsWith('- ')))) {
      const [value, nextIndex] = build(lines, i + 1, next.indent)
      map[key] = value
      i = nextIndex
    } else {
      map[key] = null
      i += 1
    }
  }
  return [map, i]
}

// ── provider / model 解析（复用 dsh 自己的配置）────────────────────────────

function readYamlFile(path) {
  try {
    return parseYaml(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 「看起来像视觉模型」的 id 特征：自动选路用；猜不中就要求显式 --model。 */
const VISION_HINT = /(^|[-_./])(vl|vision|omni|multimodal)([-_.]|$)/i

/**
 * 解析出「往哪打、用什么模型、拿哪个密钥」。优先级：
 *   1. MYDSH_VISION_BASE_URL（完全绕过 settings.yaml，给 CI / 无 dsh 环境用）
 *   2. --model / MYDSH_VISION_MODEL（`provider/model` 或裸 model 名）
 *   3. settings.yaml 里第一个「模型 id 像视觉模型」的 provider
 * 密钥来源：provider.apiKey → process.env[apiKeyEnv] → .credentials.yaml[apiKeyEnv]。
 */
export function resolveRoute({ settings, credentials, env, spec }) {
  const creds = credentials ?? {}
  const providers = settings?.['llm-pi-ai']?.providers ?? {}
  const keyOf = (name, inline) => inline ?? (name === undefined ? undefined : (env[name] ?? creds[name]))

  if (env.MYDSH_VISION_BASE_URL !== undefined && env.MYDSH_VISION_BASE_URL !== '') {
    const model = (spec ?? env.MYDSH_VISION_MODEL ?? '').split('/').pop()
    if (model === undefined || model === '') throw new Error('MYDSH_VISION_BASE_URL 已设置，但没有给模型名（--model 或 MYDSH_VISION_MODEL）')
    return {
      provider: 'env', model, api: env.MYDSH_VISION_API ?? 'openai-completions', baseURL: env.MYDSH_VISION_BASE_URL,
      key: keyOf(env.MYDSH_VISION_API_KEY_ENV, env.MYDSH_VISION_API_KEY),
    }
  }

  const wanted = spec ?? env.MYDSH_VISION_MODEL
  const entry = (name) => {
    const p = providers[name]
    if (p === undefined || p === null) throw new Error(`settings.yaml 里没有 provider "${name}"（llm-pi-ai.providers）`)
    if (p.baseURL === undefined) throw new Error(`provider "${name}" 缺少 baseURL`)
    return p
  }
  const build1 = (name, model) => {
    const p = entry(name)
    return { provider: name, model, api: p.api ?? 'openai-completions', baseURL: p.baseURL, key: keyOf(p.apiKeyEnv, p.apiKey) }
  }

  if (wanted !== undefined && wanted !== '') {
    const slash = wanted.lastIndexOf('/')
    if (slash > 0) return build1(wanted.slice(0, slash), wanted.slice(slash + 1))
    for (const [name, p] of Object.entries(providers)) {
      if ((p?.models ?? []).some((m) => m?.id === wanted)) return build1(name, wanted)
    }
    throw new Error(`没有 provider 声明模型 "${wanted}"；用 provider/model 形式明确指定`)
  }

  for (const [name, p] of Object.entries(providers)) {
    for (const m of p?.models ?? []) {
      if (typeof m?.id === 'string' && (VISION_HINT.test(m.id) || VISION_HINT.test(name))) return build1(name, m.id)
    }
  }
  throw new Error('自动选路失败：settings.yaml 里没有看起来支持视觉的模型。用 --model provider/model 指定，或设置 MYDSH_VISION_MODEL')
}

/** 三种 API 方言的请求 URL。 */
export function endpointOf(api, baseURL) {
  const base = baseURL.replace(/\/+$/, '')
  if (api === 'anthropic-messages') return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
  if (api === 'openai-responses') return `${base}/responses`
  return `${base}/chat/completions`
}

// ── 三种 API 方言：请求体与取文本 ──────────────────────────────────────────

/** images: [{ base64, mediaType }]。maxTokens 只是产出上限，不是计费上限。 */
export function buildRequest({ api, model, prompt, images, maxTokens = 4096 }) {
  const dataUrl = (img) => `data:${img.mediaType};base64,${img.base64}`
  if (api === 'anthropic-messages') {
    return {
      model, max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
      ] }],
    }
  }
  if (api === 'openai-responses') {
    return {
      model, max_output_tokens: maxTokens,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        ...images.map((img) => ({ type: 'input_image', image_url: dataUrl(img) })),
      ] }],
    }
  }
  return {
    model, max_tokens: maxTokens,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      ...images.map((img) => ({ type: 'image_url', image_url: { url: dataUrl(img) } })),
    ] }],
  }
}

/** 认证头按方言给（密钥只进 header，不进日志）。 */
function authHeaders(api, key) {
  if (api === 'anthropic-messages') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  return { authorization: `Bearer ${key}` }
}

/** 从非流式响应里取文本；取不到返回空串（调用方报错）。 */
export function extractText(api, json) {
  const fromParts = (parts) => (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === 'text' || p?.type === 'output_text').map((p) => p?.text ?? '').join('')
  if (api === 'anthropic-messages') return fromParts(json?.content).trim()
  if (api === 'openai-responses') {
    if (typeof json?.output_text === 'string') return json.output_text.trim()
    return (json?.output ?? []).filter((item) => item?.type === 'message' || item?.content !== undefined)
      .map((item) => fromParts(item?.content)).join('').trim()
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  return fromParts(content).trim()
}

// ── HTTP（超时 + 有限重试）─────────────────────────────────────────────────

/** 可重试的失败：网络错误、超时、429、5xx。 */
function retryable(status) {
  return status === undefined || status === 408 || status === 429 || status >= 500
}

async function callModel({ url, api, key, body, timeoutMs, retries }) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...authHeaders(api, key) },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        // 响应体可能含 provider 侧提示，但绝不会含我们的密钥；仍然截断以免噪音。
        const text = (await response.text().catch(() => '')).slice(0, 500)
        const error = new Error(`视觉模型返回 HTTP ${response.status}: ${text}`)
        error.status = response.status
        throw error
      }
      return await response.json()
    } catch (error) {
      lastError = error
      const status = error?.status
      if (attempt === retries || !retryable(status)) break
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.floor(Math.random() * 200)))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('视觉模型调用失败')
}

// ── main ────────────────────────────────────────────────────────────────────

const OPTIONS = {
  prompt: { type: 'string', short: 'p' },
  preset: { type: 'string', default: 'describe' },
  pages: { type: 'string', default: '1' },
  frames: { type: 'string', default: '3' },
  at: { type: 'string' },
  'max-side': { type: 'string', default: '1280' },
  model: { type: 'string' },
  'max-chars': { type: 'string', default: '8000' },
  timeout: { type: 'string', default: '120000' },
  retries: { type: 'string', default: '2' },
  json: { type: 'boolean', default: false },
  'no-cache': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
}

/** 数值选项校验：宁可报错，也不静默把 "abc" 当 0 用。 */
function int(raw, name, { min = 0 } = {}) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} 需要 ≥ ${min} 的整数，收到 ${JSON.stringify(raw)}`)
  return value
}

/** 被拒原因 → 给人看的中文说明（决策逻辑在 core，措辞留在各平面）。 */
function denialText(result, roots, pinned) {
  return {
    'no-roots': '没有可用的允许根（cwd 不可用且未设置 MYDSH_VISION_ROOTS/EXTRA_ROOTS）',
    missing: '文件不存在或不可读',
    'not-file': '不是普通文件',
    outside: `不在允许根内（${roots.join(', ')}${pinned ? '；由 MYDSH_VISION_ROOTS 固定' : ''}）`,
    unsupported: '不支持的类型（图片/PDF/视频之外）',
    'too-large': `文件过大（${result.size} 字节）`,
  }[result.reason]
}

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true })
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (positionals.length === 0) {
    process.stderr.write(USAGE)
    return 2
  }
  const prompt = (values.prompt ?? PRESETS[values.preset] ?? '').trim()
  if (prompt === '') throw new Error(`未知 --preset ${JSON.stringify(values.preset)}；可选: ${Object.keys(PRESETS).join(' | ')}`)
  const maxSide = int(values['max-side'], 'max-side')
  const maxChars = int(values['max-chars'], 'max-chars', { min: 100 })
  const timeoutMs = int(values.timeout, 'timeout', { min: 1000 })
  const retries = int(values.retries, 'retries')
  const frames = int(values.frames, 'frames', { min: 1 })

  // ── 路径限制：先把每个输入夹到允许根内（决策来自 lib/vision-core.mjs）──
  const { roots, pinned } = rootsFrom(process.env, process.cwd())
  const contained = []
  const denials = []
  for (const input of positionals) {
    const result = contain(input, roots)
    if (!result.ok) {
      audit('cli-denied', { path: input, reason: result.reason, ...(result.size === undefined ? {} : { size: result.size }) })
      denials.push(`${input}: ${denialText(result, roots, pinned)}`)
      continue
    }
    contained.push(result)
  }
  if (denials.length > 0) throw new Error(`以下输入被拒绝:\n  - ${denials.join('\n  - ')}`)

  // ── 素材：PDF 渲染页 / 视频抽帧 / 图片直用（含上传前缩放）──
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vision-'))
  try {
    const images = readImageBytes(await prepareImages(contained, { dir: tmp, pages: values.pages, frames, at: values.at, maxSide }))
    let payload = 0
    for (const image of images) {
      image.base64 = image.data.toString('base64')
      payload += image.base64.length
    }
    if (payload > MAX_PAYLOAD_BYTES) throw new Error(`图片总量 ${Math.round(payload / 1048576)}MB 超过上限 ${Math.round(MAX_PAYLOAD_BYTES / 1048576)}MB（调小 --max-side 或减少张数）`)

    // ── 路由与密钥 ──
    const settings = readYamlFile(join(DSH_HOME, 'settings.yaml'))
    const credentials = readYamlFile(join(DSH_HOME, '.credentials.yaml'))
    const route = resolveRoute({ settings, credentials, env: process.env, spec: values.model })
    const url = endpointOf(route.api, route.baseURL)
    const meta = {
      provider: route.provider, model: route.model, api: route.api, url,
      images: images.map((image) => ({ label: image.label, bytes: image.bytes, mediaType: image.mediaType, ...(image.scaledFrom === undefined ? {} : { scaledFrom: image.scaledFrom }) })),
      roots, rootsPinned: pinned,
    }

    // --dry-run：把「打给谁、发几张、多大」摊开，但不发请求、也不要求密钥。
    if (values['dry-run']) {
      process.stdout.write(`${JSON.stringify({ dryRun: true, prompt, ...meta }, null, 2)}\n`)
      return 0
    }
    if (route.key === undefined || route.key === '') {
      throw new Error(`provider "${route.provider}" 的密钥取不到：检查 settings.yaml 的 apiKeyEnv 名，以及 $DSH_HOME/.credentials.yaml 或同名环境变量`)
    }

    // ── 缓存：同模型 + 同问题 + 同图字节 → 直接复用（省钱且幂等）──
    const cacheKey = cacheKeyOf({ api: route.api, baseURL: route.baseURL, model: route.model, prompt, images: images.map((i) => i.sha256) })
    const cached = values['no-cache'] ? undefined : cacheRead(cacheKey)
    let text
    if (cached !== undefined && typeof cached.text === 'string') {
      text = cached.text
      audit('cli-cache-hit', { model: route.model, provider: route.provider, images: images.length })
    } else {
      const body = buildRequest({ api: route.api, model: route.model, prompt, images })
      let json
      try {
        json = await callModel({ url, api: route.api, key: route.key, body, timeoutMs, retries })
      } catch (error) {
        audit('cli-failed', { provider: route.provider, model: route.model, images: images.length, error: String(error?.message ?? error).slice(0, 300) })
        throw error
      }
      text = extractText(route.api, json)
      if (text === '') throw new Error('视觉模型没有返回文本（响应结构不符合预期或被安全策略拦截）')
      audit('cli-sent', { provider: route.provider, model: route.model, images: images.map((i) => ({ label: i.label, bytes: i.bytes })), chars: text.length })
      cacheWrite(cacheKey, { text, model: route.model, at: new Date().toISOString() })
    }

    const truncated = text.length > maxChars
    const out = truncated ? `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字；用 --max-chars 放宽）` : text
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ text: out, truncated, cached: cached !== undefined, ...meta }, null, 2)}\n`)
    } else {
      // 正文走 stdout（模型要读的就是它），元信息走 stderr，不污染结果。
      process.stdout.write(`${out}\n`)
      process.stderr.write(`[dsh-vision] ${route.provider}/${route.model} · ${images.length} 张${cached !== undefined ? ' · 缓存命中' : ''}\n`)
    }
    return 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 直接执行时才跑 main（被 tests/vision-cli.mjs import 时只取导出函数）。
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      process.stderr.write(`ERROR: ${error?.message ?? error}\n`)
      process.exit(1)
    },
  )
}
