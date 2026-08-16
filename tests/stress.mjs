// mydsh 压测：针对并发竞态、资源泄漏、边界条件做压力测试。
// 用法: node --import tsx/esm tests/stress.mjs
//
// 覆盖：
//   A. host/notify.ts 并发 JSONL 写入：N 个 agent 同时 running→idle，
//      断言日志无交错损坏、每行可独立 JSON.parse。
//   B. host/media.ts 并发 Range 请求 + 流中途错误（res.destroy）。
//   C. notify-tool 并发 execute：appendFileSync 在多并发下不损坏日志。
//   D. vision-tool 并发调用：无节流时多次 readFile + llm.stream 是否堆叠。
//   E. ui-video 生命周期：多次 apply 是否泄漏 observer（旁路 lifecycle 隐患）。
//   F. ui-notify scanner：大量会话快照下边沿检测的正确性与性能。
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

// 临时 DSH_HOME，隔离日志写入。
const TMP = join(tmpdir(), `mydsh-stress-${process.pid}`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
process.env.DSH_HOME = TMP

// ── A. host/notify.ts 并发 JSONL 写入 ──────────────────────────────────────
console.log('\n── A. host/notify 并发 JSONL 写入 ──')
{
  const notifyMod = await import(join(PROJECT, 'host/notify.ts'))
  const handlers = []
  notifyMod.apply({
    on: (name, fn) => { if (name === 'agent/status') handlers.push(fn) },
  })
  check('注册了 agent/status 监听', handlers.length === 1)
  const fn = handlers[0]
  const N = 200
  // 模拟 N 个不同会话同时 running→idle（每个会话两次状态变化）。
  // 关键：appendFileSync 是同步的，但 JS 仍是单线程，所以理论上不会交错。
  // 这个测试验证的是「日志行完整性」+「状态机在大量会话下不泄漏内存」。
  const agents = Array.from({ length: N }, (_, i) => ({ id: `stress-${i}`, session: { header: { cwd: `/tmp/job${i}` } } }))
  // 第一遍：全部 running
  for (const a of agents) fn({ agent: a, status: 'running' })
  // 第二遍：全部 idle（触发通知）
  for (const a of agents) fn({ agent: a, status: 'idle' })

  // 校验日志文件：每行必须是合法 JSON。
  const logFile = join(TMP, 'mydsh/notify.jsonl')
  check('日志文件存在', existsSync(logFile))
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  let parseFail = 0
  let idleCount = 0
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.event === 'agent-idle') idleCount++
    } catch {
      parseFail++
    }
  }
  check('所有日志行可独立 JSON.parse', parseFail === 0, `${parseFail} 行损坏`)
  check('idle 事件数 = N', idleCount === N, `got ${idleCount}, want ${N}`)
  console.log(`  (日志共 ${lines.length} 行，N=${N})`)
}

