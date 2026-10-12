// `std-check migrate` 的测试：合成一个带 `.std/` 副本、三种钩子形态的采用项目，验证方案的内容；
// 并**按方案真正执行一遍**（在临时仓里），对比同版本 std-check 输出——只允许真实 links 聚合的扫描数量变化。
// 三个真实采用项目一字节不碰（硬约束 4）；夹具里的钩子文本取自它们的真实形态（读自实物，不是编的）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { plan, renderPlan, findHooks } from '../lib/migrate.js'
import { __testHooks } from '../lib/core/fs.js'
import { pluginInstalled, main, parseArgs } from '../lib/main.js'
import { finding, findingId } from '../lib/core/finding.js'

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, '..')
const tmps = []
const mk = () => { const t = mkdtempSync(join(tmpdir(), 'mig-')); tmps.push(t); return t }
test.after(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }) })
const w = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
const git = (root, ...args) => { const env = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]; return spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { env, encoding: 'utf8' }) }

// 三种钩子的真实文本（读自 Reservoir/CMS/PMC 的实物，缩到与迁移相关的行）
const HOOK_GITHOOKS = `#!/bin/sh
[ -f .std/tools/std/pick-python.sh ] || { echo "缺 pick-python" >&2; exit 127; }
. .std/tools/std/pick-python.sh || exit $?
exec "$PY" .std/tools/std/check_all.py . --no-scope
`
const HOOK_PRECOMMIT = `repos:
  - repo: local
    hooks:
      - id: std-check-all
        entry: >-
          sh -c '[ -f .std/tools/std/pick-python.sh ] || { echo "missing" >&2; exit 127; };
          . .std/tools/std/pick-python.sh || exit $?;
          exec "$PY" .std/tools/std/check_all.py . --no-scope'
        language: system
`
const HOOK_PMC_PUSH = `#!/usr/bin/env bash
hook_pick_python
"\${HOOK_GIT_ENV_STRIP[@]}" "$PY" .std/tools/std/check_all.py . >"$STD_OUT" 2>&1
`

/** 造一个带 .std/ 副本的采用项目。flavor 决定钩子形态。 */
function adopter(flavor) {
  const root = mk()
  git(root, 'init', '-q')
  w(root, 'AGENTS.md', '# 入口\n\n标准在 `.std/标准/`，检查：`python3 .std/tools/std/check_all.py .`\n')
  w(root, 'governance/project.yaml', 'tier: L0\ncompatibility:\n  policy: 未上线，可破坏性重构\nlayout:\n  entry:\n    - AGENTS.md\n  frozen:\n    - .std                # 标准的只读内嵌副本\n')
  w(root, 'governance/STANDARD_VERSION', '2026-10-05.1\nadopted_at: 2026-09-10\n')
  w(root, '.std/标准/README.md', '# 标准\n\n候选实现修订：`2026-10-05.1`。\n')
  w(root, '.std/tools/std/check_all.py', '# 旧检查器\n')
  w(root, 'docs/plans/2026-09-01-历史计划.md', '# 历史计划\n\n当时用 `.std/tools/std/check_all.py .` 跑过。\n') // 历史记录：不应进"现行引用"清单
  if (flavor === 'githooks') w(root, '.githooks/pre-commit', HOOK_GITHOOKS)
  if (flavor === 'precommit') w(root, '.pre-commit-config.yaml', HOOK_PRECOMMIT)
  if (flavor === 'custom') { w(root, 'tools/hooks/pre-commit', '#!/usr/bin/env bash\n# 闸门①已搬到 pre-push\nhook_pick_python\n'); w(root, 'tools/hooks/pre-push', HOOK_PMC_PUSH) }
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init')
  return root
}

test('findHooks：三种形态各自被认出；自写钩子目录里「含旧检查器调用」的其它钩子（pre-push）也被认出', () => {
  assert.deepEqual(findHooks(adopter('githooks')).map((h) => [h.kind, h.path]), [['githooks-script', '.githooks/pre-commit']])
  assert.deepEqual(findHooks(adopter('precommit')).map((h) => [h.kind, h.path]), [['precommit-framework', '.pre-commit-config.yaml']])
  const c = findHooks(adopter('custom')).map((h) => [h.kind, h.path])
  assert.deepEqual(c, [['custom-hooks-dir', 'tools/hooks/pre-push']], 'PMC 真实形态：只有 pre-push 调旧检查器；pre-commit 不调，不算')
  assert.deepEqual(findHooks(mk()), [], '没有钩子 → 空')
})

test('findHooks：固定候选文件也必须真的调用旧检查器才算；钩子目录里的 .md 文档不算钩子（读三个真实项目时发现的两处缺陷：PMC 的 pre-commit 不调检查器、其 README.md 只是写着旧命令）', () => {
  const root = adopter('custom')
  w(root, 'tools/hooks/pre-commit', '#!/usr/bin/env bash\n# 闸门①已搬到 pre-push\nhook_pick_python\n') // 不调旧检查器
  w(root, 'tools/hooks/README.md', '| ① | pre-push | `python .std/tools/std/check_all.py .` |\n') // 文档里写着旧命令
  git(root, 'add', '-A')
  assert.deepEqual(findHooks(root).map((h) => h.path), ['tools/hooks/pre-push'], '只剩真正调用旧检查器的可执行钩子')
  const docs = plan(root, true).steps.find((s) => s.id === 'docs-refs')
  assert.ok(docs.hits.some(([f]) => f === 'tools/hooks/README.md'), 'README.md 里的旧命令归文档引用步骤，不丢')
})

test('findHooks：只引用 pick-python 片段、不调 check_all 的钩子也算（它依赖 .std/，.std/ 删后会找不到片段而拒绝一切提交）', () => {
  const root = mk(); git(root, 'init', '-q')
  w(root, '.githooks/pre-commit', '#!/bin/sh\n. .std/tools/std/pick-python.sh || exit $?\necho "$PY"\n'); git(root, 'add', '-A')
  assert.deepEqual(findHooks(root).map((h) => h.path), ['.githooks/pre-commit'])
})

test('findHooks：自写钩子目录里只认「含旧检查器调用」的钩子——不含的（项目自己的其它门）不算，不给它们造步骤', () => {
  const root = adopter('custom')
  w(root, 'tools/hooks/pre-merge', '#!/bin/sh\necho 项目自己的别的门，不调检查器\n'); git(root, 'add', '-A')
  assert.deepEqual(findHooks(root).map((h) => h.path), ['tools/hooks/pre-push'], '没调旧检查器的 pre-merge 与 pre-commit 都不进来')
})

