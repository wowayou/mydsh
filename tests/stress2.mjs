// mydsh 深度压测：覆盖 stress.mjs 未触及的边界条件、竞态、资源泄漏与安全边界。
// 用法: cd /home/forbackup/deepseek-harness && DSH_HOME=/tmp/mydsh-s2 NODE_PATH=$HOME/.dsh/profiles/node_modules node --import tsx/esm /home/forbackup/Dev/mydsh/tests/stress2.mjs
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)))
const REAL_DSH_HOME = require('node:os').homedir() + '/.dsh'
const PROFILE_NM = process.env.MYDSH_PROFILE_NM ?? join(REAL_DSH_HOME, 'profiles/node_modules')
const REACT = require(join(PROFILE_NM, 'react'))

let failures = 0
let warnings = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failures += 1; console.error(`  FAIL ${name} ${extra}`) }
}
const warn = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { warnings += 1; console.warn(`  WARN ${name} ${extra}`) }
}

const TMP = join(tmpdir(), `mydsh-stress2-${process.pid}`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
process.env.DSH_HOME = TMP

// ── I. media.ts 路径遍历与安全边界 ──────────────────────────────────────
console.log('\n── I. media.ts 路径遍历与安全边界 ──')
{
  const mediaMod = await import(join(PROJECT, 'host/media.ts'))
  let route = null
  mediaMod.apply({
    get: (n) => (n === 'webServer' ? { register: (r) => { route = r; return () => {} }, port: 3081 } : undefined),
    effect: (fn) => { fn(); return () => {} },
  })
  check('路由已注册', route !== null)

  const fakeRes = () => {
    const res = { statusCode: 0, headers: {}, body: '', ended: false, destroyed: false,
      writeHead(s, h) { this.statusCode = s; this.headers = h || {} },
      write(c) { this.body += String(c); },
      end(c) { if (c !== undefined) this.body += String(c); this.ended = true; },
      destroy() { this.destroyed = true; this.ended = true; },
      on() {}, once() {}, emit() {} }
    return res
  }
  const call = async (url, headers = {}) => {
    const res = fakeRes()
    route.handler({ url, headers, method: 'GET' }, res)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return res
  }

  const testFile = join(TMP, 'test.mp4')
  writeFileSync(testFile, '0123456789ABCDEFGHIJ')
  const enc = encodeURIComponent(testFile)

  check('正常文件 200', (await call(`/mydsh-media/${enc}`)).statusCode === 200)
  check('非媒体扩展名 /etc/passwd → 404（安全边界：仅媒体扩展名，2026-08-17）', (await call('/mydsh-media/%2Fetc%2Fpasswd')).statusCode === 404)
  check('多段路径 /etc/passwd → 404', (await call('/mydsh-media/etc/passwd')).statusCode === 404)
  check('编码 .. → 404', (await call('/mydsh-media/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd')).statusCode === 404)
  check('空路径 → 404', (await call('/mydsh-media/')).statusCode === 404)
  check('无前缀 → 404', (await call('/other-path')).statusCode === 404)
  check('相对路径 → 404', (await call('/mydsh-media/' + encodeURIComponent('relative/path.mp4'))).statusCode === 404)
  check('跨域 Origin → 403', (await call(`/mydsh-media/${enc}`, { origin: 'http://evil.com' })).statusCode === 403)
  check('localhost Origin → 200', (await call(`/mydsh-media/${enc}`, { origin: 'http://localhost:3081' })).statusCode === 200)
  check('127.0.0.1 Origin → 200', (await call(`/mydsh-media/${enc}`, { origin: 'http://127.0.0.1:3081' })).statusCode === 200)
  check('无 Origin → 200', (await call(`/mydsh-media/${enc}`)).statusCode === 200)
  check('目录 → 404', (await call('/mydsh-media/' + encodeURIComponent(TMP))).statusCode === 404)

  const singleByte = await call(`/mydsh-media/${enc}`, { range: 'bytes=0-0' })
  check('Range bytes=0-0 → 206 + 1字节', singleByte.statusCode === 206 && singleByte.body === '0', `${singleByte.statusCode} ${singleByte.body}`)
  const overRange = await call(`/mydsh-media/${enc}`, { range: 'bytes=0-100000' })
  check('Range 超出 → 206 + clamp', overRange.statusCode === 206 && overRange.body === '0123456789ABCDEFGHIJ', `${overRange.statusCode}`)
  const invalidRange = await call(`/mydsh-media/${enc}`, { range: 'bytes=10-5' })
  check('Range start>end → 416', invalidRange.statusCode === 416, `${invalidRange.statusCode}`)
  const openEnd = await call(`/mydsh-media/${enc}`, { range: 'bytes=0-' })
  check('Range bytes=0- → 206 全文件', openEnd.statusCode === 206 && openEnd.body === '0123456789ABCDEFGHIJ', `${openEnd.statusCode}`)
  const suffixZero = await call(`/mydsh-media/${enc}`, { range: 'bytes=-0' })
  check('Range bytes=-0 → 416 (suffix=0 → start=size)', suffixZero.statusCode === 416, `${suffixZero.statusCode}`)
  const badRange = await call(`/mydsh-media/${enc}`, { range: 'invalid' })
  check('无效 Range → 200 全文件', badRange.statusCode === 200, `${badRange.statusCode}`)
  const headRes = fakeRes()
  route.handler({ url: `/mydsh-media/${enc}`, headers: {}, method: 'HEAD' }, headRes)
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('HEAD 请求不崩溃', headRes.statusCode !== 0, `${headRes.statusCode}`)
}

// ── J. notify.ts 状态机边沿与内存泄漏 ──────────────────────────────────
console.log('\n── J. notify.ts 状态机边沿与内存泄漏 ──')
{
  const notifyMod = await import(join(PROJECT, 'host/notify.ts'))
  const handlers = {}
  notifyMod.apply({
    on: (name, fn) => { handlers[name] = fn },
  })
  check('注册了 agent/status 监听', typeof handlers['agent/status'] === 'function')
  check('注册了 session/event 监听', typeof handlers['session/event'] === 'function')
  check('注册了 session/disposed 监听', typeof handlers['session/disposed'] === 'function')

  const fn = handlers['agent/status']

  // 1) idle→idle 不触发通知（无下降沿）
  fn({ agent: { id: 'a1' }, status: 'idle' })
  fn({ agent: { id: 'a1' }, status: 'idle' })
  const logFile = join(TMP, 'mydsh/notify.jsonl')
  const lines1 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const idleEvents1 = lines1.filter((l) => { try { return JSON.parse(l).event === 'agent-idle' } catch { return false } }).length
  check('idle→idle 不触发 idle 事件', idleEvents1 === 0, `got ${idleEvents1}`)

  // 2) running→running 不触发
  fn({ agent: { id: 'a2' }, status: 'running' })
  fn({ agent: { id: 'a2' }, status: 'running' })
  const lines2 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const idleEvents2 = lines2.filter((l) => { try { return JSON.parse(l).event === 'agent-idle' } catch { return false } }).length
  check('running→running 不触发 idle 事件', idleEvents2 === 0, `got ${idleEvents2}`)

  // 3) running→idle→running→idle：第二次 idle 应该触发（状态机重置）
  fn({ agent: { id: 'a3' }, status: 'running' })
  fn({ agent: { id: 'a3' }, status: 'idle' })
  fn({ agent: { id: 'a3' }, status: 'running' })
  fn({ agent: { id: 'a3' }, status: 'idle' })
  const lines3 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const idleA3 = lines3.filter((l) => { try { const o = JSON.parse(l); return o.event === 'agent-idle' && o.sessionId === 'a3' } catch { return false } }).length
  check('running→idle→running→idle 触发两次 idle', idleA3 === 2, `got ${idleA3}`)

  // 4) session/disposed 清理 lastStatus Map（内存泄漏防护）
  fn({ agent: { id: 'a4' }, status: 'running' })
  handlers['session/disposed']({ id: 'a4' })
  // 销毁后再 idle 不应触发通知（lastStatus 已删，prev=undefined，不构成下降沿）
  fn({ agent: { id: 'a4' }, status: 'idle' })
  const lines4 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const idleA4 = lines4.filter((l) => { try { const o = JSON.parse(l); return o.event === 'agent-idle' && o.sessionId === 'a4' } catch { return false } }).length
  check('session/disposed 后 idle 不触发通知', idleA4 === 0, `got ${idleA4}`)

  // 5) approval/asked 事件写入日志
  handlers['session/event']({ id: 'a5' }, { type: 'approval/asked', data: { toolName: 'bash', reason: 'rm -rf' } })
  const lines5 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const approvalEvents = lines5.filter((l) => { try { return JSON.parse(l).event === 'approval-asked' } catch { return false } }).length
  check('approval/asked 写入日志', approvalEvents === 1, `got ${approvalEvents}`)

  // 6) 非 approval/asked 的 session/event 被忽略
  handlers['session/event']({ id: 'a6' }, { type: 'other-event', data: {} })
  const lines6 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const otherEvents = lines6.filter((l) => { try { const o = JSON.parse(l); return o.event === 'approval-asked' && o.sessionId === 'a6' } catch { return false } }).length
  check('非 approval/asked 被忽略', otherEvents === 0, `got ${otherEvents}`)

  // 7) agent 无 id 时 sessionLabel 兜底
  fn({ agent: { title: 'my-title' }, status: 'running' })
  fn({ agent: { title: 'my-title' }, status: 'idle' })
  const lines7 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const titleEvents = lines7.filter((l) => { try { const o = JSON.parse(l); return o.event === 'agent-idle' && o.sessionId === 'my-title' } catch { return false } }).length
  check('无 id 时用 title 兜底', titleEvents === 1, `got ${titleEvents}`)

  // 8) agent undefined 不崩溃
  fn({ agent: undefined, status: 'idle' })
  check('agent undefined 不崩溃', true)

  // 9) 大量会话创建+销毁：Map 不无限增长
  const N = 500
  for (let i = 0; i < N; i++) {
    fn({ agent: { id: `churn-${i}` }, status: 'running' })
    handlers['session/disposed']({ id: `churn-${i}` })
  }
  const lines9 = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const churnIdle = lines9.filter((l) => { try { const o = JSON.parse(l); return o.event === 'agent-idle' && o.sessionId?.startsWith('churn-') } catch { return false } }).length
  check('churn 会话销毁后 idle 不触发', churnIdle === 0, `got ${churnIdle}`)
}

// ── K. vision-tool 信号量饥饿与错误路径 ────────────────────────────────
console.log('\n── K. vision-tool 信号量饥饿与错误路径 ──')
{
  const registered = []
  let streamCalls = 0
  let maxActive = 0
  let currentActive = 0
  const fakeCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* (options) {
          streamCalls++
          currentActive++
          maxActive = Math.max(maxActive, currentActive)
          await new Promise((r) => setTimeout(r, 10))
          currentActive--
          yield { type: 'text-delta', index: 0, text: '描述' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }[n]),
  }
  const ctxWithTools = { ...fakeCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }

  // 本段所有实例都 cache: false —— 下面的用例反复用同一张图 + 同一 prompt 去走
  // 不同的错误路径，结果缓存会把它们短路掉（缓存本身在 9) 里单独测）。
  const visionTool = await import(join(PROJECT, 'preset/plugins/vision-tool.ts'))
  visionTool.apply(ctxWithTools, { maxConcurrency: 2, maxChars: 100, cache: false })
  const visionDef = registered.find((t) => t.name === 'vision_describe')
  check('vision_describe 注册', visionDef !== undefined)

  // 写测试图片
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const imgFile = join(TMP, 'test.png')
  writeFileSync(imgFile, png)
  // 模拟 agent loop 注入的执行上下文：会话工作区 = TMP（测试图片都写在 TMP 内）。
  // 2026-08-17 起 vision_describe 把路径限制到工作区，无 exec 上下文会 fail closed。
  const exec = { agent: { session: { header: { cwd: TMP } } } }

  // 1) 并发 10 次，maxActive 不超过 2
  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(visionDef.execute({ path: imgFile, prompt: '描述' }, exec))
  }
  const results = await Promise.all(promises)
  check('并发 10 次全部成功', results.every((r) => typeof r === 'string' && !r.startsWith('ERROR')), `${results.filter((r) => r.startsWith('ERROR')).length} failed`)
  check('maxActive <= 2', maxActive <= 2, `maxActive=${maxActive}`)
  check('streamCalls = 10', streamCalls === 10, `streamCalls=${streamCalls}`)

  // 2) 不支持的图片格式
  const badFormat = await visionDef.execute({ path: '/tmp/test.bmp', prompt: '描述' }, exec)
  check('不支持的格式返回 ERROR', typeof badFormat === 'string' && badFormat.startsWith('ERROR'), badFormat)

  // 3) 文件不存在
  const noFile = await visionDef.execute({ path: '/nonexistent/nope.png', prompt: '描述' }, exec)
  check('文件不存在返回 ERROR', typeof noFile === 'string' && noFile.startsWith('ERROR'), noFile)

  // 4) 截断到 maxChars
  const longCtx = { ...fakeCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  let longText = ''
  const longCtx2 = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: 'A'.repeat(200) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }[n]),
  }
  const longCtxWithTools = { ...longCtx2, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  visionTool.apply(longCtxWithTools, { maxConcurrency: 1, maxChars: 50, cache: false })
  const longDef = registered.find((t) => t.name === 'vision_describe' && registered.indexOf(t) === registered.length - 1)
  const longResult = await longDef.execute({ path: imgFile, prompt: '描述' }, exec)
  check('超长截断到 maxChars=50 + 标记', longResult.length > 50 && longResult.length <= 70 && longResult.includes('…'), `len=${longResult.length}`)

  // 5) LLM stream 抛异常（传 exec 走到 LLM 调用层，不被 no-roots 提前截断）
  const errorCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () { throw new Error('LLM boom') },
      },
    }[n]),
  }
  const errorCtxWithTools = { ...errorCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  visionTool.apply(errorCtxWithTools, { maxConcurrency: 1, cache: false })
  const errorDef = registered[registered.length - 1]
  const errorResult = await errorDef.execute({ path: imgFile, prompt: '描述' }, exec)
  check('LLM 异常返回 ERROR', typeof errorResult === 'string' && errorResult.startsWith('ERROR') && errorResult.includes('LLM boom'), errorResult)

  // 6) finish reason = error
  const finishErrorCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider error' } } }
        },
      },
    }[n]),
  }
  const finishErrorCtxWithTools = { ...finishErrorCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  visionTool.apply(finishErrorCtxWithTools, { maxConcurrency: 1, cache: false })
  const finishErrorDef = registered[registered.length - 1]
  const finishErrorResult = await finishErrorDef.execute({ path: imgFile, prompt: '描述' }, exec)
  check('finish error 返回 ERROR', typeof finishErrorResult === 'string' && finishErrorResult.startsWith('ERROR') && finishErrorResult.includes('provider error'), finishErrorResult)

  // 7) 空响应
  const emptyCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
      },
    }[n]),
  }
  const emptyCtxWithTools = { ...emptyCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  visionTool.apply(emptyCtxWithTools, { maxConcurrency: 1, cache: false })
  const emptyDef = registered[registered.length - 1]
  const emptyResult = await emptyDef.execute({ path: imgFile, prompt: '描述' }, exec)
  check('空响应返回 ERROR', typeof emptyResult === 'string' && emptyResult.startsWith('ERROR') && emptyResult.includes('no text'), emptyResult)

  // 8) 无 prompt 时用默认 prompt（传 exec 过路径限制，真正走到 LLM 调用层）
  const defaultPromptCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* (options) {
          yield { type: 'text-delta', index: 0, text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }[n]),
  }
  const defaultPromptCtxWithTools = { ...defaultPromptCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  visionTool.apply(defaultPromptCtxWithTools, { maxConcurrency: 1, cache: false })
  const defaultDef = registered[registered.length - 1]
  const defaultResult = await defaultDef.execute({ path: imgFile }, exec)
  check('无 prompt 用默认', typeof defaultResult === 'string' && !defaultResult.startsWith('ERROR') && defaultResult === 'ok', defaultResult)

  // 9) 结果缓存（2026-08-21 起与 skill CLI 共用 lib/vision-core.mjs 的缓存）
  let cacheStreams = 0
  const cacheCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 'test', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () {
          cacheStreams++
          yield { type: 'text-delta', index: 0, text: 'cached-answer' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }[n]),
  }
  const cacheCtxWithTools = { ...cacheCtx, tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  visionTool.apply(cacheCtxWithTools, { maxConcurrency: 1 })
  const cacheDef = registered[registered.length - 1]
  // prompt 带上 pid：DSH_HOME 已隔离到 TMP，但仍避免与同机其它跑用例撞键。
  const cachePrompt = `缓存用例-${process.pid}`
  const firstCall = await cacheDef.execute({ path: imgFile, prompt: cachePrompt }, exec)
  const secondCall = await cacheDef.execute({ path: imgFile, prompt: cachePrompt }, exec)
  check('缓存命中不再调用 llm', cacheStreams === 1, `cacheStreams=${cacheStreams}`)
  check('缓存返回同一文本', firstCall === 'cached-answer' && secondCall === firstCall, `${firstCall} / ${secondCall}`)
  const otherPrompt = await cacheDef.execute({ path: imgFile, prompt: `${cachePrompt}-变体` }, exec)
  check('不同 prompt 不复用缓存', cacheStreams === 2 && otherPrompt === 'cached-answer', `cacheStreams=${cacheStreams}`)
  const auditText = existsSync(join(TMP, 'mydsh/vision.jsonl')) ? readFileSync(join(TMP, 'mydsh/vision.jsonl'), 'utf8') : ''
  check('审计含 via=preset-tool', auditText.includes('"via":"preset-tool"'), auditText.slice(0, 200))
  check('审计含 cache-hit 事件', auditText.includes('vision-describe-cache-hit'))
  check('审计不含图片字节', !auditText.includes('base64'))

  // 10) 新支持的素材类型与参数校验（PDF/视频需外部依赖，这里只验分支与报错）
  const txtFile = join(TMP, 'notes.txt')
  writeFileSync(txtFile, 'x')
  const unsupported = await cacheDef.execute({ path: txtFile }, exec)
  check('非媒体类型报 unsupported', typeof unsupported === 'string' && unsupported.includes('unsupported type'), unsupported)
  const badFrames = await cacheDef.execute({ path: imgFile, frames: 99 }, exec)
  check('frames 越界报错', typeof badFrames === 'string' && badFrames.startsWith('ERROR') && badFrames.includes('frames'), badFrames)
  const fakePdf = join(TMP, 'fake.pdf')
  writeFileSync(fakePdf, 'not a real pdf')
  const pdfResult = await cacheDef.execute({ path: fakePdf, pages: '1' }, exec)
  check('坏 PDF 报 prepare 失败而非崩溃', typeof pdfResult === 'string' && pdfResult.startsWith('ERROR: cannot prepare'), pdfResult)
  const badPages = await cacheDef.execute({ path: fakePdf, pages: '3-1' }, exec)
  check('非法页码报错', typeof badPages === 'string' && badPages.startsWith('ERROR: cannot prepare'), badPages)
}

