// single_authority 检查器的验收测试：selftest 全过且 (id,status) 集合与 Python 黄金样本相同；对 4 个真实仓逐条一致；变异验证靠这里的直接断言变红。
// 期望值取自 Python 版实测（探针已删，输出逐条抄在断言里）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, run, scope, selftest } from '../lib/checks/single_authority.js'
import { SINGLE_AUTHORITY } from './cases/selftest-ids.mjs'

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..')
const probes = SINGLE_AUTHORITY.map(([id, status]) => ({ id, status }))

test('NAME 与 Python 版一致', () => assert.equal(NAME, 'single-authority'))

test('selftest：每条都 PASS，且 (id, status) 集合与黄金样本完全相同', () => {
  const got = selftest()
  const unreadable = got.filter(f => f.title === '反例一之二：读不了的被跟踪文件须记一条未定（single-authority/unreadable）')
  const expectedUnreadable = typeof process.geteuid === 'function' && process.geteuid() !== 0 ? 1 : 0
  assert.equal(unreadable.length, expectedUnreadable, '非 root POSIX 必须验证 chmod 读不了的反例')
  assert.deepEqual(got.filter((f) => f.status !== 'PASS').map((f) => `${f.title}｜${f.evidence}`), [])
  assert.deepEqual(got.filter(f => !unreadable.includes(f)).map((f) => [f.id, f.status]).sort(), probes.map((p) => [p.id, p.status]).sort())
})

// ---- 直接断言（所有平台都跑）----
const tmps = []
const mk = () => { const t = mkdtempSync(join(tmpdir(), 'sachk-')); tmps.push(t); return t }
test.after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }) })
const GID = ['-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']
const track = (t) => { spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', t]); spawnSync('git', ['-C', t, ...GID, 'add', '-A', '-f']); spawnSync('git', ['-C', t, ...GID, 'commit', '-q', '-m', 's']) }
const repo = (files, extra = {}) => { const t = mk(); for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(t, rel)), { recursive: true }); writeFileSync(join(t, rel), body) } track(t); return { t, cfg: { _root: t, layout: { frozen: [] }, ...extra } } }
const A = '# 甲文档\n\n库存模块负责把门店盘点结果写回中心账，写入口只有一个。\n它对外只暴露一个幂等接口，重复提交按同一次盘点合并。\n出错时不回滚整批，只标记失败行并交由人工复核。\n'
const B = '# 乙文档\n\n结算模块按天切账，切账窗口关闭后不再接受补录。\n补录走单独的调整单流程，调整单必须绑定原始凭证。\n调整单由财务负责人批准，批准记录随单存档。\n'
const C = '# 丙文档\n\n配送模块只读取已确认的订单，未确认订单不进入排线。\n排线结果发布后冻结，改动需新建一次排线并作废旧的。\n作废原因写在排线记录里，不改动已发布的那一份。\n'
const SH = '退款口径由结算模块单独维护，别处引用它的接口而不抄写规则。\n抄写会在下一次口径变化时留下一份不会更新的旧值。\n因此本节只给出指针，具体数值到结算模块文档去读。\n'
const row = (f) => [f.status, f.id, f.where ?? null]
const SCAN = (n, ex = 0, bin = 0, big = 0, un = 0) => `扫了 ${n} 个文本文件；排除归档与派生 ${ex} 个，跳过二进制 ${bin} 个、超大 ${big} 个、读不了 ${un} 个`
const DOCN = (n) => `其中算文档的 ${n} 个（后缀 .md .markdown .txt .rst .adoc .org）`
const DEF = '用的是默认值（duplicate_min_lines=3、duplicate_min_chars=60），项目未校准'

test('三份互不相同的文档 → 三条 PASS，id 与 evidence 的每个字都对（扫描摘要、默认阈值说明、文档数）', () => {
  const { cfg } = repo({ 'a.md': A, 'b.md': B, 'c.md': C }); const r = run(cfg)
  assert.deepEqual(r.map(row), [['PASS', 'single-authority/eca01990', null], ['PASS', 'single-authority/0eb1835e', null], ['PASS', 'single-authority/d391d8dd', null]])
  assert.deepEqual(r.map((f) => f.title), ['没有内容逐字节相同的两个文件', '没有跨文件重复的实质文本块（至少一处在文档里的）', '没有同一「数字+量词+名词」组合跨文件出现在文档里'])
  assert.equal(r[0].evidence, SCAN(3)); assert.equal(r[1].evidence, `${DEF}；${SCAN(3)}；${DOCN(3)}`); assert.equal(r[2].evidence, `${SCAN(3)}；${DOCN(3)}`)
})

