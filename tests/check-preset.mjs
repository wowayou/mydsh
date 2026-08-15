// mydsh 预设校验：模拟 PresetTree 的解析规则逐行解析并验证可导入。
//  - 相对行 ('./x') 相对预设目录解析；
//  - 裸包名从 harness base（apps/cli）解析（含子路径行）；
//  - 'cordis:' 内建。
// 用法: node tests/check-preset.mjs [preset 目录] [harness base]
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// yaml 从 profile node_modules 解析（heal 生成的扁平依赖，含 yaml）。
const harnessRequire = createRequire('/home/forbackup/.dsh/profiles/node_modules/yaml/package.json')
const yaml = harnessRequire('yaml')

const require = createRequire(import.meta.url)
const PRESET_DIR = process.argv[2] ?? '/home/forbackup/.dsh/.agent-presets/mydsh'
const HARNESS_BASE = process.argv[3] ?? '/home/forbackup/deepseek-harness/apps/cli'
const COMPOSE = join(PRESET_DIR, 'agent.cordis.yml')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failures += 1; console.error(`  FAIL ${name} ${extra}`) }
}

if (!existsSync(COMPOSE)) {
  console.error(`找不到预设: ${COMPOSE}`)
  process.exit(1)
}

// 掩掉 loader 方言的 !!js 表达式（只解析结构，不执行表达式）。
const raw = readFileSync(COMPOSE, 'utf8').replace(/!!js .*$/gm, 'js-expr')
let rows
try {
  rows = yaml.parse(raw)
} catch (error) {
  console.error('YAML 解析失败:', error.message)
  process.exit(1)
}

/** 递归收集所有行（含 group 嵌套）。 */
function collect(list, out = []) {
  for (const item of list ?? []) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.id === 'string' && typeof item.name === 'string') out.push(item)
    if (Array.isArray(item.config)) collect(item.config, out)
  }
  return out
}

const all = collect(rows)
check(`YAML 解析 + 行数 ${all.length}`, all.length >= 25)

let nameCount = 0
for (const row of all) {
  const name = row.name
  nameCount += 1
  if (name.startsWith('cordis:')) { check(`[${row.id}] 内建 ${name}`, true); continue }
  if (name.startsWith('.')) {
    const rel = join(PRESET_DIR, name)
    check(`[${row.id}] 相对文件 ${name}`, existsSync(rel), `→ ${rel}`)
    continue
  }
  // 裸包名（可能带子路径）：先从 harness base 解析 package.json。
  let resolved = null
  try { resolved = require.resolve(`${name}/package.json`, { paths: [HARNESS_BASE] }) } catch {}
  if (resolved === null) {
    const root = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
    try { resolved = require.resolve(`${root}/package.json`, { paths: [HARNESS_BASE] }) } catch {}
  }
  check(`[${row.id}] 包 ${name}`, resolved !== null, resolved ?? '')
}

// 顶部元数据（persona 等）非行结构仅检查文件存在。
check('preset.yml 存在', existsSync(join(PRESET_DIR, 'preset.yml')))
check('plugins/notify-tool.ts 存在', existsSync(join(PRESET_DIR, 'plugins/notify-tool.ts')))
check('plugins/vision-tool.ts 存在', existsSync(join(PRESET_DIR, 'plugins/vision-tool.ts')))

console.log(failures === 0 ? '\n预设校验通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)