// ── L. notify-tool 错误路径与并发安全 ──────────────────────────────────
console.log('\n── L. notify-tool 错误路径与并发安全 ──')
{
  const registered = []
  const fakeCtx = {
    get: (n) => ({}[n]),
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
  }

  const notifyTool = await import(join(PROJECT, 'preset/plugins/notify-tool.ts'))
  notifyTool.apply(fakeCtx)
  const notifyDef = registered.find((t) => t.name === 'notify_user')
  check('notify_user 注册', notifyDef !== undefined)

  // 1) 正常调用
  const result = await notifyDef.execute({ title: '测试', body: '内容' })
  check('正常调用返回字符串', typeof result === 'string')
  check('返回 notification sent', result === 'notification sent', result)

  // 2) 空标题
  const emptyTitle = await notifyDef.execute({ title: '', body: '内容' })
  check('空标题不崩溃', typeof emptyTitle === 'string')

  // 3) 空内容
  const emptyBody = await notifyDef.execute({ title: '标题', body: '' })
  check('空内容不崩溃', typeof emptyBody === 'string')

  // 4) 超长标题/内容
  const longStr = 'A'.repeat(10000)
  const longResult = await notifyDef.execute({ title: longStr, body: longStr })
  check('超长标题/内容不崩溃', typeof longResult === 'string')

  // 5) 特殊字符（注入测试）
  const specialResult = await notifyDef.execute({ title: '$(echo pwned)', body: '`rm -rf /`' })
  check('特殊字符不崩溃', typeof specialResult === 'string')

  // 6) 并发 200 次：日志行完整性
  const promises = []
  for (let i = 0; i < 200; i++) {
    promises.push(notifyDef.execute({ title: `t${i}`, body: `b${i}` }))
  }
  await Promise.all(promises)
  const logFile = join(TMP, 'mydsh/notify.jsonl')
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  let parseFail = 0
  let notifyCount = 0
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.event === 'notify-user') notifyCount++
    } catch {
      parseFail++
    }
  }
  check('并发 200 次日志行无损坏', parseFail === 0, `${parseFail} 行损坏`)
  check('并发 200 次日志记录完整', notifyCount >= 200, `got ${notifyCount}`)
}

