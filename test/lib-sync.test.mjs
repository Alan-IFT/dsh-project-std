// lib-sync checker regression tests use isolated project roots and a fixture-only Node compiler.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { runLibSync } from '../scripts/check-lib-sync.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const checker = join(project, 'scripts', 'check-lib-sync.mjs')
const stageRoot = join(project, '.staging')

function makeRoot({ compiler = true, output = 'export const fixture = true\n', exit = 0 } = {}) {
  // A fresh checkout has no ignored scratch directory; create only this layer.
  try { mkdirSync(stageRoot) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stageInfo = lstatSync(stageRoot)
  assert.ok(stageInfo.isDirectory() && !stageInfo.isSymbolicLink(), '.staging must be a real directory')
  assert.equal(realpathSync(stageRoot), stageRoot)
  const root = mkdtempSync(join(stageRoot, 'lib-sync-test-'))
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    writeFileSync(join(root, 'src', 'fixture.ts'), output)
    writeFileSync(join(root, 'lib', 'fixture.js'), output.replace(/\.ts/g, '.js'))
    if (compiler) {
      const compilerPath = join(root, 'node_modules', 'typescript', 'bin')
      mkdirSync(compilerPath, { recursive: true })
      writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"type":"commonjs"}')
      writeFileSync(join(compilerPath, 'tsc'), `const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');\nconst { join } = require('node:path');\nconst root = process.cwd();\nconst source = readFileSync(join(root, 'src', 'fixture.ts'), 'utf8');\nif (source.includes('FIXTURE_FAIL')) { console.error('fixture compilation failed'); process.exitCode = ${exit || 1}; } else { const out = process.argv[process.argv.indexOf('--outDir') + 1]; mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'fixture.js'), source.replace(/\\.ts/g, '.js')); }\n`)
    }
    return root
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function dispose(root) {
  if (root) rmSync(root, { recursive: true, force: true })
}

function runCli(root) {
  const scriptCopy = join(root, 'scripts', 'check-lib-sync.mjs')
  mkdirSync(dirname(scriptCopy), { recursive: true })
  cpSync(checker, scriptCopy)
  const result = spawnSync(process.execPath, [scriptCopy], { cwd: root, stdio: 'ignore' })
  return result.status
}

test('fixture compiler output matches; CRLF normalizes; owned scratch is removed', () => {
  const root = makeRoot({ output: 'export const fixture = true\r\n' })
  try {
    writeFileSync(join(root, 'lib', 'fixture.js'), 'export const fixture = true\n')
    const sentinel = join(root, '.staging', 'keep.txt')
    mkdirSync(join(root, '.staging'), { recursive: true })
    writeFileSync(sentinel, 'keep')
    assert.equal(runLibSync(root), 0)
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
    assert.deepEqual((awaitScratchNames(root)), [])
  } finally { dispose(root) }
})

function awaitScratchNames(root) {
  const path = join(root, '.staging')
  return existsSync(path) ? readdirSync(path).filter((name) => name.startsWith('lib-sync-')) : []
}

test('missing, changed, and stale outputs each return 1', () => {
  const root = makeRoot()
  try {
    rmSync(join(root, 'lib', 'fixture.js'))
    assert.equal(runLibSync(root), 1)
    writeFileSync(join(root, 'lib', 'fixture.js'), 'different\n')
    assert.equal(runLibSync(root), 1)
    writeFileSync(join(root, 'lib', 'fixture.js'), 'export const fixture = true\n')
    assert.equal(runLibSync(root), 0)
    writeFileSync(join(root, 'lib', 'other.js'), 'export const other = true\n')
    assert.equal(runLibSync(root), 1)
  } finally { dispose(root) }
})

test('missing compiler, failed compiler, and empty output return 2 and clean scratch', () => {
  const missing = makeRoot({ compiler: false })
  const failed = makeRoot({ output: 'FIXTURE_FAIL\n' })
  const empty = makeRoot()
  try {
    assert.equal(runLibSync(missing), 2)
    assert.equal(runLibSync(failed), 2)
    // A fixture compiler that exits successfully without writing output is not accepted.
    writeFileSync(join(empty, 'node_modules', 'typescript', 'bin', 'tsc'), 'process.exitCode = 0\n')
    assert.equal(runLibSync(empty), 2)
    for (const root of [missing, failed, empty]) assert.deepEqual(awaitScratchNames(root), [])
  } finally { dispose(missing); dispose(failed); dispose(empty) }
})

test('cleanup refuses a replaced owned path and returns 2', () => {
  const root = makeRoot()
  try {
    const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
    writeFileSync(compiler, `const { rmSync, writeFileSync } = require('node:fs');\nconst out = process.argv[process.argv.indexOf('--outDir') + 1];\nrmSync(out, { recursive: true });\nwriteFileSync(out, 'not the owned directory');\n`)
    assert.equal(runLibSync(root), 2)
    assert.equal(readFileSync(join(root, '.staging', readdirSync(join(root, '.staging')).find((name) => name.startsWith('lib-sync-'))), 'utf8'), 'not the owned directory')
  } finally { dispose(root) }
})

test('preexisting staging is preserved; staging symlink and non-directory are rejected', (t) => {
  const root = makeRoot()
  const external = mkdtempSync(join(stageRoot, 'lib-sync-external-'))
  try {
    const staging = join(root, '.staging')
    mkdirSync(staging)
    writeFileSync(join(staging, 'sentinel'), 'preserve')
    assert.equal(runLibSync(root), 0)
    assert.equal(readFileSync(join(staging, 'sentinel'), 'utf8'), 'preserve')
    rmSync(staging, { recursive: true })
    writeFileSync(staging, 'not a directory')
    assert.equal(runLibSync(root), 2)
    rmSync(staging)
    try { symlinkSync(external, staging, 'junction') } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`junction fixture unavailable: ${error.code}`); return }
      throw error
    }
    assert.equal(runLibSync(root), 2)
    assert.equal(existsSync(join(external, 'sentinel')), false)
  } finally { dispose(root); dispose(external) }
})

test('parallel CLI invocations use independent scratch; import is side-effect free', async () => {
  const first = makeRoot()
  const second = makeRoot()
  const importProbe = join(first, 'import-probe.mjs')
  try {
    cpSync(checker, join(first, 'check-lib-sync.mjs'))
    writeFileSync(importProbe, `import { runLibSync } from './check-lib-sync.mjs';\nif (typeof runLibSync !== 'function') process.exitCode = 1;\n`)
    assert.equal(spawnSync(process.execPath, [importProbe], { cwd: first, stdio: 'ignore' }).status, 0)
    const statuses = await Promise.all([first, second].map((root) => new Promise((resolve, reject) => {
      const script = join(root, 'scripts', 'check-lib-sync.mjs')
      mkdirSync(dirname(script), { recursive: true })
      cpSync(checker, script)
      const child = spawn(process.execPath, [script], { cwd: root, stdio: 'ignore' })
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })))
    assert.deepEqual(statuses, [0, 0])
    assert.deepEqual(awaitScratchNames(first), [])
    assert.deepEqual(awaitScratchNames(second), [])
  } finally { dispose(first); dispose(second) }
})