test('plan：只要有 .std/ 以外的迁移对象（版本声明或钩子）就不能判「无需迁移」——哪怕没有 .std/ 目录', () => {
  const a = mk(); git(a, 'init', '-q'); w(a, 'governance/STANDARD_VERSION', '1\n'); git(a, 'add', '-A')
  const pa = plan(a, true); assert.equal(pa.notApplicable, undefined); assert.deepEqual(pa.steps.map((s) => s.id), ['rm-standard-version', 'compare'])
  const b = mk(); git(b, 'init', '-q'); w(b, '.githooks/pre-commit', HOOK_GITHOOKS); git(b, 'add', '-A')
  const pb = plan(b, true); assert.equal(pb.notApplicable, undefined); assert.ok(pb.steps.some((s) => s.id.startsWith('hook:')))
})

test('plan：未跟踪 .std/ 不给失败的 git rm，要求清点备份和授权', () => {
  const root = mk(); git(root, 'init', '-q'); w(root, 'README.md', '# x\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'i')
  w(root, '.std/x.md', '# 未跟踪\n') // 未 git add
  const s = plan(root, true).steps.find((x) => x.id === 'rm-std')
  assert.equal(s.commands.length, 1); assert.ok(!s.commands[0].startsWith('git rm'), '没有跟踪文件时 git rm 会报 pathspec 无匹配而失败')
  assert.match(s.commands[0], /没有被 git 跟踪/)
})

test('plan：文档引用清单不含 .std/ 自己里的文件（标准副本里到处写着 .std/ 不算项目的引用）', () => {
  const root = adopter('githooks'); w(root, '.std/标准/说明.md', '# 副本\n\n见 `.std/标准/01.md`\n'); git(root, 'add', '-A')
  const docs = plan(root, true).steps.find((s) => s.id === 'docs-refs')
  assert.ok(docs.hits.every(([f]) => !f.startsWith('.std/')), `混进了 .std/ 内的文件：${docs.hits.map((h) => h[0]).join(',')}`)
})

test('plan：文档引用最多列 200 处（方案要给人和 agent 读，不能一次倒出几千行）；标题里写的是真实总数', () => {
  const root = adopter('githooks')
  w(root, 'docs/很多引用.md', Array.from({ length: 260 }, (_, i) => `第${i}处见 .std/标准/x.md`).join('\n') + '\n'); git(root, 'add', '-A')
  const docs = plan(root, true).steps.find((s) => s.id === 'docs-refs')
  assert.ok(docs.hits.length <= 200); assert.equal(pCoverageTotal(plan(root, true)), 200); assert.match(docs.title, /共 261 处/, '标题里是真实总数，不是截断后的数（含 AGENTS.md 的 1 处）')
})

test('plan：frozen 只认真正的 .std 项——.stdlib、.std-cache 这类同前缀的目录不能被当成要删的', () => {
  const root = adopter('githooks'); w(root, 'governance/project.yaml', 'tier: L0\ncompatibility:\n  policy: x\nlayout:\n  frozen:\n    - .stdlib\n    - .std-cache\n')
  assert.ok(!plan(root, true).steps.some((s) => s.id === 'frozen-std'))
})

test('renderPlan：无命中但缺配置仍输出现状、coverage 与不完整说明', () => {
  const root = mk(); git(root, 'init', '-q')
  const txt = renderPlan(plan(root, true))
  assert.match(txt, /coverage/); assert.match(txt, /配置不完整/); assert.ok(txt.includes('项目现状'))
})

test('命令行 migrate：根是文件、不存在、含 NUL 都不崩——报告不完整，不声称全仓无需迁移', () => {
  for (const r of ['package.json', 'D:/不存在的目录-xyz', 'a\0b']) {
    const out = [], err = []
    assert.equal(main(['migrate', r], undefined, { out: (t) => out.push(t), err: (t) => err.push(t) }), 0, `根 ${JSON.stringify(r)}`)
    assert.deepEqual(err, []); assert.match(out[0], /不能判断全仓无需迁移/); assert.match(out[0], /issue/)
  }
})

test('plan：不是带内嵌标准的采用项目 → 无需迁移，不给步骤', () => {
  const root = mk(); git(root, 'init', '-q'); w(root, 'README.md', '# x\n')
  const p = plan(root, true)
  assert.equal(p.steps.length, 0); assert.match(p.notApplicable, /不能判断全仓无需迁移/); assert.equal(p.coverage.config, 'unknown')
})

test('plan：步骤次序＝先钩子、再删 .std/、再删版本声明、再 frozen、再文档引用、最后对账（删 .std/ 之前钩子必须已改，否则旧钩子找不到检查器、提交被拒）', () => {
  const p = plan(adopter('githooks'), true)
  assert.deepEqual(p.steps.map((s) => s.id.split(':')[0]), ['hook', 'rm-std', 'rm-standard-version', 'frozen-std', 'docs-refs', 'compare'])
  assert.deepEqual(p.steps.filter((s) => s.kind === 'deterministic').map((s) => s.id), ['rm-std', 'rm-standard-version', 'compare'])
  assert.deepEqual(p.steps[1].commands, ['git rm -r -q .std']); assert.deepEqual(p.steps[2].commands, ['git rm -q governance/STANDARD_VERSION'])
  for (const s of p.steps) { assert.ok(s.verify.length > 10, `${s.id} 没写验证`); assert.ok(s.rollback.length > 5, `${s.id} 没写回退`) }
})

test('plan：新插件未装入 → 钩子步骤标 blocked 并说清缺什么；其余步骤不受影响（失败关闭，不假装能调）', () => {
  const p = plan(adopter('githooks'), { ok: false, why: '缺插件' })
  const hook = p.steps.find((s) => s.id.startsWith('hook:'))
  assert.equal(hook.blocked, '缺插件'); assert.equal(p.facts.pluginInstalled, false)
  assert.ok(p.steps.filter((s) => s.id.startsWith('rm-')).every((s) => s.prerequisites.length >= 3), '无 blocked 不等于删除立即可做')
  assert.match(renderPlan(p), /当前不可做/)
})

test('plan：现行文档的 .std/ 引用被列出（行号与原文），历史计划目录里的不列；.std/ 自己里的不列', () => {
  const docs = plan(adopter('githooks'), true).steps.find((s) => s.id === 'docs-refs')
  const files = [...new Set(docs.hits.map((h) => h[0]))]
  assert.deepEqual(files, ['AGENTS.md'], '历史计划 docs/plans/ 与 .std/ 下的不进清单')
  assert.deepEqual(docs.hits.map((h) => h[1]), [3, 3].slice(0, docs.hits.length)); assert.match(docs.hits[0][2], /\.std\//)
})

test('plan：frozen 里的 .std 一项被识别（连注释一起指给你看），project.yaml 没有时不产出这一步', () => {
  const p = plan(adopter('githooks'), true)
  const f = p.steps.find((s) => s.id === 'frozen-std'); assert.equal(f.hits.length, 1); assert.match(f.hits[0][2], /^\s*-\s*\.std/)
  const root = adopter('githooks'); w(root, 'governance/project.yaml', 'tier: L0\ncompatibility:\n  policy: x\n')
  assert.ok(!plan(root, true).steps.some((s) => s.id === 'frozen-std'))
})

test('plan：三种钩子形态给各自的建议（折叠块要用 ; 连；自写钩子不动它自己的选解释器逻辑、保持 0 与 2 放行的语义）', () => {
  const adv = (f) => plan(adopter(f), true).steps.find((s) => s.id.startsWith('hook:')).advice
  assert.match(adv('githooks'), /失败关闭/); assert.match(adv('githooks'), /DSH_PROFILE_DIR/)
  assert.match(adv('precommit'), /折叠块/); assert.match(adv('precommit'), /`;` 连/)
  assert.match(adv('custom'), /不要动/); assert.match(adv('custom'), /由采用方判断/); assert.match(adv('custom'), /不推广/)
  const hits = plan(adopter('custom'), true).steps.filter((s) => s.id.startsWith('hook:')).map((s) => s.id)
  assert.deepEqual(hits, ['hook:tools/hooks/pre-push'], '只给真正调旧检查器的 pre-push 步骤')
})

test('只读：对项目跑 plan／renderPlan 不改任何文件（工作区与 git 索引前后一致）', () => {
  const root = adopter('custom')
  const before = git(root, 'status', '--porcelain').stdout + git(root, 'ls-files', '-s').stdout
  plan(root, true); renderPlan(plan(root, false))
  assert.equal(git(root, 'status', '--porcelain').stdout + git(root, 'ls-files', '-s').stdout, before)
})

test('pluginInstalled：没有 DSH_PROFILE_DIR → 检测不到并说明；profile 里有 cli.js → true；没有 → 说清路径', () => {
  assert.match(pluginInstalled({}).why, /DSH_PROFILE_DIR/)
  const prof = mk()
  assert.match(pluginInstalled({ DSH_PROFILE_DIR: prof }).why, /还没装入/)
  w(prof, 'node_modules/dsh-project-std/lib/cli.js', '// x\n'); assert.equal(pluginInstalled({ DSH_PROFILE_DIR: prof }), true)
})

test('命令行：migrate 只认第一个位置；--json 输出可解析；无需迁移的退出 0；未知参数仍退出 2', () => {
  assert.equal(parseArgs(['migrate', 'p', '--json']).migrate, true)
  assert.equal(parseArgs(['p', 'migrate']), '多余的位置参数：migrate', 'migrate 不在第一位 → 当位置参数，多了就报错（不静默当子命令）')
  const out = [], err = []
  const io = { out: (t) => out.push(t), err: (t) => err.push(t) }
  const root = mk(); git(root, 'init', '-q')
  assert.equal(main(['migrate', root, '--json'], undefined, io), 0); assert.match(JSON.parse(out[0]).notApplicable, /无需迁移/)
  assert.equal(main(['migrate', root, '--nope'], undefined, io), 2)
})

// §12.45 A–G：独立合成夹具；不访问采用仓。
const fresh = () => { const r = mk(); git(r, 'init', '-q'); w(r, 'governance/project.yaml', 'tier: L0\ncompatibility:\n  policy: x\n'); return r }
const add = (r) => { const x = git(r, 'add', '-A'); assert.equal(x.status, 0, x.stderr) }
const byPath = (p, f) => p.candidates.find((c) => c.path === f)
const evidenceUnion = (p) => [...new Map([...p.candidates.flatMap((c) => c.evidence), ...p.steps.flatMap((s) => s.hits ?? [])].map((h) => [JSON.stringify(h), h])).values()]
const pCoverageTotal = (p) => evidenceUnion(p).length

test('A/B：gate、普通脚本、CI/tasks、变量 wrapper 和新 CLI 反例', () => {
  const root = fresh()
  const gate = 'step "5/7 标准检查" uv run python .std/tools/std/check_all.py .'
  w(root, '.std/old.py', 'python .std/tools/std/check_all.py .\n')
  w(root, 'scripts/gate.sh', '\n'.repeat(68) + gate + '\n')
  w(root, 'scripts/windows.ps1', '& python ".std\\tools\\std\\check_all.py" .\n')
  w(root, 'scripts/variable.sh', 'STD_TOOLS=.std/tools/std\nCHECKER="$STD_TOOLS/check_all.py"\n"$PY" "$CHECKER" .\n')
  w(root, '.github/workflows/check.yml', 'jobs:\n  check:\n    steps:\n      - run: uv run python .std/tools/std/check_all.py .\n')
  w(root, '.vscode/tasks.json', '{"command":"python .std/tools/std/check_all.py ."}\n')
  w(root, 'scripts/new.sh', 'node "$CLI" .\nstd-check .\n')
  add(root)
  const p = plan(root, true)
  assert.equal(p.coverage.excludedStd, 1)
  assert.equal(byPath(p, '.std/old.py'), undefined)
  for (const f of ['scripts/gate.sh', 'scripts/windows.ps1', '.github/workflows/check.yml', '.vscode/tasks.json']) assert.equal(byPath(p, f).category, 'execution', f)
  assert.equal(byPath(p, 'scripts/variable.sh').category, 'review')
  assert.equal(byPath(p, 'scripts/new.sh'), undefined)
  assert.deepEqual(byPath(p, 'scripts/gate.sh').evidence, [['scripts/gate.sh', 69, gate]])
  assert.equal(p.warning, '采用项目必须先处理这些调用，否则删除目录后现行检查入口将失效。')
  for (const id of ['execution', 'review']) {
    const before = p.steps.findIndex((s) => s.id === id), deletion = p.steps.findIndex((s) => s.id === 'rm-std')
    assert.ok(before >= 0 && deletion >= 0 && before < deletion, `${id} 必须早于 rm-std`)
  }
})

test('B：多行、仅 pick-python、包装路径、注释和未知名称均不求值', () => {
  const root = fresh()
  w(root, 'scripts/multi.sh', 'uv run python \\\n  .std/tools/std/check_all.py .\n')
  w(root, 'scripts/pick.sh', '. .std/tools/std/pick-python.sh\n')
  w(root, 'scripts/comment.sh', '# python .std/tools/std/check_all.py .\n')
  w(root, 'unknown.dat', 'check_all.py 与 pick-python.sh 名称只是线索\n')
  add(root)
  const p = plan(root, true)
  assert.deepEqual(byPath(p, 'scripts/multi.sh').evidence.map((h) => h[1]), [1, 2])
  assert.equal(byPath(p, 'scripts/pick.sh').category, 'execution')
  assert.equal(byPath(p, 'scripts/comment.sh').category, 'review')
  assert.equal(byPath(p, 'unknown.dat').category, 'review')
})

test('C：配置 frozen、自定义历史、示例区及兼容排除只报告保留；新文档仍有步骤', () => {
  const root = fresh()
  w(root, 'governance/project.yaml', 'layout:\n  frozen:\n    - snapshots\ncompatibility:\n  policy: x\n')
  for (const f of ['snapshots/old.sh', 'examples/run.sh', 'docs/plans/old.md', 'docs/审计记录/a.md', 'docs/归档/a.md', '分析/a.md', 'docs/state/artifacts/a.md', 'README.md']) w(root, f, 'python .std/tools/std/check_all.py .\n')
  add(root)
  const p = plan(root, true)
  assert.equal(byPath(p, 'README.md').category, 'documentation')
  for (const c of p.candidates.filter((c) => c.path !== 'README.md')) assert.equal(c.category, 'retained', c.path)
  assert.ok(p.steps.find((s) => s.id === 'docs-refs').hits.every(([f]) => f === 'README.md'))
  assert.match(renderPlan(p), /确认是否仍被现行执行引用/)
})

test('D/E：真实 frozen 节点、YML 与 CLI --config 转发，外部配置不制造默认编辑义务', () => {
  const root = fresh()
  rmSync(join(root, 'governance/project.yaml'))
  w(root, 'governance/project.yml', 'layout:\n  frozen:\n    - .std\nother:\n  list:\n    - .std\ncompatibility:\n  policy: x\n')
  add(root)
  const p = plan(root, true)
  assert.deepEqual(p.steps.find((s) => s.id === 'frozen-std').hits.map((h) => h[1]), [3])
  const extRoot = mk(), ext = join(extRoot, 'external.yml')
  w(extRoot, 'external.yml', 'layout:\n  frozen:\n    - .std\n    - scripts\ncompatibility:\n  policy: x\n')
  w(root, 'scripts/gate.sh', 'python .std/tools/std/check_all.py .\n'); add(root)
  for (const args of [['--config', ext], [`--config=${ext}`]]) {
    const out = []
    assert.equal(main(['migrate', root, '--json', ...args], undefined, { out: (x) => out.push(x), err: assert.fail }), 0)
    const q = JSON.parse(out[0])
    assert.equal(q.facts.configPath, ext)
    assert.equal(byPath(q, 'scripts/gate.sh').category, 'retained')
    assert.ok(!q.steps.some((s) => s.id === 'frozen-std'))
    assert.equal(q.facts.externalFrozenStd, true)
  }
  w(root, 'governance/project.yml', 'other:\n  list:\n    - .std\ncompatibility:\n  policy: x\n')
  assert.ok(!plan(root, true).steps.some((s) => s.id === 'frozen-std'))
})

test('D：证据不裁原行；200 cap 有 total、omitted 和补读位置', () => {
  const root = fresh(), raw = 'x'.repeat(400) + ' .std/tools/std/check_all.py'
  w(root, 'README.md', Array(230).fill(raw).join('\n')); add(root)
  const p = plan(root, true)
  assert.equal(p.coverage.total, 230); assert.equal(p.coverage.omitted, 30)
  assert.equal(byPath(p, 'README.md').evidence.length, 200)
  assert.equal(byPath(p, 'README.md').evidence[0][2], raw)
  assert.deepEqual(p.coverage.omittedLocations, [{ path: 'README.md', total: 230, omitted: 30 }])
})

test('E：拒读超限、二进制分类、未跟踪与 ignore 边界及安全钩子补充', () => {
  const root = fresh()
  w(root, 'large.sh', 'x'.repeat(2 * 1024 * 1024 + 1))
  w(root, 'binary.dat', Buffer.from([0, 255]))
  w(root, 'tracked-ignore.sh', 'python .std/tools/std/check_all.py .\n'); add(root)
  w(root, '.gitignore', 'ignored.sh\ntracked-ignore.sh\n.githooks/\n'); add(root)
  w(root, 'ignored.sh', 'python .std/tools/std/check_all.py .\n')
  w(root, 'untracked.sh', 'python .std/tools/std/check_all.py .\n')
  w(root, '.githooks/pre-commit', 'python .std/tools/std/check_all.py .\n')
  const p = plan(root, true)
  assert.ok(p.issues.some((i) => i.path === 'large.sh' && /TooLarge/.test(i.reason)))
  assert.deepEqual(p.coverage.binaryFiles, ['binary.dat'])
  assert.equal(byPath(p, 'ignored.sh'), undefined); assert.equal(byPath(p, 'untracked.sh'), undefined)
  assert.equal(byPath(p, 'tracked-ignore.sh').category, 'execution'); assert.equal(byPath(p, 'tracked-ignore.sh').tracked, true)
  assert.equal(byPath(p, '.githooks/pre-commit').tracked, false)
  assert.deepEqual(p.coverage.supplementaryHooks, ['.githooks/pre-commit'])
  const bad = plan(root, true, join(root, 'missing.yml'))
  assert.equal(bad.coverage.config, 'unknown'); assert.ok(bad.issues.some((i) => i.stage === 'config'))
})

test('E：出仓钩子目录先拒枚举，不回显仓外内容', () => {
  const root = fresh(), outside = mk()
  w(outside, 'pre-commit', 'python .std/tools/std/check_all.py SECRET_OUTSIDE\n')
  symlinkSync(outside, join(root, '.githooks'), 'junction')
  add(root)
  const p = plan(root, true)
  assert.ok(p.issues.some((i) => i.stage === 'hooks' && i.path === '.githooks'))
  assert.ok(!JSON.stringify(p).includes('SECRET_OUTSIDE'))
})

test('F：删除前置、caller 退出政策、安装在位与激活分离及窄回滚', () => {
  const p = plan(adopter('custom'), true), text = renderPlan(p)
  assert.ok(p.steps.filter((s) => s.id.startsWith('rm-')).every((s) => s.prerequisites.length >= 3))
  assert.equal(p.facts.cliPresenceOnly, true)
  for (const re of [/2=未登记未定、不是成功/, /不推广/, /cygpath/, /含空格/, /重启后确认技能/, /不要动/, /只回退本轮/, /不再预期内嵌 adoption 消失/]) assert.match(text, re)
  assert.ok(!text.includes('git checkout --'))
  assert.ok(!text.includes('0 与 2 都放行'))
})

function snapshot(root) {
  const files = []
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name), rel = prefix + name, st = lstatSync(p)
      if (st.isSymbolicLink()) files.push([rel, 'link', readlinkSync(p)])
      else if (st.isDirectory()) walk(p, rel + '/')
      else files.push([rel, readFileSync(p).toString('hex')])
    }
  }
  walk(root)
  return files
}
test('G：JSON/text/main 只读全字节快照（含 index、config、hooks），原脏改动和未跟踪也保留', () => {
  const root = adopter('custom')
  w(root, 'untracked.md', '不允许改变\n'); w(root, 'AGENTS.md', '# 原脏入口\n.std/tools/std/check_all.py\n')
  const before = snapshot(root)
  const p = plan(root, true); JSON.stringify(p); renderPlan(p)
  const out = []; main(['migrate', root, '--json'], undefined, { out: (x) => out.push(x), err: assert.fail })
  assert.equal(JSON.parse(out[0]).root, root)
  assert.deepEqual(snapshot(root), before)
})

