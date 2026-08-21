/**
 * mydsh — vision 共用核心：**路径限制 / 素材准备 / 结果缓存 / 审计** 的唯一权威源。
 *
 * 两个消费者（同一份逻辑，两个平面）：
 *   - agent 平面：`preset/plugins/vision-tool.ts` 的 `vision_describe` 工具，
 *     走 harness 的 attachment + llm.stream。
 *   - skill 平面：`skills/vision/scripts/dsh-vision.mjs` CLI，直连 provider 端点。
 *
 * 为什么抽出来：路径限制是**安全代码**，两份实现就是两份都得改、两份都可能改漏。
 * 抽出来之后 `vision_describe` 顺带拿到 PDF 渲染 / 视频抽帧 / 结果缓存。
 *
 * 部署形态：本文件是仓库里唯一的真文件，两个消费目录下各有一个指向它的符号链接
 * （`preset/plugins/lib/` 与 `skills/vision/scripts/lib/`）。install.sh 用
 * `rsync --copy-unsafe-links` 把指向仓库外的链接**落成真文件**，所以部署位置
 * 拿到的是两份独立副本，运行时不跨目录依赖。改动只发生在本文件。
 *
 * 约束：零依赖、纯 ESM、只用 node: 内建 —— CLI 要用干净的 `node` 跑（不经 tsx，
 * 不依赖 harness 依赖树），预设插件那边由 tsx 直接加载。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 每次调用时读环境：测试会在 import 之后才设置 DSH_HOME。 */
export const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** 两个平面共用同一份审计（用 `via` 区分是谁写的）。 */
export const auditFile = () => join(dshHome(), 'mydsh/vision.jsonl')
const cacheDir = () => join(dshHome(), 'mydsh/vision-cache')
/** 缓存条目上限：写入时顺带裁剪，避免无界增长。 */
const CACHE_KEEP = 200

/** 图片扩展名 → media type（视觉端点与 attachment 通道普遍只接这四类 + gif）。 */
export const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogv', '.avi'])
export const PDF_EXTS = new Set(['.pdf'])

/** 各类输入的读取前大小预检（防把巨型文件读进内存）。 */
export const MAX_BYTES = { image: 20 * 1024 * 1024, pdf: 200 * 1024 * 1024, video: 4 * 1024 * 1024 * 1024 }
/** 一次请求最多带几张图（对齐 harness 的请求图片预算，留头寸）。 */
export const MAX_IMAGES = 8

// ── 审计 ────────────────────────────────────────────────────────────────────

/**
 * 审计行：每次调用（含被拒的读取）落一条 —— 「被拒的读取」本身即提示注入的痕迹。
 * **绝不写入密钥或图片字节**。
 * @param {string} event 事件名（含平面前缀，如 cli-sent / tool-denied）
 * @param {Record<string, unknown>} detail 附加字段（约定带 `via`）
 */
