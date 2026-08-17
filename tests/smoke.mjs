// mydsh 插件冒烟测试：真实加载并执行客户端 bundle 与主机插件（不依赖浏览器/DSH 进程）。
// 用法: node tests/smoke.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)))
// Module resolution uses the real DSH_HOME (where react/yaml live);
// DSH_HOME env var isolates notify.jsonl writes to a temp dir.
const REAL_DSH_HOME = require('node:os').homedir() + '/.dsh'
const PROFILE_NM = process.env.MYDSH_PROFILE_NM ?? join(REAL_DSH_HOME, 'profiles/node_modules')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failures += 1; console.error(`  FAIL ${name} ${extra}`) }
}

// ── 客户端 bundle：在 VM 里执行 __ModuleLoader__.load，验证插件对象与 apply 行为 ──
const REACT = require(join(PROFILE_NM, 'react'))

function loadClientBundle(file) {
  const code = readFileSync(file, 'utf8')
  let captured = null
  const registrations = []
  const fakeSlots = {
    inject: (_key, cb) => { cb(); return () => {} },
    register: (opts, comp) => { registrations.push({ opts, comp }); return () => {} },
  }
  const fakeCtx = {
    get: (name) => (name === 'slots' ? fakeSlots : name === 'sessions' ? { open: () => {} } : undefined),
    effect: (fn) => { const d = fn(); return d ?? (() => {}) },
  }
  const window = {
    __ModuleLoader__: {
      load: (spec) => { captured = spec; const exportsObj = spec.factory(requireFn); spec.exports = exportsObj; },
    },
    // ui-video 需要
    AudioContext: undefined,
    __mydshVideoObserver: undefined,
  }
  const setGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) } catch { /* noop */ }
  }
  setGlobal('window', window)
  setGlobal('navigator', { language: 'zh-CN', clipboard: { writeText: async () => {} } })
  setGlobal('document', {
    hidden: false,
    body: { querySelectorAll: () => [], addEventListener: () => {} },
    addEventListener: () => {},
    createElement: () => ({ setAttribute() {}, style: {} }),
  })
  setGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  setGlobal('Notification', { permission: 'denied' })
  setGlobal('MutationObserver', class { observe() {} disconnect() {} })
  setGlobal('location', { href: 'http://localhost:3081/?session=x', search: '?session=x' })

  function requireFn(id) {
    if (id === 'react') return REACT
    if (id === 'react-dom') return require(join(PROFILE_NM, 'react-dom'))
    throw new Error(`bundle require 了未提供模块: ${id}`)
  }
  // 用 vm 执行以隔离（globalThis 打桩已就绪）。
  vm.runInThisContext(code, { filename: file })
  const plugin = captured && captured.exports
  // 真实调用 apply，验证注册行为与异常。
  if (plugin && typeof plugin.apply === 'function') plugin.apply(fakeCtx)
  const slotsUsed = registrations.map((r) => r.opts.name + '#' + r.opts.id)
  return { plugin, registrations, slotsUsed }
}

const clientCases = [
  { name: 'ui-notify', file: join(PROJECT, 'client/ui-notify/lib/client.js'), slot: 'conversation.input.dock#mydsh-notify' },
  { name: 'ui-session-tabs', file: join(PROJECT, 'client/ui-session-tabs/lib/client.js'), slot: 'conversation.session.header.actions#mydsh-open-tab' },
  { name: 'ui-session-tabs-footer', file: join(PROJECT, 'client/ui-session-tabs/lib/client.js'), slot: 'sidebar.footer.action#mydsh-new-tab' },
  { name: 'ui-video', file: join(PROJECT, 'client/ui-video/lib/client.js'), slot: null },
]

console.log('── 客户端 bundle 冒烟测试 ──')
for (const c of clientCases) {
  console.log(`\n* ${c.name}`)
  try {
    const { plugin, slotsUsed } = await loadClientBundle(c.file)
    check('plugin 对象导出', plugin && typeof plugin.apply === 'function')
    check('node half 占位可导入', require(join(dirname(dirname(c.file)), 'lib/index.js')).apply !== undefined)
    if (c.slot) check(`槽位注册 ${c.slot}`, slotsUsed.includes(c.slot), `got: ${slotsUsed.join(', ')}`)
    else check('apply 执行无异常（video 走 DOM 观察器）', true)
  } catch (error) {
    check(`${c.name} 加载`, false, String(error && error.stack || error))
  }
}