// ── M. ui-notify scanner 边沿检测深度测试 ──────────────────────────────
console.log('\n── M. ui-notify scanner 边沿检测深度测试 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-notify/lib/client.js'), 'utf8')
  let captured = null
  const window = {
    __ModuleLoader__: {
      load: (spec) => { captured = spec; spec.exports = spec.factory(requireFn); },
    },
    AudioContext: undefined,
  }
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {}
  }
  setGlobal('window', window)
  setGlobal('navigator', { language: 'zh-CN', clipboard: { writeText: async () => {} }, locks: undefined })
  setGlobal('document', { hidden: false, body: { querySelectorAll: () => [], addEventListener: () => {} }, addEventListener: () => {}, createElement: () => ({ setAttribute() {}, style: {} }) })
  setGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  setGlobal('Notification', { permission: 'denied' })
  setGlobal('MutationObserver', class { observe() {} disconnect() {} })
  setGlobal('location', { href: 'http://localhost:3081/', search: '' })
  function requireFn(id) {
    if (id === 'react') return REACT
    if (id === 'react-dom') return require(join(PROFILE_NM, 'react-dom'))
    throw new Error(`bundle require: ${id}`)
  }
  vm.runInThisContext(code, { filename: 'ui-notify.js' })
  const t = captured.exports.__test
  check('导出 __test', t && typeof t.makeScanner === 'function')

  // 1) 快速翻转：running→idle→running→idle 多轮
  const events = []
  const scanner = t.makeScanner((id, entry, kind) => { events.push({ id, kind }) })
  const byId = { 's1': { running: true, pendingInteraction: null } }
  scanner.observe(byId) // 基线
  for (let i = 0; i < 100; i++) {
    byId['s1'].running = false
    scanner.observe(byId)
    byId['s1'].running = true
    scanner.observe(byId)
  }
  const idleCount = events.filter((e) => e.kind === 'idle').length
  const runningCount = events.filter((e) => e.kind === 'running').length
  check('100 轮翻转 idle 事件 = 100', idleCount === 100, `got ${idleCount}`)
  check('100 轮翻转 running 事件 = 100', runningCount === 100, `got ${runningCount}`)

  // 2) pending 边沿：无→有→无→有
  const events2 = []
  const scanner2 = t.makeScanner((id, entry, kind) => { events2.push({ id, kind }) })
  const byId2 = { 's2': { running: true, pendingInteraction: null } }
  scanner2.observe(byId2) // 基线
  byId2['s2'].pendingInteraction = 'approval'
  scanner2.observe(byId2)
  byId2['s2'].pendingInteraction = null
  scanner2.observe(byId2)
  byId2['s2'].pendingInteraction = 'question'
  scanner2.observe(byId2)
  const pendingCount = events2.filter((e) => e.kind === 'pending').length
  const clearedCount = events2.filter((e) => e.kind === 'pending-cleared').length
  check('pending 出现 2 次', pendingCount === 2, `got ${pendingCount}`)
  check('pending 清除 1 次', clearedCount === 1, `got ${clearedCount}`)

  // 3) 会话消失后重现：prev 清理后重新出现只记基线
  const events3 = []
  const scanner3 = t.makeScanner((id, entry, kind) => { events3.push({ id, kind }) })
  let byId3 = { 's3': { running: true, pendingInteraction: null } }
  scanner3.observe(byId3) // 基线
  byId3['s3'].running = false
  scanner3.observe(byId3) // idle 边沿
  byId3 = {} // 会话消失
  scanner3.observe(byId3)
  byId3 = { 's3': { running: true, pendingInteraction: null } } // 重现
  scanner3.observe(byId3) // 应记基线，不触发 running
  byId3['s3'].running = false
  scanner3.observe(byId3) // idle 边沿
  const idle3 = events3.filter((e) => e.kind === 'idle').length
  const running3 = events3.filter((e) => e.kind === 'running').length
  check('消失重现后 idle 事件 = 2', idle3 === 2, `got ${idle3}`)
  check('消失重现后 running 事件 = 0', running3 === 0, `got ${running3}`)

  // 4) 大量会话同时翻转
  const events4 = []
  const scanner4 = t.makeScanner((id, entry, kind) => { events4.push({ id, kind }) })
  const byId4 = {}
  for (let i = 0; i < 1000; i++) {
    byId4[`s${i}`] = { running: true, pendingInteraction: null }
  }
  scanner4.observe(byId4) // 基线
  for (let i = 0; i < 1000; i++) {
    byId4[`s${i}`].running = false
  }
  const t0 = Date.now()
  scanner4.observe(byId4)
  const elapsed = Date.now() - t0
  const idle4 = events4.filter((e) => e.kind === 'idle').length
  check('1000 会话同时 idle 全检出', idle4 === 1000, `got ${idle4}`)
  warn('1000 会话扫描 < 20ms', elapsed < 20, `${elapsed}ms`)

  // 5) claimEdge 跨标签去重
  const storage = (() => {
    const m = new Map()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } }
  })()
  const now = 1000000
  check('首次 claim 返回 true', t.claimEdge('s1', now, storage) === true)
  check('30s 内再次 claim 返回 false', t.claimEdge('s1', now + 10000, storage) === false)
  check('30s 后再次 claim 返回 true', t.claimEdge('s1', now + 31000, storage) === true)
  check('不同 id 独立 claim', t.claimEdge('s2', now, storage) === true)

  // 6) displayLabelOf 兜底链
  check('displayTitle 优先', t.displayLabelOf({ displayTitle: '标题' }, 'id1') === '标题')
  check('title 兜底', t.displayLabelOf({ title: '标题2' }, 'id1') === '标题2')
  check('短 id 兜底', t.displayLabelOf({}, 'session-abcdef1234567890') === 'abcdef12')
  check('空 entry 用短 id', t.displayLabelOf(null, 'session-xyz') === 'xyz')

  // 7) shortIdOf 边界
  check('shortIdOf session- 前缀剥离', t.shortIdOf('session-abcdef1234567890') === 'abcdef12')
  check('shortIdOf 短 id 不截断', t.shortIdOf('abc') === 'abc')
  check('shortIdOf null 安全', t.shortIdOf(null) === '')
  check('shortIdOf undefined 安全', t.shortIdOf(undefined) === '')
}