// ── B. host/media.ts 并发 Range + 流中途错误 ──────────────────────────────
console.log('\n── B. host/media 并发 Range 请求 + 流错误 ──')
{
  const mediaMod = await import(join(PROJECT, 'host/media.ts'))
  let route = null
  mediaMod.apply({
    get: (n) => (n === 'webServer' ? { register: (r) => { route = r; return () => {} } } : undefined),
    effect: (fn) => { fn(); return () => {} },
  })
  check('注册了 /mydsh-media 路由', route !== null)

  // 大文件（1MB）用于并发 Range。
  const bigSize = 1024 * 1024
  const bigFile = join(TMP, 'big.mp4')
  const buf = Buffer.alloc(bigSize, 0x41)
  for (let i = 0; i < bigSize; i += 1024) buf.writeUInt8((i / 1024) % 256, i)
  writeFileSync(bigFile, buf)
  const enc = encodeURIComponent(bigFile)

  const fakeRes = (onEnd) => {
    const res = {
      statusCode: 0, headers: {}, body: Buffer.alloc(0), ended: false,
      writeHead(s, h) { this.statusCode = s; this.headers = h || {} },
      write(c) { this.body = Buffer.concat([this.body, Buffer.isBuffer(c) ? c : Buffer.from(String(c))]) },
      end(c) { if (c !== undefined) this.body = Buffer.concat([this.body, Buffer.isBuffer(c) ? c : Buffer.from(String(c))]); this.ended = true; if (onEnd) onEnd(this) },
      on(_ev, cb) { if (_ev === 'error') this._onError = cb },
      once() {}, emit() {},
    }
    return res
  }

  // 基于 res.ended 的轮询等待（流 pipe 完成会调 end）。
  const call = (url, headers = {}) => new Promise((resolve) => {
    let done = false
    const finish = (res) => { if (!done) { done = true; resolve(res) } }
    const res = fakeRes(finish)
    route.handler({ url, headers, method: 'GET' }, res)
    // 兜底超时
    setTimeout(() => finish(res), 500)
  })

  // B1: 并发 50 个不同 Range 请求
  const concurrent = 50
  const reqs = []
  for (let i = 0; i < concurrent; i++) {
    const start = (i * 1024) % (bigSize - 2048)
    const end = start + 1023
    reqs.push(call(`/mydsh-media/${enc}`, { range: `bytes=${start}-${end}` }))
  }
  const results = await Promise.all(reqs)
  const ok206 = results.filter((r) => r.statusCode === 206).length
  check(`并发 ${concurrent} 个 Range 请求全部 206`, ok206 === concurrent, `got ${ok206}`)
  // 校验数据正确性：找第一个返回 206 且 body 非空的请求验证长度
  const withBody = results.filter((r) => r.statusCode === 206 && r.body.length === 1024)
  check(`并发 Range 数据块大小正确 (1024 字节)`, withBody.length === concurrent, `got ${withBody.length} 个 1024 字节`)

  // B2: 客户端中途断开（res.destroy 模拟）—— 流应被清理，不泄漏
  // 这里只能模拟 res.end 提前调用的情况；真实 destroy 需要流 error 事件。
  // 至少验证：handler 不因 res 异常而抛。
  let threw = false
  try {
    const res = { writeHead() {}, write() {}, end() {}, on() {}, once() {}, emit() {} }
    route.handler({ url: `/mydsh-media/${enc}`, headers: {}, method: 'GET' }, res)
  } catch (e) { threw = true }
  check('handler 对最小 res 不抛', !threw)

  // B3: 反向 Range（start > end）—— 修复后应返回 416
  const reversed = await call(`/mydsh-media/${enc}`, { range: 'bytes=100-50' })
  check('反向 range 返回 416', reversed.statusCode === 416, `got ${reversed.statusCode}`)

  // B4: 越界 start（>= size）—— 修复后应返回 416
  const oob = await call(`/mydsh-media/${enc}`, { range: `bytes=${bigSize}-` })
  check('越界 start 返回 416', oob.statusCode === 416, `got ${oob.statusCode}`)
}

// ── C. notify-tool 并发 execute ──────────────────────────────────────────
console.log('\n── C. notify-tool 并发 execute ──')
{
  const registered = []
  const ctxWithTools = {
    get: () => undefined,
    tools: { register: (t) => { registered.push(t); return () => {} } },
  }
  const notifyTool = await import(join(PROJECT, 'preset/plugins/notify-tool.ts'))
  notifyTool.apply(ctxWithTools)
  const def = registered.find((t) => t.name === 'notify_user')
  check('notify_user 注册', def !== undefined)
  // 并发 100 次 execute：appendFileSync 单线程不会交错，但验证 notify-send 调用不泄漏。
  const N = 100
  const promises = []
  for (let i = 0; i < N; i++) promises.push(def.execute({ title: `t${i}`, body: `b${i}` }))
  const outs = await Promise.all(promises)
  check(`并发 ${N} 次 execute 全部返回`, outs.length === N && outs.every((o) => typeof o === 'string'))
  // 日志行数
  const logFile = join(TMP, 'mydsh/notify.jsonl')
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.length > 0)
  const notifyUserLines = lines.filter((l) => { try { return JSON.parse(l).event === 'notify-user' } catch { return false } })
  check(`日志记录了 ${N} 条 notify-user`, notifyUserLines.length === N, `got ${notifyUserLines.length}`)
}

