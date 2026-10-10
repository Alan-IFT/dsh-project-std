// `std-check migrate`：为一个还内嵌着 `.std/` 的采用项目生成**迁移方案**（设计 §12.33）。
//
// **本命令只读，不写任何文件**——"确定性层不碰写"是这个工具的边界。它输出一份机器可读的变更清单：每一步改什么文件、
// 怎么验证、怎么回退；由会话里的 agent 用平台已有的 edit/write/审批逐步执行，人审阅。需要判断的（自然语言文档里怎么改措辞、
// 钩子怎么改写）只给"命中行 + 建议改法"，不替人定。
//
// 为什么不做 `--apply`：写文件意味着写前备份、原子写、失败回滚、不碰 .git、拒绝脏工作区——一套本仓从没有过的、安全敏感的代码；
// 而三个项目的钩子各是一种形态（见 hookKind），要各写一个解析器。让会话模型逐步执行同样的步骤，既复用平台的审批，又不引入这套代码。
//
// 前置条件（命令会检查并写进方案）：新插件已装入 DSH profile。检测不到时方案里的钩子步骤标 `blocked`，说清缺什么——
// 失败关闭，不假装能调。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isFile, isDir, readText } from './core/fs.js'
import { trackedFiles } from './core/tracked.js'

/** 方案里每一步的类别：deterministic＝精确命令可直接执行；judgement＝需要判断，只给命中与建议。 */
export type StepKind = 'deterministic' | 'judgement'

export interface Step {
  id: string
  kind: StepKind
  title: string
  /** deterministic 步骤：要执行的 git 命令（一条一项，逐条可单独回退）。 */
  commands?: string[]
  /** judgement 步骤：命中的位置 [相对路径, 行号, 原文]。 */
  hits?: Array<[string, number, string]>
  /** 建议改法（人读）。 */
  advice?: string
  verify: string
  rollback: string
  /** 非空表示这一步当前做不了，值是缺什么。 */
  blocked?: string
}

export interface Plan {
  root: string
  /** 项目当前的形态摘要，供读方案的人核对"这确实是它"。 */
  facts: Record<string, string | boolean | number | null>
  steps: Step[]
  /** 方案不适用时的说明（例如根本没有 .std/）。 */
  notApplicable?: string
}

/** 钩子的三种已知形态（读自三个真实项目）。认不出的记 unknown，由人决定——不猜。 */
export type HookKind = 'githooks-script' | 'precommit-framework' | 'custom-hooks-dir' | 'unknown' | 'none'

const HOOK_FILES: Array<[HookKind, string]> = [
  ['githooks-script', '.githooks/pre-commit'],
  ['precommit-framework', '.pre-commit-config.yaml'],
  ['custom-hooks-dir', 'tools/hooks/pre-commit'],
]

/** 找出项目里调用旧检查器的钩子文件（只看文件内容里有没有 `.std/tools/std/check_all`）。 */
export function findHooks(root: string): Array<{ kind: HookKind; path: string }> {
  const out: Array<{ kind: HookKind; path: string }> = []
  const seen = new Set<string>()
  const callsOld = (rel: string): boolean => {
    try { return OLD_CALL.test(readText(join(root, rel), root)) } catch { return false }
  }
  // 固定候选也必须**真的调用旧检查器**才算：PMC 的 tools/hooks/pre-commit 就不调（闸门①已搬到 pre-push），把它列成"要改的钩子"是给人造假工作
  for (const [kind, rel] of HOOK_FILES) {
    if (isFile(join(root, rel)) && !seen.has(rel) && callsOld(rel)) { seen.add(rel); out.push({ kind, path: rel }) }
  }
  // 自写钩子目录里的其它钩子（pre-push 等）：同目录下任何**可执行钩子文本**含旧检查器调用的都算。
  // 文档（.md）不算钩子——PMC 的 tools/hooks/README.md 里写着旧命令，那是文档引用，归 docs-refs 步骤
  for (const dir of ['tools/hooks', '.githooks']) {
    const d = join(root, dir)
    if (!isDir(d)) continue
    for (const name of readdirSync(d)) {
      const rel = `${dir}/${name}`
      const p = join(root, rel)
      if (seen.has(rel) || /\.(md|markdown|txt)$/i.test(name) || !isFile(p) || !statSync(p).isFile()) continue
      if (callsOld(rel)) { seen.add(rel); out.push({ kind: dir === 'tools/hooks' ? 'custom-hooks-dir' : 'githooks-script', path: rel }) }
    }
  }
  return out
}

/** 旧检查器或旧选解释器片段的调用。 */
const OLD_CALL = /\.std\/tools\/std\/(check_all|pick-python)/

/** 在文本里找所有命中某模式的行：[行号, 原文]。 */
function grepLines(text: string, re: RegExp): Array<[number, string]> {
  const out: Array<[number, string]> = []
  text.split('\n').forEach((l, i) => { if (re.test(l)) out.push([i + 1, l.length > 160 ? l.slice(0, 159) + '…' : l]) })
  return out
}

const STD_REF = /\.std[\\/]/

