// mydsh 客户端插件的 npm 打包校验（纯 node，不依赖 harness）。
//
// 这四个包要能被社区用 `dsh plugin --profile web add @mydsh/<name>` 一条命令装上，
// 靠的是 package.json 里的 `dsh.bundle.patch` + 包内 cordis.patch.yml：
// dsh 装完把包名追加到 profile 的 `dsh.profile.bundles`，再应用这一层把插件行
// 插进 loader tree。任一环节漏了（patch 文件没进 files、行 id 与 install.sh 不一致、
// 忘了 publishConfig.access）都不会在本机报错，而是等社区装的时候才炸。
//
// 用法: node tests/npm-packages.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(PROJECT, 'client')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failures += 1; console.error(`  FAIL ${name} ${extra}`) }
}

const dirs = readdirSync(CLIENT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
check('client/ 下有包', dirs.length > 0)

// install.sh 写进 profile patch 的插件行 id（同一批 id 必须与包内 patch 一致，
// 否则「仓库部署」与「npm 安装」两条路径给出的是两个不同的行）。
const installSh = readFileSync(join(PROJECT, 'install.sh'), 'utf8')
// manifest.json 记录了同一批包与 tag，漏登记就会和 README 说的对不上。
const manifest = JSON.parse(readFileSync(join(PROJECT, 'manifest.json'), 'utf8'))
const declared = new Map((manifest.npm?.packages ?? []).map((p) => [p.name, p]))

for (const name of dirs) {
  const dir = join(CLIENT, name)
  console.log(`\n[${name}]`)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) { check('package.json 存在', false, pkgPath); continue }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  check('name 在 @mydsh scope 下', pkg.name === `@mydsh/${name}`, pkg.name)
  check('publishConfig.access=public（scoped 包默认私有）', pkg.publishConfig?.access === 'public', JSON.stringify(pkg.publishConfig))
  check('repository.directory 指向本目录', pkg.repository?.directory === `client/${name}`, JSON.stringify(pkg.repository?.directory))
  check('有 license/author/description/keywords', typeof pkg.license === 'string' && typeof pkg.author === 'string'
    && typeof pkg.description === 'string' && Array.isArray(pkg.keywords) && pkg.keywords.length > 0)
  check('LICENSE 存在', existsSync(join(dir, 'LICENSE')))
  check('README.md 存在', existsSync(join(dir, 'README.md')))

  // exports 的每个目标文件都必须真实存在（发出去才发现 404 就晚了）。
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'string') continue
    check(`exports["${subpath}"] 文件存在`, existsSync(join(dir, target)), target)
  }
  check('dsh.client.platform=web', pkg.dsh?.client?.platform === 'web')

  // ── 一条命令可安装的关键：bundle patch 层 ──
  const patchRel = pkg.dsh?.bundle?.patch
  check('声明 dsh.bundle.patch', typeof patchRel === 'string', JSON.stringify(pkg.dsh?.bundle))
  if (typeof patchRel === 'string') {
    const patchPath = join(dir, patchRel)
    check('bundle patch 文件存在', existsSync(patchPath), patchPath)
    const patchName = patchRel.replace(/^\.\//, '')
    check('bundle patch 进了 files（否则发布后丢失）',
      Array.isArray(pkg.files) && pkg.files.includes(patchName), JSON.stringify(pkg.files))
    if (existsSync(patchPath)) {
      const patch = readFileSync(patchPath, 'utf8')
      // 结构：`- insert:` 下一行 `- id: <id>` + `name: <包名>`（不引 yaml，保持零依赖）。
      check('patch 是 insert 列表', /^\s*- insert:\s*$/m.test(patch), patch.slice(0, 80))
      const id = patch.match(/^\s*- id:\s*(\S+)\s*$/m)?.[1]
      check('patch 行 id 存在', typeof id === 'string', id)
      check('patch 行 name 是本包名', patch.includes(`name: '${pkg.name}'`), pkg.name)
      // 与 install.sh 的 marker 块保持同一个 id：两条安装路径插的是同一行，
      // 用户误装两条时才能被「同 id 两行」这种显式冲突发现（README 有说明）。
      if (typeof id === 'string' && installSh.includes(`name: '${pkg.name}'`)) {
        check('行 id 与 install.sh 一致', installSh.includes(`id: ${id}`), id)
      }
    }
  }

  // files 里列的路径都得存在（打包时静默丢文件是最难查的一类）。
  for (const entry of pkg.files ?? []) check(`files: ${entry} 存在`, existsSync(join(dir, entry)))

  // ── 发布礼节：装在别人机器上不能造成副作用 ─────────────────────────
  // 这一组不是「功能对不对」，而是「装的人会不会被坑」：重复安装、宿主换槽位、
  // localStorage 配额（origin 共享，宿主 UI 也在里面）、静默失败。
  const bundlePath = join(dir, 'lib/client.js')
  if (existsSync(bundlePath)) {
    const src = readFileSync(bundlePath, 'utf8')
    check('有重复挂载防护（两条安装路径都装时不双挂）',
      src.includes('claimMount(') && /MOUNT_KEY = '__mydsh\w+Mounts'/.test(src))
    check('重复时给出可执行的告警', src.includes('mounted ') && src.includes('--dump-config'))
    if (src.includes("ctx.get('slots')")) {
      check('拿不到 slots 服务时有告警（不静默失败）', src.includes('exposes no `slots` service'))
    }
    if (name === 'ui-notify') {
      check('自定义提示音有体积上限', src.includes('MAX_SOUND_BYTES = 512 * 1024'))
      check('上限在读文件之前生效', src.indexOf('MAX_SOUND_BYTES)') < src.indexOf('readAsDataURL'))
      check('保存失败不被静默吞掉', !src.includes('.catch(function() {})') && src.includes("code === 'too-big'"))
      check('有静音开关（不必卸插件才能安静）', src.includes('MUTE_KEY') && src.includes('isMuted()'))
    }
    if (name === 'ui-annotate') {
      check('批注库有总体积上限', src.includes('MAX_TOTAL_BYTES = 256 * 1024'))
      check('删除永远放行（超限的旧库不会锁死）', src.includes('saveAll(all, true)'))
      check('写失败对用户可见', src.includes('setErr(T.full)'))
    }
    if (name === 'ui-video') {
      check('只改写单前导斜杠绝对路径', src.includes('isLocalAbsolute'))
      check('主机层路由缺失时退化保留原链接', src.includes("addEventListener('error'") && src.includes('fallback'))
      check('不往 window 挂全局 observer', !src.includes('window.__mydshVideoObserver'))
    }
  }
  const readmePath = join(dir, 'README.md')
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8')
    check('README 声明了验证过的 dsh 版本', readme.includes('dsh `0.1.0-rc.5`'))
    check('README 写了卸载方式', readme.includes(`remove ${pkg.name}`))
  }

  // manifest.json 的 npm 登记与包本身对齐（版本 + preview tag）。
  const row = declared.get(pkg.name)
  check('manifest.json 已登记本包', row !== undefined)
  if (row !== undefined) {
    check('manifest 版本与 package.json 一致', row.version === pkg.version, `${row.version} vs ${pkg.version}`)
    const prerelease = pkg.version.includes('-')
    check('预发布版本用 preview tag', !prerelease || (row.tag === 'preview' && pkg.publishConfig?.tag === 'preview'),
      `${row.tag} / ${pkg.publishConfig?.tag}`)
  }
}

console.log(failures === 0 ? '\nnpm 打包校验通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)