// ── 主机插件：tsx 导入并执行 apply（fake ctx）───
// ── ui-notify 通知优化逻辑（多任务可辨识：标题/跨标签去重/边沿检测） ──
console.log('\n── ui-notify 通知逻辑冒烟测试 ──')
try {
  const uiNotify = loadClientBundle(join(PROJECT, 'client/ui-notify/lib/client.js'))
  const t = uiNotify.plugin.__test
  check('ui-notify 导出 __test', t && typeof t.makeScanner === 'function')
  if (t) {
    // 1) 边沿扫描器：基线不触发；running→idle 触发；idle→running 触发；不重复
    const seen = []
    const sc = t.makeScanner((id, entry, kind) => seen.push([id, kind]))
    sc.observe({ a: { running: true } })            // 基线
    sc.observe({ a: { running: true } })            // 无变化
    check('scanner 基线不触发', seen.length === 0, JSON.stringify(seen))
    sc.observe({ a: { running: false } })           // idle 边沿
    sc.observe({ a: { running: false } })           // 无变化
    sc.observe({ a: { running: true } })            // running 边沿
    sc.observe({ a: { running: false } })           // 再次 idle 边沿
    check('scanner idle/running 边沿', JSON.stringify(seen) === JSON.stringify([['a','idle'],['a','running'],['a','idle']]), JSON.stringify(seen))
    // 2) 跨标签认领：窗口期内只放行一次，窗口外放行
    const fake = { data: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null }, setItem(k, v) { this.data[k] = v } }
    const now = 1000000
    check('claim 首次通过', t.claimEdge('x', now, fake) === true)
    check('claim 窗口内拒绝', t.claimEdge('x', now + 1000, fake) === false)
    check('claim 窗口外通过', t.claimEdge('x', now + 40000, fake) === true)
    check('claim 无 storage 放行', t.claimEdge('y', now, null) === true)
    // 3) 标题回退：displayTitle → title → 短 id
    check('label 取 displayTitle', t.displayLabelOf({ displayTitle: '修复通知', title: 'x', running: false }, 'session-1234567890abc') === '修复通知')
    check('label 回退 title', t.displayLabelOf({ title: '备用', running: false }, 'session-1234567890abc') === '备用')
    check('label 回退短 id', t.displayLabelOf({ running: false }, 'session-1234567890abcdefgh') === '12345678', t.displayLabelOf({ running: false }, 'session-1234567890abcdefgh'))
    check('shortId 去前缀', t.shortIdOf('session-12345678') === '12345678')
  }
} catch (error) {
  check('ui-notify 通知逻辑', false, String(error && error.stack || error))
}