test('R1/R2：YAML/YML/仓内显式配置只遮蔽真实 frozen 独立值，候选和步骤原行在文本及 CLI 去重', () => {
  for (const rel of ['governance/project.yaml', 'governance/project.yml', 'settings.yml']) {
    const root = fresh()
    rmSync(join(root, 'governance/project.yaml'))
    const raw = [
      '  gate_command: python .std/tools/std/check_all.py .',
      '  other:', '    frozen:', '      - .std',
      '  "layout": # .std/tools/std/check_all.py HEADER',
      '    nested:', '      frozen:', '        - .std',
      "    'frozen':", '      # python .std/tools/std/check_all.py COMMENT',
      '      - .std\\', '      - ".std/"', "      - '.std'", '      - .std-cache',
      '      - docs/archive', '    entry:', '      - .std/AGENTS.md',
      '  derived:', '    - artifact: out.md', '      source: in.md',
      '      regen: python .std/tools/std/check_all.py DERIVED', ''
    ].join('\n')
    w(root, rel, raw); add(root)
    const config = rel === 'settings.yml' ? join(root, rel) : undefined
    const p = plan(root, true, config), c = byPath(p, rel), frozen = p.steps.find((s) => s.id === 'frozen-std')
    assert.equal(p.coverage.config, 'loaded'); assert.deepEqual(p.issues, [])
    assert.deepEqual(frozen.hits.map((h) => h[1]), [11, 12, 13])
    assert.deepEqual(c.evidence.map((h) => h[1]), [1, 4, 5, 8, 10, 17, 21])
    assert.equal(c.executionShape, true)
    const text = renderPlan(p), out = []
    const args = ['migrate', root, ...(config ? ['--config', config] : [])]
    assert.equal(main(args, undefined, { out: (s) => out.push(s), err: assert.fail }), 0)
    for (const [f, n, line] of evidenceUnion(p)) {
      const fragment = `  ${f}:${n}  ${line}`
      assert.equal(text.split(fragment).length - 1, 1, fragment)
      assert.equal(out[0].split(fragment).length - 1, 1, fragment)
    }
    // 独立步骤间重复也不重展；JSON 引用允许重复。
    const duplicated = { ...p, steps: [...p.steps, { ...frozen, id: 'duplicate' }] }
    assert.equal(renderPlan(duplicated).split(`  ${rel}:11  ${raw.split('\n')[10]}`).length - 1, 1)
  }
})

