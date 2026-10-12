// `std-check migrate`：只读召回与迁移方案。发现不是执行证明，不求值变量、不执行被扫文件（设计 §12.45）。
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { decodeUtf8Sig, inside, isDir, isFile, lexists, readBytes, readText } from './core/fs.js'
import { trackedFiles } from './core/tracked.js'
import { loadConfig } from './core/config.js'
import { cfgGet, type Config } from './core/cfg.js'
import { inFrozen } from './core/docs.js'
import { firstInvalidUtf8 } from './core/utf8.js'
import { stripComment } from './core/yaml.js'
import { pyStrip } from './core/finding.js'

export type StepKind = 'deterministic' | 'judgement'
export type Hit = [string, number, string]
export interface Step {
  id: string
  kind: StepKind
  title: string
  commands?: string[]
  hits?: Hit[]
  advice?: string
  verify: string
  rollback: string
  blocked?: string
  /** 无 blocked 不代表可立即执行，尤其删除必须满足这些条件。 */
  prerequisites?: string[]
}
export type Category = 'execution' | 'documentation' | 'retained' | 'review'
export interface Candidate {
  path: string
  category: Category
  reason: string
  evidence: Hit[]
  tracked: boolean
  executionShape: boolean
}
export interface Issue { stage: 'inventory' | 'config' | 'read' | 'hooks'; path: string; reason: string }
export interface Plan {
  root: string
  facts: Record<string, string | boolean | number | null>
  steps: Step[]
  coverage: {
    inventory: 'complete' | 'failed'
    config: 'loaded' | 'unknown'
    trackedFiles: number | null
    readFiles: number
    excludedStd: number
    binaryFiles: string[]
    supplementaryHooks: string[]
    scope: string
    total: number
    omitted: number
    omittedLocations: Array<{ path: string; total: number; omitted: number }>
  }
  issues: Issue[]
  candidates: Candidate[]
  warning?: string
  notApplicable?: string
}
export type HookKind = 'githooks-script' | 'precommit-framework' | 'custom-hooks-dir' | 'unknown' | 'none'
const HOOK_FILES: Array<[HookKind, string]> = [
  ['githooks-script', '.githooks/pre-commit'],
  ['precommit-framework', '.pre-commit-config.yaml'],
  ['custom-hooks-dir', 'tools/hooks/pre-commit'],
]
const OLD_CALL = /\.std[\\/]tools[\\/]std[\\/](check_all|pick-python)/
const CLUE = /\.std(?:[\\/]|["'`\s]|$)|check_all(?:\.py)?|pick-python(?:\.sh)?|\$(?:\{)?(?:CHECKER|STD_CHECK|STD_TOOLS)\b/i
const HISTORY = /^(docs\/plans\/|分析\/|docs\/state\/artifacts\/|docs\/审计记录\/|docs\/归档\/)/
const RETAIN_PATH = /(?:^|\/)(?:archive|archives|history|historical|examples?|fixtures?|tests?|__tests__)(?:\/|$)|示例|历史|归档/i
const DOC = /\.(?:md|markdown|rst|txt)$/i
const EXEC_PATH = /\.(?:sh|bash|ps1|cmd|bat|py|js|mjs|cjs|ts)$/i
const CAP = 200
const ROLLBACK = '先保存自己的差异和原有脏改动；只回退本轮变更，不用 checkout 覆盖既有工作。已提交时仅反转本轮迁移提交，核对冲突。'
const VERIFY_CALLER = '在实际 wrapper、工作目录和含空格路径下分别注入退出码 0/1/2、Node 与 CLI 缺失；按 caller 原合同观察，不强加成功策略。'
const DELETE_PRE = ['先解除全部现行旧依赖并验证 caller，复核所有待判断候选（含保留区是否仍被执行引用）。', '补齐 coverage/issues 中未完成的扫描与配置核对；确认安装身份、技能、Node/CLI 前提，不把在位探测当已激活。', '保存已有差异及未跟踪文件，确认授权与恢复方式后才删除；命令不代表现在可执行。']
const CONNECT = 'CLI 由包 bin 分发，正文由五个 std-* 技能分发。先核安装身份（报告 tool-identity、锁定提交及必要的 lib 哈希），重启后确认技能服务可用、运行 Node 版本符合包 engines、项目 root 正确。DSH 会话可用 DSH_PROFILE_DIR 下的插件 CLI；普通终端／CI 必须显式提供可运行 Node 和已钉版本的插件 CLI，或 PATH 上的 std-check，不能硬编码本机 profile。缺 Node/CLI 就**失败关闭**，不得静默跳过。Windows Git Bash 的盘符／反斜杠环境值需采用方确认转换（有 cygpath 可用它），含空格路径整体引用；这里不生成未经验证的跨平台 shell 脚本。0=通过，1=FAIL，2=未登记未定、不是成功；保留 caller 既有退出处理，历史 pre-push 的 0/2 例外是否保留由采用方判断，不推广到任意 custom hook 或脚本／CI。只移除旧检查器专属 Python 依赖，项目其它测试的选 Python 逻辑不要动。'

function grepLines(text: string, re: RegExp): Array<[number, string]> {
  const out: Array<[number, string]> = []
  text.split('\n').forEach((l, i) => { re.lastIndex = 0; if (re.test(l)) out.push([i + 1, l]) })
  return out
}
function hookKind(rel: string): HookKind | null {
  return HOOK_FILES.find(([, p]) => p === rel)?.[0] ??
    (!DOC.test(rel) && /^(tools\/hooks|\.githooks)\/[^/]+$/.test(rel) ? (rel.startsWith('tools/') ? 'custom-hooks-dir' : 'githooks-script') : null)
}
/** 补充固定候选和直接层未跟踪钩子；枚举前必须验证真实位置。 */
function hookPaths(root: string, issues: Issue[]): string[] {
  const paths = new Set<string>()
  for (const [, rel] of HOOK_FILES) {
    const p = join(root, rel)
    if (!inside(root, p)) { issues.push({ stage: 'hooks', path: rel, reason: '真实位置出仓，未探测' }); continue }
    if (lexists(p)) paths.add(rel)
  }
  for (const dir of ['tools/hooks', '.githooks']) {
    const d = join(root, dir)
    if (!inside(root, d)) { issues.push({ stage: 'hooks', path: dir, reason: '目录真实位置出仓，未枚举' }); continue }
    if (!lexists(d)) continue
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory() && !DOC.test(e.name)) paths.add(`${dir}/${e.name}`)
      }
    } catch (e) { issues.push({ stage: 'hooks', path: dir, reason: (e as Error).name + '：目录枚举失败' }) }
  }
  return [...paths]
}
export function findHooks(root: string): Array<{ kind: HookKind; path: string }> {
  const issues: Issue[] = []
  return hookPaths(root, issues).flatMap((rel) => {
    try { return OLD_CALL.test(readText(join(root, rel), root)) ? [{ kind: hookKind(rel)!, path: rel }] : [] } catch { return [] }
  })
}

