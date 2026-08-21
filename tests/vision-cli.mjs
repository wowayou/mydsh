// dsh-vision CLI 测试：纯 node 可跑（CLI 本身零依赖，不需要 harness checkout / tsx）。
//   node tests/vision-cli.mjs
// 覆盖：miniYaml 解析、路由解析（含 env 逃生门/缺密钥）、路径限制（含符号链接逃逸）、
// 三种 API 方言的请求体与取文本、页码解析、以及针对本地假 provider 的端到端
// （200/重试/缓存/审计/--json/--dry-run/拒绝退出码）。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(PROJECT, 'skills/vision/scripts/dsh-vision.mjs')
const mod = await import(CLI)

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failures += 1; console.error(`  FAIL ${name} ${extra}`) }
}

const TMP = mkdtempSync(join(tmpdir(), `mydsh-vision-test-${process.pid}-`))
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// ── miniYaml ────────────────────────────────────────────────────────────────
console.log('── miniYaml ──')
{
  const parsed = mod.miniYaml(`# comment
llm-pi-ai:
  providers:
    acme:
      api: openai-completions
      baseURL: https://acme.test/v1
      apiKeyEnv: ACME_KEY
      models:
        - id: acme-vl-max
          name: 'VL Max'
        - id: acme-text
flag: true
count: 7
`)
  const acme = parsed?.['llm-pi-ai']?.providers?.acme
  check('嵌套 map', acme?.baseURL === 'https://acme.test/v1', JSON.stringify(acme))
  check('map 序列', Array.isArray(acme?.models) && acme.models.length === 2 && acme.models[0].id === 'acme-vl-max', JSON.stringify(acme?.models))
  check('引号剥离', acme?.models?.[0]?.name === 'VL Max')
  check('标量类型', parsed.flag === true && parsed.count === 7, JSON.stringify([parsed.flag, parsed.count]))
  const creds = mod.miniYaml('ACME_KEY: sk-abc\nOTHER: "sk-def"\n')
  check('扁平凭据 map', creds.ACME_KEY === 'sk-abc' && creds.OTHER === 'sk-def')
}

// ── resolveRoute ────────────────────────────────────────────────────────────
console.log('\n── resolveRoute ──')
{
  const settings = { 'llm-pi-ai': { providers: {
    plain: { api: 'openai-completions', baseURL: 'https://plain.test/v1', apiKeyEnv: 'PLAIN_KEY', models: [{ id: 'plain-chat' }] },
    'acme-vision': { api: 'anthropic-messages', baseURL: 'https://acme.test', apiKeyEnv: 'ACME_KEY', models: [{ id: 'acme-vl-max' }] },
  } } }
  const credentials = { ACME_KEY: 'from-creds' }

  const auto = mod.resolveRoute({ settings, credentials, env: {}, spec: undefined })
  check('自动选中视觉 provider', auto.provider === 'acme-vision' && auto.model === 'acme-vl-max', JSON.stringify(auto))
  check('密钥回落 credentials', auto.key === 'from-creds')
  check('env 优先于 credentials', mod.resolveRoute({ settings, credentials, env: { ACME_KEY: 'from-env' } }).key === 'from-env')

  const byPair = mod.resolveRoute({ settings, credentials, env: {}, spec: 'plain/plain-chat' })
  check('provider/model 显式指定', byPair.provider === 'plain' && byPair.model === 'plain-chat')
  check('裸 model 名匹配', mod.resolveRoute({ settings, credentials, env: {}, spec: 'acme-vl-max' }).provider === 'acme-vision')
  check('缺密钥时 key 为 undefined', mod.resolveRoute({ settings, credentials: {}, env: {}, spec: 'plain/plain-chat' }).key === undefined)

  const throws = (fn) => { try { fn(); return false } catch { return true } }
  check('未知 provider 报错', throws(() => mod.resolveRoute({ settings, credentials, env: {}, spec: 'nope/x' })))
  check('未声明的裸 model 报错', throws(() => mod.resolveRoute({ settings, credentials, env: {}, spec: 'ghost' })))
  check('无视觉模型时报错', throws(() => mod.resolveRoute({ settings: { 'llm-pi-ai': { providers: { plain: settings['llm-pi-ai'].providers.plain } } }, credentials, env: {} })))

  const viaEnv = mod.resolveRoute({ settings: {}, credentials: {}, env: { MYDSH_VISION_BASE_URL: 'https://env.test/v1', MYDSH_VISION_API_KEY: 'inline', MYDSH_VISION_MODEL: 'p/env-vl' } })
  check('env 逃生门绕过 settings', viaEnv.baseURL === 'https://env.test/v1' && viaEnv.model === 'env-vl' && viaEnv.key === 'inline', JSON.stringify(viaEnv))
  check('env 逃生门缺模型名报错', throws(() => mod.resolveRoute({ settings: {}, credentials: {}, env: { MYDSH_VISION_BASE_URL: 'https://env.test' } })))
}