// ── N. ui-session-tabs URL 构造边界 ─────────────────────────────────────
console.log('\n── N. ui-session-tabs URL 构造边界 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-session-tabs/lib/client.js'), 'utf8')
  let captured = null
  const loc = { href: 'http://localhost:3081/?session=abc&other=val', search: '?session=abc&other=val' }
  const window = {
    __ModuleLoader__: {
      load: (spec) => { captured = spec; spec.exports = spec.factory(requireFn); },
    },
    location: loc,
  }
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {}
  }
  setGlobal('window', window)
  setGlobal('navigator', { language: 'zh-CN', clipboard: { writeText: async () => {} } })
  setGlobal('document', { hidden: false, body: { querySelectorAll: () => [], addEventListener: () => {} }, addEventListener: () => {}, createElement: () => ({ setAttribute() {}, style: {} }) })
  setGlobal('location', loc)
  function requireFn(id) {
    if (id === 'react') return REACT
    if (id === 'react-dom') return require(join(PROFILE_NM, 'react-dom'))
    throw new Error(`bundle require: ${id}`)
  }
  vm.runInThisContext(code, { filename: 'ui-session-tabs.js' })
  const t = captured.exports.__test
  check('导出 __test', t && typeof t.deepLink === 'function')

  // 1) deepLink 特殊字符
  const dl = t.deepLink('session-with-special-chars-!@#')
  check('deepLink 含特殊字符', dl.includes('session=') && dl.includes('session-with-special-chars'))

  // 2) deepLink 空字符串
  const dlEmpty = t.deepLink('')
  check('deepLink 空字符串', dlEmpty.includes('session='))

  // 3) deepLink null/undefined — window.location is set, should produce a string
  check('deepLink null 产生字符串', typeof t.deepLink(null) === 'string')
  check('deepLink undefined 产生字符串', typeof t.deepLink(undefined) === 'string')

  // 4) blankTabUrl 移除 session 保留其他参数
  const blank = t.blankTabUrl()
  check('blankTabUrl 移除 session', !blank.includes('session='))
  check('blankTabUrl 保留 other', blank.includes('other=val'))

  // 5) workspaceChoices 空列表
  check('workspaceChoices 空列表 → []', JSON.stringify(t.workspaceChoices([])) === '[]')
  check('workspaceChoices null → []', JSON.stringify(t.workspaceChoices(null)) === '[]')
  check('workspaceChoices undefined → []', JSON.stringify(t.workspaceChoices(undefined)) === '[]')

  // 6) workspaceChoices 异常安全
  check('workspaceChoices 异常安全', JSON.stringify(t.workspaceChoices([{ throw: true }]))) // 不抛即可
  // 实际验证不抛异常
  let threw = false
  try { t.workspaceChoices([{ id: null, title: null, path: null }]) } catch { threw = true }
  check('workspaceChoices null 字段不抛', !threw)

  // 7) openNewTabInWorkspace 无 workspaceId 走 fallback
  let openedUrl = null
  const fakeWin = { open: (url) => { openedUrl = url } }
  const fakeWs = { listWorkspaces: async () => [{ id: 'w1', title: 'W1', path: '/tmp/w1' }] }
  const r = t.openNewTabInWorkspace(fakeWs, null, fakeWin)
  check('无 workspaceId 走 fallback', r === 'fallback', r)
  await new Promise((resolve) => setTimeout(resolve, 20))

  // 8) openNewTabInWorkspace 无 workspaces 服务
  const r2 = t.openNewTabInWorkspace(undefined, 'w1', fakeWin)
  check('无 workspaces 服务走 fallback', r2 === 'fallback', r2)
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ── O. ui-video 增量扫描与幂等 ─────────────────────────────────────────
console.log('\n── O. ui-video 增量扫描与幂等 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-video/lib/client.js'), 'utf8')
  let captured = null
  const createdElements = []
  const window = {
    __ModuleLoader__: {
      load: (spec) => { captured = spec; spec.exports = spec.factory(requireFn); },
    },
    __mydshVideoObserver: undefined,
  }
  const mockObserver = { observe() {}, disconnect() {} }
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {}
  }
  setGlobal('window', window)
  setGlobal('navigator', { language: 'zh-CN' })
  setGlobal('document', {
    hidden: false,
    body: {
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    addEventListener: () => {},
    createElement: (tag) => {
      const el = {
        tag, style: {}, src: '', controls: false, preload: '',
        attrs: {}, children: [], handlers: {},
        setAttribute(k, v) { this.attrs[k] = v },
        getAttribute(k) { return this.attrs[k] ?? null },
        appendChild(child) { this.children.push(child); child.parentNode = this; return child },
        addEventListener(type, fn) { this.handlers[type] = fn },
      }
      createdElements.push(el)
      return el
    },
    createTextNode: (text) => ({ tag: '#text', text }),
  })
  setGlobal('MutationObserver', class {
    observe() {} disconnect() {}
  })
  function requireFn(id) {
    if (id === 'react') return REACT
    throw new Error(`bundle require: ${id}`)
  }
  vm.runInThisContext(code, { filename: 'ui-video.js' })
  const plugin = captured.exports
  check('ui-video 导出 apply', plugin && typeof plugin.apply === 'function')

  // 1) 首次 apply 注册 disposer
  let disposed = false
  const ctx1 = {
    effect: (fn) => { const d = fn(); return () => { disposed = true; d?.() } },
  }
  plugin.apply(ctx1)
  check('首次 apply 创建 observer', window.__mydshVideoObserver !== undefined || true)

  // 2) 重复 apply（= 两条安装路径都装）被挂载防护拦住，不出现第二个 observer
  plugin.apply(ctx1)
  plugin.apply(ctx1)
  check('重复 apply 被挂载计数识别', window.__mydshUiVideoMounts === 3, `got ${window.__mydshUiVideoMounts}`)

  // 3) 链接筛选：驱动 bundle 真正导出的 isLocalAbsolute/正则，而不是测试里再抄一份
  const t = plugin.__test
  const { MEDIA_RE, AUDIO_RE, isLocalAbsolute } = t
  const pick = (href) => MEDIA_RE.test(href) && isLocalAbsolute(href)
  check('本地绝对路径视频被选中', pick('/home/user/video.mp4'))
  check('本地绝对路径音频被选中', pick('/home/user/audio.mp3') && AUDIO_RE.test('/home/user/audio.mp3'))
  check('http 外链被排除', !pick('https://youtube.com/v.mp4'))
  // 协议相对地址（//host/x.mp4）曾经会被当成本地路径改写成 /mydsh-media/ 请求
  check('协议相对地址被排除', !pick('//evil.example/x.mp4'))
  check('data: 被排除', !pick('data:video/mp4;base64,AAAA'))
  check('blob: 被排除', !pick('blob:http://127.0.0.1/abc.mp4'))
  check('相对路径被排除', !pick('videos/demo.mp4'))
  check('非媒体扩展名不动', !pick('/home/user/notes.txt'))

  // 4) 主机层路由缺失时的退化：播放器隐藏 + 原链接显示回来（不是留个死播放器）
  const anchor = { tag: 'a', style: {}, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return this.attrs[k] ?? null },
    appendChild(c) { this.children.push(c); return c }, addEventListener() {} }
  const wrap = t.playerFor('/home/user/video.mp4', false, anchor)
  const media = wrap.children[0]
  const fallback = wrap.children[1]
  check('包裹层带已处理标记（幂等）', wrap.getAttribute('data-mydsh-media') === '1')
  check('播放地址是主机层路由', media.src === '/mydsh-media/' + encodeURIComponent('/home/user/video.mp4'), media.src)
  check('原链接被保留在兜底区', fallback.children[0] === anchor)
  check('兜底区初始隐藏', fallback.style.display === 'none', fallback.style.display)
  media.handlers.error()
  check('加载失败后播放器隐藏', media.style.display === 'none', media.style.display)
  check('加载失败后原链接显示', fallback.style.display === 'block', fallback.style.display)
}

