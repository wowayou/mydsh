/**
 * mydsh — 主机层「本地媒体服务」插件（host plane）。
 *
 * 注册 `/mydsh-media/*` 路由：把客户端传来的本地文件绝对路径（encodeURIComponent
 * 编码为单个 path 段）流式返回，带 Content-Type 与 Range 支持（视频拖动进度条必需）。
 * 供 `@mydsh/ui-video` 浏览器插件把消息里的视频链接渲染成可播放的 <video>。
 *
 * 安全边界：这是个人本机工具，只绑定 127.0.0.1，等价于本机用户自己读文件；
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

/** Range 请求（视频 seek）返回 206 局部流，否则整文件 200。 */
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
      const start = match[1] !== '' ? Number.parseInt(match[1], 10) : 0
      const end = match[2] !== '' ? Number.parseInt(match[2], 10) : stat.size - 1
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < stat.size) {
        const clampedEnd = Math.min(end, stat.size - 1)
        res.writeHead(206, {
          'content-range': `bytes ${start}-${clampedEnd}/${stat.size}`,
          'accept-ranges': 'bytes',
          'content-type': contentType,
          'content-length': String(clampedEnd - start + 1),
        })
        createReadStream(filePath, { start, end: clampedEnd }).pipe(res)
        return
      }
    }
  }
  res.writeHead(200, {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'content-length': String(stat.size),
  })
  createReadStream(filePath).pipe(res)
}

export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // CSRF protection: only accept requests from the dsh web UI (same origin).
    const origin = req.headers.origin ?? req.headers.referer
    if (typeof origin === 'string') {
      try {
        const u = new URL(origin)
        // Allow same-origin (any port on 127.0.0.1/localhost); reject cross-origin.
        if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
          return
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
    serveFile(req, res, filePath)
  }
  ctx.effect(
    () => webServer.register({ kind: 'prefix', path: PREFIX, handler }),
    'mydsh-media: route',
  )
}