test('逐字节相同 → FAIL（标题列出全部路径、where 是字典序第一个、evidence 写 sha256 前 16 位与扫描摘要）；三份同样；组按首个路径排序', () => {
  const r = run(repo({ 'a.md': A, 'copy/a.md': A, 'b.md': B }).cfg).filter((f) => f.status === 'FAIL')
  assert.deepEqual(r.map(row), [['FAIL', 'single-authority/80b751fe', 'a.md']]); assert.equal(r[0].title, '2 个文件内容逐字节相同：a.md、copy/a.md'); assert.equal(r[0].evidence, `sha256=95b40a313ef6c889；${SCAN(3)}`)
  const r3 = run(repo({ 'a.md': A, 'copy/a.md': A, 'third/a.md': A }).cfg).filter((f) => f.status === 'FAIL'); assert.equal(r3[0].title, '3 个文件内容逐字节相同：a.md、copy/a.md、third/a.md'); assert.equal(r3[0].id, 'single-authority/38c020e9')
})

test('跨文件重复的三行段落 → FAIL（where 是首处 文件:行号，标题写行数与全部位置，evidence 写首行前 80 个码点与阈值说明）；三份同样', () => {
  const r = run(repo({ 'x.md': A + '\n' + SH, 'y.md': B + '\n' + SH }).cfg).filter((f) => f.status === 'FAIL')
  assert.deepEqual(r.map(row), [['FAIL', 'single-authority/be82a7a1', 'x.md:7']]); assert.equal(r[0].title, '3 行实质文本重复出现在 2 处：x.md:7、y.md:7'); assert.equal(r[0].evidence, `首行：退款口径由结算模块单独维护，别处引用它的接口而不抄写规则。；${DEF}`)
  const r3 = run(repo({ 'x.md': A + '\n' + SH, 'y.md': B + '\n' + SH, 'z.md': C + '\n' + SH }).cfg).filter((f) => f.status === 'FAIL'); assert.equal(r3[0].title, '3 行实质文本重复出现在 3 处：x.md:7、y.md:7、z.md:7')
})

test('空仓 / 只有二进制 → 单条未定「没有可比对的文本文件」，evidence 写排除与二进制个数；非 git 仓 → 单条未定；裁剪 → 单条 SKIP', () => {
  const e = run(repo({}).cfg); assert.deepEqual(e.map(row), [['UNDETERMINED', 'single-authority/8e554579', null]]); assert.equal(e[0].evidence, '排除 0 个（归档/派生），二进制 0 个')
  const t = mk(); writeFileSync(join(t, 'bin.dat'), Buffer.from([0, 1, 2])); track(t); const b = run({ _root: t, layout: { frozen: [] } }); assert.equal(b[0].evidence, '排除 0 个（归档/派生），二进制 1 个')
  const n = mk(); writeFileSync(join(n, 'a.md'), A); const rn = run({ _root: n, layout: { frozen: [] } }); assert.deepEqual(rn.map(row), [['UNDETERMINED', 'single-authority/c5175d64', null]]); assert.match(rn[0].reason, /^git ls-files 退出码 128：/)
  const c = run(repo({ 'a.md': A }, { tailoring: [{ check: 'single-authority', applicable: false, reason: 'r' }] }).cfg); assert.deepEqual(c.map((f) => [f.status, f.id, f.reason]), [['SKIP', 'single-authority/48466a1d', 'r']])
})

test('非法 UTF-8 的文件当二进制跳过（计入「跳过二进制」）；超大文件 → 汇总未定 too-big（路径列表，超过 10 个注明「另有 N 个未列出」），其余照判', () => {
  const t = mk(); writeFileSync(join(t, 'a.md'), A); writeFileSync(join(t, 'bad.md'), Buffer.from([0x61, 0x62, 0x63, 0xff, 0xfe])); track(t)
  assert.equal(run({ _root: t, layout: { frozen: [] } })[0].evidence, SCAN(1, 0, 1))
  const u = mk(); writeFileSync(join(u, 'a.md'), A); for (let i = 0; i < 12; i++) writeFileSync(join(u, `big${String(i).padStart(2, '0')}.md`), Buffer.alloc(3 * 1024 * 1024, 0x78)); track(u)
  const r = run({ _root: u, layout: { frozen: [] } })
  assert.deepEqual(r.map(row), [['UNDETERMINED', 'single-authority/too-big', null], ['PASS', 'single-authority/eca01990', null], ['PASS', 'single-authority/0eb1835e', null], ['PASS', 'single-authority/d391d8dd', null]])
  assert.equal(r[0].title, '12 个被跟踪文件超过 2097152 字节未读，其中的重复判不了'); assert.equal(r[0].evidence, 'big00.md；big01.md；big02.md；big03.md；big04.md；big05.md；big06.md；big07.md；big08.md；big09.md；另有 2 个未列出'); assert.equal(r[1].evidence, SCAN(1, 0, 0, 12))
})