test('R1：空列表尾注释、错误 inline/形状、未知配置均不伪造专属排除', () => {
  for (const value of ['[] # python .std/tools/std/check_all.py EMPTY', '[.std/]', '{item: .std/}', '.std']) {
    const root = fresh()
    w(root, 'governance/project.yaml', `layout:\n  frozen: ${value}\n`); add(root)
    const p = plan(root, true)
    assert.equal(p.coverage.config, value.startsWith('[]') ? 'loaded' : 'unknown')
    assert.ok(byPath(p, 'governance/project.yaml').evidence.length > 0)
    assert.ok(!p.steps.some((s) => s.id === 'frozen-std'))
    if (!value.startsWith('[]')) assert.ok(p.issues.some((i) => i.stage === 'config'))
  }
  const root = fresh()
  w(root, 'governance/project.yaml', 'layout:\n  frozen:\n    - .std\nunknown: [bad]\n'); add(root)
  const p = plan(root, true)
  assert.equal(p.coverage.config, 'unknown')
  assert.ok(byPath(p, 'governance/project.yaml').evidence.some((h) => h[2] === '    - .std'))
})

test('R1：续行召回恢复原文且再次排除 frozen 专属值行；其它路径续行不丢', () => {
  const root = fresh()
  w(root, 'governance/project.yaml', 'layout:\n  frozen:\n    - .std/tools/\\\n    - .std\\\n    - tools/std/check_all.py\n'); add(root)
  const p = plan(root, true), c = byPath(p, 'governance/project.yaml')
  assert.deepEqual(c.evidence, [['governance/project.yaml', 3, '    - .std/tools/\\'], ['governance/project.yaml', 5, '    - tools/std/check_all.py']])
  assert.deepEqual(p.steps.find((s) => s.id === 'frozen-std').hits, [['governance/project.yaml', 4, '    - .std\\']])
})