// ── endpointOf ──────────────────────────────────────────────────────────────
console.log('\n── endpointOf ──')
check('anthropic 补 /v1/messages', mod.endpointOf('anthropic-messages', 'https://a.test') === 'https://a.test/v1/messages')
check('anthropic 已含 /v1', mod.endpointOf('anthropic-messages', 'https://a.test/v1/') === 'https://a.test/v1/messages')
check('responses', mod.endpointOf('openai-responses', 'https://o.test/v1') === 'https://o.test/v1/responses')
check('completions 默认', mod.endpointOf('openai-completions', 'https://o.test/v1') === 'https://o.test/v1/chat/completions')

// ── rootsFrom / contain ─────────────────────────────────────────────────────
console.log('\n── 路径限制 ──')
{
  const inside = join(TMP, 'ws')
  const outside = join(TMP, 'out')
  mkdirSync(inside, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const good = join(inside, 'a.png')
  writeFileSync(good, PNG)
  writeFileSync(join(outside, 'secret.png'), PNG)
  writeFileSync(join(inside, 'notes.txt'), 'x')
  const big = join(inside, 'big.png')
  writeFileSync(big, Buffer.alloc(21 * 1024 * 1024))
  const escape = join(inside, 'escape.png')
  symlinkSync(join(outside, 'secret.png'), escape)

  check('ROOTS 固定即权威', JSON.stringify(mod.rootsFrom({ MYDSH_VISION_ROOTS: `${inside}:relative-ignored`, MYDSH_VISION_EXTRA_ROOTS: outside }, '/cwd')) === JSON.stringify({ roots: [inside], pinned: true }), JSON.stringify(mod.rootsFrom({ MYDSH_VISION_ROOTS: `${inside}:relative-ignored`, MYDSH_VISION_EXTRA_ROOTS: outside }, '/cwd')))
  check('默认 cwd + EXTRA_ROOTS', JSON.stringify(mod.rootsFrom({ MYDSH_VISION_EXTRA_ROOTS: outside }, inside)) === JSON.stringify({ roots: [inside, outside], pinned: false }))
  check('相对路径根被忽略', mod.rootsFrom({ MYDSH_VISION_ROOTS: 'relative/x' }, inside).pinned === false)

  const roots = [inside]
  check('根内图片通过', mod.contain(good, roots).ok === true)
  check('根外拒绝', mod.contain(join(outside, 'secret.png'), roots).reason === 'outside')
  check('符号链接逃逸拒绝', mod.contain(escape, roots).reason === 'outside')
  check('缺失文件拒绝', mod.contain(join(inside, 'nope.png'), roots).reason === 'missing')
  check('目录拒绝', mod.contain(inside, roots).reason === 'not-file')
  check('非媒体类型拒绝', mod.contain(join(inside, 'notes.txt'), roots).reason === 'unsupported')
  check('超大文件拒绝', mod.contain(big, roots).reason === 'too-large')
  check('无根拒绝', mod.contain(good, []).reason === 'no-roots')
  check('kindOf 分类', mod.kindOf('a.PDF').kind === 'pdf' && mod.kindOf('a.MP4').kind === 'video' && mod.kindOf('a.jpeg').mediaType === 'image/jpeg')
}

// ── parsePages ──────────────────────────────────────────────────────────────
console.log('\n── parsePages ──')
check('区间 + 单页 + 去重', JSON.stringify(mod.parsePages('1-3,7,3')) === JSON.stringify([1, 2, 3, 7]))
{
  const throws = (spec) => { try { mod.parsePages(spec); return false } catch { return true } }
  check('倒序区间报错', throws('3-1'))
  check('零页报错', throws('0'))
  check('非数字报错', throws('a'))
  check('空报错', throws(' '))
}

// ── buildRequest / extractText ──────────────────────────────────────────────
console.log('\n── 三种方言 ──')
{
  const images = [{ base64: 'AAA', mediaType: 'image/png' }]
  const a = mod.buildRequest({ api: 'anthropic-messages', model: 'm', prompt: 'q', images })
  check('anthropic 图片块', a.messages[0].content[1].source.data === 'AAA' && a.messages[0].content[1].source.media_type === 'image/png', JSON.stringify(a))
  const r = mod.buildRequest({ api: 'openai-responses', model: 'm', prompt: 'q', images })
  check('responses input_image', r.input[0].content[1].image_url === 'data:image/png;base64,AAA', JSON.stringify(r))
  const c = mod.buildRequest({ api: 'openai-completions', model: 'm', prompt: 'q', images })
  check('completions image_url', c.messages[0].content[1].image_url.url === 'data:image/png;base64,AAA', JSON.stringify(c))
  check('prompt 在首位', a.messages[0].content[0].text === 'q' && r.input[0].content[0].text === 'q' && c.messages[0].content[0].text === 'q')

  check('取文本 anthropic', mod.extractText('anthropic-messages', { content: [{ type: 'text', text: ' hi ' }] }) === 'hi')
  check('取文本 responses output_text', mod.extractText('openai-responses', { output_text: 'hi' }) === 'hi')
  check('取文本 responses output[]', mod.extractText('openai-responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }) === 'hi')
  check('取文本 completions 字符串', mod.extractText('openai-completions', { choices: [{ message: { content: 'hi' } }] }) === 'hi')
  check('取文本 completions 分块', mod.extractText('openai-completions', { choices: [{ message: { content: [{ type: 'text', text: 'h' }, { type: 'text', text: 'i' }] } }] }) === 'hi')
  check('取不到返回空串', mod.extractText('openai-completions', {}) === '')
}

// ── 端到端：本地假 provider ──────────────────────────────────────────────────
console.log('\n── 端到端（假 provider）──')
const state = { calls: 0, failFirst: 0, lastBody: null, lastAuth: null }
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    state.calls += 1
    state.lastAuth = req.headers.authorization
    try { state.lastBody = JSON.parse(raw) } catch { state.lastBody = null }
    if (state.failFirst > 0) {
      state.failFirst -= 1
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('upstream busy')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '图中有一只猫。' } }] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

const HOME = join(TMP, 'dsh-home')
const WS = join(TMP, 'ws2')
mkdirSync(HOME, { recursive: true })
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'card.png'), PNG)
writeFileSync(join(HOME, 'settings.yaml'), `llm-pi-ai:
  providers:
    fake-vision:
      api: openai-completions
      baseURL: http://127.0.0.1:${PORT}/v1
      apiKeyEnv: FAKE_VISION_KEY
      models:
        - id: fake-vl-max
`)
writeFileSync(join(HOME, '.credentials.yaml'), 'FAKE_VISION_KEY: sk-fake-000\n')