test('被跟踪的路径在工作区里是目录（子模块的形态）→ 当「不在」，不记读不了、不计入摘要——两个平台行为一致（D21：Python 版在 Windows 上因 os.open 抛 PermissionError 而记读不了，那是平台副作用，不是它的本意；POSIX 上它与 TS 相同）（变异 H5/H6/H7/H8）', () => {
  const t = mk(); writeFileSync(join(t, 'a.md'), A); writeFileSync(join(t, 'rep.md'), B); track(t); rmSync(join(t, 'rep.md')); mkdirSync(join(t, 'rep.md'))
  const r = run({ _root: t, layout: { frozen: [] } })
  assert.deepEqual(r.map(row), [['PASS', 'single-authority/eca01990', null], ['PASS', 'single-authority/0eb1835e', null], ['PASS', 'single-authority/d391d8dd', null]]); assert.equal(r[0].evidence, SCAN(1))
  // 已删未提交：任何平台都按「不在」处理，不记读不了
  const d = mk(); writeFileSync(join(d, 'a.md'), A); writeFileSync(join(d, 'gone.md'), B); track(d); rmSync(join(d, 'gone.md'))
  const rd = run({ _root: d, layout: { frozen: [] } }); assert.deepEqual(rd.map((f) => f.status), ['PASS', 'PASS', 'PASS']); assert.equal(rd[0].evidence, SCAN(1))
})

test('读不了的被跟踪文件：evidence 里按 Python 的异常类名写——权限错误写 PermissionError（不依赖 chmod/root，用 fs.ts 的 beforeOpen 钩子注入 EACCES，两个平台同样可验）（变异 H9、H10、H11、H18）', async () => {
  const { __testHooks } = await import('../lib/core/fs.js')
  const t = mk(); writeFileSync(join(t, 'a.md'), A); writeFileSync(join(t, 'b.md'), B); writeFileSync(join(t, 'locked.md'), C); track(t)
  let n = 0; __testHooks.beforeOpen = () => { if (++n === 2) { const e = new Error('denied'); e.code = 'EACCES'; throw e } } // 按 git 的次序：a、b、locked——第 2 次打开失败的是 b.md
  let r; try { r = run({ _root: t, layout: { frozen: [] } }) } finally { __testHooks.beforeOpen = undefined }
  assert.deepEqual(r.map(row), [['UNDETERMINED', 'single-authority/unreadable', null], ['PASS', 'single-authority/eca01990', null], ['PASS', 'single-authority/0eb1835e', null], ['PASS', 'single-authority/d391d8dd', null]])
  assert.equal(r[0].title, '1 个被跟踪文件读不了，其中的重复判不了'); assert.equal(r[0].evidence, 'b.md（PermissionError）'); assert.equal(r[1].evidence, SCAN(2, 0, 0, 0, 1))
  const m = (code) => { const t2 = mk(); writeFileSync(join(t2, 'a.md'), A); writeFileSync(join(t2, 'b.md'), B); track(t2); let k = 0; __testHooks.beforeOpen = () => { if (++k === 1) { const e = new Error('x'); e.code = code; throw e } }; try { return run({ _root: t2, layout: { frozen: [] } }) } finally { __testHooks.beforeOpen = undefined } }
  assert.equal(m('EPERM')[0].evidence, 'a.md（PermissionError）', 'EPERM 也是 PermissionError'); assert.equal(m('EIO')[0].evidence, 'a.md（OSError）', '其它错误码是 OSError'); assert.equal(m('EISDIR')[0].evidence, 'a.md（IsADirectoryError）')
  assert.deepEqual(m('ENOENT').map((f) => f.status), ['PASS', 'PASS', 'PASS'], '打开时才发现不在（读的过程中被删）→ 当不在，不记读不了')
})