test('R1：成功加载后安全读取失读/定位失配均 issue 并保留已知 frozen 步骤', () => {
  const root = fresh()
  w(root, 'governance/project.yaml', 'layout:\n  frozen:\n    - .std\n'); add(root)
  let opens = 0
  __testHooks.beforeOpen = () => { if (++opens === 2) throw new Error('synthetic read loss') }
  let p
  try { p = plan(root, true) } finally { __testHooks.beforeOpen = undefined }
  assert.equal(p.coverage.config, 'loaded')
  assert.ok(p.issues.some((i) => i.stage === 'read'))
  assert.deepEqual(p.steps.find((s) => s.id === 'frozen-std').hits, [])
  assert.equal(p.notApplicable, undefined)
  assert.ok(byPath(p, 'governance/project.yaml').evidence.some((h) => h[1] === 3))
  // loader 接受的 Python 断行，召回无法可靠保持行号：不另造解析器。
  w(root, 'governance/project.yaml', 'layout:\u2028  frozen:\u2028    - .std\u2028')
  p = plan(root, true)
  assert.equal(p.coverage.config, 'loaded')
  assert.ok(p.issues.some((i) => i.stage === 'config' && /位置/.test(i.reason)))
  assert.deepEqual(p.steps.find((s) => s.id === 'frozen-std').hits, [])
  assert.ok(byPath(p, 'governance/project.yaml'))
})