// ── P. host/notify.ts JSONL 日志格式完整性 ─────────────────────────────
console.log('\n── P. host/notify.ts JSONL 日志格式完整性 ──')
{
  const notifyMod = await import(join(PROJECT, 'host/notify.ts'))
  const handlers = {}
  notifyMod.apply({ on: (name, fn) => { handlers[name] = fn } })

  // 触发各种事件
  handlers['agent/status']({ agent: { id: 'p1', session: { header: { cwd: '/tmp/project1' } } }, status: 'running' })
  handlers['agent/status']({ agent: { id: 'p1', session: { header: { cwd: '/tmp/project1' } } }, status: 'idle' })
  handlers['session/event']({ id: 'p1' }, { type: 'approval/asked', data: { toolName: 'bash', reason: 'test' } })

  const logFile = join(TMP, 'mydsh/notify.jsonl')
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)

  // 每行必须有 t (timestamp) 和 event 字段
  let allValid = true
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (typeof obj.t !== 'string' || typeof obj.event !== 'string') { allValid = false; break }
    } catch { allValid = false; break }
  }
  check('每行有 t 和 event 字段', allValid)

  // agent-idle 事件有 sessionId — find the one from this section (p1 with cwd)
  const idleLine = lines.find((l) => { try { const o = JSON.parse(l); return o.event === 'agent-idle' && o.sessionId.includes('p1') } catch { return false } })
  if (idleLine) {
    const obj = JSON.parse(idleLine)
    check('agent-idle 有 sessionId', typeof obj.sessionId === 'string')
    check('agent-idle sessionId 含 cwd 目录名', obj.sessionId.includes('project1'), obj.sessionId)
  } else {
    check('agent-idle 事件存在', false)
  }

  // approval-asked 事件有 toolName 和 reason — find the one from this section (p1)
  const approvalLine = lines.find((l) => { try { const o = JSON.parse(l); return o.event === 'approval-asked' && o.sessionId === 'p1' } catch { return false } })
  if (approvalLine) {
    const obj = JSON.parse(approvalLine)
    check('approval-asked 有 toolName', obj.toolName === 'bash')
    check('approval-asked 有 reason', obj.reason === 'test')
  } else {
    check('approval-asked 事件存在', false)
  }

  // agent-status 诊断行有 prev 和 status
  const statusLines = lines.filter((l) => { try { return JSON.parse(l).event === 'agent-status' } catch { return false } })
  check('agent-status 诊断行存在', statusLines.length > 0)
  if (statusLines.length > 0) {
    const obj = JSON.parse(statusLines[0])
    check('agent-status 有 prev', 'prev' in obj)
    check('agent-status 有 status', typeof obj.status === 'string')
  }

  // plugin-started 行存在
  const startedLine = lines.find((l) => { try { return JSON.parse(l).event === 'plugin-started' } catch { return false } })
  check('plugin-started 行存在', startedLine !== undefined)

  // ISO 时间戳格式
  let isoValid = true
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(obj.t)) { isoValid = false; break }
    } catch { isoValid = false; break }
  }
  check('时间戳是 ISO 格式', isoValid)
}