function isStd(value: unknown): boolean {
  return typeof value === 'string' && pyStrip(value).replaceAll('\\', '/').replace(/\/$/, '') === '.std'
}

/** loader 已成功；这里只证明原文位置，不解析或扩展 YAML。失配时一行也不遮蔽。 */
function frozenLines(text: string, frozen: unknown[]): number[] | null {
  // loader 的 Python 断行比召回更宽；无法保持原行号时交给人工，不猜位置。
  if (/[\v\f\x1c-\x1e\x85\u2028\u2029]/.test(text)) return null
  const lines = text.split('\n').map((raw, i) => {
    const clean = stripComment(raw)
    return { n: i + 1, indent: clean.length - clean.replace(/^ +/, '').length, body: pyStrip(clean) }
  }).filter((l) => l.body)
  const header = (body: string, key: string) => {
    const m = /^(?:"([^"]*)"|'([^']*)'|([^:]+)):\s*$/.exec(body)
    return !!m && pyStrip(m[1] ?? m[2] ?? m[3]!) === key
  }
  const top = lines[0]?.indent
  const layout = lines.findIndex((l) => l.indent === top && header(l.body, 'layout'))
  if (layout < 0) return null
  const childIndent = lines[layout + 1]?.indent
  if (childIndent === undefined || childIndent <= top!) return null
  let start = -1
  for (let i = layout + 1; i < lines.length && lines[i]!.indent > top!; i++) {
    if (lines[i]!.indent === childIndent && header(lines[i]!.body, 'frozen')) { start = i; break }
  }
  if (start < 0) return null
  const itemIndent = lines[start + 1]?.indent
  if (itemIndent === undefined || itemIndent <= childIndent) return null
  const values: string[] = [], hits: number[] = []
  for (let i = start + 1; i < lines.length && lines[i]!.indent > childIndent; i++) {
    const l = lines[i]!
    if (l.indent !== itemIndent || !l.body.startsWith('- ')) return null
    let value = pyStrip(l.body.slice(2))
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1)
    values.push(value)
    if (isStd(value)) hits.push(l.n)
  }
  return values.length === frozen.length && values.every((v, i) => v === frozen[i]) ? hits : null
}