test('R3：201+ 独立 frozen、同路径混合、候选占满统一 tuple union 预算；标题和步骤不受截断', () => {
  for (const mode of ['pure', 'mixed', 'full']) {
    const root = fresh(), rel = 'governance/project.yaml'
    const candidates = mode === 'mixed' ? Array.from({ length: 3 }, (_, i) => `gate${i}: python .std/tools/std/check_all.py .`) : []
    w(root, rel, [...candidates, 'layout:', '  frozen:', ...Array.from({ length: 205 }, () => '    - .std'), ''].join('\n'))
    if (mode === 'full') w(root, 'a.sh', Array.from({ length: 200 }, () => 'python .std/tools/std/check_all.py .').join('\n'))
    add(root)
    const p = plan(root, true), total = mode === 'pure' ? 205 : mode === 'mixed' ? 208 : 405
    const frozen = p.steps.find((s) => s.id === 'frozen-std')
    assert.equal(p.coverage.total, total); assert.equal(p.coverage.omitted, total - 200)
    assert.equal(pCoverageTotal(p), 200)
    assert.equal(frozen.hits.length, mode === 'pure' ? 200 : mode === 'mixed' ? 197 : 0)
    assert.deepEqual(p.coverage.omittedLocations, [{ path: rel, total: mode === 'mixed' ? 208 : 205, omitted: total - 200 }])
    assert.equal(p.notApplicable, undefined); assert.ok(p.steps.some((s) => s.id === 'compare'))
    if (mode !== 'pure') {
      assert.ok(p.warning)
      const step = p.steps.find((s) => s.id === (mode === 'mixed' ? 'review' : 'execution'))
      assert.equal(step.hits.length, mode === 'mixed' ? 3 : 200)
      assert.equal(step.title, mode === 'mixed' ? '旧依赖未证明：删除前逐项判断候选用途' : '现行执行入口候选：删除前迁移并核对 caller')
    } else assert.equal(byPath(p, rel), undefined)
  }
})

test('R3：同路径 union 遗漏不能反推候选标题，候选/步骤引用投影同一保留集合', () => {
  const root = fresh(), rel = 'settings.md'
  w(root, rel, [...Array.from({ length: 205 }, (_, i) => `gate${i}: python .std/tools/std/check_all.py .`), 'layout:', '  frozen:', ...Array.from({ length: 205 }, () => '    - .std'), ''].join('\n')); add(root)
  const p = plan(root, true, join(root, rel)), c = byPath(p, rel), docs = p.steps.find((s) => s.id === 'docs-refs')
  assert.match(docs.title, /共 205 处/)
  assert.deepEqual(docs.hits, c.evidence)
  assert.equal(p.coverage.total, 410); assert.equal(p.coverage.omitted, 210)
  assert.deepEqual(p.coverage.omittedLocations, [{ path: rel, total: 410, omitted: 210 }])
  assert.equal(p.steps.find((s) => s.id === 'frozen-std').hits.length, 0)
})

// 局部对账合同：身份旁证可变；判定及登记不变；仅真实 links 聚合数量可换 id。
function compareMigration(before, after) {
  const index = ({ f }) => {
    const out = new Map(f.map((x) => [x.id, x]))
    assert.equal(out.size, f.length, 'finding id 必须唯一')
    return out
  }
  const b = index(before), a = index(after)
  const identity = (out) => {
    const records = [...out.values()].filter((f) => f.check === 'tool-identity')
    assert.equal(records.length, 1, '必须恰有一条精确 tool-identity 元记录')
    const [f] = records
    assert.deepEqual([f.status, f.where, f.registered], ['SKIP', 'tools/std/', null], '身份缺失、扫描作废或身份形状错误')
    const shape = /^检查器身份 · sha256:[0-9a-f]{16}（\d+ 个文件，含 CONTRACT\.md）· git .+ · (?:工作区 dirty（哈希已含未提交改动）|工作区干净|工作区状态未知：.+)$/u.exec(f.title)
    assert.ok(shape && shape[0] === f.title, '身份标题必须是 identityLine 形态')
    const lines = f.evidence.split('\n').filter((s) => /^tool_identity_digest:/.test(s))
    assert.equal(lines.length, 1, '身份必须有唯一 digest 字段')
    const digest = /^tool_identity_digest: ([0-9a-f]{64})$/.exec(lines[0])
    assert.ok(digest && digest[0] === lines[0], '身份必须有完整 64hex digest')
    assert.ok(f.title.includes(`sha256:${digest[1].slice(0, 16)}（`), '身份标题摘要必须吻合')
    out.delete(f.id) // 只排除这条已核验元记录，不按 id 前缀排除。
    return digest[1]
  }
  assert.equal(identity(b), identity(a), '迁移前后必须使用同一检查器内容')
  assert.ok([0, 1, 2].includes(before.rc) && [0, 1, 2].includes(after.rc), '退出码必须为 0/1/2')
  assert.equal(before.rc, after.rc, '退出码不变')
  for (const [id, f] of b) if (a.has(id)) {
    const g = a.get(id)
    assert.deepEqual([g.check, g.status, g.where, g.registered], [f.check, f.status, f.where, f.registered], `共有 id 的判定及登记不变：${id}`)
  }
  const gone = [...b.values()].filter((f) => !a.has(f.id)), added = [...a.values()].filter((f) => !b.has(f.id))
  if (!gone.length && !added.length) return 0
  assert.deepEqual([gone.length, added.length], [1, 1], '只允许一对 links 聚合，无其它消失或新增')
  const aggregate = (f) => {
    assert.deepEqual([f.check, f.status, f.where, f.registered], ['links', 'PASS', null, null], '只允许未登记的 links 聚合 PASS')
    const m = /^扫了 (\d+) 份 markdown、(\d+) 条本地链接，(\d+) 条有问题$/.exec(f.title)
    assert.ok(m && m[0] === f.title, '必须是完整 links 聚合数量标题')
    assert.equal(f.id, findingId('links', f.title), 'links 聚合 id 必须为真实标题哈希')
    return m.slice(1).map((n) => BigInt(n))
  }
  const x = aggregate(gone[0]), y = aggregate(added[0])
  assert.equal(x[2], y[2], '问题出现数不得变化')
  assert.ok(x[0] !== y[0] || x[1] !== y[1], '扫描文件数或本地链接数必须变化')
  return 1
}

