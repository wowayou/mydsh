/**
 * mydsh — 主机层「本地媒体服务」插件（host plane）。
 *
 * 注册 `/mydsh-media/*` 路由：把客户端传来的本地文件绝对路径（encodeURIComponent
 * 编码为单个 path 段）流式返回，带 Content-Type 与 Range 支持（视频拖动进度条必需）。
 * 供 `@mydsh/ui-video` 浏览器插件把消息里的视频链接渲染成可播放的 <video>。
 *
 * 安全边界（2026-08-17 收紧，见 docs/journal.md）：
 *   1. 服务器只绑定 127.0.0.1（harness 明确拒绝 --host 0.0.0.0）：
 *      请求方等价于本机用户自己读文件；
 *   2. 只服务扩展名在 CONTENT_TYPES 内的文件（唯一合法消费者 <video>/<audio>
 *      只可能生成这些扩展名的链接），其余一律 404（不泄露文件存在性）——
 *      攻击面从「任意可读文件」收缩到「媒体文件」；
 *   3. 请求携带 Origin/Referer 时必须来自本服务自身 origin（127.0.0.1/localhost
 *      + 当前监听端口）：挡住恶意网页的跨源 fetch 与其它本地 web 应用的读取；
 *   4. 无 Origin 的请求放行：<video>/<audio> 媒体元素按协议从不发送 Origin
 *      （拦截即功能不可用），本地 curl 同理——loopback-only 下等价于本机
 *      用户读取媒体文件。
 * 不做目录列举，只服务存在的普通文件。
 *
 * 挂在 `~/.dsh/profiles/web/cordis.patch.yml`（host 行，纯消费 webServer 服务）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'

export const name = 'mydsh-media'

/** 硬依赖 webServer：apply 必须等服务就绪（启动时序里 patch 行可能先于 webserver 激活）。 */
export const inject = ['webServer']

const PREFIX = '/mydsh-media'

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

/** 扩展名白名单查询：只有 CONTENT_TYPES 里的扩展名才允许被本路由服务。 */
function contentTypeFor(filePath: string): string | undefined {
  return CONTENT_TYPES[extname(filePath).toLowerCase()]
}

/** 单个 path 段是 encodeURIComponent(绝对路径)；只对该段解码（pathname 不做整体 decode，避免 %2F 提前还原成 /）。 */
function decodePath(pathname: string): string | undefined {
  if (!pathname.startsWith(PREFIX + '/')) return undefined
  const raw = pathname.slice(PREFIX.length + 1)
  if (raw === '' || raw.includes('/')) return undefined // 只接受单个编码段
  try {
    const decoded = decodeURIComponent(raw)
    return decoded.length > 0 && decoded.startsWith('/') ? decoded : undefined
  } catch {
    return undefined
  }
}

/** Range 请求（视频 seek）返回 206 局部流，否则整文件 200；越界返回 416。 */
function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(filePath)
  } catch {
    notFound(res)
    return
  }
  if (!stat.isFile()) {
    notFound(res)
    return
  }
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      // RFC 7233：`bytes=-N` 表示「最后 N 字节」（后缀形式），start = size - N；
      // `bytes=N-` 表示「从 N 到结尾」；`bytes=N-M` 表示闭区间。
      let start: number
      let end: number
      if (match[1] === '' && match[2] !== '') {
        // 后缀形式：bytes=-N → 最后 N 字节
        const suffix = Number.parseInt(match[2], 10)
        start = Math.max(0, stat.size - suffix)
        end = stat.size - 1
      } else {
        start = match[1] !== '' ? Number.parseInt(match[1], 10) : 0
        end = match[2] !== '' ? Number.parseInt(match[2], 10) : stat.size - 1
      }
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < stat.size) {
        const clampedEnd = Math.min(end, stat.size - 1)
        res.writeHead(206, {
          'content-range': `bytes ${start}-${clampedEnd}/${stat.size}`,
          'accept-ranges': 'bytes',
          'content-type': contentType,
          'content-length': String(clampedEnd - start + 1),
        })
        const stream = createReadStream(filePath, { start, end: clampedEnd })
        stream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
        stream.pipe(res)
        return
      }
      // 越界（start >= size 或 start > end）：返回 416 Range Not Satisfiable。
      res.writeHead(416, { 'content-range': `bytes */${stat.size}`, 'content-type': 'text/plain; charset=utf-8' })
      res.end('range not satisfiable')
      return
    }
  }
  res.writeHead(200, {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'content-length': String(stat.size),
  })
  const stream = createReadStream(filePath)
  stream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
  stream.pipe(res)
}

export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  // 实际监听端口：config port=0（OS 分配）时以 listen 后的真实值为准。请求能到达
  // 时 listen 必已成功，生产环境恒有值；测试 fake 缺省时退化为仅校验 hostname。
  const serverPort = typeof webServer.port === 'number' ? String(webServer.port) : undefined
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // 带 Origin/Referer 的请求必须来自 dsh web UI（本服务自身 origin）：
    //   - hostname 限定 127.0.0.1/localhost（同时挡住 DNS rebinding：
    //     evil.com 解析到 127.0.0.1 时其 Origin 仍是 evil.com）；
    //   - 端口精确匹配（UI 由本服务同源提供，origin 端口必然等于监听端口；
    //     其它本地 web 应用/页面的 fetch 因此被拒）。
    // 无 Origin 的请求放行：<video>/<audio> 媒体元素从不发送 Origin，
    // 本地 curl 同理；服务器 loopback-only，等价于本机用户读媒体文件（见文件头）。
    const origin = req.headers.origin ?? req.headers.referer
    if (typeof origin === 'string') {
      try {
        const u = new URL(origin)
        if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
        }
        if (serverPort !== undefined) {
          const effective = u.port !== '' ? u.port : u.protocol === 'https:' ? '443' : '80'
          if (effective !== serverPort) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('forbidden')
            return
          }
        }
      } catch {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const filePath = decodePath(pathname)
    if (filePath === undefined) {
      notFound(res)
      return
    }
    // 扩展名白名单：非媒体扩展名一律 404（与文件不存在同码，不泄露存在性）。
    // 注意：改名为 .mp4 的敏感文件仍可被本机读取——loopback 下等价于本机用户
    // 自己读文件，且唯一能构造这类请求的只有本机进程/用户自己的浏览器。
    if (contentTypeFor(filePath) === undefined) {
      notFound(res)
      return
    }
    serveFile(req, res, filePath)
  }
  ctx.effect(
    () => webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'mydsh-media: route',
  )
}