const hitKey = ([path, line, raw]: Hit): string => JSON.stringify([path.replaceAll('\\', '/'), line, raw])
/** 一个 tuple 池：候选按索引顺序先入，独立步骤证据后入；引用可重复，计费不重复。 */
function budgetEvidence(p: Plan): void {
  const pool = new Map<string, Hit>()
  for (const hits of [...p.candidates.map((c) => c.evidence), ...p.steps.map((s) => s.hits ?? [])]) {
    for (const hit of hits) if (!pool.has(hitKey(hit))) pool.set(hitKey(hit), hit)
  }
  const kept = new Set([...pool.keys()].slice(0, CAP))
  const paths = new Map<string, { path: string; total: number; omitted: number }>()
  for (const [key, hit] of pool) {
    const path = hit[0].replaceAll('\\', '/')
    const count = paths.get(path) ?? { path, total: 0, omitted: 0 }
    count.total++; if (!kept.has(key)) count.omitted++
    paths.set(path, count)
  }
  p.coverage.total = pool.size
  p.coverage.omitted = pool.size - kept.size
  p.coverage.omittedLocations = [...paths.values()].filter((v) => v.omitted > 0)
  for (const c of p.candidates) c.evidence = c.evidence.filter((h) => kept.has(hitKey(h)))
  for (const s of p.steps) if (s.hits) s.hits = s.hits.filter((h) => kept.has(hitKey(h)))
}

