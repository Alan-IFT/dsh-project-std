// 包级不变量：构建产物不得静态导入宿主包。
// 真机 profile 的 node_modules 里没有运行时服务包（@deepseek-ai/dsh-tools 之类），
// 插件一旦静态导入它们，bundle 条目就会 “failed to import”——这个缺陷真的发生过一次。
// 只扫 ESM 静态形式：动态 require/import 判据另由 config-install-import.test.mjs 按安装形态实测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return jsFiles(full)
    return entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name) ? [full] : []
  })
}

// 行首的 ESM 静态导入／再导出；类型导入在编译后不会留下痕迹，所以扫 lib 即可。
// 静态形式之外的动态写法（try/catch 里的 createRequire 探测、顶层 await import）本扫描不判，
// 由 config-install-import.test.mjs 按安装形态实际导入三入口覆盖。
const STATIC_HOST_IMPORT = /^[ \t]*(?:import|export)[^;]*?from[ \t]*['"]@deepseek-ai\/|^[ \t]*import[ \t]*['"]@deepseek-ai\//m

test('构建产物不得静态导入宿主包', () => {
  const files = jsFiles(join(root, 'lib'))
  assert.ok(files.length > 20, `lib 下应有构建产物，实际 ${files.length} 个模块文件`)
  const offenders = files
    .filter((file) => STATIC_HOST_IMPORT.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
  assert.deepEqual(offenders, [], '这些文件静态导入了宿主包，真机装机时会导入失败')
})