// ── D. vision-tool 并发调用 ──────────────────────────────────────────────
console.log('\n── D. vision-tool 并发调用 ──')
{
  let streamCalls = 0
  let activeStreams = 0
  let maxActive = 0
  const registered = []
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const pngFile = join(TMP, 'test.png')
  writeFileSync(pngFile, png)
  const ctxWithTools = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 's', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () {
          streamCalls++
          activeStreams++
          maxActive = Math.max(maxActive, activeStreams)
          await new Promise((r) => setTimeout(r, 10)) // 模拟网络延迟
          yield { type: 'text-delta', text: '猫' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          activeStreams--
        },
      },
    }[n]),
    tools: { register: (t) => { registered.push(t); return () => {} } },
  }
  const visionTool = await import(join(PROJECT, 'preset/plugins/vision-tool.ts'))
  visionTool.apply(ctxWithTools)
  const def = registered.find((t) => t.name === 'vision_describe')
  check('vision_describe 注册', def !== undefined)
  // 并发 20 次：当前实现无节流，maxActive 应 = 20（无限制）
  const N = 20
  const outs = await Promise.all(Array.from({ length: N }, () => def.execute({ path: pngFile })))
  check(`并发 ${N} 次 vision_describe 全部成功`, outs.length === N && outs.every((o) => typeof o === 'string' && o.includes('猫')))
  console.log(`  (streamCalls=${streamCalls}, maxActive=${maxActive})`)
  check('vision_describe 有并发限制 (maxActive<=4)', maxActive <= 4, `maxActive=${maxActive}`)

  // D2: 超长返回值截断
  let longCtx
  const longRegistered = []
  longCtx = {
    get: (n) => ({
      attachments: { saveImage: async (input) => ({ attachmentId: 's', mediaType: input.mediaType, bytes: 1, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* () {
          yield { type: 'text-delta', text: 'X'.repeat(20000) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }[n]),
    tools: { register: (t) => { longRegistered.push(t); return () => {} } },
  }
  visionTool.apply(longCtx)
  const longDef = longRegistered.find((t) => t.name === 'vision_describe')
  const longOut = await longDef.execute({ path: pngFile })
  check('超长返回截断到 maxChars=8000', longOut.length <= 8000 + 20 && longOut.length > 8000, `got ${longOut.length}`)
  check('截断有省略标记', longOut.endsWith('… [truncated]'), `末尾: ...${longOut.slice(-20)}`)
}

// ── E. ui-video 生命周期泄漏 ─────────────────────────────────────────────
console.log('\n── E. ui-video 生命周期（旁路隐患）──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-video/lib/client.js'), 'utf8')
  let captured = null
  const fakeSlots = {
    inject: (_key, cb) => { cb(); return () => {} },
    register: (opts, comp) => { return () => {} },
  }
  let observerCreated = 0
  let observerDisconnected = 0
  const window = {
    __ModuleLoader__: { load: (spec) => { captured = spec; spec.exports = spec.factory(requireFn); } },
    __mydshVideoObserver: undefined,
    __mydshVideoDispose: undefined,
    AudioContext: undefined,
  }
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {}
  }
  setGlobal('window', window)
  setGlobal('document', {
    body: { querySelectorAll: () => [], addEventListener: () => {} },
    addEventListener: () => {},
    createElement: () => ({ setAttribute() {}, style: {} }),
  })
  setGlobal('MutationObserver', class {
    constructor(cb) { this.cb = cb; observerCreated++; }
    observe() {} disconnect() { observerDisconnected++; }
  })
  function requireFn(id) {
    if (id === 'react') return REACT
    throw new Error(`bundle require 了未提供模块: ${id}`)
  }
  vm.runInThisContext(code, { filename: 'ui-video.js' })
  const plugin = captured && captured.exports
  check('ui-video 导出 apply', plugin && typeof plugin.apply === 'function')

  // 模拟框架的 effect lifecycle：保存 disposer，卸载时调用。
  let savedDisposers = []
  const fakeCtx = {
    get: () => fakeSlots,
    effect: (fn) => { const d = fn(); savedDisposers.push(d); return d ?? (() => {}) },
  }
  // 第一次 apply：应创建 1 个 observer，并注册 disposer
  plugin.apply(fakeCtx)
  check('首次 apply 创建 1 个 observer', observerCreated === 1, `got ${observerCreated}`)
  check('首次 apply 注册了 disposer', savedDisposers.length === 1, `got ${savedDisposers.length}`)
  // 第二次 apply：started 标志位阻止重入，不创建新 observer
  plugin.apply(fakeCtx)
  check('多次 apply 不重复创建 observer', observerCreated === 1, `got ${observerCreated}`)
  // 关键检查：disposer 走 ctx.effect（修复后），不再旁路到 window 全局变量。
  const hasEffectCall = code.includes('ctx.effect')
  check('ui-video 走 ctx.effect 生命周期', hasEffectCall, `代码中 ctx.effect=${hasEffectCall ? '有' : '无'}`)
  // 验证修复后不再有 window.__mydshVideoDispose 全局变量
  check('不再旁路到 window.__mydshVideoDispose', typeof window.__mydshVideoDispose === 'undefined', `dispose=${typeof window.__mydshVideoDispose}`)
  // 模拟框架卸载：调用 disposer，应断开 observer 并重置 started
  savedDisposers[0]()
  check('disposer 调用后 observer 被断开', observerDisconnected === 1, `got ${observerDisconnected}`)
  // 卸载后重新 apply 应能重新创建 observer（started 已重置）
  plugin.apply(fakeCtx)
  check('卸载后重新 apply 创建新 observer', observerCreated === 2, `got ${observerCreated}`)
}

// ── F. ui-notify scanner 大量会话性能 ───────────────────────────────────
console.log('\n── F. ui-notify scanner 性能 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-notify/lib/client.js'), 'utf8')
  let captured = null
  const window = { __ModuleLoader__: { load: (spec) => { captured = spec; spec.exports = spec.factory(requireFn); } }, AudioContext: undefined }
  const setGlobal = (name, value) => { try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {} }
  setGlobal('window', window)
  setGlobal('navigator', { language: 'zh-CN', clipboard: { writeText: async () => {} } })
  setGlobal('document', { hidden: false, body: { querySelectorAll: () => [], addEventListener: () => {} }, addEventListener: () => {}, createElement: () => ({ setAttribute() {}, style: {} }) })
  setGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  setGlobal('Notification', { permission: 'denied' })
  setGlobal('MutationObserver', class { observe() {} disconnect() {} })
  setGlobal('location', { href: 'http://localhost:3081/?session=x', search: '?session=x' })
  function requireFn(id) { if (id === 'react') return REACT; throw new Error(`bundle require: ${id}`) }
  vm.runInThisContext(code, { filename: 'ui-notify.js' })
  const t = captured.exports.__test

  // F1: 1000 个会话快照，测量单次 observe 耗时
  const N = 1000
  const byId1 = {}
  for (let i = 0; i < N; i++) byId1[`session-${i}`] = { running: true }
  const sc1 = t.makeScanner(() => {})
  sc1.observe(byId1) // 基线（全 running）
  // 无变化场景：再 observe 一次同样的全 running
  const t0 = process.hrtime.bigint()
  sc1.observe(byId1)
  const t1 = process.hrtime.bigint()
  const noChangeMs = Number(t1 - t0) / 1e6
  check(`1000 会话无变化扫描 < 5ms`, noChangeMs < 5, `got ${noChangeMs.toFixed(2)}ms`)

  // 有变化场景：全新 scanner，基线全 running，然后全 idle
  const edges = []
  const sc2 = t.makeScanner((id, entry, kind) => { if (kind === 'idle') edges.push(id) })
  const byId2 = {}
  for (let i = 0; i < N; i++) byId2[`session-${i}`] = { running: true }
  sc2.observe(byId2) // 基线
  for (let i = 0; i < N; i++) byId2[`session-${i}`].running = false
  const t2 = process.hrtime.bigint()
  sc2.observe(byId2)
  const t3 = process.hrtime.bigint()
  const changeMs = Number(t3 - t2) / 1e6
  check(`1000 会话全 idle 边沿 < 10ms`, changeMs < 10, `got ${changeMs.toFixed(2)}ms`)
  check(`边沿检测出 ${N} 个 idle`, edges.length === N, `got ${edges.length}`)
  // F2: 内存增长——prev map 应清理已消失的会话条目（修复后）。
  // 验证：会话消失后再重现，prev 应被清理，重现时按基线处理（不误触发）。
  let triggerCount = 0
  const sc4 = t.makeScanner(() => { triggerCount++ })
  sc4.observe({ a: { running: true } }) // 基线
  sc4.observe({}) // a 消失，prev.a 应被清理
  sc4.observe({ a: { running: true } }) // a 回来：prev.a 已清理 → 基线，不触发
  sc4.observe({ a: { running: false } }) // idle 边沿
  check('会话消失后重现仍能触发边沿', triggerCount === 1, `triggerCount=${triggerCount}`)
  check('scanner prev map 清理已消失会话', triggerCount === 1, `prev 清理后 a 重现应按基线（triggerCount 应=1，实际=${triggerCount}）`)
}