// 注意：假 provider 跑在本进程里，所以子进程必须异步 spawn —— spawnSync 会
// 阻塞事件循环，HTTP 请求永远得不到响应（死锁）。
const cli = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: WS,
    env: { ...process.env, DSH_HOME: HOME, MYDSH_VISION_EXTRA_ROOTS: '', ...env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  child.on('close', (status) => resolve({ status, stdout, stderr }))
})

{
  const first = await cli(['card.png', '--max-side', '0'])
  check('首次调用成功', first.status === 0 && first.stdout.includes('一只猫'), `${first.status} ${first.stdout} ${first.stderr}`)
  check('请求带 Bearer 密钥', state.lastAuth === 'Bearer sk-fake-000', String(state.lastAuth))
  check('请求体含 data URL 图片', state.lastBody?.messages?.[0]?.content?.[1]?.image_url?.url?.startsWith('data:image/png;base64,') === true)
  check('默认 preset 是描述类', typeof state.lastBody?.messages?.[0]?.content?.[0]?.text === 'string' && state.lastBody.messages[0].content[0].text.includes('描述'))

  const callsBefore = state.calls
  const cached = await cli(['card.png', '--max-side', '0', '--json'])
  const parsed = JSON.parse(cached.stdout)
  check('缓存命中不再请求', state.calls === callsBefore && parsed.cached === true, `${state.calls} vs ${callsBefore}`)
  check('--json 带路由元信息', parsed.model === 'fake-vl-max' && parsed.provider === 'fake-vision' && parsed.images[0].label === 'card.png', cached.stdout)

  const fresh = await cli(['card.png', '--max-side', '0', '--no-cache'])
  check('--no-cache 重新请求', state.calls === callsBefore + 1 && fresh.status === 0)

  // 不同 prompt → 不同缓存键
  const other = await cli(['card.png', '--max-side', '0', '-p', '这是什么？'])
  check('不同 prompt 不复用缓存', state.calls === callsBefore + 2 && other.status === 0)

  state.failFirst = 2
  const retried = await cli(['card.png', '--max-side', '0', '--no-cache', '-p', 'retry-case', '--retries', '2'])
  check('503 后重试成功', retried.status === 0 && retried.stdout.includes('一只猫'), `${retried.status} ${retried.stderr}`)

  state.failFirst = 5
  const gaveUp = await cli(['card.png', '--max-side', '0', '--no-cache', '-p', 'fail-case', '--retries', '1'])
  check('重试耗尽后失败退出', gaveUp.status === 1 && gaveUp.stderr.includes('HTTP 503'), `${gaveUp.status} ${gaveUp.stderr}`)
  state.failFirst = 0

  const dry = await cli(['card.png', '--dry-run'], { DSH_HOME: HOME })
  const dryJson = JSON.parse(dry.stdout)
  check('--dry-run 不发请求', dry.status === 0 && dryJson.dryRun === true && dryJson.url.includes(`127.0.0.1:${PORT}`), dry.stdout)

  const denied = await cli(['/etc/passwd'])
  check('根外输入退出码 1', denied.status === 1 && denied.stderr.includes('不在允许根内'), `${denied.status} ${denied.stderr}`)

  const noArgs = await cli([])
  check('无参数打印用法并返回 2', noArgs.status === 2 && noArgs.stderr.includes('用法'), String(noArgs.status))
  const help = await cli(['--help'])
  check('--help 返回 0', help.status === 0 && help.stdout.includes('dsh-vision'))
  const badPreset = await cli(['card.png', '--preset', 'nope'])
  check('未知 preset 报错', badPreset.status === 1 && badPreset.stderr.includes('未知 --preset'), badPreset.stderr)
  const badInt = await cli(['card.png', '--frames', 'abc'])
  check('非法数值选项报错', badInt.status === 1 && badInt.stderr.includes('--frames'), badInt.stderr)

  const noKey = await cli(['card.png', '--max-side', '0', '--no-cache', '-p', 'nokey'], { DSH_HOME: join(TMP, 'empty-home') })
  check('无配置时报选路失败', noKey.status === 1 && noKey.stderr.includes('自动选路失败'), noKey.stderr)

  // 密钥绝不出现在审计日志里
  const audit = readFileSync(join(HOME, 'mydsh/vision.jsonl'), 'utf8')
  check('审计记录 cli-sent', audit.includes('"event":"cli-sent"') && audit.includes('"via":"skill-cli"'))
  check('审计记录 cli-denied', audit.includes('"event":"cli-denied"') && audit.includes('"reason":"outside"'))
  check('审计记录 cli-cache-hit', audit.includes('"event":"cli-cache-hit"'))
  check('审计不含密钥', !audit.includes('sk-fake-000'))
  check('审计不含图片字节', !audit.includes('base64'))
}

server.close()
rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)