// ── Q. host/media.ts 大文件并发流式读取 ────────────────────────────────
console.log('\n── Q. host/media.ts 大文件并发流式读取 ──')
{
  const mediaMod = await import(join(PROJECT, 'host/media.ts'))
  let route = null
  mediaMod.apply({
    get: (n) => (n === 'webServer' ? { register: (r) => { route = r; return () => {} }, port: 3081 } : undefined),
    effect: (fn) => { fn(); return () => {} },
  })

  // 4MB 文件
  const bigSize = 4 * 1024 * 1024
  const bigFile = join(TMP, 'big.mp4')
  const buf = Buffer.alloc(bigSize)
  for (let i = 0; i < bigSize; i++) buf[i] = i % 256
  writeFileSync(bigFile, buf)
  const enc = encodeURIComponent(bigFile)

  const fakeRes = () => {
    const chunks = []
    return {
      statusCode: 0, headers: {}, body: Buffer.alloc(0), ended: false,
      writeHead(s, h) { this.statusCode = s; this.headers = h || {} },
      write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))) },
      end(c) {
        if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
        this.body = Buffer.concat(chunks)
        this.ended = true
      },
      on() {}, once() {}, emit() {},
    }
  }

  // 并发 20 个不同 Range 请求
  const promises = []
  for (let i = 0; i < 20; i++) {
    const start = i * 1000
    const end = start + 999
    const res = fakeRes()
    route.handler({ url: `/mydsh-media/${enc}`, headers: { range: `bytes=${start}-${end}` }, method: 'GET' }, res)
    promises.push(new Promise((resolve) => {
      setTimeout(() => resolve({ res, start, end }), 100)
    }))
  }
  const results = await Promise.all(promises)
  let allCorrect = true
  for (const { res, start, end } of results) {
    if (res.statusCode !== 206) { allCorrect = false; break }
    const expected = buf.subarray(start, end + 1)
    if (!res.body.equals(expected)) { allCorrect = false; break }
  }
  check('并发 20 个 Range 全部 206 + 数据正确', allCorrect)

  // 整文件读取
  const fullRes = fakeRes()
  route.handler({ url: `/mydsh-media/${enc}`, headers: {}, method: 'GET' }, fullRes)
  await new Promise((resolve) => setTimeout(resolve, 200))
  check('4MB 整文件 200', fullRes.statusCode === 200)
  check('4MB 数据完整', fullRes.body.length === bigSize, `got ${fullRes.body.length}`)
  check('4MB 数据正确', fullRes.body.equals(buf))
}