// 合成 probe 不替代真实 CLI：rc 固定 1，确保已有 FAIL/两种未定不能借总退出码掩盖。
const aggregateProbe = (files, links, bad = 3) => finding('links', 'PASS', `扫了 ${files} 份 markdown、${links} 条本地链接，${bad} 条有问题`)
const migrationProbe = () => {
  const digest = 'a'.repeat(64)
  const f = [
    finding('tool-identity', 'SKIP', `检查器身份 · sha256:${digest.slice(0, 16)}（5 个文件，含 CONTRACT.md）· git 123456789abc · 工作区干净`, { where: 'tools/std/', reason: '身份记录', evidence: `tool_identity_digest: ${digest}\ntool_identity_git_head: 123456789abc` }),
    finding('adoption', 'PASS', '兼容性政策', { kind: 'compatibility-policy' }),
    finding('probe', 'FAIL', '原 FAIL', { kind: 'fail', where: 'a.md' }),
    { ...finding('probe', 'UNDETERMINED', '已登记未定', { kind: 'registered', reason: '不可知' }), registered: { id: 'EX-001', expires: '2099-12-31' } },
    finding('probe', 'UNDETERMINED', '未登记未定', { kind: 'unregistered', reason: '不可知' }),
    aggregateProbe(10, 20),
  ]
  return [{ rc: 1, f }, { rc: 1, f: [...f.slice(0, -1), aggregateProbe(9, 19)] }].map((r) => structuredClone(r))
}

test('对账 probe P：原 FAIL/已登记与未登记未定保留；数量可增减；身份旁证可变', (t) => {
  const cases = [
    ['数量减少，nBad 非零', () => {}, 1],
    ['仅文件数增加', ([, a]) => { a.f[5] = aggregateProbe(11, 20) }, 1],
    ['仅链接数增加', ([, a]) => { a.f[5] = aggregateProbe(10, 21) }, 1],
    ['仅文件数减少', ([, a]) => { a.f[5] = aggregateProbe(9, 20) }, 1],
    ['仅链接数减少', ([, a]) => { a.f[5] = aggregateProbe(10, 19) }, 1],
    ['身份标题/git/dirty 旁证变化但 digest 相同', ([, a]) => {
      a.f[0].title = a.f[0].title.replace('123456789abc · 工作区干净', 'fedcba987654 · 工作区 dirty（哈希已含未提交改动）')
      a.f[0].id = findingId('tool-identity', a.f[0].title)
      a.f[0].evidence = a.f[0].evidence.replace('123456789abc', 'fedcba987654')
    }, 1],
    ['共有 id 的标题/证据/reason 不是全文 diff 合同', ([, a]) => { Object.assign(a.f[2], { title: '旁证更新', evidence: '新证据', reason: '新说明' }) }, 1],
    ['无差异返回零对', ([b, a]) => { a.f = structuredClone(b.f) }, 0],
  ]
  for (const [name, change, pairs] of cases) {
    const runs = migrationProbe(); change(runs)
    assert.equal(compareMigration(...runs), pairs, name)
  }
  t.diagnostic(`${cases.length} 个正向合成 case`)
})

