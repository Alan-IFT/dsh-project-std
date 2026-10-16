// 按“已安装插件”的形态导入：临时 node_modules 里只有本包，没有任何宿主包。
// 真实 profile 就是这样——宿主包（如 @deepseek-ai/dsh-tools）不在 profile 的 node_modules 里，
// 安装的插件一旦静态导入它们，整个条目就会 import 失败。这个测试必须与真实形态一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 把 package.files 白名单连同 package.json 复制成一个“装好的包”。 */
function installInto(target) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const entries = ['package.json', ...pkg.files]
  for (const rel of entries) {
    const from = join(root, rel)
    const to = join(target, rel)
    if (!existsSync(from)) throw new Error(`package.files 声明了不存在的 ${rel}`)
    mkdirSync(dirname(to), { recursive: true })
    if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
    else copyFileSync(from, to)
  }
  return pkg
}

test('按安装形态导入：三个条目在没有任何宿主包的 node_modules 下都能加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'std-installed-'))
  try {
    const pkgDir = join(dir, 'node_modules', 'dsh-project-std')
    const pkg = installInto(pkgDir)
    // 只放本包：宿主包缺失正是真实 profile 的形态，这条断言保证测试环境确实干净。
    assert.deepEqual(readFileSync(join(pkgDir, 'package.json'), 'utf8'), readFileSync(join(root, 'package.json'), 'utf8'))
    assert.ok(!existsSync(join(dir, 'node_modules', '@deepseek-ai')), '临时 node_modules 里不得有宿主包')
    const specifiers = [pkg.name, `${pkg.name}/skills`, `${pkg.name}/config`]
    writeFileSync(join(dir, 'probe.mjs'), `export const loaded = Promise.all(${JSON.stringify(specifiers)}.map(async (s) => ({ specifier: s, url: import.meta.resolve(s), keys: Object.keys(await import(s)).sort() })))\n`)
    const probe = await import(pathToFileURL(join(dir, 'probe.mjs')).href)
    const loaded = await probe.loaded
    assert.deepEqual(loaded.map((entry) => entry.specifier), specifiers)
    for (const entry of loaded) assert.ok(entry.url.startsWith(pathToFileURL(pkgDir).href), `${entry.specifier} 必须解析到安装副本：${entry.url}`)
    // 导出面与各入口实际提供的一致（技能入口不接受插件配置，所以没有 Config）。
    assert.deepEqual(loaded[0].keys, ['Config', 'apply', 'inject', 'name'])
    assert.deepEqual(loaded[1].keys, ['apply', 'inject', 'name'])
    assert.deepEqual(loaded[2].keys, ['Config', 'apply', 'buildConfig', 'inject', 'name', 'validateConfig'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
