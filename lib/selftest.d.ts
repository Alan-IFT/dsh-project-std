import { type Finding } from './core/finding.js';
/**
 * stdlib 层：配置读取与路径护栏，每条样本都来自一次实测的误读或越界（D-123）。
 * 返回的 Finding 与 Python 版同标题；Python 专有、对象在 TS 里不存在的 8 条不在这里（见 expected-changes.json）。
 */
export declare function stdlibSelftest(): Finding[];
/**
 * `--selftest` 追加的汇总层与 stdlib 层自检，次序与 Python 版 `run_all(selftest_only=True)` 相同：契约示例 → 入口冒烟 → 跨检查器 → （内嵌只读：已废弃，不迁）→ git 环境 → 敌意 git 配置 → stdlib。
 * 黄金样本里这一层有 79 条探针；其中 Python 专有机制 8 条在 test/cases/expected-changes.mjs 的 CHECK_ALL 登记为预期消失，另有 3 条 Windows 上造不出夹具而 SKIP。
 */
export declare function aggregateSelftest(): Finding[];