test('对账 probe N：拒历史豁免、伪配对、判定/登记漂移、无效身份及重复 id', (t) => {
  const cases = []
  const reject = (name, change) => cases.push([name, change])
  for (const id of ['adoption/8baf1c92', 'adoption/8714bd62', 'adoption/settings-absent', 'adoption/60a5c980']) {
    reject(`历史 ${id} 消失`, ([b]) => { b.f.push({ ...finding('adoption', 'PASS', '旧项'), id }) })
  }
  reject('compatibility 消失', ([, a]) => { a.f.splice(1, 1) })
  for (const status of ['FAIL', 'SKIP']) reject(`compatibility 降为 ${status}`, ([, a]) => { a.f[1].status = status })
  for (const side of [0, 1, 'both']) reject(`非 links 同 check/where PASS 替换：${side}`, (runs) => {
    for (const i of side === 'both' ? [0, 1] : [side]) runs[i].f[5] = finding('other', 'PASS', `不同标题 ${i}`)
  })
  const invalidAggregates = [
    ['任意标题', { title: '任意 PASS' }],
    ['尾字', { title: '扫了 8 份 markdown、18 条本地链接，3 条有问题尾字' }],
    ['尾换行', { title: '扫了 8 份 markdown、18 条本地链接，3 条有问题\n' }],
    ['不是 PASS', { status: 'FAIL' }],
    ['SKIP', { status: 'SKIP' }],
    ['未定', { status: 'UNDETERMINED' }],
    ['where 非 null', { where: 'a.md' }],
    ['registered 非 null', { registered: { id: 'EX-002', expires: '2099-12-31' } }],
    ['伪 hash id', { id: 'links/not-title-hash' }],
  ]
  for (const side of [0, 1]) for (const [name, patch] of invalidAggregates) reject(`聚合 ${side}：${name}`, (runs) => {
    Object.assign(runs[side].f[5], patch)
    if (!Object.hasOwn(patch, 'id')) runs[side].f[5].id = findingId('links', runs[side].f[5].title)
  })
  reject('两端都不是聚合', ([b, a]) => { b.f[5] = finding('links', 'PASS', '旧任意标题'); a.f[5] = finding('links', 'PASS', '新任意标题') })
  for (const bad of [2, 4]) reject(`nBad 变为 ${bad}`, ([, a]) => { a.f[5] = aggregateProbe(9, 19, bad) })
  reject('前两数不变，仅数字拼写改 id', ([, a]) => { a.f[5] = finding('links', 'PASS', '扫了 010 份 markdown、020 条本地链接，3 条有问题') })
  for (const side of [0, 1]) {
    reject(`孤立 ${side ? 'gone' : 'added'}`, (runs) => { runs[side].f.pop() })
    reject(`${side ? '1:2' : '2:1'} 聚合`, (runs) => { runs[side].f.push(aggregateProbe(8, 18)) })
  }
  for (const i of [2, 3, 4]) {
    reject(`FAIL/未定 ${i} 消失而 rc1 不变`, ([, a]) => { a.f.splice(i, 1) })
    reject(`FAIL/未定 ${i} 改 id 而 rc1 不变`, ([, a]) => { a.f[i].id += '-changed' })
    for (const status of ['PASS', 'SKIP', i === 2 ? 'UNDETERMINED' : 'FAIL']) reject(`FAIL/未定 ${i} 改为 ${status} 而 rc1 不变`, ([, a]) => { a.f[i].status = status })
  }
  for (const [field, value] of [['check', 'other'], ['where', 'new.md']]) reject(`同 id ${field} 变化`, ([, a]) => { a.f[2][field] = value })
  reject('registered 对象→null', ([, a]) => { a.f[3].registered = null })
  reject('registered null→对象', ([, a]) => { a.f[4].registered = { id: 'EX-001', expires: '2099-12-31' } })
  for (const [field, value] of [['id', 'EX-002'], ['expires', '2099-12-30']]) reject(`registered.${field} 变化`, ([, a]) => { a.f[3].registered[field] = value })
  for (const rc of [0, 2]) reject(`rc 变化为 ${rc}`, ([, a]) => { a.rc = rc })
  for (const rc of [null, -1, 3, '1']) reject(`两端非法 rc ${rc}`, (runs) => { for (const r of runs) r.rc = rc })
  reject('digest 变化且标题摘要吻合', ([, a]) => {
    a.f[0].evidence = a.f[0].evidence.replace('a'.repeat(64), 'b'.repeat(64))
    a.f[0].title = a.f[0].title.replace('a'.repeat(16), 'b'.repeat(16))
    a.f[0].id = findingId('tool-identity', a.f[0].title)
  })
  reject('两端 identityVoid 同 rc2', (runs) => {
    for (const r of runs) { r.rc = 2; r.f = [finding('tool-identity', 'UNDETERMINED', '扫描期间检查器自身被改动，本次结论作废', { where: 'tools/std/', reason: '扫描作废' })] }
  })
  for (const side of [0, 1]) {
    reject(`身份 ${side} 缺失`, (runs) => { runs[side].f.shift() })
    reject(`身份 ${side} 额外记录`, (runs) => { runs[side].f.push({ ...runs[side].f[0], id: 'tool-identity/extra' }) })
    reject(`身份 ${side} 额外 UNDET`, (runs) => { runs[side].f.push(finding('tool-identity', 'UNDETERMINED', '扫描期间检查器自身被改动，本次结论作废', { reason: '作废' })) })
    for (const [field, value] of [['check', 'tool-identity-shadow'], ['status', 'UNDETERMINED'], ['where', null], ['registered', { id: 'EX-001', expires: '2099-12-31' }], ['title', '任意身份标题']]) {
      reject(`身份 ${side} ${field} 不合形状`, (runs) => { runs[side].f[0][field] = value })
    }
    for (const evidence of ['', `tool_identity_digest: ${'a'.repeat(63)}`, `tool_identity_digest: ${'a'.repeat(64)}尾字`, `tool_identity_digest: ${'a'.repeat(64)}\ntool_identity_digest: ${'a'.repeat(64)}`]) {
      reject(`身份 ${side} 非完整唯一 digest：${evidence.length}`, (runs) => { runs[side].f[0].evidence = evidence })
    }
    reject(`重复 id ${side}`, (runs) => { runs[side].f.push(structuredClone(runs[side].f[2])) })
  }
  reject('tool-identity-shadow 前缀 id 消失不得排除', ([b]) => { b.f.push({ ...finding('other', 'PASS', '普通判定'), id: 'tool-identity-shadow/12345678' }) })
  for (const [name, change] of cases) {
    const runs = migrationProbe(); change(runs)
    assert.throws(() => compareMigration(...runs), { name: 'AssertionError' }, name)
  }
  t.diagnostic(`${cases.length} 个负向合成 case`)
})

// ---- 按方案真正执行一遍，对比迁移前后（用本仓的 lib/cli.js 做检查器）----
const cli = join(repo, 'lib', 'cli.js')
const std = (root) => { const r = spawnSync(process.execPath, [cli, root, '--json', '--no-scope'], { encoding: 'utf8', maxBuffer: 1 << 28 }); return { rc: r.status, f: JSON.parse(r.stdout) } }

const scanDays = () => { const d = new Date(); return [[d.getFullYear(), d.getMonth(), d.getDate()], new Date(d.getTime() + 14 * 3600000).toISOString().slice(0, 10)] }

test('端到端：同身份同日期执行确定性迁移，仅真实 links 聚合扫描数量变化，其余判定与登记不变', () => {
  const root = adopter('githooks')
  const days = scanDays(), before = std(root)
  const p = plan(root, true)
  for (const s of p.steps.filter((x) => x.kind === 'deterministic' && x.commands && x.id !== 'compare')) {
    for (const c of s.commands) { const m = /^git (.+)$/.exec(c); assert.ok(m, `${s.id} 的命令不是 git：${c}`); const r = git(root, ...m[1].split(' ')); assert.equal(r.status, 0, `${c} 失败：${r.stderr}`) }
  }
  // frozen 里的 .std 一行：方案是「需判断」，这里按它的建议手工删（模拟 agent 执行）
  const y = readFileSync(join(root, 'governance', 'project.yaml'), 'utf8').split('\n').filter((l) => !/^\s*-\s*\.std\b/.test(l)).join('\n').replace(/\n  frozen:\n(?=\S|$)/, '\n')
  writeFileSync(join(root, 'governance', 'project.yaml'), y)
  const after = std(root)
  assert.deepEqual(scanDays(), days, '扫描跨越本地日或 UTC+14 基准日，必须重跑，不跳过')
  assert.ok(!existsSync(join(root, '.std')) && !existsSync(join(root, 'governance', 'STANDARD_VERSION')))
  assert.ok(compareMigration(before, after) >= 1, '实际应有至少一对 links 聚合扫描数量变化')
  // 同版迁移的 adoption 完全一致，且只剩 compatibility.policy 一条；没有历史消失白名单。
  const ad = (r) => r.f.filter((f) => f.check === 'adoption').map((f) => [f.id, f.status])
  assert.deepEqual(ad(after), ad(before)); assert.deepEqual(ad(after), [['adoption/compatibility-policy', 'PASS']])
  assert.equal(before.rc, after.rc, '退出码不变')
})
