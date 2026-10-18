// cross_repo 检查器的验收测试：selftest 全过且 (id,status) 集合与 Python 黄金样本相同；对 4 个真实仓逐条一致；变异验证靠这里与 cr-scenarios.test.mjs 的直接断言变红。
// 期望值取自 Python 版实测（探针已删，输出逐条抄在断言里）。
// 有意差异（设计 §12.30）：退役仓默认规则文件清单去掉 `.claude/` 与 `CLAUDE.md`——这里单独断言；整仓场景样本里的退役仓都显式写了 layout.rule_files，不走默认清单。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, run, scope, selftest } from '../lib/checks/cross_repo.js'
import { CROSS_REPO } from './cases/selftest-ids.mjs'

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..')
const probes = CROSS_REPO.map(([id, status]) => ({ id, status }))

test('NAME 与 Python 版一致', () => assert.equal(NAME, 'cross-repo'))

test('selftest：每条都 PASS，且 (id, status) 集合与黄金样本完全相同', () => {
  const got = selftest()
  const unreadable = got.filter(f => f.title === '读不了的 *.md 须记一条未定，不得静默跳过')
  const expectedUnreadable = typeof process.geteuid === 'function' && process.geteuid() !== 0 ? 1 : 0
  assert.equal(unreadable.length, expectedUnreadable, '非 root POSIX 必须验证 chmod 读不了的反例')
  assert.deepEqual(got.filter((f) => f.status !== 'PASS').map((f) => `${f.title}｜${f.evidence}`), [])
  assert.deepEqual(got.filter(f => !unreadable.includes(f)).map((f) => [f.id, f.status]).sort(), probes.map((p) => [p.id, p.status]).sort())
})

const tmps = []
const mk = () => { const t = mkdtempSync(join(tmpdir(), 'crchk-')); tmps.push(t); return t }
test.after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true, maxRetries: 3 }) })
const put = (t, files) => { for (const [rel, body] of files) { const p = join(t, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) } }
const base = [['sys/.git/HEAD', 'x'], ['old/.git/HEAD', 'x'], ['sys/AGENTS.md', '# s\n\nsys（system）、old（retired）\n'], ['old/AGENTS.md', '已退役\n']]
const repos = [{ name: 'sys', path: 'sys', role: 'system' }, { name: 'old', path: 'old', role: 'retired' }]
const cfgOf = (t, extra = {}) => ({ _root: t, layout: { entry: ['AGENTS.md'] }, repos, ...extra })
const retired = (r) => r.filter((f) => f.title.includes('退役仓'))

test('有意差异：退役仓不写 layout.rule_files 时走默认清单 [.harness/rules/, AGENTS.md]（Python 版是 4 项，多 .claude/ 与 CLAUDE.md，属已废弃宿主的落点）——CLAUDE.md 与 .claude/ 下未标失效的文件不再被报', () => {
  const t = mk(); put(t, [...base, ['old/CLAUDE.md', '规则\n'], ['old/.claude/x.md', '规则\n'], ['old/.harness/rules/a.md', '已退役\n']])
  const r = retired(run(cfgOf(t)))
  assert.deepEqual(r.map((f) => [f.status, f.title, f.where]), [['PASS', '退役仓 old 的 2 份规则文件都带失效标记', 'old']])
  assert.equal(r[0].evidence, "扫描清单：.harness/rules/、AGENTS.md；layout.rule_files 用的是缺省清单 ['.harness/rules/', 'AGENTS.md']（项目未在 project.yaml 里校准）")
  // 项目自己写了 rule_files 的照旧认（cms 就写了 .claude/ 与 CLAUDE.md）——退役仓若仍按旧宿主落地，在这里列出来
  const own = retired(run(cfgOf(t, { layout: { entry: ['AGENTS.md'], rule_files: ['.claude/', 'CLAUDE.md', 'AGENTS.md'] } })))
  assert.deepEqual(own.map((f) => [f.status, f.title, f.where]), [['FAIL', '退役仓 old（role=retired）仍有 2 份文件可被当作现行规则读入', 'old/.claude/x.md']])
  assert.match(own[0].evidence, /^前 20 行内没有 已退役\/失效\/不再生效\/已归档\/已停用\/retired\/archived\/deprecated 任一失效标记的文件（共 2 份，列前 2）：\.claude\/x\.md、CLAUDE\.md；layout\.rule_files 取自 project\.yaml$/)
  // rule_files 显式写 null 等于没写：同样走缺省清单（变异 M1：只认 undefined 时 null 会掉进「不是列表」未定）
  const nul = retired(run(cfgOf(t, { layout: { entry: ['AGENTS.md'], rule_files: null } })))
  assert.deepEqual(nul.map((f) => [f.status, f.title]), [['PASS', '退役仓 old 的 2 份规则文件都带失效标记']])
  assert.match(nul[0].evidence, /缺省清单/)
})

