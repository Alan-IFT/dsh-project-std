#!/usr/bin/env node
// 校验 lib/ 与 src/ 一致（重构设计 §4：lib/ 是提交进 git 的发布产物，src/ 才是手写源，二者不一致就是没构建就提交）。
// 做法：把 src/ 重新编译到项目 .staging 下的唯一临时目录，与已提交的 lib/ 逐文件逐字节比较。只读：不改 lib/，不改 src/。
// 退出码：0 一致；1 不一致（列出差异）；2 校验本身没跑成（缺 tsc 等）——没跑成按失败处理（01 §2 N1）。
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

function diagnostic(message) {
  console.error(`lib 校验没跑成：${message}`)
}

function canonicalDirectory(path, expected, label) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} 不是普通目录`)
  const actual = realpathSync(path)
  if (actual !== expected) throw new Error(`${label} 的真实路径越界：${actual}`)
  return { info, actual }
}

function ensureStaging(root) {
  const base = join(root, '.staging')
  try {
    mkdirSync(base)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  canonicalDirectory(base, base, '.staging')
  return base
}

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`拒绝遍历符号链接：${path}`)
    if (entry.isDirectory()) return walkFiles(path)
    if (!entry.isFile()) throw new Error(`产物不是普通文件：${path}`)
    return [path]
  })
}

function readTree(dir) {
  return new Map(walkFiles(dir).map((path) => [
    relative(dir, path).split('\\').join('/'),
    readFileSync(path).toString('utf8').replace(/\r\n/g, '\n'), // 行尾不当差异：Windows 检出可能是 CRLF，索引里是 LF
  ]))
}

function runLibSync(root = join(dirname(scriptPath), '..')) {
  let canonicalRoot
  let staging
  let temp
  let tempIdentity
  let result = 2
  let builtCount = 0

  try {
    canonicalRoot = realpathSync(root)
    staging = ensureStaging(canonicalRoot)
    temp = mkdtempSync(join(staging, 'lib-sync-'))
    const created = canonicalDirectory(temp, temp, '临时目录')
    if (!created.info.dev || !created.info.ino) throw new Error('平台未提供可用的临时目录身份，拒绝执行不可安全清理的构建')
    tempIdentity = { dev: created.info.dev, ino: created.info.ino }

    const compiler = join(canonicalRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    try {
      lstatSync(compiler)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('找不到 node_modules/typescript/bin/tsc（先 pnpm install）')
      throw error
    }
    const build = spawnSync(process.execPath, [compiler, '-p', join(canonicalRoot, 'tsconfig.json'), '--outDir', temp], { cwd: canonicalRoot, encoding: 'utf8' })
    if (build.error) throw new Error(`启动 tsc 失败：${build.error.message}`)
    if (build.status !== 0) throw new Error(`tsc 失败（status=${build.status}, signal=${build.signal || 'none'}）。\n${build.stdout || ''}${build.stderr || ''}`)

    const built = readTree(temp)
    if (built.size === 0) throw new Error('tsc 未生成任何文件，拒绝将空输出视为通过')
    const libDir = join(canonicalRoot, 'lib')
    let committed = new Map()
    try {
      const info = lstatSync(libDir)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`lib/ 不是普通目录：${libDir}`)
      committed = readTree(libDir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const problems = []
    for (const [path, contents] of built) {
      if (!committed.has(path)) problems.push(`lib/${path}：src 能构建出来，但 lib/ 里没有（忘了构建？）`)
      else if (committed.get(path) !== contents) problems.push(`lib/${path}：内容与从当前 src 构建的结果不同（src 改了没重新构建，或 lib 被手改）`)
    }
    for (const path of committed.keys()) {
      if (!built.has(path)) problems.push(`lib/${path}：src 里已没有对应源码，是过期产物（该删）`)
    }

    if (problems.length) {
      console.error('lib/ 与 src/ 不一致：\n  ' + problems.join('\n  '))
      result = 1
    } else {
      builtCount = built.size
      result = 0
    }
  } catch (error) {
    diagnostic(error?.stack || String(error))
    result = 2
  } finally {
    if (temp) {
      try {
        if (!canonicalRoot || realpathSync(root) !== canonicalRoot) throw new Error('仓库根目录身份改变，拒绝清理临时目录')
        canonicalDirectory(staging, join(canonicalRoot, '.staging'), '.staging')
        const current = canonicalDirectory(temp, temp, '临时目录')
        if (!tempIdentity || current.info.dev !== tempIdentity.dev || current.info.ino !== tempIdentity.ino) {
          throw new Error('临时目录身份改变，拒绝删除非本次创建的路径')
        }
        rmSync(temp, { recursive: true, force: false })
      } catch (error) {
        diagnostic(`清理临时目录失败：${error?.stack || String(error)}`)
        result = 2
      }
    }
  }
  if (result === 0) console.log(`lib/ 与 src/ 一致（${builtCount} 个文件）`)
  return result
}

export { runLibSync }

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  process.exitCode = runLibSync()
}
