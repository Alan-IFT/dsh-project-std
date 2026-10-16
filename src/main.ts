// `std-check` 的主流程（对应 tools/std/check_all.py 的 `main`）。与 `cli.ts` 分开是为了避免依赖环：
// `--selftest` 要追加汇总层自检（`selftest.ts`），而汇总层自检里的入口冒烟又要调 `main`——所以 main 不 import selftest，由入口（cli.ts）把追加函数传进来。
//
// 用法：std-check [项目根] [--selftest] [--json] [--no-scope] [--config PATH]
//   --config PATH   改从这个路径读配置，而不是 <项目根>/governance/project.yaml；用于扫描只读项目：配置放在被测项目之外，扫描过程不往被测项目写任何东西。
// 退出码：有 FAIL → 1；无 FAIL 但有**未登记**的 UNDETERMINED → 2；否则 0。**2 不是成功。** 已登记的未定仍是未定、仍逐条列出、仍计数，登记只改变退出码。

import { join } from 'node:path'
import { runConfigReview } from './config-cli.js'
import { exitCode, render, runAll } from './check_all.js'
import { isFile } from './core/fs.js'
import { plan, renderPlan } from './migrate.js'
import type { CheckModule } from './checks/index.js'
import type { Finding } from './core/finding.js'

export interface Args { root: string; selftest: boolean; json: boolean; noScope: boolean; config: string | null; migrate: boolean }

/** 参数解析：与 Python argparse 的行为对齐到本工具用到的子集；认不出的参数直接报错退出 2（不静默忽略）。 */
export function parseArgs(argv: readonly string[]): Args | string {
  const a: Args = { root: '.', selftest: false, json: false, noScope: false, config: null, migrate: false }
  let rootSet = false
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === 'migrate' && i === 0) a.migrate = true // 子命令只认第一个位置；`std-check migrate [项目根] [--json]`
    else if (t === '--selftest') a.selftest = true
    else if (t === '--json') a.json = true
    else if (t === '--no-scope') a.noScope = true
    else if (t === '--config') {
      const v = argv[++i]
      if (v === undefined) return '--config 需要一个路径参数'
      a.config = v
    } else if (t.startsWith('--config=')) a.config = t.slice('--config='.length)
    else if (t.startsWith('-') && t !== '-') return `不认识的参数：${t}`
    else if (rootSet) return `多余的位置参数：${t}`
    else { a.root = t; rootSet = true }
  }
  return a
}

export interface Io { out: (text: string) => void; err: (text: string) => void }
const stdio: Io = { out: (t) => process.stdout.write(t + '\n'), err: (t) => process.stderr.write(t + '\n') }

/**
 * 新插件是否已装入 DSH profile：看 `$DSH_PROFILE_DIR/node_modules/dsh-project-std/lib/cli.js` 在不在。
 * 只读环境变量与一个文件的存在性；DSH 之外没有 DSH_PROFILE_DIR，如实返回"检测不到"并说明原因——不猜。
 */
export function pluginInstalled(env: NodeJS.ProcessEnv = process.env): true | { ok: false; why: string } {
  const dir = env.DSH_PROFILE_DIR
  if (!dir) return { ok: false, why: '没有 DSH_PROFILE_DIR（不在 DSH 会话里运行）：无法检测新插件是否已装入 profile。在 DSH 会话里重跑本命令，或自行确认后再执行钩子步骤。' }
  return isFile(join(dir, 'node_modules', 'dsh-project-std', 'lib', 'cli.js')) ? true
    : { ok: false, why: `profile（${dir}）里没有 node_modules/dsh-project-std/lib/cli.js：新插件还没装入。先在 Plugins 页用 git 地址安装并重启。` }
}

/** `std-check migrate [项目根] [--json]`：只读，输出迁移方案。退出码 0＝方案已给出（含"无需迁移"）；2＝命令自身出错。 */
function runMigrate(args: Args, io: Io): number {
  try {
    const p = plan(args.root, pluginInstalled(), args.config)
    io.out(args.json ? JSON.stringify(p, null, 2) : renderPlan(p))
    return 0
  } catch (exc) {
    io.err(`std-check migrate: 生成方案失败：${(exc as Error).name}: ${(exc as Error).message}`)
    return 2
  }
}

/**
 * 返回退出码，不直接调 `process.exit`（它同步结束进程、接不住，设计 §12.31 取舍 3；测试也要能调）。
 * `extraSelftest`：`--selftest` 时追加的汇总层/stdlib 层自检（由入口注入，见头注释）；封签之外追加的部分不进身份比对，与 Python 版一致（其 `_sealed` 只包 findings 的收尾）。
 */
export function main(argv: readonly string[], extraSelftest?: () => Finding[], io: Io = stdio, mods?: ReadonlyArray<CheckModule>): number {
  if (argv[0] === 'config-review') return runConfigReview(argv.slice(1), io)
  const args = parseArgs(argv)
  if (typeof args === 'string') { io.err(`std-check: ${args}`); return 2 }
  if (args.migrate) return runMigrate(args, io)
  let findings: Finding[]
  let text: string
  try {
    let cfg
    ;[findings, cfg] = runAll(args.root, { selftestOnly: args.selftest, configPath: args.config, extraSelftest, mods })
    text = args.json ? JSON.stringify(findings, null, 2) : render(findings, args.root, cfg, !args.noScope && !args.selftest, mods)
  } catch (exc) { // 契约 §1：崩溃记未定，退出 2，且给报告
    io.out(`check_all 自身崩溃，本次没有结论（记未定，退出码 2）：${(exc as Error).name}: ${(exc as Error).message}`)
    return 2
  }
  io.out(text)
  return exitCode(findings)
}