/**
 * 生成方案。`installed`：新插件是否已装入 profile（由调用方探测并传入，便于测试注入；生产路径由 cli 探测）。
 * 不读被扫项目之外的任何东西；对项目只读。
 */
export function plan(root: string, installed: boolean | { ok: false; why: string } = false): Plan {
  const facts: Plan['facts'] = {}
  const stdDir = join(root, '.std')
  const hasStd = isDir(stdDir)
  facts.hasStdDir = hasStd
  const [tracked] = trackedFiles(root, ['.std'])
  const stdTracked = tracked === null ? null : tracked.length
  facts.stdTrackedFiles = stdTracked
  const sv = join(root, 'governance', 'STANDARD_VERSION')
  const hasSv = isFile(sv)
  facts.hasStandardVersion = hasSv
  const hooks = findHooks(root)
  facts.hooks = hooks.map((h) => `${h.kind}:${h.path}`).join('、') || '无'

  if (!hasStd && !hasSv && hooks.length === 0) {
    return { root, facts, steps: [], notApplicable: '没有 .std/、没有 governance/STANDARD_VERSION、也没有调用旧检查器的钩子——不是一个带内嵌标准的采用项目，无需迁移。' }
  }

  const steps: Step[] = []
  const ok = installed === true
  const why = installed === true ? undefined : typeof installed === 'object' ? installed.why : '没有检测到新插件（dsh-project-std）已装入 DSH profile。先在 Plugins 页用 git 地址安装并重启，再执行钩子步骤；在那之前钩子仍调旧的 .std/ 检查器，项目不会被锁死。'
  facts.pluginInstalled = ok

  // 1. 钩子改调 std-check（先于删 .std/：删了 .std/ 旧钩子就找不到检查器，提交会被拒）
  if (hooks.length) {
    for (const h of hooks) {
      const text = (() => { try { return readText(join(root, h.path), root) } catch { return '' } })()
      const hits = grepLines(text, /\.std[\\/]tools[\\/]std[\\/]|pick-python/)
      steps.push({
        id: `hook:${h.path}`, kind: 'judgement',
        title: `钩子 ${h.path}（形态：${h.kind}）改调 std-check，并去掉 pick-python 的 .std/ 依赖`,
        hits: hits.map(([n, l]) => [h.path, n, l]),
        advice: hookAdvice(h.kind),
        verify: '改后在一个干净的临时提交上跑一次钩子，必须退出 0；再故意制造一条 FAIL，钩子必须退出非 0（别只验"能过"）。',
        rollback: `git checkout -- ${h.path}`,
        blocked: ok ? undefined : why,
      })
    }
  }

  // 2. 删 .std/（确定性）
  if (hasStd) {
    steps.push({
      id: 'rm-std', kind: 'deterministic', title: '删除内嵌的 .std/（标准正文改由插件以技能分发）',
      commands: stdTracked && stdTracked > 0 ? ['git rm -r -q .std'] : ['（.std/ 存在但没有被 git 跟踪的文件：直接删除目录即可，不涉及 git）'],
      verify: '`git status --short` 只应出现 .std/ 下的删除；`std-check .` 的退出码不应因此变差（adoption 的内嵌类判据已随之消失，属预期）。',
      rollback: '`git revert <本次迁移提交>`（.std/ 在历史里）。',
    })
  }

  // 3. 删 STANDARD_VERSION（确定性）
  if (hasSv) {
    steps.push({
      id: 'rm-standard-version', kind: 'deterministic', title: '删除 governance/STANDARD_VERSION（版本改由 profile 锁文件钉住，报告自带身份摘要；设计 §12.33）',
      commands: ['git rm -q governance/STANDARD_VERSION'],
      verify: '`std-check .` 里 adoption 不再产出「记了版本值」「记了采用日期」两条 PASS（预期消失，见 test/cases/expected-changes.mjs 的 ADOPTION），其余 id 与状态与迁移前相同。',
      rollback: '`git revert <本次迁移提交>`；若要保留升级评估记录，先把 `last_evaluated_upgrade` 那行的内容转进项目自己的决策记录再删。',
    })
  }

  // 4. project.yaml 里 .std 的 frozen 声明（确定性：只删这一行）
  const py = join(root, 'governance', 'project.yaml')
  if (isFile(py)) {
    const t = readText(py, root)
    // 只认恰好是 .std 的一项（可带引号、尾斜杠、行尾注释）。不能用 \b：`-`、`.` 前后也是词边界，会把 .std-cache、.std.bak 当成 .std
    const frozen = grepLines(t, /^\s*-\s*["']?\.std\/?["']?\s*(#.*)?$/)
    if (frozen.length) {
      steps.push({
        id: 'frozen-std', kind: 'judgement', title: 'governance/project.yaml 的 layout.frozen 里去掉 .std 这一项（目录已不存在，留着是死声明）',
        hits: frozen.map(([n, l]) => ['governance/project.yaml', n, l]),
        advice: '只删命中的那一行（连同它行尾的注释）；不动 frozen 里的其它项。列表若因此变空，整个 frozen: 键也一并删。',
        verify: '`std-check .` 的 layout／links／single-authority 的 id 与状态与迁移前相同。',
        rollback: '`git checkout -- governance/project.yaml`',
      })
    }
  }

  // 5. 自然语言文档里的 .std/ 引用：只列命中，交模型逐项处理
  const [mdFiles] = trackedFiles(root, ['*.md'])
  const hits: Array<[string, number, string]> = []
  for (const rel of mdFiles ?? []) {
    if (rel.startsWith('.std/')) continue
    // 历史记录（计划、审计、复核、归档）里的 .std/ 引用是当时的事实，不改
    if (/^(docs\/plans\/|分析\/|docs\/state\/artifacts\/|docs\/审计记录\/|docs\/归档\/)/.test(rel)) continue
    let text: string
    try { text = readText(join(root, rel), root) } catch { continue }
    for (const [n, l] of grepLines(text, STD_REF)) hits.push([rel, n, l])
  }
  if (hits.length) {
    steps.push({
      id: 'docs-refs', kind: 'judgement', title: `入口与现行文档里对 .std/ 的引用（共 ${hits.length} 处；历史计划、审计、复核、归档类文档已排除，它们记的是当时的事实）`,
      hits: hits.slice(0, 200),
      advice: '标准正文的引用改为「用 skill 工具加载 std-01-project-management 等技能，按其节目录定位」；检查命令改为 `std-check .`；「.std/ 只读」之类的规则整条删（目录已不存在）。不要机械替换——每处按上下文判断。',
      verify: '`std-check .` 的 links 检查对改过的文件无新增断链；入口文件行数仍在预算内（entry-budget）。',
      rollback: '`git checkout -- <文件>`',
    })
  }

  // 6. 迁移前后对账（确定性）
  steps.push({
    id: 'compare', kind: 'deterministic', title: '迁移前后各跑一次 std-check --json，逐 id 对账',
    commands: ['（迁移前）std-check . --json > before.json', '（迁移后）std-check . --json > after.json'],
    verify: '只允许出现：adoption 的预期消失项（见 test/cases/expected-changes.mjs 的 ADOPTION）；其余每个 id 的状态必须相同。出现任何别的差异就回退，先查原因，不要带着差异提交。',
    rollback: '`git revert <本次迁移提交>`',
  })

  return { root, facts, steps }
}

function hookAdvice(kind: HookKind): string {
  switch (kind) {
    case 'githooks-script':
      return '去掉 `. .std/tools/std/pick-python.sh` 与 `exec "$PY" .std/tools/std/check_all.py …`；改为用 DSH 的 node 调插件的 cli：' +
        '先按 $DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node(.exe) 取 node，再 `"$NODE" "$DSH_PROFILE_DIR/node_modules/dsh-project-std/lib/cli.js" . --no-scope`；' +
        '在 DSH 之外（终端手敲、CI）没有 DSH_HOME，回退到 PATH 上的 node；两者都没有就**失败关闭**（退出 127，说清缺什么），不放行（设计 §4.1）。'
    case 'precommit-framework':
      return '`entry` 是 YAML 折叠块（`>-`），换行会被折成空格，命令之间要用 `;` 连。把 sh -c 字符串里的 `.std/tools/std/pick-python.sh` 与 `check_all.py` 两处替换成上面 githooks 同样的 node + cli.js 写法；改完用 `pre-commit run std-check-all --all-files` 验证。'
    case 'custom-hooks-dir':
      return '项目用自己的 hooks 目录与自己的选解释器逻辑（hook_pick_python）。只替换**调用检查器的那一行**为 node + cli.js；它自己的选 Python 逻辑服务于项目的其它门（回归、测试），不要动。注意 pre-push 对退出码的语义：它把 0 与 2 都放行、只阻断 1，std-check 的退出码语义与旧检查器相同，保持这个处理。'
    case 'none':
    case 'unknown':
      return '认不出这个钩子的形态；请人读文件后决定。'
  }
}

/** 文本渲染：给人读的方案（--json 另给机器可读版）。 */
export function renderPlan(p: Plan): string {
  const out: string[] = [`迁移方案 · ${p.root}`, '（只读：本命令不写任何文件；由 agent 逐步执行、人审阅）', '']
  if (p.notApplicable) { out.push(p.notApplicable); return out.join('\n') }
  out.push('项目现状：')
  for (const [k, v] of Object.entries(p.facts)) out.push(`  ${k}: ${String(v)}`)
  out.push('')
  p.steps.forEach((s, i) => {
    out.push(`${i + 1}. [${s.kind === 'deterministic' ? '确定' : '需判断'}] ${s.title}${s.blocked ? '  ⛔ 当前不可做' : ''}`)
    if (s.blocked) out.push(`   缺：${s.blocked}`)
    for (const c of s.commands ?? []) out.push(`   $ ${c}`)
    for (const [f, n, l] of s.hits ?? []) out.push(`   ${f}:${n}  ${l}`)
    if (s.advice) out.push(`   建议：${s.advice}`)
    out.push(`   验证：${s.verify}`, `   回退：${s.rollback}`, '')
  })
  return out.join('\n')
}

export const _internal = { grepLines, existsSync, readFileSync }