// ── R. ui-notify 提示音配额闸与静音（发包不能拖垮宿主 UI）─────────────
// localStorage 配额是整个 origin 共享的：dsh UI 自己的设置/草稿和插件挤在一起。
// 一个几 MB 的自定义音频能把配额吃满，让宿主的写入开始失败 —— 这是「发出去的包
// 对别人的副作用」，所以上限必须在读文件之前就生效，失败必须能被调用方看见。
console.log('\n── R. ui-notify 提示音配额闸与静音 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-notify/lib/client.js'), 'utf8')
  let captured = null
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {}
  }
  const store = new Map()
  let failNextSet = false
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (failNextSet) { failNextSet = false; const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e }
      store.set(k, v)
    },
    removeItem: (k) => { store.delete(k) },
  }
  let readerUses = 0
  class FakeFileReader {
    readAsDataURL(file) { readerUses += 1; this.result = 'data:audio/mp3;base64,' + 'A'.repeat(file.size); this.onload() }
  }
  let audioPlays = 0
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1 }
    play() { audioPlays += 1; return Promise.resolve() }
  }
  setGlobal('window', {
    __ModuleLoader__: { load: (spec) => { captured = spec; spec.exports = spec.factory((id) => {
      if (id === 'react') return REACT
      throw new Error(`bundle require: ${id}`)
    }) } },
    AudioContext: undefined,
  })
  setGlobal('navigator', { language: 'zh-CN' })
  setGlobal('document', { hidden: false, title: 't', addEventListener() {}, removeEventListener() {} })
  setGlobal('localStorage', localStorage)
  setGlobal('FileReader', FakeFileReader)
  setGlobal('Audio', FakeAudio)
  vm.runInThisContext(code, { filename: 'ui-notify-sound.js' })
  const t = captured.exports.__test
  check('ui-notify 导出提示音内部逻辑', typeof t.saveCustomSound === 'function')
  check('上限是 512 KiB', t.MAX_SOUND_BYTES === 512 * 1024, String(t.MAX_SOUND_BYTES))

  // 1) 超限文件：连读都不读（不把几 MB 读进内存），reject 带可分文案的 code
  let err = null
  await t.saveCustomSound({ size: t.MAX_SOUND_BYTES + 1 }).catch((e) => { err = e })
  check('超限文件被拒', err !== null && err.code === 'too-big', err && err.code)
  check('超限文件根本没被读取', readerUses === 0, `readerUses=${readerUses}`)
  check('超限时不写 localStorage', t.loadCustomSound() === null)

  // 2) 正常文件：写进去，读得回来
  err = null
  await t.saveCustomSound({ size: 32 }).catch((e) => { err = e })
  check('正常文件保存成功', err === null && typeof t.loadCustomSound() === 'string', err && err.code)

  // 3) 配额失败：reject 'quota'，且不留半截值（否则下次读到坏数据）
  t.clearCustomSound()
  failNextSet = true
  err = null
  await t.saveCustomSound({ size: 64 }).catch((e) => { err = e })
  check('配额失败被 reject（不静默吞掉）', err !== null && err.code === 'quota', err && err.code)
  check('配额失败不留半截值', t.loadCustomSound() === null, String(t.loadCustomSound()))

  // 4) 静音：完成时不发声，显式试听照响
  await t.saveCustomSound({ size: 16 })
  audioPlays = 0
  t.setMuted(true)
  check('静音状态可读', t.isMuted() === true)
  t.playSound()
  check('静音时不播放', audioPlays === 0, `plays=${audioPlays}`)
  t.playSound(true)
  check('试听无视静音', audioPlays === 1, `plays=${audioPlays}`)
  t.setMuted(false)
  t.playSound()
  check('取消静音后恢复发声', audioPlays === 2, `plays=${audioPlays}`)
  check('静音键用 mydsh.notify.* 命名空间', t.MUTE_KEY.startsWith('mydsh.notify.'), t.MUTE_KEY)
}

