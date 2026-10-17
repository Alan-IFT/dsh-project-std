// package.json 清单合规（awesome-dsh-plugin 的收录要求 + 官方 @deepseek-ai/dsh-package-manifest 的字段）。
// 这些是“被收录审查打回”的常见原因，也是装入时 DSH 读的字段；写成测试，改坏时当场知道。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('收录要求：声明 dsh.bundle.patch，且指向的 cordis.patch.yml 真在仓库根', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, 'cordis.patch.yml')))
})

test('官方清单字段：dsh.manifestVersion 是 1；engines.dsh 只列实际验证过的精确版本（0.2.1 起宿主导入前强制校验，不满足整包跳过）', () => {
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(typeof pkg.engines?.dsh, 'string'); assert.ok(pkg.engines.dsh.length > 0, 'engines.dsh 不能为空')
  const entries = pkg.engines.dsh.split('||').map((s) => s.trim())
  assert.ok(entries.length >= 1, 'engines.dsh 至少列一个版本')
  assert.deepEqual(entries, ['0.2.0-rc.2', '0.2.1-rc.2'], '验证过的宿主版本清单；新增一项前先在该宿主上实测插件能激活')
  for (const e of entries) assert.match(e, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, '每一项都写精确版本，不写没验证过的范围')
})

test('不抄规范外的字段：官方 package-manifest 里没有 dsh.compatibility（那是个别社区包自己加的），这里不写', () => {
  assert.equal(pkg.dsh.compatibility, undefined)
})

test('收录要求：包名等于仓库名；repository／homepage／bugs 都指向同一个仓库', () => {
  assert.equal(pkg.name, 'dsh-project-std')
  const repo = 'github.com/Alan-IFT/dsh-project-std'
  assert.ok(pkg.repository.url.includes(repo)); assert.ok(pkg.homepage.includes(repo)); assert.ok(pkg.bugs.url.includes(repo))
})

test('收录要求：keywords 含 dsh-plugin；description 非空、不含已删除的机制（描述与代码不符是被打回的头号原因）', () => {
  assert.ok(pkg.keywords.includes('dsh-plugin'))
  assert.ok(pkg.description.length > 10)
  assert.doesNotMatch(pkg.description, /\.std|内嵌|标准目录只读|check_all|subtree|Python/i, '描述里不能再出现已删除的机制')
})

test('peer 范围：dsh-tools 放行已验证的下限，并显式放行 0.2.1 的预发布（收录文档警告：不带预发布分支会让用户装时 ERESOLVE）', () => {
  const r = pkg.peerDependencies['@deepseek-ai/dsh-tools']
  assert.match(r, /\|\|/, '范围里要有显式的预发布分支')
  assert.match(r, />=0\.2\.0-rc\.2/, '下限是验证过的 0.2.0-rc.2'); assert.match(r, />=0\.2\.1-0/, '放行 0.2.1 的预发布')
})

test('files 白名单：包里带运行所需的 lib、skills、契约文档与清单，不带源码、测试、历史', () => {
  for (const must of ['lib', 'skills', 'cordis.patch.yml', 'README.md', 'LICENSE']) assert.ok(pkg.files.includes(must), `files 缺 ${must}`)
  for (const bad of ['src', 'test', 'docs', 'scripts', '.githooks', 'tools/dsh-std', '标准', 'templates']) assert.ok(!pkg.files.includes(bad), `files 不该带 ${bad}`)
})

test('exports 与 bin 指向的文件真在 lib 里（lib 提交进 git，装入时没有构建步骤）', () => {
  for (const p of [pkg.main, pkg.types, pkg.bin['std-check'], pkg.exports['.'].default, pkg.exports['./skills'].default]) assert.ok(existsSync(join(root, p)), `${p} 不存在`)
})
