// scripts/check-residue.mjs（废弃技术栈字样白名单）的验收测试：在临时 git 仓里造文件，验证“白名单内放行、白名单外拦下”两个方向，
// 并验证白名单的粒度：同一个字样，换一个路径就从放行变拦下。最后在本仓真实跑一次，必须通过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', 'scripts', 'check-residue.mjs')
const tmps = []
test.after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true, maxRetries: 3 }) })

/** 在临时仓里放 files（相对路径 → 内容），把脚本拷到 scripts/ 下（它按自身位置推仓根），返回 {rc, out}。 */
function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'resid-')); tmps.push(root)
  const git = (...a) => { const r = spawnSync('git', ['-C', root, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(a.join(' ') + r.stderr) }
  git('init', '-q')
  mkdirSync(join(root, 'scripts'), { recursive: true }); cpSync(SCRIPT, join(root, 'scripts', 'check-residue.mjs'))
  for (const [rel, body] of Object.entries(files)) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
  git('add', '-A', '-f')
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-residue.mjs')], { encoding: 'utf8' })
  return { rc: r.status, out: r.stdout.replaceAll('\r\n', '\n') }
}

const WORDS = ['Claude Code', 'claude-code', 'CLAUDE.md', '.claude/', 'claude plugin', '.std/', 'git subtree', 'STANDARD_VERSION']

test('白名单之外出现任一废弃字样 → 退出 1，并指出文件、行号与次数（8 个字样逐个）', () => {
  for (const w of WORDS) {
    const r = run({ 'docs/普通文档.md': `# 标题\n\n正文里提到 ${w} 一次。\n` })
    assert.equal(r.rc, 1, w); assert.match(r.out, /docs\/普通文档\.md（1 处）/, w); assert.match(r.out, /3: 正文里提到/, '行号')
  }
})

test('同样的字样放进白名单路径 → 退出 0：冻结区、历史叙述、迁移功能、设计账、反例数据', () => {
  const w = 'CLAUDE.md'
  for (const rel of ['docs/审计记录/001.md', 'docs/归档/x.md', 'docs/参考资料/y.md', 'docs/参考资料-Claude/z.md', '标准/参考资料/M.md', 'docs/决策日志.md', 'docs/失败Case清单.md', 'docs/重构设计-TS插件化.md', 'src/migrate.ts', 'test/migrate.test.mjs', 'test/mutations/migrate.json', 'test/cases/a.mjs', 'test/mutations/docs.json', 'src/guard/policy.ts', 'lib/x.js', 'skills/s.md', 'tools/std/README.md', 'docs/附录-载体实例/迁移提示词.md']) {
    const r = run({ [rel]: `含 ${w} 的一行\n` }); assert.equal(r.rc, 0, rel + ' 应在白名单内：' + r.out)
  }
})

test('白名单的粒度：同一目录下“相近但不同”的路径不放行（防白名单被写成前缀通配）', () => {
  for (const rel of ['docs/决策日志副本.md', 'docs/重构设计.md', 'docs/附录-载体实例/README.md', 'docs/附录-载体实例/迁移提示词副本.md', 'docs/附录-载体实例/子目录/迁移提示词.md', 'src/checks/links.ts', 'src/core/fs.ts', 'test/other.test.mjs', 'scripts/other.mjs', 'templates/AGENTS.md', 'tools/std/NOTES.md', 'tools/other/README.md', 'docs/审计记录x/a.md', '标准/01-另一章.md', 'tools/dsh-std/README.md', 'tools/dsh-std/lib/policy.js']) {
    const r = run({ [rel]: '含 .std/ 的一行\n' }); assert.equal(r.rc, 1, rel + ' 不该在白名单内'); assert.match(r.out, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), rel)
  }
})

test('没有任何字样 → 退出 0；多个文件、多处命中都要报全（不是遇到第一个就停）', () => {
  assert.equal(run({ 'docs/a.md': '干净\n' }).rc, 0)
  const r = run({ 'docs/a.md': '.std/ 和 .std/\n', 'docs/b.md': 'CLAUDE.md\n', 'docs/c.md': '干净\n' })
  assert.equal(r.rc, 1); assert.match(r.out, /2 个文件/); assert.match(r.out, /docs\/a\.md（2 处）/); assert.match(r.out, /docs\/b\.md（1 处）/); assert.doesNotMatch(r.out, /docs\/c\.md/)
})

test('非文本扩展名不扫（图片、二进制的偶然字节不触发）；.gitignore 与无扩展名的 pre-commit 要扫', () => {
  assert.equal(run({ 'a.png': '.std/' }).rc, 0)
  assert.equal(run({ '.gitignore': '.std/\n' }).rc, 1)
  assert.equal(run({ '.githooks/pre-commit': '# .std/ 旧写法\n' }).rc, 1)
})

test('字样放在 .json 里也要扫（变异清单、配置里的旧写法）；中文路径不被 git 转义成八进制串而失配', () => {
  assert.equal(run({ 'config/x.json': '{"a": ".std/"}' }).rc, 1)
  const r = run({ '文档/说明.md': '旧写法 .std/ 一处\n' })
  assert.equal(r.rc, 1); assert.match(r.out, /文档\/说明\.md（1 处）/)
})

test('不在 git 工作区 → 退出 2 并说明（没跑成不当通过）', () => {
  const root = mkdtempSync(join(tmpdir(), 'resid-nogit-')); tmps.push(root)
  mkdirSync(join(root, 'scripts')); cpSync(SCRIPT, join(root, 'scripts', 'check-residue.mjs'))
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-residue.mjs')], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } })
  assert.equal(r.status, 2); assert.match(r.stderr, /不在 git 工作区/)
})

test('本仓真实跑一次：必须通过（白名单外 0 处）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout.slice(0, 800)); assert.match(r.stdout, /白名单外 0 处/)
})