// ── G. ui-session-tabs 深链与空白标签页 URL 构造 ────────────────────────
console.log('\n── G. ui-session-tabs 深链/空白 URL 构造 ──')
{
  const code = readFileSync(join(PROJECT, 'client/ui-session-tabs/lib/client.js'), 'utf8')
  const location = { href: '', search: '' }
  const setGlobal = (name, value) => { try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch {} }
  function requireFn(id) { if (id === 'react') return REACT; throw new Error(`bundle require: ${id}`) }
  // 加载拿到 __test（deepLink/blankTabUrl 读 window.location.href，每次取最新值）
  const loadPlugin = () => {
    let captured = null
    const w = { __ModuleLoader__: { load: (spec) => { captured = spec; spec.exports = spec.factory(requireFn); } }, location }
    setGlobal('window', w)
    setGlobal('navigator', { language: 'zh-CN' })
    vm.runInThisContext(code, { filename: 'ui-session-tabs.js' })
    return captured.exports
  }
  const plugin = loadPlugin()
  const t = plugin.__test
  check('导出 __test', t && typeof t.blankTabUrl === 'function' && typeof t.deepLink === 'function')
  if (t) {
    // blankTabUrl: 必须移除 ?session= 但保留其他参数
    location.href = 'http://127.0.0.1:3081/?session=abc-123'
    check('blankTabUrl 移除 session 参数', t.blankTabUrl() === 'http://127.0.0.1:3081/', t.blankTabUrl())
    location.href = 'http://127.0.0.1:3081/?other=x&session=abc'
    check('blankTabUrl 保留其他参数', t.blankTabUrl() === 'http://127.0.0.1:3081/?other=x', t.blankTabUrl())
    location.href = 'http://127.0.0.1:3081/'
    check('blankTabUrl 无 session 时不变', t.blankTabUrl() === 'http://127.0.0.1:3081/', t.blankTabUrl())
    location.href = 'http://127.0.0.1:3081/?session=a&session=b'
    check('blankTabUrl 移除全部同名 session', !t.blankTabUrl().includes('session'), t.blankTabUrl())
    // deepLink: 设置 session 参数（新增或覆盖）
    location.href = 'http://127.0.0.1:3081/'
    check('deepLink 新增 session', t.deepLink('xyz') === 'http://127.0.0.1:3081/?session=xyz', t.deepLink('xyz'))
    location.href = 'http://127.0.0.1:3081/?session=old'
    check('deepLink 覆盖 session', t.deepLink('new') === 'http://127.0.0.1:3081/?session=new', t.deepLink('new'))
    location.href = 'http://127.0.0.1:3081/?other=x'
    check('deepLink 保留其他参数', t.deepLink('s') === 'http://127.0.0.1:3081/?other=x&session=s', t.deepLink('s'))
    // 互逆性：blankTabUrl(deepLink(id)) 移除 session
    location.href = 'http://127.0.0.1:3081/'
    check('blankTabUrl(deepLink(id)) 回到无 session', !t.blankTabUrl().includes('session'))
  }

  // apply 注册 3 个 slot
  const registrations = []
  const fakeSlots = {
    inject: (_key, cb) => { try { cb({ wide: true }) } catch { try { cb() } catch {} }; return () => {} },
    register: (opts, comp) => { registrations.push({ opts, comp }); return () => {} },
  }
  const fakeCtx = { get: (n) => (n === 'slots' ? fakeSlots : n === 'sessions' ? { open: () => {} } : undefined), effect: (fn) => { const d = fn(); return d ?? (() => {}) } }
  plugin.apply(fakeCtx)
  const ids = registrations.map((r) => r.opts.id)
  check('apply 注册 3 个 slot', ids.length === 3, `got ${ids.join(',')}`)
  check('注册 sidebar.footer.action#mydsh-new-tab', ids.includes('mydsh-new-tab'))
  check('注册 conversation.session.header.actions#mydsh-open-tab', ids.includes('mydsh-open-tab'))
  check('注册 conversation.input.dock#mydsh-url-session', ids.includes('mydsh-url-session'))

  // 视觉调性：NewTabButton 必须对齐 DSH footer 的 Settings trigger
  // （SettingsRoot.module.css .trigger: 34px/12px 圆角/14px/label-primary/hover interactive-bg-hover），
  // 而不是第三方补丁感的小按钮。rail 折叠态对齐 .trigger.rail（36px 圆形）。
  check('NewTabButton 对齐 34px 高度', /height: wide \? '34px' : '36px'/.test(code), '高度应为 34px')
  check('NewTabButton 对齐 12px 圆角', /borderRadius: wide \? '12px' : '50%'/.test(code), '圆角应为 12px')
  check('NewTabButton 对齐 14px 字号', /fontSize: '14px'/.test(code), '字号应为 14px')
  check('NewTabButton 使用 label-primary 色', /--dsw-alias-label-primary/.test(code))
  check('NewTabButton hover 用 interactive-bg-hover', /interactive-bg-hover/.test(code))
  check('NewTabButton 用 DSH 同款 NewChat 图标', /NEW_CHAT_ICON_PATH/.test(code))
  check('NewTabButton rail 对齐 36px 圆形', /borderRadius: wide \? '12px' : '50%'/.test(code) && /width: wide \? 'auto' : '36px'/.test(code) && /height: wide \? '34px' : '36px'/.test(code))

  // ── workspace 选择逻辑（openNewTabInWorkspace / workspaceChoices）──
  if (t && typeof t.workspaceChoices === 'function' && typeof t.openNewTabInWorkspace === 'function') {
    // workspaceChoices: 列表 → 选项
    const list = { items: [
      { workspaceId: 'w1', title: '项目A', path: '/home/forbackup/Dev/project-a' },
      { workspaceId: 'w2', title: '项目B', path: '/tmp/b' },
    ] }
    const opts = t.workspaceChoices(list)
    check('workspaceChoices 提取 id/title/path', opts.length === 2 && opts[0].id === 'w1' && opts[0].title === '项目A' && opts[0].path.endsWith('project-a'), JSON.stringify(opts))
    check('workspaceChoices 空列表 → []', t.workspaceChoices(null).length === 0 && t.workspaceChoices({ items: [] }).length === 0)
    check('workspaceChoices 异常安全', t.workspaceChoices(undefined).length === 0)

    // openNewTabInWorkspace:
    // 1) 选 workspace → connectWorkspace 返回 id → window.open(深链)
    location.href = 'http://127.0.0.1:3081/'
    let openedUrl = null
    const fakeWin = { open: (u) => { openedUrl = u } }
    const ws = { connectWorkspace: async (id) => `session-${id}-created` }
    const r1 = t.openNewTabInWorkspace(ws, 'w1', fakeWin)
    check('选 workspace 返回 opened', r1 === 'opened', r1)
    // 等 promise 落定
    await new Promise((r) => setTimeout(r, 20))
    check('connectWorkspace 后打开深链', openedUrl === 'http://127.0.0.1:3081/?session=session-w1-created', String(openedUrl))
    // 2) 无 workspaceId → fallback 打开空标签页
    openedUrl = null
    const r2 = t.openNewTabInWorkspace(ws, null, fakeWin)
    check('无 workspaceId 走 fallback', r2 === 'fallback', r2)
    await new Promise((r) => setTimeout(r, 20))
    check('fallback 打开空标签页（无 session）', openedUrl === 'http://127.0.0.1:3081/', String(openedUrl))
    // 3) 无 workspaces 服务 → fallback
    openedUrl = null
    const r3 = t.openNewTabInWorkspace(null, 'w1', fakeWin)
    check('无 workspaces 服务走 fallback', r3 === 'fallback', r3)
    await new Promise((r) => setTimeout(r, 20))
    check('无服务 fallback 打开空标签页', openedUrl === 'http://127.0.0.1:3081/', String(openedUrl))
    // 4) connectWorkspace reject → 不打开，返回 opened（异步失败记录）
    openedUrl = null
    const wsFail = { connectWorkspace: async () => { throw new Error('boom') } }
    const r4 = t.openNewTabInWorkspace(wsFail, 'w1', fakeWin)
    check('connectWorkspace 异步失败返回 opened（错误记录）', r4 === 'opened', r4)
    await new Promise((r) => setTimeout(r, 20))
    check('失败时不打开新标签页', openedUrl === null, String(openedUrl))
    // 5) connectWorkspace 同步 throw → error
    const wsThrow = { connectWorkspace: () => { throw new Error('sync') } }
    check('connectWorkspace 同步抛错返回 error', t.openNewTabInWorkspace(wsThrow, 'w1', fakeWin) === 'error')
  } else {
    check('workspace 选择逻辑已导出', false, '__test 缺 workspaceChoices/openNewTabInWorkspace')
  }
}

console.log(failures === 0 ? `\n压测完成 ✔ (${warnings} 项告警)` : `\n${failures} 项失败 ✘ (${warnings} 项告警)`)
rmSync(TMP, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