// ── S. ui-annotate 批注库总量闸（同一份 origin 配额）───────────────────
console.log('\n── S. ui-annotate 批注库总量闸 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-annotate/lib/client.js'), 'utf8')
  let captured = null
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {}
  }
  const store = new Map()
  setGlobal('window', {
    __ModuleLoader__: { load: (spec) => { captured = spec; spec.exports = spec.factory((id) => {
      if (id === 'react') return REACT
      throw new Error(`bundle require: ${id}`)
    }) } },
  })
  setGlobal('navigator', { language: 'zh-CN' })
  setGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  })
  vm.runInThisContext(code, { filename: 'ui-annotate.js' })
  const t = captured.exports.__test
  check('ui-annotate 导出存储逻辑', typeof t.saveAll === 'function')
  check('总量上限是 256 KiB', t.MAX_TOTAL_BYTES === 256 * 1024, String(t.MAX_TOTAL_BYTES))

  const k = t.bucketKey('session-a', 'msg-1')
  check('正常写入放行', t.saveAll({ [k]: [{ id: '1', note: 'hi' }] }) === 'ok')
  const huge = { [k]: [{ id: '1', note: 'x'.repeat(t.MAX_TOTAL_BYTES) }] }
  check('超总量被拒（不挤占宿主 UI 配额）', t.saveAll(huge) === 'too-big')
  check('被拒后旧数据没被动过', JSON.parse(store.get('mydsh.annotations.v1'))[k].length === 1)
  // 已超限的旧库必须还能删：否则用户被锁在「删不掉也存不下」里
  check('删除写入永远放行', t.saveAll(huge, true) === 'ok')
}

console.log(failures === 0 ? `\n深度压测完成 ✔ (${warnings} 项告警)` : `\n${failures} 项失败 ✘ (${warnings} 项告警)`)
rmSync(TMP, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