function classify(rel: string, text: string, cfg: Config, configKnown: boolean, tracked: boolean): Candidate | null {
  const lines = text.split('\n')
  const positions = new Set(grepLines(text, CLUE).map(([n]) => n - 1))
  // 反斜杠／反引号续行只用于召回；证据保留相关原行，不拼造源码。
  const joined = text.replace(/(?:\\|`)\r?\n\s*/g, '')
  if (!positions.size && !OLD_CALL.test(joined)) return null
  if (!positions.size) for (let i = 0; i < lines.length; i++) if (/\.std|check_|pick-/.test(lines[i]!)) positions.add(i)
  const continuation = /\.ps1$/i.test(rel) ? /`\s*$/ : /\\\s*$/
  for (const i of [...positions]) {
    if (i > 0 && continuation.test(lines[i - 1]!)) positions.add(i - 1)
    let j = i
    while (j < lines.length - 1 && continuation.test(lines[j]!)) positions.add(++j)
  }
  const evidence: Hit[] = [...positions].sort((a, b) => a - b).map((i) => [rel, i + 1, lines[i]!])
  const active = lines.filter((l) => !/^\s*(?:#|\/\/|\/\*|\*|REM\b)/i.test(l)).join('\n')
  const executionShape = OLD_CALL.test(active.replace(/(?:\\|`)\n\s*/g, '')) && /(?:\b(?:python\d*|uv\s+run|exec|sh|bash|node|pwsh|step|run|command|entry)\b|^\s*\.\s|["']?\$\{?\w+)/m.test(active)
  let category: Category, reason: string
  if ((configKnown && inFrozen(cfg, rel)) || HISTORY.test(rel) || RETAIN_PATH.test(rel)) {
    category = 'retained'; reason = configKnown && inFrozen(cfg, rel) ? '配置 layout.frozen 保留区；不自动解冻' : '历史／示例／测试路径保留候选，路径不证明实际用途'
  } else if (DOC.test(rel)) {
    category = 'documentation'; reason = '现行入口／接入文档候选；逐项按上下文判断'
  } else if ((hookKind(rel) || EXEC_PATH.test(rel) || /^(\.github\/workflows\/|\.vscode\/)|(?:^|\/)(?:Makefile|package\.json|.*(?:ci|task).*\.ya?ml)$/i.test(rel)) && executionShape) {
    category = 'execution'; reason = '脚本／钩子／CI／任务配置有旧路径和执行形态，仅静态候选，不证明运行'
  } else {
    category = 'review'; reason = '仅名称、注释、变量／路径片段或用途未证明；不求值，不确定 .std 来源'
  }
  if (!configKnown) reason += '；配置未知，不能证明不在冻结区'
  return { path: rel, category, reason, evidence, tracked, executionShape }
}

/** 一次索引枚举；配置路径由 main 转发，外部配置仅按显式授权读取。 */
export function plan(root: string, installed: boolean | { ok: false; why: string } = false, configPath?: string | null): Plan {
  const issues: Issue[] = []
  const [tracked, inventoryProblem] = trackedFiles(root)
  if (inventoryProblem) issues.push({ stage: 'inventory', path: root, reason: inventoryProblem })
  const [cfg, configProblem] = loadConfig(root, configPath)
  if (configProblem) issues.push({ stage: 'config', path: configPath ?? 'governance/project.yaml / project.yml', reason: configProblem })
  const supplements = hookPaths(root, issues)
  const files = new Set([...(tracked ?? []), ...supplements])
  const candidates: Candidate[] = []
  const frozen = cfgGet(cfg, 'layout.frozen', [])
  const hasFrozenStd = !configProblem && Array.isArray(frozen) && frozen.some(isStd)
  const configRel = cfg._path ? relative(resolve(root), resolve(root, String(cfg._path))).replaceAll('\\', '/') : null
  const external = configRel !== null && !inside(root, join(root, configRel))
  let frozenHits: Hit[] = []
  let configText: string | undefined
  let masked = new Set<number>()
  if (hasFrozenStd && !external && configRel !== null) {
    try {
      const text = readText(join(root, configRel), root).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      configText = text
      const positions = frozenLines(text, frozen as unknown[])
      if (positions === null) issues.push({ stage: 'config', path: configRel, reason: '已加载 layout.frozen，但原文位置无法安全证明；保留迁移步骤，不排除候选原行' })
      else {
        masked = new Set(positions)
        frozenHits = positions.map((n) => [configRel, n, text.split('\n')[n - 1]!])
      }
    } catch (e) { issues.push({ stage: 'read', path: configRel, reason: `${(e as Error).name}：已加载配置原文定位失读；保留已知迁移步骤` }) }
  }
  const coverage: Plan['coverage'] = { inventory: tracked === null ? 'failed' : 'complete', config: configProblem ? 'unknown' : 'loaded', trackedFiles: tracked?.length ?? null, readFiles: 0, excludedStd: 0, binaryFiles: [], supplementaryHooks: supplements.filter((p) => !tracked?.includes(p)), scope: '一次 git ls-files 全索引＋固定/直接层钩子补充；其余未跟踪及 ignore 未跟踪文件不覆盖；无静态线索的动态构造不保证发现。', total: 0, omitted: 0, omittedLocations: [] }
  for (const rel of files) {
    if (rel.startsWith('.std/')) { coverage.excludedStd++; continue }
    try {
      const data = readBytes(join(root, rel), root)
      coverage.readFiles++
      if (data.includes(0) || firstInvalidUtf8(data) >= 0) { coverage.binaryFiles.push(rel); continue }
      const text = decodeUtf8Sig(data).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      const excluded = rel === configRel && text === configText ? masked : new Set<number>()
      if (rel === configRel && masked.size && text !== configText) issues.push({ stage: 'config', path: rel, reason: '配置定位后原文改变；不排除候选原行，需重新核对' })
      const raw = text.split('\n')
      const recall = raw.map((l, i) => excluded.has(i + 1) ? '' : l).join('\n')
      const c = classify(rel, recall, cfg, !configProblem, tracked?.includes(rel) ?? false)
      if (c) {
        // 续行可能重新选中占位：恢复完整原文，并再次排除已证明的专属值行。
        c.evidence = c.evidence.filter((h) => !excluded.has(h[1])).map(([f, n]) => [f, n, raw[n - 1]!])
        candidates.push(c)
      }
    } catch (e) { issues.push({ stage: 'read', path: rel, reason: `${(e as Error).name}：拒读或读取失败，未按零命中处理` }) }
  }
  const hasStd = inside(root, join(root, '.std')) && isDir(join(root, '.std'))
  const hasSv = inside(root, join(root, 'governance/STANDARD_VERSION')) && isFile(join(root, 'governance/STANDARD_VERSION'))
  const stdTracked = tracked === null ? null : tracked.filter((p) => p.startsWith('.std/')).length
  const hooks = candidates.filter((c) => c.category === 'execution' && hookKind(c.path))
  const ok = installed === true
  const facts: Plan['facts'] = { hasStdDir: hasStd, stdTrackedFiles: stdTracked, hasStandardVersion: hasSv, hooks: hooks.map((c) => `${hookKind(c.path)}:${c.path}`).join('、') || '无', pluginInstalled: ok, configPath: String(cfg._path ?? configPath ?? '未知'), cliPresenceOnly: true }
  const p: Plan = { root, facts, steps: [], coverage, issues, candidates }
  const why = installed === true ? undefined : typeof installed === 'object' ? installed.why : '没有检测到新插件在 profile 的 CLI 文件；先核安装身份、重启与技能服务。在位检测不证明已激活。'
  const current = candidates.filter((c) => c.category !== 'retained')
  if (current.some((c) => c.category === 'execution' || c.category === 'review' || c.executionShape)) p.warning = '采用项目必须先处理这些调用，否则删除目录后现行检查入口将失效。'
  const addCandidates = (id: string, title: string, cs: Candidate[], advice: string, blocked?: string) => {
    if (!cs.length) return
    p.steps.push({ id, title, kind: 'judgement', hits: cs.flatMap((c) => c.evidence), advice, verify: VERIFY_CALLER, rollback: ROLLBACK, blocked })
  }
  for (const c of hooks) addCandidates(`hook:${c.path}`, `钩子 ${c.path}（形态：${hookKind(c.path)}）改调 std-check`, [c], CONNECT + (hookKind(c.path) === 'precommit-framework' ? ' entry 折叠块换行会折成空格，命令之间要用 `;` 连；验证实际 pre-commit 调用。' : ''), why)
  addCandidates('execution', '现行执行入口候选：删除前迁移并核对 caller', current.filter((c) => c.category === 'execution' && !hookKind(c.path)), CONNECT, why)
  addCandidates('review', '旧依赖未证明：删除前逐项判断候选用途', current.filter((c) => c.category === 'review'), '确认来源、变量构造及实际用途；不能机械替换或把未知当成无依赖。' + CONNECT)
  if (hasStd && tracked !== null) p.steps.push({ id: 'rm-std', kind: 'deterministic', title: '满足前置条件后删除内嵌 .std/（正文改由技能分发）', commands: stdTracked && stdTracked > 0 ? ['git rm -r -q .std'] : ['（没有被 git 跟踪的文件：先清点和备份未跟踪内容，确认授权；不可直接删除目录）'], prerequisites: DELETE_PRE, verify: 'git status --short 只应有本轮预期删除；逐 id/状态/退出码对账，adoption/compatibility-policy 不得消失或降级。', rollback: ROLLBACK })
  if (hasSv && tracked !== null) p.steps.push({ id: 'rm-standard-version', kind: 'deterministic', title: '满足前置条件后删除 governance/STANDARD_VERSION', commands: tracked.includes('governance/STANDARD_VERSION') ? ['git rm -q governance/STANDARD_VERSION'] : ['（版本声明未跟踪：先备份、确认授权和恢复方式，不直接删除）'], prerequisites: DELETE_PRE, verify: '同一修复版本迁移前后 adoption/compatibility-policy 及其余 id/状态/退出码相同；不再预期内嵌 adoption 消失。', rollback: ROLLBACK })
  if (hasFrozenStd) {
    if (external) facts.externalFrozenStd = true
    else p.steps.push({ id: 'frozen-std', kind: 'judgement', title: `${configRel} 的 layout.frozen 去掉独立 .std 项`, hits: frozenHits, advice: '仅处理实际 layout.frozen 的独立 .std 项，其它列表及 frozen 项不动；空列表是否删键由采用方判断。定位或读取问题见 issues，证据缺失不代表无需迁移。', prerequisites: DELETE_PRE, verify: '同配置逐 id/状态对账，无新增断链。', rollback: ROLLBACK })
  }
  addCandidates('docs-refs', `入口与现行文档里对旧标准的引用（共 ${current.filter((c) => c.category === 'documentation').reduce((n, c) => n + c.evidence.length, 0)} 处）`, current.filter((c) => c.category === 'documentation'), '逐处按上下文处理，标准正文用 skill 加载 std-*；检查命令接包 bin；不机械替换。' + CONNECT)
  if (!hasStd && !hasSv && candidates.length === 0 && p.steps.length === 0 && !facts.externalFrozenStd) {
    p.notApplicable = issues.length ? '本轮未发现迁移对象，但扫描／配置不完整，不能判断全仓无需迁移。' : '在已声明扫描范围内未发现旧依赖，无需迁移；动态构造与未跟踪文件仍需采用方核对。'
  } else p.steps.push({ id: 'compare', kind: 'deterministic', title: '同修复版本／配置／日期，迁移前后逐 id、状态与退出码对账', commands: ['（迁移前）std-check . --json > before.json', '（迁移后）std-check . --json > after.json'], advice: '两次都使用同一显式 --config（如有），保存已有 FAIL／未定。保留类仅报告、不要求修改；其中执行形态需确认是否仍被引用。外部配置中的 .std frozen 项只能报告，由配置所有者另行授权处理。', verify: 'adoption/compatibility-policy 不得消失或降级；仅 links 同检查器／同位置成对的聚合 PASS 数量标题变化可说明；历史断链需因果分析及采用方决定，不自动改历史。其它差异先查原因。', rollback: ROLLBACK })
  budgetEvidence(p)
  return p
}

export function renderPlan(p: Plan): string {
  const out = [`std-check migrate — ${p.root}`, '只读迁移方案（由采用方判断、执行并审阅）', '项目现状：']
  for (const [k, v] of Object.entries(p.facts)) out.push(`  ${k}: ${String(v)}`)
  out.push(`coverage: ${JSON.stringify(p.coverage)}`)
  for (const issue of p.issues) out.push(`issue [${issue.stage}] ${issue.path}: ${issue.reason}`)
  if (p.warning) out.push(p.warning)
  if (p.notApplicable) out.push(p.notApplicable)
  const shown = new Set<string>()
  const showHits = (hits: Hit[]) => {
    for (const h of hits) if (!shown.has(hitKey(h))) {
      const [f, n, l] = h
      out.push(`  ${f}:${n}  ${l}`)
      shown.add(hitKey(h))
    }
  }
  for (const c of p.candidates) {
    out.push(`[${c.category}] ${c.path}：${c.reason}${c.category === 'retained' && c.executionShape ? '；请确认是否仍被现行执行引用，不自动改保留内容' : ''}`)
    showHits(c.evidence)
  }
  out.push(`命中 total=${p.coverage.total}，omitted=${p.coverage.omitted}；遗漏位置见 coverage.omittedLocations，补读对应文件原文。`)
  p.steps.forEach((s, i) => {
    out.push(`${i + 1}. [${s.kind === 'deterministic' ? '确定（有前置条件）' : '需判断'}] ${s.title}${s.blocked ? '  ⛔ 当前不可做' : ''}`)
    showHits(s.hits ?? [])
    if (s.blocked) out.push(`   缺：${s.blocked}`)
    for (const pre of s.prerequisites ?? []) out.push(`   前提：${pre}`)
    for (const command of s.commands ?? []) out.push(`   $ ${command}`)
    if (s.advice) out.push(`   建议：${s.advice}`)
    out.push(`   验证：${s.verify}`, `   回退：${s.rollback}`, '')
  })
  return out.join('\n')
}
export const _internal = { grepLines }