test('POSIX 上文件名可以含反斜杠：派生声明里写 `docs\\gen.md`（反斜杠）时，实际跟踪的路径 `docs/gen.md` 也被排除；而一个**文件名本身**含反斜杠的文件（`docs\\gen.md` 这一个名字）按归一后的路径比对（变异 G9，仅 POSIX 可构造）', { skip: process.platform === 'win32' ? 'Windows 的文件名不允许反斜杠' : false }, () => {
  const t = mk(); mkdirSync(join(t, 'docs')); writeFileSync(join(t, 'docs', 'gen.md'), A); writeFileSync(join(t, 'docs\\gen2.md'), A); writeFileSync(join(t, 'b.md'), B); track(t)
  const r = run({ _root: t, layout: { frozen: [] }, derived: [{ artifact: 'docs/gen2.md', source: 'b.md', regen: 'make' }] })
  assert.equal(r[0].evidence, SCAN(2, 1), '跟踪的文件名是 `docs\\gen2.md`（一个名字），归一成 docs/gen2.md 后命中声明 → 排除 1 个；若不归一就比不上，排除 0 个、且与 docs/gen.md 逐字节相同会被报 FAIL')
  assert.equal(r.some((f) => f.status === 'FAIL'), false)
})

test('阈值取自配置 → evidence 写「阈值取自 project.yaml：连续 N 行 / 有效字符 M」；layout.frozen 里的副本排除（计入「排除归档与派生」）；声明为派生的工件排除', () => {
  const a = run(repo({ 'a.md': A, 'b.md': B }, { budgets: { duplicate_min_lines: 2, duplicate_min_chars: 20 } }).cfg); assert.equal(a[1].evidence, `阈值取自 project.yaml：连续 2 行 / 有效字符 20；${SCAN(2)}；${DOCN(2)}`)
  const f = run({ ...repo({ 'a.md': A, 'arch/z.md': A, 'b.md': B }).cfg, layout: { frozen: ['arch'] } }); assert.deepEqual(f.map((x) => x.status), ['PASS', 'PASS', 'PASS'], '副本在 frozen 里：不报逐字节相同'); assert.equal(f[0].evidence, SCAN(2, 1))
  const d = run(repo({ 'a.md': A, 'docs/gen.html': A, 'b.md': B }, { derived: [{ artifact: 'docs/gen.html', source: 'a.md', regen: 'make' }] }).cfg); assert.deepEqual(d.map((x) => x.status), ['PASS', 'PASS', 'PASS']); assert.equal(d[0].evidence, SCAN(2, 1))
  const dd = run(repo({ 'a.md': A, './x.md': B, 'docs/gen.html': A }, { derived: [{ artifact: './docs/gen.html', source: 'a.md', regen: 'make' }] }).cfg); assert.equal(dd[0].evidence, SCAN(2, 1), '声明路径开头的 ./ 去掉后再比')
})

test('逐字节相同的组超过 30 个 → 只列 30 条 FAIL，另记一条未定 overflow-identical（不静默丢弃），且它排在 PASS 之前', () => {
  const files = {}
  for (let i = 0; i < 32; i++) { const body = `# 文档${i}\n\n这是第${i}组逐字节相同的文档，内容足够长以便超过有效字符下限二十个字。\n`; files[`g${String(i).padStart(2, '0')}/a.md`] = body; files[`g${String(i).padStart(2, '0')}/b.md`] = body }
  const r = run(repo(files).cfg)
  assert.equal(r.filter((f) => f.status === 'FAIL').length, 30); const o = r.find((f) => f.id === 'single-authority/overflow-identical'); assert.equal(o.title, '还有 2 组逐字节相同的文件未逐条列出'); assert.equal(o.reason, '单类结果上限 30 条；未列出的不等于没问题（契约 §2）')
  assert.deepEqual(r.slice(30, 31).map((f) => f.id), ['single-authority/overflow-identical'], '溢出条目紧跟在 30 条 FAIL 之后')
})

test('scope：覆盖 4 条、未覆盖 15 条；frozen 为空写「（未配置）」，有值用「、」连；阈值与后缀进文案', () => {
  const s = scope({ layout: { frozen: [] } }); assert.deepEqual([s.covered.length, s.not_covered.length], [4, 15])
  assert.match(s.covered[1], /^跨文件重复的实质文本段落（默认连续 3 行、有效字符 ≥60）/); assert.match(s.covered[2], /^同一「数字\+量词\+名词」组合出现在 2 个以上文件/); assert.equal(s.covered[3], '算文档的后缀：.md .markdown .txt .rst .adoc .org')
  assert.equal(s.not_covered[12], '不看只读归档区 layout.frozen：（未配置）（01 §3.1）'); assert.equal(scope({ layout: { frozen: ['a', 'b'] } }).not_covered[12], '不看只读归档区 layout.frozen：a、b（01 §3.1）')
  assert.equal(scope({}).not_covered[12], '不看只读归档区 layout.frozen：（未配置）（01 §3.1）', '没有 layout 也不抛'); assert.equal(scope({ layout: { frozen: [1, 2] } }).not_covered[12], '不看只读归档区 layout.frozen：1、2（01 §3.1）', '元素按 str() 写')
})