test('规则展开：条目里的反斜杠归一成 /（变异 E13；Windows 上 path.join 本身认反斜杠，归一与否结果相同，所以只在 POSIX 上有区分力）', { skip: process.platform === 'win32' ? 'Windows 的 path.join 认反斜杠，此条与原代码等价' : false }, () => {
  const t = mk(); put(t, [...base, ['old/sub/rule.md', '规则\n']])
  const r = retired(run(cfgOf(t, { layout: { entry: ['AGENTS.md'], rule_files: ['sub\\rule.md'] } })))
  assert.deepEqual(r.map((f) => [f.status, f.title, f.where]), [['FAIL', '退役仓 old（role=retired）仍有 1 份文件可被当作现行规则读入', 'old/sub/rule.md']], '反斜杠被当成目录分隔符才找得到 sub/rule.md；不归一时 POSIX 上把它当文件名里的字符，找不到，仓里就没有可读的规则文件')
})

test('判据七：UNC 路径（\\\\srv\\share）与 / 开头的链接按「宿主绝对路径」记未定，不当相对路径去解析、也不报断链（变异 N8；UNC 只有 Windows 的 isAbsolute 认，所以这条在 Windows 上才有区分力）', { skip: process.platform === 'win32' ? false : 'POSIX 上 \\\\srv\\share 是普通相对路径名，此条与原代码等价' }, () => {
  // 盘符形态（C:\x、C:/x）到不了这里：linkTargets 先按「带协议」过滤掉（SCHEME 匹配 `C:`），与 Python 版一致——所以只有 UNC 与 / 开头走 isAbsolute 分支
  const t = mk(); put(t, [...base, ['old/notes.md', '[c](\\\\srv\\share\\c.md) [d](/etc/d.md) [ok](../sys/AGENTS.md)\n']])
  const r = run(cfgOf(t)).filter((f) => f.title.includes('指向绝对路径'))
  assert.equal(r.length, 1); assert.equal(r[0].status, 'UNDETERMINED'); assert.equal(r[0].title, '仓 old 有 2 处引用指向绝对路径，本机不可判')
  assert.match(r[0].evidence, /^共 2 处，列前 2：notes\.md -> \\\\srv\\share\\c\.md；notes\.md -> \/etc\/d\.md$/)
  assert.ok(!run(cfgOf(t)).some((f) => f.status === 'FAIL'), 'UNC 路径不能被当成相对路径解析成断链')
})

test('scope：覆盖项与未覆盖项的条数随 former_names 有无而变（6/15 与 7/14）；默认规则文件清单写进文案；入口未配置写「（未配置）」', () => {
  const a = scope({}); assert.deepEqual([a.covered.length, a.not_covered.length], [6, 15])
  assert.equal(a.covered[0], 'repos 里声明的每个仓：路径是否存在、根下有没有 .git、有没有 layout.entry 里的入口文件（（未配置））')
  assert.equal(a.covered[4], 'role 为 retired/archived 的仓根下，layout.rule_files（.harness/rules/, AGENTS.md）展开出的文件前 20 行有没有失效标记', '默认清单随有意差异去掉两项（Python 版文案里是 4 项）')
  assert.equal(a.not_covered[0], 'repos[].former_names 未声明，仓的历史别名一字未查——不声明就不猜哪个名字是旧名（判据八）')
  const b = scope({ layout: { entry: ['AGENTS.md', 'README.md'], rule_files: ['a/', 'b'] }, repos: [{ name: 'x', former_names: ['y', 'z'] }, { name: 'w' }] })
  assert.deepEqual([b.covered.length, b.not_covered.length], [7, 14]); assert.equal(b.covered[0], 'repos 里声明的每个仓：路径是否存在、根下有没有 .git、有没有 layout.entry 里的入口文件（AGENTS.md, README.md）')
  assert.equal(b.covered[4], 'role 为 retired/archived 的仓根下，layout.rule_files（a/, b）展开出的文件前 20 行有没有失效标记')
  assert.match(b.covered[6], /^repos\[\]\.former_names 声明的历史别名（x 的旧名 y、x 的旧名 z）：是否仍以独立记号出现在\*\*别的仓\*\*的 git 跟踪文本里（判据八）。/)
  assert.match(b.not_covered[0], /^role: archived 的条目按 01 §3\.8 的定义/)
  const c = scope({ repos: [{ name: 'x', former_names: 'y' }] }); assert.deepEqual([c.covered.length, c.not_covered.length], [6, 15], 'former_names 不是列表时不算声明了别名')
})