export function audit(event, detail = {}) {
  try {
    const file = auditFile()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), event, ...detail })}\n`)
  } catch {
    // 审计失败不阻断功能。
  }
}

// ── 路径限制 ────────────────────────────────────────────────────────────────

/** 解析 ':' 分隔的根列表（支持 ~ 展开，忽略相对路径段）。 */
export function parseRoots(raw) {
  return (raw ?? '').split(':').map((s) => s.trim()).filter((s) => s !== '')
    .map((p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p))
    .filter((p) => isAbsolute(p))
}

/**
 * 可读根：`MYDSH_VISION_ROOTS` 一旦设置即权威（命令行参数 / 会话工作区都无法扩大
 * —— 这是给「想要硬边界」的部署用的开关）；否则 base（CLI 的 cwd 或工具的会话
 * 工作区）+ `MYDSH_VISION_EXTRA_ROOTS`。base 缺失时**不回退 process.cwd()**：
 * dsh 进程的 cwd 是 harness checkout，可能含带密钥的 .env，回退反而扩大读取面。
 */
export function rootsFrom(env, base) {
  const pinned = parseRoots(env.MYDSH_VISION_ROOTS)
  if (pinned.length > 0) return { roots: pinned, pinned: true }
  const head = typeof base === 'string' && base !== '' ? [base] : []
  return { roots: [...head, ...parseRoots(env.MYDSH_VISION_EXTRA_ROOTS)], pinned: false }
}

/** 输入按扩展名分类。 */
export function kindOf(path) {
  const ext = extname(path).toLowerCase()
  if (ext in IMAGE_TYPES) return { kind: 'image', ext, mediaType: IMAGE_TYPES[ext] }
  if (PDF_EXTS.has(ext)) return { kind: 'pdf', ext }
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', ext }
  return { kind: 'unsupported', ext }
}

/**
 * 把「别人给的路径」夹到允许根内：
 * resolve → 必须普通文件 → realpath（防符号链接逃逸）→ 落在某个根内（根不存在则
 * 跳过）→ 类型判定落在**真实路径**上（防 `x.png` 链到别处）→ 大小预检。
 * 注：realpath 与后续读取之间的换链 TOCTOU 在单用户本机下不具实际可利用性
 * （能并发换链者已可直接读文件），不额外上锁。
 */
export function contain(input, roots) {
  if (roots.length === 0) return { ok: false, reason: 'no-roots' }
  const abs = resolve(input)
  let st
  try {
    st = statSync(abs)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-file' }
  let real
  try {
    real = realpathSync(abs)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const inside = roots.some((root) => {
    let realRoot
    try {
      realRoot = realpathSync(root)
    } catch {
      return false
    }
    return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
  })
  if (!inside) return { ok: false, reason: 'outside' }
  const type = kindOf(real)
  if (type.kind === 'unsupported') return { ok: false, reason: 'unsupported' }
  if (st.size > MAX_BYTES[type.kind]) return { ok: false, reason: 'too-large', size: st.size }
  return { ok: true, path: real, size: st.size, ...type }
}

/** 审计用的简短原因（拒绝详情，不含路径以外的敏感信息）。 */
export function denialDetail(result) {
  return result.reason === 'too-large' ? `too-large (${result.size} bytes)` : result.reason
}

// ── 素材准备（PDF 渲染页 / 视频抽帧 / 上传前缩放）──────────────────────────

/** "1-3,7" → [1,2,3,7]。非法段直接报错，避免悄悄少读几页。 */
export function parsePages(spec) {
  const pages = []
  for (const part of String(spec).split(',')) {
    const seg = part.trim()
    if (seg === '') continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(seg)
    if (range !== null) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (from < 1 || to < from) throw new Error(`--pages 区间非法: ${seg}`)
      for (let p = from; p <= to; p += 1) pages.push(p)
      continue
    }
    if (!/^\d+$/.test(seg) || Number(seg) < 1) throw new Error(`--pages 段非法: ${seg}`)
    pages.push(Number(seg))
  }
  if (pages.length === 0) throw new Error('--pages 为空')
  return [...new Set(pages)]
}

/** 视频抽帧时间点：显式 at 优先，否则在时长内均匀取 n 点（避开首尾黑帧）。 */
export function frameTimes({ at, frames, duration }) {
  if (at !== undefined && at !== '') {
    const times = String(at).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0)
    if (times.length === 0) throw new Error('--at 里没有合法的秒数')
    return times
  }
  if (duration <= 0) return [0]
  return Array.from({ length: frames }, (_, i) => Math.round(duration * (i + 1) / (frames + 1) * 10) / 10)
}

/** 外部二进制是否可用（缺了就报错或降级，不擅自安装）。 */
async function hasBin(bin) {
  try {
    await run(bin, ['-version'], { timeout: 5000 })
    return true
  } catch (error) {
    return error?.code !== 'ENOENT'
  }
}

/** ffprobe 读取像素尺寸；失败返回 undefined（缩放随之跳过）。 */
async function probeSize(path) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path], { timeout: 20000 })
    const [w, h] = stdout.trim().split('\n')[0].split('x').map(Number)
    return Number.isFinite(w) && Number.isFinite(h) ? { width: w, height: h } : undefined
  } catch {
    return undefined
  }
}

/** 视频时长（秒）；拿不到就按 0 处理（只抽第 0 秒一帧）。 */
export async function probeDuration(path) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { timeout: 20000 })
    const seconds = Number(stdout.trim())
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  } catch {
    return 0
  }
}

/** PDF → 每页一张 PNG（pdftoppm，150dpi 足够读正文与截图）。 */
export async function renderPdf(path, pages, dir) {
  if (!await hasBin('pdftoppm')) throw new Error('需要 pdftoppm（poppler-utils）才能渲染 PDF；或先自行导出图片再传入')
  const out = []
  for (const page of pages) {
    const prefix = join(dir, `pdf-p${page}`)
    await run('pdftoppm', ['-png', '-r', '150', '-f', String(page), '-l', String(page), path, prefix], { timeout: 120000 })
    const file = readdirSync(dir).filter((f) => f.startsWith(`pdf-p${page}-`) || f === `pdf-p${page}.png`).sort()[0]
    if (file === undefined) throw new Error(`PDF 第 ${page} 页渲染失败（可能超出总页数）`)
    out.push({ path: join(dir, file), mediaType: 'image/png', label: `${basename(path)} p${page}` })
  }
  return out
}

/** 视频 → 指定时间点各抽一帧 PNG（-ss 放 -i 前用关键帧快速定位）。 */
export async function grabFrames(path, times, dir) {
  if (!await hasBin('ffmpeg')) throw new Error('需要 ffmpeg 才能从视频抽帧；或先自行截图再传入')
  const out = []
  for (const [index, at] of times.entries()) {
    const file = join(dir, `frame-${index}.png`)
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-i', path, '-frames:v', '1', '-y', file], { timeout: 120000 })
    if (!existsSync(file)) throw new Error(`视频抽帧失败 @${at}s`)
    out.push({ path: file, mediaType: 'image/png', label: `${basename(path)} @${at}s` })
  }
  return out
}

/** 长边超过 maxSide 时缩放（省 token 与钱）；没有 ffmpeg 就原样上传。 */
export async function maybeDownscale(image, maxSide, dir, index) {
  if (maxSide <= 0) return image
  const size = await probeSize(image.path)
  if (size === undefined || Math.max(size.width, size.height) <= maxSide) return image
  if (!await hasBin('ffmpeg')) return image
  const jpeg = image.mediaType === 'image/jpeg'
  const file = join(dir, `scaled-${index}${jpeg ? '.jpg' : '.png'}`)
  try {
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', image.path, '-vf', `scale=${maxSide}:${maxSide}:force_original_aspect_ratio=decrease`, '-y', file], { timeout: 120000 })
  } catch {
    return image // 缩放失败不致命：原图继续。
  }
  if (!existsSync(file)) return image
  return { ...image, path: file, mediaType: jpeg ? 'image/jpeg' : 'image/png', scaledFrom: `${size.width}x${size.height}` }
}

/**
 * 已通过路径限制的输入 → 待上传图片列表（图片直用 / PDF 按页渲染 / 视频抽帧，
 * 再按需缩放）。`dir` 必须是调用方自建的临时目录（PDF/视频/缩放的产物写在那里）。
 * @param {Array<{kind: string, path: string, mediaType?: string}>} items contain() 的成功结果
 * @param {{dir?: string, pages?: string|number, frames?: number, at?: string, maxSide?: number}} options
 * @returns {Promise<Array<{path: string, mediaType: string, label: string, scaledFrom?: string}>>}
 */
export async function prepareImages(items, { dir, pages = '1', frames = 3, at, maxSide = 0 } = {}) {
  const images = []
  for (const item of items) {
    if (item.kind === 'image') {
      images.push({ path: item.path, mediaType: item.mediaType, label: basename(item.path) })
      continue
    }
    if (dir === undefined) throw new Error(`处理 ${item.kind} 需要临时目录（内部错误：prepareImages 未收到 dir）`)
    if (item.kind === 'pdf') images.push(...await renderPdf(item.path, parsePages(pages), dir))
    else images.push(...await grabFrames(item.path, frameTimes({ at, frames, duration: await probeDuration(item.path) }), dir))
  }
  if (images.length === 0) throw new Error('没有可用的图片')
  if (images.length > MAX_IMAGES) throw new Error(`一次最多 ${MAX_IMAGES} 张图，当前 ${images.length} 张（减少 --pages/--frames 或分批）`)
  if (maxSide <= 0) return images
  return Promise.all(images.map((image, index) => maybeDownscale(image, maxSide, dir, index)))
}

/** 读入字节并算摘要（缓存键 + 审计尺寸用；base64 由需要它的调用方自己算）。 */
export function readImageBytes(images) {
  for (const image of images) {
    const bytes = readFileSync(image.path)
    image.data = bytes
    image.bytes = bytes.length
    image.sha256 = sha256(bytes)
  }
  return images
}

// ── 结果缓存（同图 + 同问题 + 同模型不重复付费）────────────────────────────

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** 缓存键：把「决定结果的一切」摘要成一个文件名（两个平面各自的键天然不冲突）。 */
export const cacheKeyOf = (parts) => sha256(JSON.stringify(parts))

export function cacheRead(key) {
  try {
    return JSON.parse(readFileSync(join(cacheDir(), `${key}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

export function cacheWrite(key, value) {
  try {
    const dir = cacheDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(value))
    // 顺带裁剪：按 mtime 保留最近 CACHE_KEEP 条，避免缓存目录无界增长。
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(CACHE_KEEP)) unlinkSync(join(dir, f))
  } catch {
    // 缓存不可用不阻断功能。
  }
}