// 注意：本脚本需以 `node --import tsx tests/smoke.mjs` 运行（tsx 解析 .ts）。
console.log('\n── 主机插件冒烟测试 ──')
try {
  const notifyMod = await import(join(PROJECT, 'host/notify.ts'))
  check('host/notify.ts 导出 apply', typeof notifyMod.apply === 'function')
  const events = []
  notifyMod.apply({
    on: (name, fn) => { events.push([name, fn]) },
  })
  check('host/notify.ts 监听 agent/status', events.some(([n]) => n === 'agent/status'))
  // 触发一次 running→idle，验证不抛异常
  const fn = events.find(([n]) => n === 'agent/status')[1]
  fn({ agent: { id: 'smoke' }, status: 'running' })
  fn({ agent: { id: 'smoke' }, status: 'idle' })
  check('host/notify.ts 状态机不抛异常', true)

  const mediaMod = await import(join(PROJECT, 'host/media.ts'))
  check('host/media.ts 导出 apply', typeof mediaMod.apply === 'function')
  let route = null
  // fake webServer 带真实监听端口（3081）：精确 origin 校验（host+port）在
  // 生产环境恒生效；这里让冒烟测试同时覆盖端口匹配与不匹配两条路径。
  mediaMod.apply({
    get: (n) => (n === 'webServer' ? { register: (r) => { route = r; return () => {} }, port: 3081 } : undefined),
    effect: (fn) => { fn(); return () => {} },
  })
  check('host/media.ts 注册 /mydsh-media 路由', route && route.kind === 'prefix' && route.path === '/mydsh-media')

  // 直接驱动路由 handler（绕过 HMR 模块缓存），验证 200 / 206 Range / 404。
  const { writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const mediaFile = joinPath(tmpdir(), 'mydsh-route-test.mp4')
  writeFileSync(mediaFile, '0123456789abcdefghij')
  const enc = encodeURIComponent(mediaFile)

  const fakeRes = () => {
    const res = { statusCode: 0, headers: {}, body: '', writeHead(s, h) { this.statusCode = s; this.headers = h || {} }, write(c) { this.body += String(c); }, end(c) { if (c !== undefined) this.body += String(c); this.ended = true; }, on() {}, once() {}, emit() {} }
    return res
  }
  const call = async (url, headers = {}) => {
    const res = fakeRes()
    route.handler({ url, headers, method: 'GET' }, res)
    // createReadStream 的写入是异步的：等一个 tick 再读 body。
    await new Promise((resolve) => setTimeout(resolve, 60))
    return res
  }

  const full = await call(`/mydsh-media/${enc}`)
  check('media 200 整文件', full.statusCode === 200 && full.body === '0123456789abcdefghij', `${full.statusCode} ${full.body}`)
  const range = await call(`/mydsh-media/${enc}`, { range: 'bytes=0-4' })
  check('media 206 Range', range.statusCode === 206 && range.body === '01234', `${range.statusCode} ${range.body}`)
  const bad = await call(`/mydsh-media/${encodeURIComponent('/nope/missing.mp4')}`)
  check('media 404 缺失文件', bad.statusCode === 404)
  const traversal = await call('/mydsh-media/%2Fetc%2Fpasswd%2Fextra')
  check('media 404 多段路径', traversal.statusCode === 404)

  // ── 安全边界（2026-08-17）：扩展名白名单 + 精确 origin ──
  // 非媒体扩展名一律 404（与缺失同码，不泄露存在性）。/etc/passwd 在 Linux
  // 上真实存在——旧实现会返回 200 全文，现必须 404。
  const secretTxt = joinPath(tmpdir(), 'mydsh-route-secret.txt')
  writeFileSync(secretTxt, 'sensitive')
  const nonMedia = await call(`/mydsh-media/${encodeURIComponent(secretTxt)}`)
  check('media 404 非媒体扩展名', nonMedia.statusCode === 404, `${nonMedia.statusCode}`)
  const passwd = await call('/mydsh-media/%2Fetc%2Fpasswd')
  check('media 404 任意路径（/etc/passwd）', passwd.statusCode === 404, `${passwd.statusCode}`)
  // 精确 origin：hostname 必须 127.0.0.1/localhost 且端口必须等于监听端口。
  const evilOrigin = await call(`/mydsh-media/${enc}`, { origin: 'http://evil.com:3081' })
  check('media 403 跨域 Origin', evilOrigin.statusCode === 403, `${evilOrigin.statusCode}`)
  const wrongPort = await call(`/mydsh-media/${enc}`, { origin: 'http://127.0.0.1:8080' })
  check('media 403 本地异端口 Origin', wrongPort.statusCode === 403, `${wrongPort.statusCode}`)
  const okOrigin = await call(`/mydsh-media/${enc}`, { origin: 'http://localhost:3081' })
  check('media 200 同源 Origin（localhost+端口）', okOrigin.statusCode === 200, `${okOrigin.statusCode}`)
} catch (error) {
  check('主机插件加载', false, String(error && error.stack || error))
}

// ── 预设工具插件：真实 defineTool + fake tools/llm/attachments ──
console.log('\n── 预设工具插件冒烟测试 ──')
try {
  const registered = []
  const fakeCtx = {
    get: (n) => ({
      tools: undefined,
      attachments: { saveImage: async (input) => ({ attachmentId: 'smoke', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }) },
      llm: {
        stream: async function* (options) {
          yield { type: 'text-delta', index: 0, text: '图中有' }
          yield { type: 'text-delta', index: 0, text: '一只猫。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }[n]),
  }
  const toolsService = { register: (tool) => { registered.push(tool); return () => {} } }
  // 真实运行时 inject: ['tools'] 会把 ctx.tools 作为属性注入；这里同样提供属性。
  const ctxWithTools = { ...fakeCtx, tools: toolsService }

  const notifyTool = await import(join(PROJECT, 'preset/plugins/notify-tool.ts'))
  notifyTool.apply(ctxWithTools)
  const notifyDef = registered.find((t) => t.name === 'notify_user')
  check('notify_user 工具注册', notifyDef !== undefined)
  if (notifyDef) {
    const out = await notifyDef.execute({ title: 't', body: 'b' })
    check('notify_user execute 返回', typeof out === 'string')
  }

  const visionTool = await import(join(PROJECT, 'preset/plugins/vision-tool.ts'))
  visionTool.apply(ctxWithTools)
  const visionDef = registered.find((t) => t.name === 'vision_describe')
  check('vision_describe 工具注册', visionDef !== undefined)
  if (visionDef) {
    const { writeFileSync, mkdirSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: joinPath } = await import('node:path')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    // 两个独立目录：cwdDir 模拟会话工作区，outside 在其外（同属 /tmp 但互不为子路径）。
    const cwdDir = joinPath(tmpdir(), `mydsh-smoke-cwd-${process.pid}`)
    const outside = joinPath(tmpdir(), `mydsh-smoke-outside-${process.pid}`)
    mkdirSync(cwdDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const file = joinPath(cwdDir, 'mydsh-smoke.png')
    writeFileSync(file, png)
    // 模拟 agent loop 注入的 ToolRunContext（exec.agent.session.header.cwd = 工作区）。
    const exec = { agent: { session: { header: { cwd: cwdDir } } } }
    const out = await visionDef.execute({ path: file, prompt: '这张图里有什么？' }, exec)
    check('vision_describe 返回描述', typeof out === 'string' && out.includes('猫'), out)
    const bad = await visionDef.execute({ path: '/nonexistent/nope.png' }, exec)
    check('vision_describe 缺失文件报错', typeof bad === 'string' && bad.startsWith('ERROR'), bad)

    // ── 安全边界（2026-08-17）：路径限制到工作区，防提示注入外渗 ──
    writeFileSync(joinPath(outside, 'secret.png'), png)
    const denied = await visionDef.execute({ path: joinPath(outside, 'secret.png'), prompt: 'x' }, exec)
    check('vision_describe 拒绝工作区外路径', typeof denied === 'string' && denied.startsWith('ERROR') && denied.includes('outside allowed roots'), denied)
    process.env.MYDSH_VISION_EXTRA_ROOTS = outside
    const viaEnv = await visionDef.execute({ path: joinPath(outside, 'secret.png'), prompt: 'x' }, exec)
    check('vision_describe 允许 env 附加根', typeof viaEnv === 'string' && viaEnv.includes('猫'), viaEnv)
    delete process.env.MYDSH_VISION_EXTRA_ROOTS
    const link = joinPath(cwdDir, `escape-${process.pid}.png`)
    symlinkSync(joinPath(outside, 'secret.png'), link)
    const viaLink = await visionDef.execute({ path: link, prompt: 'x' }, exec)
    check('vision_describe 拒绝符号链接逃逸', typeof viaLink === 'string' && viaLink.startsWith('ERROR'), viaLink)
    const noExec = await visionDef.execute({ path: file, prompt: 'x' })
    check('vision_describe 无会话上下文时 fail closed', typeof noExec === 'string' && noExec.startsWith('ERROR') && noExec.includes('no allowed root'), noExec)
  }
} catch (error) {
  check('预设工具插件加载', false, String(error && error.stack || error))
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)