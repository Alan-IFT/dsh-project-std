#!/usr/bin/env node
// 机械检查：废弃技术栈字样只许出现在白名单里（重构设计 §7 阶段 4 的退出判据，§12.38 七；Alan 2026-10-10 认可“改成可机械核对的白名单”）。
//
// 为什么是白名单而不是“零命中”：`std-check migrate` 要识别并指导删除采用项目里的旧物，必须点名 `.std/`、`STANDARD_VERSION`；
// 反例测试要断言“不再认 CLAUDE.md”；守卫的词法与路径测试借 `.std` 当一个普通的受保护路径名。零命中既不可达，也会逼人把这些必要的字面量改写成别的形状。
// 白名单的另一面是：**白名单之外一旦出现，就是新增的残留，钩子拦下**。
//
// 口径（与阶段 0 的残留基线同一把尺子，docs/归档/残留基线-阶段0.txt）：
//   Claude Code | claude-code | CLAUDE.md | .claude/ | claude plugin | .std/ | git subtree | STANDARD_VERSION
// 扫描面：git ls-files（已跟踪与已暂存）里的文本文件。
//
// 白名单的每一项必须写理由；加新项是一次需要解释的变更（评审时看这一个文件的 diff）。
// 用法：node scripts/check-residue.mjs         退出码 0 通过、1 有白名单之外的命中、2 脚本自己跑不了
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAT = /Claude Code|claude-code|CLAUDE\.md|\.claude\/|claude plugin|\.std\/|git subtree|STANDARD_VERSION/g

/** [路径正则, 理由]。第一个匹配的生效。 */
const ALLOW = [
  [/^docs\/(审计记录|归档|参考资料|参考资料-Claude)\//, '冻结区（governance/project.yaml 的 layout.frozen）：当时的记录，不改写历史'],
  [/^(DSH-FINDINGS\.md|review\/PLAN-REVIEW\.md)$/, '冻结研究／审查记录（2026-10-12，2026-10-17 收口时入库）：比较对象本身包含旧宿主路径，点名旧物是内容而不是现行行为；不进规范正文与交付面，文件头已声明效力为零'],
  [/^标准\/参考资料\//, '冻结区：研究证据'],
  [/^docs\/(决策日志|失败Case清单)\.md$/, '历史叙述：决策与失败案例按当时的事实记录，D-135 起的废弃是其中的内容'],
  [/^docs\/重构设计-TS插件化\.md$/, '本次重构的设计与进度账：讲怎么清除，天然点名旧物'],
  [/^docs\/附录-载体实例\/(DSH载体映射|会话交接|仓库工作须知)\.md$/, '载体映射与交接：叙述 D-135 的取舍、已删除的东西、仍待处理的项'],
  [/^docs\/附录-载体实例\/迁移提示词\.md$/, '(a) 给三个旧采用项目的迁移提示词：它们的 .std/、STANDARD_VERSION 正是要被迁走的旧物，不点名就没法下指令；迁完后随会话交接一并清理'],
  [/^(src\/migrate\.ts|test\/migrate\.test\.mjs|test\/mutations\/migrate\.json)$/, '(a) `std-check migrate` 的功能本身：识别并指导删除采用项目里的旧物，必须点名它们'],
  [/^(src\/checks\/(cross_repo|adoption|drift|freshness)\.ts|src\/core\/(tracked|shell|docs|config)\.ts|src\/(check_all|selftest|selftest_shared|selftest_git|skills)\.ts)$/, '(c) 源码注释：记录“为什么不再有这个判据／这个机制”（设计 §12.28、§12.30、§12.33、§12.38），不是行为'],
  [/^test\/(cases|mutations)\//, '(c) 期望数据与变异清单里的反例和历史字面量（例如“CLAUDE.md 不再是入口候选”）'],
  [/^test\/(check-cross-repo|check-adoption|adoption-compat|docs|tracked)\.test\.mjs$/, '(c) 反例测试：断言“不再认 .claude/ 与 CLAUDE.md”“不再读 STANDARD_VERSION”“不带 .std/ 自排除”'],
  [/^test\/(regress|policy)\.test\.mjs$/, '(b) 守卫的词法／路径测试把 `.std` 当作一个普通的受保护路径名（protect:[\'.std\']）；价值在解析能力，不在 .std 本身（设计 §12.38）'],
  [/^src\/guard\//, '守卫源码注释里对已删除的 .std/ 只读判定的说明'],
  [/^(lib|skills)\//, '生成物：随源码与 标准/ 走，源头在白名单里即可'],
  [/^tools\/std\/(README|CONTRACT)\.md$/, '迁移一节与“已删除”说明：必须点名旧物才能讲清楚怎么迁'],
  [/^(标准\/01-项目管理标准\.md|标准\/README\.md|标准\/覆盖与采用检查\.md|README\.md|PROJECT_STATUS\.md|CONTEXT_MANIFEST\.md|docs\/09-跨工具通用性\.md)$/, '规范正文与入口文档里对“宿主已不再支持／该机制已删除”的说明句（D-135）；逐处在 §12.38 复核过'],
  [/^scripts\/check-residue\.mjs$/, '本脚本自己：正则里必须写这些字样'],
  [/^test\/residue\.test\.mjs$/, '本脚本的验收测试：造用例必须写这些字样'],
]

const ls = spawnSync('git', ['-C', root, '-c', 'core.quotepath=false', 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
if (ls.status !== 0) { console.error('不在 git 工作区，无法取文件清单：' + (ls.stderr || '').trim()); process.exit(2) }
const files = ls.stdout.split('\0').filter(Boolean)

const outside = []     // 白名单之外的命中
const usedRule = new Map()
for (const f of files) {
  if (!/\.(md|ts|mjs|js|json|yaml|yml|sh|txt)$|(^|\/)pre-commit$|(^|\/)\.gitignore$/.test(f) || !existsSync(resolve(root, f))) continue
  let text; try { text = readFileSync(resolve(root, f), 'utf8') } catch { continue }
  const hits = text.match(PAT); if (!hits) continue
  const rule = ALLOW.find(([re]) => re.test(f))
  if (rule) { usedRule.set(rule[1], (usedRule.get(rule[1]) ?? 0) + 1); continue }
  const lines = text.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => PAT.test(l) || (PAT.lastIndex = 0, false)).slice(0, 3)
  outside.push([f, hits.length, lines])
  PAT.lastIndex = 0
}

if (outside.length === 0) {
  console.log(`残留检查：通过（白名单外 0 处；白名单 ${ALLOW.length} 项里有 ${usedRule.size} 项被用到）`)
  process.exit(0)
}
console.log(`残留检查：失败——白名单之外有 ${outside.length} 个文件出现废弃技术栈字样：`)
for (const [f, n, lines] of outside) { console.log(`  ${f}（${n} 处）`); for (const [i, l] of lines) console.log(`      ${i}: ${l.trim().slice(0, 140)}`) }
console.log('\n处置：这是新增残留就清掉它；确有必须点名旧物的理由，就在本脚本的 ALLOW 里加一项并写理由（该变更需要评审）。')
process.exit(1)
